import { attachTooltip } from './tooltip.js';
import { sendPanelCommand, isConnectionError } from '../bridge/panelPort.js';
import { getInspectedTabId, isDevToolsPanel } from '../bridge/inspectedTab.js';
import { pullPageSnapshot } from '../bridge/inspectPage.js';
import { getTextureHintText } from '../shared/textureHints.js';
import { initCaptureView } from './captureView.js';
import { initCaptureSplitters } from './splitters.js';
import { installTooltips } from './tooltip.js';
import { fnv1aHex, textBytes } from '../shared/storage/hash.js';
import { MAX_SHADER_SOURCE_LENGTH } from '../backend/webgl/spies/programSpy.js';
import { createShaderTabs, programTitle } from './shaderTabs.js';

const $ = (id) => document.getElementById(id);

let activeTabId = null;
let currentView = 'overview';
let selectedResource = 'textures';
let captureContexts = [];

let inspectionHostPromises = new Map();
let hostRequestSerial = 0;
const INSPECTION_HOST_TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pages that build their scene behind an async load (e.g. GLTFLoader) don't have a
// THREE.Scene yet if the panel pings right after navigation — keep polling briefly
// before giving up, instead of reporting no data after a single early PING.
const SCENE_POLL_ATTEMPTS = 6;
const SCENE_POLL_INTERVAL_MS = 500;

const INSPECTION_HOST_PATHS = {
  webgl: 'inspection/webgl/host.html',
  webgpu: 'inspection/webgpu/host.html'
};

function getInspectionHost(api = 'webgl') {
  const hostApi = INSPECTION_HOST_PATHS[api] ? api : 'webgl';
  if (!inspectionHostPromises.has(hostApi)) {
    let iframe = null;
    const pending = new Promise((resolve, reject) => {
      iframe = document.createElement('iframe');
      iframe.id = `inspection-host-${hostApi}`;
      iframe.setAttribute('title', `${hostApi.toUpperCase()} capture inspector`);
      iframe.hidden = true;
      iframe.src = `chrome-extension://${chrome.runtime.id}/${INSPECTION_HOST_PATHS[hostApi]}`;
      document.body.appendChild(iframe);
      const timeout = setTimeout(
      () => reject(new Error('The capture host did not load within 30 seconds — reload the inspected page and reopen Ispettore')),
      INSPECTION_HOST_TIMEOUT_MS
    );
      iframe.addEventListener(
        'load',
        () => {
          clearTimeout(timeout);
          resolve(iframe);
        },
        { once: true }
      );
      iframe.addEventListener(
        'error',
        () => {
          clearTimeout(timeout);
          reject(new Error('Capture host failed to load'));
        },
        { once: true }
      );
    });
    const tracked = pending.catch((error) => {
      inspectionHostPromises.delete(hostApi);
      iframe?.remove();
      throw error;
    });
    inspectionHostPromises.set(hostApi, tracked);
  }
  return inspectionHostPromises.get(hostApi);
}

async function hostRequest({ command, hostApi, ...rest }) {
  const iframe = await getInspectionHost(hostApi);
  return new Promise((resolve, reject) => {
    const id = ++hostRequestSerial;
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('The capture host did not respond within 30 seconds — reload the inspected page and reopen Ispettore'));
    }, INSPECTION_HOST_TIMEOUT_MS);
    const handler = (event) => {
      if (event.source !== iframe.contentWindow) return;
      const data = event.data;
      if (!data || data.type !== 'ISPETTORE_INSPECT_RESULT' || data.id !== id) return;
      window.removeEventListener('message', handler);
      clearTimeout(timeout);
      if (data.ok) resolve(data);
      else reject(new Error(data.error || 'Capture host error'));
    };
    window.addEventListener('message', handler);
    try {
      iframe.contentWindow.postMessage({ type: 'ISPETTORE_INSPECT', id, command, payload: rest }, '*');
    } catch (error) {
      clearTimeout(timeout);
      window.removeEventListener('message', handler);
      reject(error);
    }
  });
}

async function sendCommand(command, { quiet = false } = {}) {
  try {
    const response = await sendPanelCommand(command);
    if (!response?.ok) {
      if (!quiet) setStatus(response?.error || 'Could not reach page');
      return false;
    }
    if (response.tabId) activeTabId = response.tabId;
    return true;
  } catch (err) {
    const hint = isConnectionError(err)
      ? 'Extension disconnected — reload the page and reopen the panel'
      : err?.message || 'Could not reach page';
    if (!quiet) setStatus(hint);
    return false;
  }
}

function setStatus(text) {
  const el = $('status');
  if (el) {
    el.textContent = text;
    el.title = text;
  }
}

function formatPanelError(error, fallback = 'Operation failed') {
  if (isConnectionError(error)) {
    return 'Extension was reloaded. Close and reopen Ispettore, then reload the demo page.';
  }
  return error?.message || String(error || fallback);
}

function updatePanelActions(view = currentView) {
  const pingBtn = $('ping');
  const frameActions = $('frame-actions');
  if (pingBtn) pingBtn.hidden = view !== 'overview';
  if (frameActions) frameActions.hidden = view !== 'frame';
}

function setBadge(id, count) {
  const el = $(id);
  if (!el) return;
  el.textContent = count > 0 ? String(count) : '';
}

function setView(view) {
  currentView = view;

  document.querySelectorAll('.mode-nav [role="tab"]').forEach((btn) => {
    const on = btn.dataset.view === view;
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    const panel = $(btn.getAttribute('aria-controls'));
    if (!panel) return;
    panel.classList.toggle('view--active', on);
    panel.hidden = !on;
  });
  if (view === 'frame' || view === 'captures') captureView.onViewActivated();

  updatePanelActions(view);
}

// Resource kinds whose tab is hidden while the page has none of them.
const HIDE_WHEN_EMPTY = new Set(['textures', 'models']);
const resourceCounts = { textures: 0, programs: 0, models: 0 };

function isResourceTabVisible(name) {
  return !HIDE_WHEN_EMPTY.has(name) || resourceCounts[name] > 0;
}

function applyResourceTabs() {
  const tabs = [...document.querySelectorAll('.resource-tabs [role="tab"]')];
  for (const btn of tabs) btn.hidden = !isResourceTabVisible(btn.dataset.resource);
  const shown = isResourceTabVisible(selectedResource)
    ? selectedResource
    : tabs.find((btn) => !btn.hidden)?.dataset.resource;
  for (const btn of tabs) {
    const on = btn.dataset.resource === shown;
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    $(btn.getAttribute('aria-controls')).hidden = !on;
  }
}

function selectResource(name) {
  selectedResource = name;
  applyResourceTabs();
}

// Set once the user picks a tab, so automatic tab choices never override them.
let userPickedView = false;

document.querySelectorAll('.mode-nav [role="tab"]').forEach((btn) => {
  btn.addEventListener('click', () => {
    userPickedView = true;
    setView(btn.dataset.view);
  });
});

// Without three.js there is no scene tree, so the Frame tab is the useful starting point.
function openFrameTabForNonThreePage(data) {
  if (userPickedView || currentView !== 'overview' || emptyOverviewKind(data) !== 'no-three') return;
  setView('frame');
  $('frame-refresh')?.click();
}

document.querySelectorAll('.resource-tabs [role="tab"]').forEach((btn) => {
  btn.addEventListener('click', () => selectResource(btn.dataset.resource));
});

function renderMeta(data) {
  const parts = [];
  if (data.three?.detected) {
    parts.push(`Three.js r${data.three.revision ?? '?'}`);
  } else {
    parts.push('Three.js not detected on page');
  }
  if (data.gpuApi === 'webgpu') parts.push('WebGPU');
  if (data.camera) parts.push(`Camera: ${data.camera.name || data.camera.type}`);
  $('meta').textContent = parts.join(' · ');
}

function renderOverviewGlHint(data) {
  const el = $('overview-gl-hint');
  const tex = data.textures?.length ?? 0;
  el.textContent = tex ? `Last snapshot: ${tex} texture(s).` : '';
}

function renderOverviewSceneNotice(data) {
  const el = $('overview-scene-notice');
  if (!el) return;

  const three = data.three;
  if (three?.devtoolsBridge !== false) {
    el.hidden = true;
    el.textContent = '';
    return;
  }

  const min = three.devtoolsMinRevision ?? 106;
  const rev = three.revision ?? '?';
  el.hidden = false;
  el.textContent = `Scene object overview requires Three.js r${min} or newer (built-in __THREE_DEVTOOLS__ bridge). This page uses r${rev}.`;
}


const TYPE_ICONS = {
  Scene: '◎',
  PerspectiveCamera: '⌖',
  OrthographicCamera: '⌖',
  DirectionalLight: '☀',
  PointLight: '●',
  SpotLight: '▸',
  AmbientLight: '○',
  Group: '▸',
  Mesh: '◆',
  SkinnedMesh: '◆',
  Line: '─',
  Points: '⁘'
};

function iconForType(type) {
  return TYPE_ICONS[type] ?? '·';
}

function renderTreeNode(node) {
  if (!node) return '';
  const hidden = node.visible === false ? ' hidden' : '';
  const icon = iconForType(node.type);
  const summary = node.summary ? `<span class="summary">${escapeHtml(node.summary)}</span>` : '';
  const filter =
    node.uuid != null
      ? `<button type="button" class="scene-filter" data-scene-filter-uuid="${escapeHtml(node.uuid)}" data-scene-filter-name="${escapeHtml(node.name)}" title="Filter browser events for this node">⊘</button>`
      : '';
  const kids = (node.children || []).map((c) => `<li>${renderTreeNode(c)}</li>`).join('');
  const childBlock = kids ? `<ul>${kids}</ul>` : '';
  return `<span class="tree-row ${hidden.trim()}"><span class="icon">${icon}</span><strong>${escapeHtml(node.name)}</strong>${summary}${filter}</span>${childBlock}`;
}

function renderRendererList(renderers) {
  if (!renderers?.length) {
    return '<p class="empty">No renderer data — refresh while the app is drawing.</p>';
  }

  return `<ul class="inspector-list">${renderers
    .map((r) => {
      const size =
        r.width != null && r.height != null ? `${r.width}×${r.height}` : 'unknown size';
      const tris = r.triangles ? ` · ${r.triangles} triangles` : '';
      const props = r.properties;
      const mem = r.memory;
      const propsBlock = props
        ? `<dl class="renderer-props">
        <div><dt>Size</dt><dd>${size}</dd></div>
        <div><dt>Draw calls</dt><dd>${r.draws ?? 0}</dd></div>
        <div><dt>Triangles</dt><dd>${r.triangles ?? 0}</dd></div>
        <div><dt>Alpha</dt><dd>${props.alpha}</dd></div>
        <div><dt>Antialias</dt><dd>${props.antialias}</dd></div>
        <div><dt>Output color space</dt><dd>${escapeHtml(String(props.outputColorSpace))}</dd></div>
        <div><dt>Tone mapping</dt><dd>${props.toneMapping} · exposure ${props.toneMappingExposure}</dd></div>
        <div><dt>Shadows</dt><dd>${props.shadowMap ? 'enabled' : 'disabled'}</dd></div>
        <div><dt>Auto clear</dt><dd>color ${props.autoClearColor} · depth ${props.autoClearDepth} · stencil ${props.autoClearStencil}</dd></div>
        <div><dt>Memory</dt><dd>${mem?.geometries ?? 0} geometries · ${mem?.textures ?? 0} textures · ${r.programCount ?? 0} programs</dd></div>
      </dl>`
        : '';

      return `<li class="inspector-item inspector-item--renderer renderer-block">
        <details>
          <summary><span class="icon">▣</span><strong>${escapeHtml(r.type)}</strong><span class="muted">${size} · ${r.draws ?? 0} draws${tris}</span></summary>
          ${propsBlock}
        </details>
      </li>`;
    })
    .join('')}</ul>`;
}

function setRefreshAttention(on) {
  $('ping')?.classList.toggle('panel-action--attention', on);
}

function contextLabels(data) {
  const labels = new Set();
  for (const context of data.webGlCaptureContexts ?? []) {
    labels.add(context.contextInfo?.version ? `WebGL ${context.contextInfo.version}` : 'WebGL');
  }
  if (data.webgpuContextCount) labels.add('WebGPU');
  return [...labels];
}

function usesThree(data) {
  return Boolean(data?.three?.detected || data?.renderers?.length);
}

function isStalePageScript(data) {
  return Boolean(data?.buildId) && data.buildId !== (globalThis.__ISPETTORE_BUILD_ID ?? null);
}

const OVERVIEW_MESSAGES = {
  loading: () => ({ spinner: true, title: 'Looking for a scene…', attention: false }),
  unreachable: () => ({
    title: 'Ispettore cannot reach this page yet.',
    text: 'Reload the page with Ispettore active, then press <strong>Refresh overview</strong>.',
    attention: true
  }),
  stale: () => ({
    title: 'This tab runs an older Ispettore page script.',
    text: 'Reload the page to use the latest version.',
    attention: false
  }),
  'no-context': () => ({
    title: 'No WebGL or WebGPU context on this page yet.',
    text: 'If the page starts drawing later, press <strong>Refresh overview</strong>. If it already draws, reload it — Ispettore must be active when the page loads.',
    attention: true
  }),
  'no-three': (data) => ({
    title: `This page renders with ${contextLabels(data).join(' and ')} without three.js, so there is no scene tree.`,
    text: 'Capture a frame to inspect its draw calls, shaders, and pipeline state. Resources below still lists the textures and programs it uses.',
    action: '<button type="button" class="panel-action" data-go-frame>Go to Frame</button>',
    attention: false
  }),
  'three-no-scene': (data) => ({
    title: `three.js${data.three?.revision ? ` r${escapeHtml(data.three.revision)}` : ''} detected, but no scene has been rendered yet.`,
    text: 'Interact with the page if it only renders on demand, then press <strong>Refresh overview</strong>.',
    attention: true
  })
};

function overviewMessageHtml(kind, data) {
  const message = OVERVIEW_MESSAGES[kind](data);
  setRefreshAttention(message.attention);
  return `<div class="overview-empty" data-overview-state="${kind}">
    ${message.spinner ? '<span class="overview-spinner" aria-hidden="true"></span>' : ''}
    <p class="overview-empty-title">${message.title}</p>
    ${message.text ? `<p class="overview-empty-text">${message.text}</p>` : ''}
    ${message.action ?? ''}
  </div>`;
}

function renderOverviewMessage(kind, data = {}) {
  $('inspector-root').innerHTML = overviewMessageHtml(kind, data);
}

function emptyOverviewKind(data) {
  if (isStalePageScript(data)) return 'stale';
  if (usesThree(data)) return 'three-no-scene';
  return contextLabels(data).length ? 'no-three' : 'no-context';
}

function renderInspector(data) {
  const root = $('inspector-root');
  const scene = data.scene;
  const count = data.sceneObjectCount ?? 0;

  if (!scene && !data.renderers?.length) {
    renderOverviewMessage(emptyOverviewKind(data), data);
    return;
  }
  setRefreshAttention(!scene);

  const sceneHeader = scene
    ? `${escapeHtml(scene.name)} <span class="muted">${count} objects</span>`
    : 'Scene';

  root.innerHTML = `
    <section class="inspector-block">
      <h3 class="inspector-heading">RENDERERS</h3>
      ${renderRendererList(data.renderers)}
    </section>
    <section class="inspector-block">
      <h3 class="inspector-heading">SCENES</h3>
      ${
        scene
          ? `<ul class="inspector-list scene-root"><li><span class="tree-row"><span class="icon">◎</span><strong>${sceneHeader}</strong></span><ul>${(scene.children || []).map((c) => `<li>${renderTreeNode(c)}</li>`).join('')}</ul></li></ul>`
          : overviewMessageHtml(emptyOverviewKind(data), data)
      }
    </section>
  `;

  if (scene?.summary) {
    const row = root.querySelector('.scene-root > li > .tree-row');
    if (row) row.insertAdjacentHTML('beforeend', `<span class="summary">${escapeHtml(scene.summary)}</span>`);
  }

  root.querySelectorAll('[data-scene-filter-uuid]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      captureView.setSceneFilter(button.dataset.sceneFilterUuid, button.dataset.sceneFilterName);
      setStatus(`Filtering browser events for ${button.dataset.sceneFilterName}`);
    });
  });
}

function openTextureFull(tex) {
  const url = tex.previewFull || tex.preview;
  if (!url) return;

  const opened = window.open(url, '_blank', 'noopener');
  if (!opened) {
    setStatus('Pop-up blocked — allow pop-ups for DevTools');
  }
}

function renderTextures(textures) {
  setBadge('texture-count', textures?.length ?? 0);
  const grid = $('texture-grid');
  grid.innerHTML = '';

  for (const tex of textures) {
    const card = document.createElement('article');
    card.className = 'texture-card';
    if (tex.internal) card.classList.add('texture-card--internal');

    const thumb = document.createElement('div');
    thumb.className = 'thumb-wrap';

    const canOpen = Boolean(tex.previewFull || tex.preview);

    if (tex.preview) {
      const img = document.createElement('img');
      img.src = tex.preview;
      img.alt = tex.label || `Texture ${tex.id}`;
      img.loading = 'lazy';
      thumb.appendChild(img);
    } else {
      const msg = document.createElement('div');
      msg.className = 'no-preview';
      msg.textContent = tex.previewError || 'No preview';
      thumb.appendChild(msg);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';

    const titleRow = document.createElement('div');
    titleRow.className = 'texture-title-row';
    const title = document.createElement('strong');
    title.textContent = tex.label || `Texture #${tex.id}`;
    titleRow.appendChild(title);

    const details = document.createElement('span');
    details.textContent = `${tex.target || '?'} · ${tex.width ?? '?'}×${tex.height ?? '?'}`;

    meta.appendChild(titleRow);
    meta.appendChild(details);

    card.appendChild(thumb);
    card.appendChild(meta);
    grid.appendChild(card);

    const hintText = getTextureHintText(tex);
    if (hintText) {
      attachTooltip(titleRow, hintText, { inline: true, icon: 'i', position: 'bottom' });
    }

    if (canOpen) {
      card.classList.add('texture-card--openable');
      card.title = 'Click to open full size in a new tab';
      card.addEventListener('click', (e) => {
        if (e.target.closest('.ispettore-tooltip-trigger')) return;
        openTextureFull(tex);
      });
    }
  }
}

const shaderTabs = createShaderTabs({
  nav: document.querySelector('.mode-nav'),
  views: document.querySelector('main.views'),
  showView: setView,
  fallbackView: 'captures',
  truncatedAt: MAX_SHADER_SOURCE_LENGTH
});

function openShaderSource(program, stage = null) {
  if (!program.shaders?.length) return;
  const key = fnv1aHex(textBytes(program.shaders.map((s) => s.source).join('\0')));
  shaderTabs.open(key, program, { stage });
}

function renderPrograms(programs) {
  setBadge('program-count', programs?.length ?? 0);
  const list = $('program-list');
  list.innerHTML = '';

  for (const p of programs || []) {
    const li = document.createElement('li');
    const shaderCount = p.shaders?.length ?? 0;
    const label = document.createElement('span');
    label.textContent = programTitle(p);
    li.appendChild(label);
    if (shaderCount) {
      li.className = 'program-item--openable';
      li.title = 'Click to view shader source in a panel tab';
      const icon = document.createElement('span');
      icon.className = 'program-item-icon';
      icon.textContent = '↗';
      li.appendChild(icon);
      li.addEventListener('click', () => openShaderSource(p));
    }
    list.appendChild(li);
  }
  if (!programs?.length) {
    list.innerHTML = '<li class="empty">None linked yet</li>';
  }
}

function formatByteSize(bytes) {
  if (!Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function downloadModel(model) {
  setStatus(`Downloading ${model.fileName}…`);
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ISPETTORE_DOWNLOAD', url: model.url, fileName: model.fileName });
    if (!result?.ok) throw new Error(result?.error || 'Download failed');
    setStatus(result.state === 'complete' ? `Saved ${model.fileName} to Downloads` : `Downloading ${model.fileName} in the background…`);
  } catch (error) {
    setStatus(`Could not download ${model.fileName}: ${isConnectionError(error) ? 'extension reloaded — reopen Ispettore' : error?.message || error}`);
  }
}

function renderModels(models) {
  setBadge('model-count', models?.length ?? 0);
  const list = $('model-list');
  list.innerHTML = '';

  for (const model of models || []) {
    const li = document.createElement('li');
    li.className = 'model-item';
    li.tabIndex = 0;
    li.title = `Click to download ${model.url}`;
    const format = document.createElement('span');
    format.className = `model-format model-format--${model.format}`;
    format.textContent = model.format.toUpperCase();
    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = model.fileName;
    const meta = document.createElement('span');
    meta.className = 'model-meta muted';
    meta.textContent = [model.formatLabel, formatByteSize(model.byteSize)].filter(Boolean).join(' · ');
    const icon = document.createElement('span');
    icon.className = 'program-item-icon';
    icon.textContent = '⤓';
    li.append(format, name, meta, icon);
    li.addEventListener('click', () => void downloadModel(model));
    li.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void downloadModel(model);
      }
    });
    list.appendChild(li);
  }
}

function updateResourcesSummary(data) {
  const tex = data.textures?.length ?? 0;
  const prog = data.programs?.length ?? 0;
  const models = data.models?.length ?? 0;
  const parts = [`${tex} texture(s)`, `${prog} program(s)`];
  if (models) parts.push(`${models} model(s)`);
  $('resources-summary').textContent = tex || prog || models ? `· ${parts.join(', ')}` : '';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function resolveCaptureData(data) {
  if (!data || data.scene || !isDevToolsPanel()) return data;
  const live = await pullPageSnapshot();
  if (!live) return data;
  return {
    ...data,
    scene: live.scene ?? data.scene,
    sceneObjectCount: live.sceneObjectCount ?? data.sceneObjectCount,
    three: live.three ?? data.three,
    camera: live.camera ?? data.camera,
    renderers: live.renderers?.length ? live.renderers : data.renderers
  };
}

function renderCapture(data, { quiet = false } = {}) {
  captureContexts = data.webGlCaptureContexts ?? captureContexts;
  captureView.setContexts(captureContexts);
  setBadge('frame-count', captureContexts?.length ?? 0);
  renderMeta(data);
  renderOverviewSceneNotice(data);
  renderInspector(data);
  renderTextures(data.textures);
  renderPrograms(data.programs);
  renderModels(data.models);
  resourceCounts.textures = data.textures?.length ?? 0;
  resourceCounts.programs = data.programs?.length ?? 0;
  resourceCounts.models = data.models?.length ?? 0;
  applyResourceTabs();
  updateResourcesSummary(data);
  renderOverviewGlHint(data);

  setView(currentView);

  const texCount = data.textures?.length ?? 0;
  if (quiet) {
    /* the Overview itself shows the result of an automatic refresh */
  } else if (data.ping && data.scene) {
    setStatus(texCount ? `Scene updated · ${texCount} texture(s)` : 'Scene tree updated');
  } else if (data.ping) {
    const kind = emptyOverviewKind(data);
    setStatus(
      kind === 'no-three'
        ? `Refreshed · ${contextLabels(data).join(' and ')} page without three.js`
        : kind === 'no-context'
          ? 'Refreshed · no WebGL or WebGPU context yet'
          : kind === 'stale'
            ? 'Refreshed · reload the page to update the Ispettore page script'
            : 'Refreshed · no scene rendered yet'
    );
  } else {
    setStatus('Ready');
  }
}

async function sessionGet(key) {
  try {
    return await chrome.storage.session.get(key);
  } catch (err) {
    if (isConnectionError(err)) return {};
    throw err;
  }
}

async function loadCaptureBundle(tabId) {
  const key = `capture:${tabId}`;
  const stored = await sessionGet(key);
  const data = stored[key];
  if (!data) return null;
  return resolveCaptureData(data);
}

async function loadLastCapture() {
  const tabId = activeTabId ?? (await getInspectedTabId());
  if (!tabId) return;
  const data = await loadCaptureBundle(tabId);
  if (data) renderCapture(data);
}

let refreshSerial = 0;
let refreshesRunning = 0;

// Automatic refreshes (panel open, navigation, tab switch) are quiet: they update the Overview,
// which carries its own messages, but never overwrite the status line of another operation.
async function refreshInspector({ quiet = false } = {}) {
  // A user-started refresh always wins: quiet ones never interrupt a refresh in progress, and
  // a click cancels a quiet refresh that is still waiting to start.
  if (quiet && refreshesRunning > 0) return;
  if (!quiet) clearTimeout(navigationRefreshTimer);
  refreshesRunning++;
  try {
    await runRefresh(quiet);
  } finally {
    refreshesRunning--;
  }
}

async function runRefresh(quiet) {
  const serial = ++refreshSerial;
  const current = () => serial === refreshSerial;
  const status = quiet ? () => {} : setStatus;
  status('Refreshing…');
  if (!$('inspector-root').querySelector('.scene-root')) renderOverviewMessage('loading');
  const tabId = activeTabId ?? (await getInspectedTabId());
  if (!tabId || !current()) return;

  const key = `capture:${tabId}`;
  const stored = await sessionGet(key);
  let data = await pullPageSnapshot();
  const frozen = stored[key] || null;

  if (!data?.scene) {
    for (let attempt = 0; attempt < SCENE_POLL_ATTEMPTS && !data?.scene; attempt++) {
      if (attempt > 0) {
        status('Refreshing… (waiting for the scene to initialize)');
        await delay(SCENE_POLL_INTERVAL_MS);
        if (!current()) return;
      }
      const ok = await sendCommand('PING', { quiet });
      if (!current()) return;
      if (!ok) {
        renderOverviewMessage('unreachable');
        return;
      }
      const updated = await sessionGet(key);
      data = await resolveCaptureData(updated[key] || frozen || data);
      if (!current()) return;
      // Pages without three.js never produce a scene; stop waiting once a snapshot says so.
      if (data && !usesThree(data)) break;
    }
  } else if (frozen) {
    data = { ...frozen, ...data };
  }

  if (data) {
    renderCapture(data, { quiet });
    if (quiet) openFrameTabForNonThreePage(data);
  } else {
    renderOverviewMessage('unreachable');
    status('No data — reload the page and try again');
  }
}

// Refresh on open and after the inspected page navigates, so users do not have to find the
// button first. Navigation events fire before the new page has drawn; the refresh itself
// polls for a scene for a few seconds.
const NAVIGATION_REFRESH_DELAY_MS = 800;
let navigationRefreshTimer = null;

function scheduleAutoRefresh() {
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => void refreshInspector({ quiet: true }), NAVIGATION_REFRESH_DELAY_MS);
}

function watchInspectedPage() {
  if (isDevToolsPanel()) {
    chrome.devtools.network?.onNavigated?.addListener(() => scheduleAutoRefresh());
    return;
  }
  chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' && tabId === activeTabId) scheduleAutoRefresh();
  });
  chrome.tabs?.onActivated?.addListener(({ tabId }) => {
    if (tabId === activeTabId) return;
    activeTabId = tabId;
    scheduleAutoRefresh();
  });
}

function watchCaptureUpdates() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;

    void getInspectedTabId()
      .then((tabId) => {
        if (!tabId) return;
        const key = `capture:${tabId}`;
        if (!changes[key]) return;
        activeTabId = tabId;
        return loadCaptureBundle(tabId).then((data) => {
          if (!data) return;
          renderCapture(data, { quiet: true });
        });
      })
      .catch((err) => {
        if (!isConnectionError(err)) return;
        setStatus('Extension reloaded — close and reopen the Ispettore panel');
      });
  });
}

window.addEventListener('unhandledrejection', (event) => {
  if (!isConnectionError(event.reason)) return;
  event.preventDefault();
  setStatus('Extension disconnected — close and reopen the side panel');
});

$('ping').addEventListener('click', () => {
  void refreshInspector();
});

$('inspector-root').addEventListener('click', (event) => {
  if (!event.target.closest('[data-go-frame]')) return;
  setView('frame');
  $('frame-refresh')?.click();
});

const captureView = initCaptureView({
  hostRequest,
  sendPanelCommand,
  setStatus,
  formatError: formatPanelError,
  openShaderProgram: openShaderSource
});

initCaptureSplitters();
installTooltips();

setView('overview');
selectResource('textures');
watchCaptureUpdates();
watchInspectedPage();
void loadLastCapture().then(() => refreshInspector({ quiet: true }));
