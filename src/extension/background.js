/* global chrome */

import { installCaptureStorage } from './storage.js';
import { modelAssetFromEntry } from '../backend/modelAssets.js';

installCaptureStorage().catch((error) => {
  console.error('Ispettore: capture storage failed to initialize', error?.message || error);
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/** @type {Map<number, number>} */
const debugTabByWindow = new Map();

function isInspectableUrl(url) {
  if (!url) return false;
  return /^(https?|file):/i.test(url);
}

function isConnectionErrorMessage(msg) {
  return /receiving end does not exist|could not establish connection/i.test(msg || '');
}

function tabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response);
    });
  });
}

function rememberDebugTab(tab) {
  if (tab?.id && tab.windowId != null && isInspectableUrl(tab.url)) {
    debugTabByWindow.set(tab.windowId, tab.id);
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(rememberDebugTab).catch(() => {});
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) rememberDebugTab(tab);
});

async function getTargetTab() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id && isInspectableUrl(active.url)) {
    rememberDebugTab(active);
    return active;
  }

  if (active?.windowId != null) {
    const fallbackId = debugTabByWindow.get(active.windowId);
    if (fallbackId) {
      try {
        const tab = await chrome.tabs.get(fallbackId);
        if (isInspectableUrl(tab.url)) return tab;
      } catch (_) {
        debugTabByWindow.delete(active.windowId);
      }
    }
  }

  return active ?? null;
}

async function ensureContentScript(tabId) {
  try {
    await tabsSendMessage(tabId, { type: 'ISPETTORE_PING' });
    return;
  } catch (e) {
    if (!isConnectionErrorMessage(e.message)) throw e;
  }

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content.js']
  });

  await tabsSendMessage(tabId, { type: 'ISPETTORE_PING' });
}

async function resolveTab(tabId) {
  if (tabId != null) {
    try {
      return await chrome.tabs.get(tabId);
    } catch (_) {
      return null;
    }
  }
  return getTargetTab();
}

// A demo can render inside a same-origin iframe (e.g. threejs.org's examples gallery embeds
// each example in <iframe id="viewer">) rather than the tab's top frame, so every query here
// must check every frame in the tab, not just frame 0 (chrome.scripting.executeScript's
// default target when frameIds/allFrames are not specified).
async function readLatestAnimationFrames(tabId, summaryGetter) {
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: (getterName) => {
      if (!window.__ISPETTORE__) return { installed: false, contexts: [] };
      const buildId = globalThis.__ISPETTORE_BUILD_ID ?? null;
      const contexts = (window.__ISPETTORE__[getterName]?.() ?? [])
        .filter((context) => !context.installWarning)
        .map((context) => ({
          contextId: context.contextId,
          lastFrameId:
            context.frames?.filter((frame) => frame.kind === 'animation-frame' || frame.kind === 'on-demand').at(-1)?.frameId ?? null
        }));
      return { installed: true, contexts, buildId };
    },
    args: [summaryGetter]
  });

  let installed = false;
  let stale = false;
  const contexts = [];
  for (const injection of injections ?? []) {
    if (!injection?.result?.installed) continue;
    installed = true;
    if (isStaleBuild(injection.result.buildId)) stale = true;
    for (const context of injection.result.contexts) {
      contexts.push({ ...context, frameId: injection.frameId });
    }
  }
  return { installed, contexts, stale };
}

// Reloading the extension does not re-inject open tabs: they keep the page script from the
// previous build, which still records and captures but lacks newer capture behavior.
// Every bundle carries the same build banner, so a mismatch means the tab needs a reload.
const STALE_PAGE_ERROR = 'This tab is running an older Ispettore page script — reload the page, then capture again';

function isStaleBuild(pageBuildId) {
  return pageBuildId !== (globalThis.__ISPETTORE_BUILD_ID ?? null);
}

// Broadcasting PING via tabsSendMessage and letting every frame push its own snapshot back
// through ISPETTORE_CAPTURE races: a frame with no Three.js scene (e.g. the wrapper page of a
// gallery that embeds the real demo in an <iframe>) can finish last and overwrite a real scene
// with an empty one, since storeCapture keys purely by tabId. Querying every frame directly and
// picking whichever one actually has a scene avoids that race entirely. Model files are merged
// from every frame, since the model can be loaded by a different frame than the one rendering.
// Each frame's Resource Timing entries are read here too, so models are listed even when the
// page still runs an injected script from before the extension was updated.
async function collectSceneSnapshot(tabId) {
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: () => {
      let snapshot = null;
      try {
        snapshot = window.__ISPETTORE__?.getSnapshot?.({ ping: true, skipGpuSnapshot: true }) ?? null;
      } catch (_) {
        snapshot = null;
      }
      let resources = [];
      try {
        resources = performance.getEntriesByType('resource').map((entry) => ({
          name: entry.name,
          initiatorType: entry.initiatorType,
          decodedBodySize: entry.decodedBodySize,
          encodedBodySize: entry.encodedBodySize,
          transferSize: entry.transferSize
        }));
      } catch (_) {
        resources = [];
      }
      return { snapshot, resources, href: location.href };
    }
  });

  let chosen = null;
  let fallback = null;
  const models = new Map();
  const addModel = (model, frameId) => {
    if (model && !models.has(model.url)) models.set(model.url, { ...model, frameId });
  };
  for (const injection of injections ?? []) {
    const { snapshot: result, resources = [], href } = injection?.result ?? {};
    for (const model of result?.models ?? []) addModel(model, injection.frameId);
    for (const entry of resources) addModel(modelAssetFromEntry(entry, href), injection.frameId);
    if (!result) continue;
    if (result.scene && !chosen) chosen = { data: result, frameId: injection.frameId };
    if (!fallback) fallback = { data: result, frameId: injection.frameId };
  }
  const snapshot = chosen ?? fallback;
  if (snapshot) snapshot.data = { ...snapshot.data, models: Array.from(models.values()) };
  return snapshot;
}

// Ispettore's content script observes every WebGL2/WebGPU context from creation on every page
// load (manifest content script, run_at: document_start) — it never needs a reload to start
// recording. So "Capture frame" arms against the page as it is running right now: it remembers
// each context's latest completed animation frame, then waits for a newer one to land, the same
// "capture the next frame" model Spector.js uses. This preserves whatever live state the page is
// in (camera position, interaction, in-flight asset loads) instead of discarding it with a reload.
const RENDER_NUDGE_DELAY_MS = 1000;

async function captureFirstFrame(tabId, api = 'webgl') {
  const summaryGetter = api === 'webgpu' ? 'getWebGpuJournalSummary' : 'getWebGlJournalSummary';
  const storeFn = api === 'webgpu' ? 'storeWebGpuFrame' : 'storeWebGlFrame';
  const apiLabel = api === 'webgpu' ? 'WebGPU' : 'WebGL';

  const baseline = await readLatestAnimationFrames(tabId, summaryGetter);
  if (!baseline.installed) {
    return { ok: false, error: 'Ispettore not injected — reload the page' };
  }
  if (baseline.stale) {
    return { ok: false, error: STALE_PAGE_ERROR };
  }
  // Each frame's injected.js assigns contextIds independently (ctx-1, ctx-2, ...), so the
  // same id can exist in more than one frame — key the baseline by (frameId, contextId).
  const baselineMap = new Map(
    baseline.contexts.map((context) => [`${context.frameId}:${context.contextId}`, context.lastFrameId])
  );

  // Arm only frames the baseline actually found a WebGL2 context in — e.g. a gallery page
  // that embeds the real demo in an <iframe> has other frames with no context at all, and
  // arming those too just logs a spurious "matched no WebGL2 context" warning on the page.
  const armableFrameIds = [...new Set(baseline.contexts.map((context) => context.frameId))];

  if (api === 'webgl' && armableFrameIds.length) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: armableFrameIds },
        world: 'MAIN',
        func: () => window.__ISPETTORE__?.armWebGlCapture?.() ?? null
      });
    } catch (error) {
      // Best-effort: a missing/failed arm must never block the existing capture flow.
      console.warn('[ispettore] armWebGlCapture failed, continuing without arming:', error);
    }
  }

  if (api === 'webgpu' && armableFrameIds.length) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: armableFrameIds },
        world: 'MAIN',
        func: () => window.__ISPETTORE__?.armWebGpuCapture?.() ?? null
      });
    } catch (error) {
      return { ok: false, error: `Could not arm WebGPU capture: ${error?.message || error}` };
    }
  }

  const startedAt = Date.now();
  const deadline = startedAt + 30000;
  let target = null;
  let nudged = false;
  while (Date.now() < deadline) {
    // Render-on-demand pages only draw on input or resize, so an armed capture can wait
    // forever; one synthetic resize makes typical three.js pages (onWindowResize -> render())
    // redraw, and the journal records that draw as an on-demand frame.
    if (api === 'webgl' && !nudged && armableFrameIds.length && Date.now() - startedAt > RENDER_NUDGE_DELAY_MS) {
      nudged = true;
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: armableFrameIds },
          world: 'MAIN',
          func: () => window.dispatchEvent(new Event('resize'))
        });
      } catch (_) {
        // Best-effort: the user can still trigger a redraw by interacting with the page.
      }
    }
    try {
      const current = await readLatestAnimationFrames(tabId, summaryGetter);
      for (const context of current.contexts) {
        const key = `${context.frameId}:${context.contextId}`;
        if (context.lastFrameId && context.lastFrameId !== (baselineMap.get(key) ?? null)) {
          target = { contextId: context.contextId, frameId: context.frameId, gpuFrameId: context.lastFrameId };
          break;
        }
      }
      if (target) break;
    } catch (_) {
      // The page may briefly be unavailable (e.g. an unrelated navigation) — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!target) {
    return { ok: false, error: `Timed out waiting for the next complete ${apiLabel} animation frame` };
  }

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [target.frameId] },
    world: 'MAIN',
    func: async (contextId, gpuFrameId, storeName) => {
      try {
        return await window.__ISPETTORE__?.[storeName]?.(contextId, gpuFrameId);
      } catch (error) {
        return { ok: false, error: error?.stack || error?.message || String(error) };
      }
    },
    args: [target.contextId, target.gpuFrameId, storeFn]
  });
  return injection?.result ?? { ok: false, error: 'Frame capture returned no result' };
}

async function sendCommandToTab(command, tabId, payload = {}) {
  const tab = await resolveTab(tabId);
  if (!tab?.id) {
    return { ok: false, error: 'No inspected tab' };
  }
  if (!isInspectableUrl(tab.url)) {
    return {
      ok: false,
      error: 'Open an http(s) or file:// page with your WebGL app (not chrome:// pages)'
    };
  }

  try {
    await ensureContentScript(tab.id);

    if (command === 'GET_WEBGL_CONTEXTS') {
      const injections = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        func: () => {
          try {
            const webgl = (window.__ISPETTORE__?.getWebGlJournalSummary?.() ?? []).map((context) => ({
              ...context,
              api: 'webgl'
            }));
            const webgpu = (window.__ISPETTORE__?.getWebGpuJournalSummary?.() ?? [])
              .filter((context) => context.contextId != null)
              .map((context) => ({ ...context, api: 'webgpu' }));
            return window.__ISPETTORE__
              ? { ok: true, contexts: [...webgpu, ...webgl], buildId: globalThis.__ISPETTORE_BUILD_ID ?? null }
              : { ok: false, error: 'Ispettore not injected — reload the page' };
          } catch (error) {
            return { ok: false, error: error?.message || String(error) };
          }
        }
      });

      const contexts = [];
      let anyInjected = false;
      let stale = false;
      let lastError = null;
      for (const injection of injections ?? []) {
        const result = injection?.result;
        if (!result) continue;
        if (result.ok) {
          anyInjected = true;
          if (isStaleBuild(result.buildId)) stale = true;
          for (const context of result.contexts ?? []) {
            // contextIds are only unique within one frame (each frame's injected.js counts its
            // own ctx-1, ctx-2, ...) — disambiguate once contexts from multiple frames are merged.
            contexts.push({ ...context, frameId: injection.frameId, contextId: `${injection.frameId}:${context.contextId}` });
          }
        } else if (result.error) {
          lastError = result.error;
        }
      }

      return {
        ok: anyInjected,
        contexts,
        stalePageScript: stale,
        error: anyInjected ? null : lastError || 'Ispettore not injected — reload the page',
        tabId: tab.id
      };
    }

    if (command === 'CAPTURE_WEBGL_FRAME') {
      const api = payload.api === 'webgpu' ? 'webgpu' : 'webgl';
      const result = await captureFirstFrame(tab.id, api);
      return { ...result, tabId: tab.id };
    }

    if (command === 'PING') {
      const snapshot = await collectSceneSnapshot(tab.id);
      if (snapshot) storeCapture(tab.id, snapshot.data, { frameId: snapshot.frameId, documentId: null });
      return { ok: true, tabId: tab.id };
    }

    await tabsSendMessage(tab.id, { type: 'ISPETTORE_COMMAND', command });
    return { ok: true, tabId: tab.id };
  } catch (err) {
    return {
      ok: false,
      error: isConnectionErrorMessage(err.message)
        ? 'Page not connected — reload the demo tab, then try again'
        : err.message || String(err)
    };
  }
}

function captureStorageKey(tabId) {
  return `capture:${tabId}`;
}

function stripCaptureForStorage(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  const out = { ...payload };
  delete out.frameThumbnail;

  if (Array.isArray(out.textures)) {
    out.textures = out.textures.map((tex) => {
      const { preview, previewFull, ...meta } = tex;
      return meta;
    });
  }

  return out;
}

function storeCapture(tabId, payload, sender) {
  if (tabId == null) return;
  const key = captureStorageKey(tabId);
  const data = {
    ...stripCaptureForStorage(payload),
    source: {
      frameId: Number.isInteger(sender?.frameId) ? sender.frameId : null,
      documentId: sender?.documentId ?? null
    }
  };

  chrome.storage.session.set({ [key]: data }, () => {
    const err = chrome.runtime.lastError;
    if (err) {
      console.error('Ispettore: session storage quota exceeded — capture not saved', err.message || err);
    }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ispettore-panel') return;

  port.onMessage.addListener((message) => {
    if (message?.type !== 'COMMAND') return;

    sendCommandToTab(message.command, message.tabId, message.payload)
      .then((result) => {
        try {
          port.postMessage(result);
        } catch (_) {
          /* panel closed */
        }
      })
      .catch((err) => {
        try {
          port.postMessage({ ok: false, error: err?.message || String(err) });
        } catch (_) {
          /* panel closed */
        }
      });
  });
});

const DOWNLOAD_WAIT_MS = 60000;

function safeDownloadName(name) {
  const cleaned = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return cleaned || 'model';
}

function waitForDownload(downloadId) {
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(result);
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') finish({ ok: true, state: 'complete' });
      else if (delta.state.current === 'interrupted') finish({ ok: false, error: delta.error?.current || 'Download interrupted' });
    };
    const timeout = setTimeout(() => finish({ ok: true, state: 'in_progress' }), DOWNLOAD_WAIT_MS);
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }, ([item] = []) => {
      if (item?.state === 'complete') finish({ ok: true, state: 'complete' });
      else if (item?.state === 'interrupted') finish({ ok: false, error: item.error || 'Download interrupted' });
    });
  });
}

// Saving through chrome.downloads avoids the blank window Chrome opens for <a download> clicks
// made from DevTools and side-panel pages.
async function downloadResource({ url, fileName }) {
  if (typeof url !== 'string' || !/^(https?|file):/i.test(url)) {
    return { ok: false, error: 'Only http(s) and file resources can be downloaded' };
  }
  const downloadId = await chrome.downloads.download({
    url,
    filename: safeDownloadName(fileName),
    conflictAction: 'uniquify',
    saveAs: false
  });
  const result = await waitForDownload(downloadId);
  return { ...result, downloadId };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'ISPETTORE_DOWNLOAD') return;
  downloadResource(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'ISPETTORE_CAPTURE') return;

  if (sender.tab) rememberDebugTab(sender.tab);
  storeCapture(sender.tab?.id, message.payload, sender);
  sendResponse({ ok: true });
  return true;
});
