import {
  buildEventIndex,
  isDrawOp,
  preferredPreviewEvent,
  summarizeCommand
} from '../inspection/webgl/view.js';
import { buildFrameCostGroups, buildPassGroups, buildStepGroups, computeRegionLayout } from './frameCost.js';
import { describeHostFailure } from './hostErrors.js';
import { renderSideBySideDiff } from './diffView.js';
import { renderEventDetails } from './detailsView.js';
import { renderPipelineStages } from './pipelineView.js';
import { renderWebGpuPipelineStages, webGpuShaderProgram } from './webgpuPipelineView.js';

const EVENT_KIND_COLOR_KEY = {
  draw: 'draw',
  clear: 'command',
  blit: 'command',
  copy: 'command'
};

function eventKindColorKey(kind) {
  return EVENT_KIND_COLOR_KEY[kind] ?? 'other';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function kindClass(kind) {
  return `range-kind--${eventKindColorKey(kind)}`;
}

function frameEventBarClass(kind) {
  return `frame-event-bar--${eventKindColorKey(kind)}`;
}

function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function inspectionStatusHtml(inspectionStatus) {
  if (!inspectionStatus) return '';
  const level = inspectionStatus.level ?? 'supported';
  const reasons = Array.isArray(inspectionStatus.reasons) ? inspectionStatus.reasons : [];
  const reasonsHtml = reasons.length
    ? `<ul class="inspection-status-reasons">${reasons
        .map((reason) => `<li>${escapeHtml(reason)}</li>`)
        .join('')}</ul>`
    : '';
  return `<span class="inspection-status inspection-status--${escapeHtml(level)}">${escapeHtml(level)}${reasonsHtml}</span>`;
}

function attributesHtml(attributes) {
  if (!attributes) return '';
  const labels = [
    ['alpha', 'alpha'],
    ['antialias', 'antialias'],
    ['depth', 'depth'],
    ['stencil', 'stencil'],
    ['premultipliedAlpha', 'premultiplied alpha'],
    ['preserveDrawingBuffer', 'preserve buffer'],
    ['powerPreference', 'power']
  ];
  const parts = labels
    .filter(([key]) => attributes[key] != null)
    .map(([key, label]) => `${label}: ${String(attributes[key])}`);
  return parts.length ? parts.join(' · ') : '—';
}

function extensionsList(extensions) {
  if (!Array.isArray(extensions) || !extensions.length) return '—';
  return extensions.map(escapeHtml).join(', ');
}

function overflowHtml(overflow) {
  if (!overflow) return null;
  const kind = overflow.kind === 'bytes' ? 'byte' : 'command';
  return `<p class="capture-warn">Capture stopped: hit the ${kind} budget (limit ${overflow.limit}, captured ${overflow.captured}). History may be truncated.</p>`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pages that build their scene behind an async load (e.g. GLTFLoader) create their
// WebGL2/WebGPU context only once that load resolves, so a refresh right after
// navigation can race the page and find nothing yet — keep polling briefly before
// reporting "no context found".
const CONTEXT_POLL_ATTEMPTS = 6;
const CONTEXT_POLL_INTERVAL_MS = 500;
const ON_DEMAND_HINT_DELAY_MS = 4000;

export function initCaptureView(panel) {
  const { hostRequest, sendPanelCommand, setStatus, formatError, openShaderProgram } = panel;
  const $ = (id) => document.getElementById(id);

  let contexts = [];
  let storedCaptures = [];
  let selectedContextId = null;
  let currentCaptureId = null;
  let currentCaptureApi = 'webgl';

  function captureApi(captureId) {
    const summary = storedCaptures.find((capture) => capture.captureId === captureId);
    return summary?.schema === 'ispettore-webgpu-capture' ? 'webgpu' : 'webgl';
  }
  let currentView = null;
  let currentMeta = null;
  let currentEventIndex = null;
  let currentGpuTimings = null;
  let selectedFrameId = null;
  let selectedEid = null;
  let selectedCommandIndex = null;
  let inspectionBuffer = 'color';
  let search = '';
  let sort = 'eid';
  let sceneFilterUuid = null;
  let sceneFilterName = null;
  let inspectionSerial = 0;

  const contextSelect = $('frame-context');
  const storeButton = $('frame-store');
  const refreshButton = $('frame-refresh');
  const metadata = $('capture-metadata');
  const metadataFold = $('capture-metadata-details');
  const storedList = $('stored-captures-list');
  const storedNote = $('stored-captures-note');
  const rangeList = $('frame-event-list');
  const searchInput = $('frame-search');
  const sortSelect = $('frame-sort');
  const viewport = $('frame-viewport');
  let detailsProgram = null;
  let pipelineStage = 'vertex-input';
  let lastInspectionResult = null;
  viewport?.addEventListener('click', (event) => {
    const stageButton = event.target.closest('[data-pipeline-stage]');
    if (stageButton && lastInspectionResult) {
      pipelineStage = stageButton.dataset.pipelineStage;
      renderPipelineTab(lastInspectionResult);
      return;
    }
    const openButton = event.target.closest('[data-open-program]');
    if (openButton && detailsProgram) openShaderProgram?.(detailsProgram, openButton.dataset.stage);
  });
  const eventLabel = $('frame-event-label');
  const details = $('frame-details');
  const commandList = $('frame-command-list');
  const commandsPanel = $('frame-commands');
  const diffPanel = $('capture-diff');
  const diffBar = $('capture-diff-bar');
  const diffSelectA = $('diff-capture-a');
  const diffSelectB = $('diff-capture-b');
  const diffRun = $('diff-run');
  const diffClear = $('diff-clear');
  const sceneFilterChip = $('scene-filter-chip');
  const clearSelection = $('frame-selection-clear');
  const importButton = $('stored-import');
  const deleteAllButton = $('stored-delete-all');
  const DELETE_ALL_CONFIRM_MS = 4000;
  let deleteAllArmedUntil = 0;

  function resetDeleteAllButton() {
    deleteAllArmedUntil = 0;
    if (!deleteAllButton) return;
    deleteAllButton.textContent = 'Delete all captures';
    deleteAllButton.classList.remove('is-armed');
  }

  async function deleteAllStoredCaptures() {
    const captures = storedCaptures.slice();
    deleteAllButton.disabled = true;
    let deleted = 0;
    const failures = [];
    for (const capture of captures) {
      try {
        const result = await hostRequest({ command: 'deleteStoredCapture', captureId: capture.captureId, hostApi: captureApi(capture.captureId) });
        if (result?.removed) deleted++;
      } catch (error) {
        failures.push(describeHostFailure(error, 'Could not delete stored capture'));
      }
    }
    resetCurrentCapture();
    await refreshStored();
    deleteAllButton.disabled = false;
    setStatus(
      failures.length
        ? `Deleted ${deleted} of ${captures.length} stored captures — ${failures[0]}`
        : `Deleted all ${deleted} stored capture(s)`
    );
  }

  deleteAllButton?.addEventListener('click', () => {
    if (!storedCaptures.length) return;
    if (Date.now() > deleteAllArmedUntil) {
      deleteAllArmedUntil = Date.now() + DELETE_ALL_CONFIRM_MS;
      deleteAllButton.textContent = `Confirm: delete ${storedCaptures.length} capture(s)`;
      deleteAllButton.classList.add('is-armed');
      setTimeout(() => {
        if (Date.now() >= deleteAllArmedUntil) resetDeleteAllButton();
      }, DELETE_ALL_CONFIRM_MS);
      return;
    }
    resetDeleteAllButton();
    void deleteAllStoredCaptures();
  });
  const importFileInput = $('stored-import-file');
  const frameStrip = $('frame-strip');
  const frameStripTitle = $('frame-strip-title');
  const expandedPassKeys = new Set();
  let sideBySideDiff = null;

  function formatMs(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0 ms';
    return `${ms >= 10 ? Math.round(ms) : Math.round(ms * 100) / 100} ms`;
  }

  function renderFrameStrip() {
    if (!frameStrip || !frameStripTitle) return;
    if (!currentView || !currentView.events?.length) {
      frameStrip.hidden = true;
      return;
    }
    frameStrip.hidden = false;
    const gpu = currentGpuTimings;
    const effectiveCommands = gpu
      ? currentView.commands.map((command) => ({ ...command }))
      : currentView.commands;
    if (gpu) {
      for (const event of currentView.events) {
        const gpuMs = gpu[event.eid];
        if (gpuMs != null) effectiveCommands[event.commandIndex].durationMs = gpuMs;
      }
    }
    const { totalMs, timedEvents } = buildFrameCostGroups(currentView.events, effectiveCommands);
    const source = gpu ? 'GPU' : timedEvents ? 'CPU' : 'untimed';
    frameStripTitle.textContent =
      `${source} ${formatMs(totalMs)} · ${currentView.events.length} events${timedEvents ? ` · ${timedEvents} timed` : ''}`;

    const northStarPanel = frameStrip.querySelector('.frame-strip-body');

    const annotated = buildPassGroups(currentView.events, effectiveCommands);
    const hasAnnotations = annotated.some((pass) => pass.key !== 'unattributed');
    const frameLabel = currentView.frames?.[0]?.label || 'Frame';
    const passes = hasAnnotations
      ? annotated
      : (() => {
          const unattributed = annotated.find((pass) => pass.key === 'unattributed');
          const events = currentView.events ?? [];
          const ticks = unattributed?.ticks ?? events.map((event) => ({
            eid: event.eid,
            durationMs: effectiveCommands[event.commandIndex]?.durationMs,
            kind: event.kind
          }));
          return [{
            key: 'frame',
            name: frameLabel,
            index: null,
            durationMs: ticks.reduce((sum, tick) => sum + (Number.isFinite(tick.durationMs) ? tick.durationMs : 0), 0),
            eventCount: events.length,
            drawCount: ticks.filter((tick) => tick.kind === 'draw').length,
            clearCount: ticks.filter((tick) => tick.kind === 'clear').length,
            firstEid: events[0]?.eid ?? null,
            lastEid: events.at(-1)?.eid ?? null,
            ticks
          }];
        })();
    const palette = ['#ffb86c', '#7ee787', '#60a5fa', '#f0a6ca', '#e2c044'];

    for (const pass of passes) pass.steps = buildStepGroups(pass.ticks);

    {
      const regions = computeRegionLayout(passes);

      const eventBars = [];
      for (const pass of passes) {
        for (const tick of pass.ticks) {
          eventBars.push(
            `<span class="frame-event-bar ${frameEventBarClass(tick.kind)}" data-eid="${tick.eid}" data-tooltip="EID ${tick.eid} · ${tick.kind} · ${gpu && gpu[tick.eid] != null ? `GPU ${formatMs(tick.durationMs)}` : Number.isFinite(tick.durationMs) ? `CPU ${formatMs(tick.durationMs)}` : 'not timed'}"></span>`
          );
        }
      }

      const regionHtml = regions
        .map(({ pass, left, width }) => {
          const color = palette[pass.position % palette.length];
          const isPostProcess = pass.kind === 'postprocess';
          const isUnattributed = pass.key === 'unattributed';
          const canExpand = pass.steps.length > 1;
          const isExpanded = canExpand && expandedPassKeys.has(pass.key);
          const fxBadge = isPostProcess ? '<span class="frame-region-fx" title="Three.js post-processing effect">FX</span>' : '';
          const expandToggle = canExpand ? `<span class="frame-region-expand">${isExpanded ? '▾' : '▸'}</span>` : '';
          const nameLabel = isUnattributed ? '' : `<span class="frame-region-name">${escapeHtml(pass.name)}</span>`;
          const tooltip = isPostProcess
            ? `Post-processing effect · ${escapeHtml(pass.name)} · ${formatMs(pass.durationMs)} · ${pass.eventCount} events — click to jump`
            : `${escapeHtml(pass.name)} · ${formatMs(pass.durationMs)} · ${pass.eventCount} events — click to jump`;
          const expandAttr = canExpand ? ` data-pass-key="${escapeHtml(pass.key)}"` : '';
          const regionTooltip = canExpand
            ? `${isExpanded ? 'Collapse' : 'Expand'} ${pass.steps.length} internal steps · ${tooltip}`
            : tooltip;
          return `<div class="frame-region${isPostProcess ? ' frame-region--postprocess' : ''}" style="left:${left}%;width:${width}%;--region-color:${color}" data-last-eid="${pass.lastEid}"${expandAttr} data-tooltip="${regionTooltip}">
            ${fxBadge}
            ${expandToggle}
            ${nameLabel}
            <span class="frame-region-meta">${formatMs(pass.durationMs)}</span>
          </div>`;
        })
        .join('');

      let stepPosition = 0;
      const stepRegionHtml = regions
        .filter(({ pass }) => pass.steps.length > 1 && expandedPassKeys.has(pass.key))
        .flatMap(({ pass, left: parentLeft, width: parentWidth }) =>
          computeRegionLayout(pass.steps).map(({ pass: step, left, width }) => {
            const color = palette[stepPosition++ % palette.length];
            const subLeft = parentLeft + (parentWidth * left) / 100;
            const subWidth = (parentWidth * width) / 100;
            const tooltip = `${escapeHtml(pass.name)} · ${escapeHtml(step.name)} · ${formatMs(step.durationMs)} · ${step.eventCount} events — click to jump`;
            return `<div class="frame-region frame-region--step" style="left:${subLeft}%;width:${subWidth}%;--region-color:${color}" data-last-eid="${step.lastEid}" data-tooltip="${tooltip}">
              <span class="frame-region-name">${escapeHtml(step.name)}</span>
            </div>`;
          })
        )
        .join('');
      const stepsRow = stepRegionHtml
        ? `<div class="frame-timeline-row frame-timeline-steps">${stepRegionHtml}</div>`
        : '';

      northStarPanel.innerHTML = `<div class="frame-timeline"><div class="frame-timeline-row frame-timeline-regions">${regionHtml}</div>${stepsRow}<div class="frame-timeline-row frame-timeline-events">${eventBars.join('')}</div></div>`;
    }

    for (const region of northStarPanel.querySelectorAll('.frame-timeline-regions .frame-region')) {
      const passKey = region.dataset.passKey;
      const lastEid = Number(region.dataset.lastEid);
      region.addEventListener('click', () => {
        if (passKey != null) {
          if (expandedPassKeys.has(passKey)) expandedPassKeys.delete(passKey);
          else expandedPassKeys.add(passKey);
          renderFrameStrip();
          return;
        }
        if (Number.isInteger(lastEid)) void selectEvent(lastEid);
      });
    }
    for (const region of northStarPanel.querySelectorAll('.frame-timeline-steps .frame-region')) {
      const lastEid = Number(region.dataset.lastEid);
      region.addEventListener('click', () => {
        if (Number.isInteger(lastEid)) void selectEvent(lastEid);
      });
    }
    for (const bar of northStarPanel.querySelectorAll('.frame-event-bar')) {
      const eid = Number(bar.dataset.eid);
      bar.addEventListener('click', (event) => {
        event.stopPropagation();
        if (Number.isInteger(eid)) void selectEvent(eid);
      });
    }
  }

  if (metadataFold) {
    try {
      metadataFold.open = localStorage.getItem('ispettore.metadataFoldOpen') === '1';
    } catch (_) {
      metadataFold.open = false;
    }
    metadataFold.addEventListener('toggle', () => {
      try {
        localStorage.setItem('ispettore.metadataFoldOpen', metadataFold.open ? '1' : '0');
      } catch (_) {
        /* persistence is best effort */
      }
    });
  }

  function setInspectionBuffer(bufferType) {
    inspectionBuffer = bufferType;
    document.querySelectorAll('.inspection-tabs [data-inspect]').forEach((button) => {
      button.setAttribute('aria-selected', button.dataset.inspect === bufferType ? 'true' : 'false');
    });
  }

  document.querySelectorAll('#view-frame .inspection-tabs [data-inspect]').forEach((button) => {
    button.addEventListener('click', () => {
      setInspectionBuffer(button.dataset.inspect);
      if (selectedEid != null) void selectEvent(selectedEid);
      else if (selectedCommandIndex != null) void selectCommand(selectedCommandIndex);
    });
  });

  function contextLabel(context) {
    const api = context.api === 'webgpu' ? 'webgpu' : 'webgl';
    const version = context.contextInfo?.version;
    const prefix = api === 'webgpu' ? 'WebGPU' : version ? `WebGL ${version}` : 'WebGL';
    if (context.installWarning) return `${prefix} · ${context.contextId ?? '?'} · capture hook failed`;
    if (api === 'webgpu') {
      const size = context.configuration ? '' : ' · unconfigured';
      return `${prefix} · ${context.commandCount} commands · ${context.frames?.length ?? 0} frames${size}`;
    }
    const info = context?.contextInfo ?? {};
    const latestResize = context?.resizes?.length ? context.resizes[context.resizes.length - 1] : null;
    const width = latestResize?.drawingBufferWidth ?? latestResize?.canvasWidth ?? info.drawingBufferWidth ?? info.canvasWidth;
    const height = latestResize?.drawingBufferHeight ?? latestResize?.canvasHeight ?? info.drawingBufferHeight ?? info.canvasHeight;
    const size = `${width ?? '?'}×${height ?? '?'}`;
    const overflow = context.overflow ? ' · overflow' : '';
    const bytes = context.capturedBytes != null ? ` · ${formatBytes(context.capturedBytes)} raw` : '';
    return `${prefix} · ${size} · ${context.commandCount} commands · ${context.frames?.length ?? 0} frames${bytes}${overflow}`;
  }

  function selectedContext() {
    return contexts.find((context) => context.contextId === selectedContextId) ?? null;
  }

  function renderContextSelect() {
    if (!contextSelect) return;
    const previous = selectedContextId;
    contextSelect.innerHTML = '';
    for (const context of contexts) {
      const option = document.createElement('option');
      option.value = context.contextId;
      option.textContent = contextLabel(context);
      contextSelect.appendChild(option);
    }
    if (selectedContextId && contexts.some((context) => context.contextId === selectedContextId)) {
      contextSelect.value = selectedContextId;
    } else if (previous && !contexts.some((context) => context.contextId === previous)) {
      selectedContextId = contexts[0]?.contextId ?? null;
      contextSelect.value = selectedContextId ?? '';
    } else if (!selectedContextId) {
      selectedContextId = contexts[0]?.contextId ?? null;
      contextSelect.value = selectedContextId ?? '';
    }
    const current = selectedContext();
    if (storeButton) {
      storeButton.disabled = !current || Boolean(current.installWarning);
      storeButton.setAttribute(
        'data-tooltip',
        current?.api === 'webgpu'
          ? 'Capture frame waits for this WebGPU context\'s next completed animation frame and stores it — no page reload. The capture is inspected in the extension\'s isolated WebGPU host.'
          : 'Capture frame waits for the next complete animation frame and stores it — no page reload. Stored captures are inspected in the extension, never the live page.'
      );
    }
    if (!contexts.length) setStatus('No WebGL or WebGPU context found');
  }

  contextSelect?.addEventListener('change', (event) => {
    selectedContextId = event.target.value;
    renderContextSelect();
  });

  refreshButton?.addEventListener('click', async () => {
    setStatus('Refreshing contexts…');
    try {
      let result = await sendPanelCommand('GET_WEBGL_CONTEXTS');
      if (!result?.ok) {
        setStatus(formatError(result?.error, 'Could not refresh contexts'));
        return;
      }
      for (let attempt = 1; attempt < CONTEXT_POLL_ATTEMPTS && !result.contexts?.length; attempt++) {
        setStatus('Refreshing contexts… (waiting for the page to create one)');
        await delay(CONTEXT_POLL_INTERVAL_MS);
        result = await sendPanelCommand('GET_WEBGL_CONTEXTS');
        if (!result?.ok) {
          setStatus(formatError(result?.error, 'Could not refresh contexts'));
          return;
        }
      }
      setContexts(result.contexts);
      if (result.stalePageScript) {
        setStatus('This tab is running an older Ispettore page script — reload the page to use the latest capture fixes');
        return;
      }
      setStatus(
        contexts.length
          ? `Found ${contexts.length} context(s) (${contexts.filter((context) => context.api === 'webgpu').length} WebGPU, ${contexts.filter((context) => context.api !== 'webgpu').length} WebGL)`
          : 'No WebGL or WebGPU context found'
      );
    } catch (error) {
      setStatus(formatError(error, 'Could not refresh contexts'));
    }
  });

  function showCaptureBusy() {
    const label = storeButton.textContent;
    const startedAt = Date.now();
    storeButton.classList.add('is-busy');
    storeButton.setAttribute('aria-busy', 'true');
    const render = () => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      storeButton.innerHTML = `<span class="capture-hourglass" aria-hidden="true">⌛</span> Capturing…${seconds ? ` ${seconds} s` : ''}`;
    };
    render();
    const timer = setInterval(render, 1000);
    return () => {
      clearInterval(timer);
      storeButton.classList.remove('is-busy');
      storeButton.removeAttribute('aria-busy');
      storeButton.textContent = label;
    };
  }

  storeButton?.addEventListener('click', async () => {
    const context = selectedContext();
    if (!context) return;
    const api = context.api === 'webgpu' ? 'webgpu' : 'webgl';
    storeButton.disabled = true;
    const hideBusy = showCaptureBusy();
    setStatus(`Capturing the next ${api === 'webgpu' ? 'WebGPU' : 'WebGL'} frame — this can take a few seconds…`);
    const waitingHint = setTimeout(() => {
      setStatus('Still waiting for a frame — if the page only renders on interaction, drag or zoom its canvas');
    }, ON_DEMAND_HINT_DELAY_MS);
    let busy = true;
    const endBusy = () => {
      if (!busy) return;
      busy = false;
      clearTimeout(waitingHint);
      hideBusy();
      storeButton.disabled = !selectedContext();
    };
    try {
      const result = await sendPanelCommand('CAPTURE_WEBGL_FRAME', { api });
      // The capture is stored at this point; opening it (a WebGPU inspection can take a while) is
      // separate work and must not keep the button busy or let the waiting hint fire.
      endBusy();
      if (!result?.ok) {
        setStatus(formatError(result?.error, 'Could not capture the frame'));
        return;
      }
      const refreshed = await sendPanelCommand('GET_WEBGL_CONTEXTS');
      if (refreshed?.ok) {
        setContexts(refreshed.contexts);
      }
      setStatus(
        `Captured frame ${result.captureId} (${result.commandCount} commands, ${formatBytes(result.byteSize)}${
          result.serializeMs != null ? ` · serialized in ${result.serializeMs} ms` : ''
        })`
      );
      await refreshStored();
      await openCapture(result.captureId);
    } catch (error) {
      setStatus(formatError(error, 'Could not capture the frame'));
    } finally {
      endBusy();
    }
  });

  clearSelection?.addEventListener('click', async () => {
    try {
      await hostRequest({ command: 'restart', hostApi: currentCaptureApi });
      selectedEid = null;
      selectedFrameId = null;
      selectedCommandIndex = null;
      renderRangeList();
      renderInspection(null, { placeholder: 'Selection cleared — select an event.' });
      clearSelection.hidden = true;
    } catch (error) {
      setStatus(formatError(error, 'Could not clear the selection'));
    }
  });

  function captureTime(capture) {
    const value = capture?.capturedAt ?? capture?.source?.capturedAt;
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unknown time';
  }

  function captureSource(capture) {
    const value = capture?.source?.url;
    if (!value) return 'Unknown page';
    try {
      const url = new URL(value);
      return `${url.hostname}${url.pathname}`;
    } catch (_) {
      return String(value);
    }
  }

  function resetCurrentCapture() {
    currentCaptureId = null;
    currentCaptureApi = 'webgl';
    currentView = null;
    currentMeta = null;
    currentEventIndex = null;
    currentGpuTimings = null;
    selectedEid = null;
    selectedFrameId = null;
    selectedCommandIndex = null;
    if (metadata) {
      metadata.hidden = true;
      metadata.innerHTML = '';
    }
    if (frameStrip) frameStrip.hidden = true;
    if (rangeList) rangeList.innerHTML = '<li class="empty">Select a stored capture to inspect it.</li>';
    if (commandList) commandList.innerHTML = '';
    if (commandsPanel) commandsPanel.hidden = true;
    if (details) details.hidden = true;
    if (eventLabel) eventLabel.textContent = '';
    if (clearSelection) clearSelection.hidden = true;
    renderInspection(null, {});
  }

  async function deleteStoredCapture(captureId) {
    const wasCurrent = currentCaptureId === captureId;
    try {
      const result = await hostRequest({ command: 'deleteStoredCapture', captureId, hostApi: captureApi(captureId) });
      if (!result?.removed) throw new Error('Capture was already removed');
      if (wasCurrent) resetCurrentCapture();
      await refreshStored();
      if (wasCurrent && storedCaptures.length) await openCapture(storedCaptures[0].captureId);
      setStatus(`Deleted stored capture ${captureId}`);
    } catch (error) {
      await refreshStored();
      if (wasCurrent && !storedCaptures.some((capture) => capture.captureId === captureId)) {
        resetCurrentCapture();
        if (storedCaptures.length) await openCapture(storedCaptures[0].captureId);
      }
      setStatus(describeHostFailure(error, 'Could not delete stored capture'));
    }
  }

  function renderStoredList() {
    if (!storedList) return;
    if (deleteAllButton) deleteAllButton.hidden = !storedCaptures.length;
    storedList.innerHTML = '';
    if (!storedCaptures.length) {
      storedList.innerHTML =
        '<li class="empty">No stored captures yet — press Capture frame in the Frame tab.</li>';
      if (storedNote) storedNote.textContent = '';
      return;
    }
    if (storedNote) {
      storedNote.textContent = `${storedCaptures.length} capture(s) · survives page navigation`;
    }
    for (const [index, capture] of storedCaptures.entries()) {
      const li = document.createElement('li');
      const selected = capture.captureId === currentCaptureId;
      const byteSize = formatBytes(capture.meta?.byteSize);
      const commands = capture.meta?.commandCount != null ? `${capture.meta.commandCount} cmds` : '';
      const badges = [index === 0 ? '<span class="stored-badge">Latest</span>' : '', selected ? '<span class="stored-badge stored-badge--open">Open</span>' : ''].join('');
      li.innerHTML = `<span class="stored-main"><span class="stored-title"><span class="stored-id">${escapeHtml(capture.captureId)}</span>${badges}</span><span class="stored-meta">${escapeHtml(captureTime(capture))} · ${escapeHtml(captureSource(capture))} · ${escapeHtml(commands)} · ${escapeHtml(byteSize)}</span></span><span class="stored-actions"><button type="button" class="stored-export panel-action" data-tooltip="Export capture as JSON file">Export</button><button type="button" class="stored-delete panel-action" data-tooltip="Delete stored capture">Delete</button></span>`;
      li.classList.add('stored-item');
      if (selected) li.classList.add('selected');
      li.addEventListener('click', () => void openCapture(capture.captureId));
      li.querySelector('.stored-delete')?.addEventListener('click', (event) => {
        event.stopPropagation();
        void deleteStoredCapture(capture.captureId);
      });
      li.querySelector('.stored-export')?.addEventListener('click', (event) => {
        event.stopPropagation();
        void exportStoredCapture(capture.captureId);
      });
      storedList.appendChild(li);
    }
  }

  async function exportStoredCapture(captureId) {
    setStatus(`Exporting capture ${captureId}…`);
    try {
      const result = await hostRequest({ command: 'downloadStoredCapture', captureId, hostApi: captureApi(captureId) });
      if (!result?.ok) throw new Error(result?.error || 'The capture host could not export this capture');
      setStatus(`Exported capture to ${result.filename}`);
    } catch (error) {
      setStatus(describeHostFailure(error, 'Could not export the stored capture'));
    }
  }

  async function importCaptureFile(file) {
    if (!file) return;
    setStatus(`Importing ${file.name}…`);
    let data;
    try {
      data = await file.text();
    } catch (error) {
      setStatus(`Could not read ${file.name}: ${describeHostFailure(error)}`);
      return;
    }
    try {
      let hostApi = 'webgl';
      try {
        if (JSON.parse(data)?.schema === 'ispettore-webgpu-capture') hostApi = 'webgpu';
      } catch (_) {}
      const result = await hostRequest({ command: 'importCapture', data, hostApi });
      if (!result?.ok) throw new Error(result?.error || 'The import was rejected by the capture host');
      await refreshStored();
      await openCapture(result.captureId);
      setStatus(`Imported capture ${result.captureId}`);
    } catch (error) {
      setStatus(describeHostFailure(error, 'Could not import the capture file'));
    }
  }

  importButton?.addEventListener('click', () => {
    importFileInput?.click();
  });

  importFileInput?.addEventListener('change', () => {
    const file = importFileInput.files?.[0] ?? null;
    importFileInput.value = '';
    void importCaptureFile(file);
  });

  async function refreshStored() {
    try {
      const result = await hostRequest({ command: 'listStoredCaptures' });
      storedCaptures = [...(result.captures ?? [])].sort((a, b) => {
        const timeA = Date.parse(a.capturedAt ?? a.source?.capturedAt ?? '') || 0;
        const timeB = Date.parse(b.capturedAt ?? b.source?.capturedAt ?? '') || 0;
        return timeB - timeA;
      });
    } catch (error) {
      storedCaptures = [];
      setStatus(describeHostFailure(error, 'Capture host unavailable'));
    }
    renderStoredList();
    renderDiffSelects();
  }

  function renderDiffSelects() {
    if (!diffSelectA || !diffSelectB) return;
    const previousA = diffSelectA.value;
    const previousB = diffSelectB.value;
    for (const select of [diffSelectA, diffSelectB]) {
      select.innerHTML = '';
      for (const capture of storedCaptures) {
        const option = document.createElement('option');
        option.value = capture.captureId;
        option.textContent = capture.captureId;
        select.appendChild(option);
      }
    }
    const hasPreviousA = previousA && storedCaptures.some((capture) => capture.captureId === previousA);
    const hasPreviousB = previousB && storedCaptures.some((capture) => capture.captureId === previousB);
    if (hasPreviousA) {
      diffSelectA.value = previousA;
    }
    if (hasPreviousB) {
      diffSelectB.value = previousB;
    }
    if (storedCaptures.length >= 2) {
      const captureIds = storedCaptures.map((capture) => capture.captureId);
      let nextA = hasPreviousA ? previousA : null;
      let nextB = hasPreviousB ? previousB : null;
      if (!nextA) nextA = [...captureIds].reverse().find((captureId) => captureId !== nextB) ?? captureIds.at(-1);
      if (!nextB) nextB = captureIds.find((captureId) => captureId !== nextA) ?? captureIds[0];
      if (nextA === nextB) {
        nextA = captureIds.at(-1);
        nextB = captureIds[0];
      }
      diffSelectA.value = nextA;
      diffSelectB.value = nextB;
    } else if (storedCaptures.length > 0) {
      diffSelectA.value = storedCaptures[0].captureId;
      diffSelectB.value = storedCaptures[0].captureId;
    }
    const canDiff = storedCaptures.length >= 2;
    if (diffBar) diffBar.hidden = !canDiff;
    if (diffRun) diffRun.disabled = !canDiff;
  }

  diffRun?.addEventListener('click', () => {
    runDiff(diffSelectA.value, diffSelectB.value).catch((error) => {
      showDiffMessage(`The diff could not be shown: ${escapeHtml(error?.message ?? String(error))}`);
      setStatus('Diff failed');
    });
  });

  function showDiffMessage(html) {
    sideBySideDiff?.destroy();
    sideBySideDiff = null;
    if (!diffPanel) return;
    diffPanel.hidden = false;
    if (diffClear) diffClear.hidden = false;
    diffPanel.innerHTML = `<h3 class="capture-pane-title">Capture diff</h3><p class="preview-placeholder diff-message">${html}</p>`;
  }

  function clearDiffPanel() {
    sideBySideDiff?.destroy();
    sideBySideDiff = null;
    if (!diffPanel) return;
    diffPanel.hidden = true;
    diffPanel.innerHTML = '';
  }

  diffClear?.addEventListener('click', () => {
    clearDiffPanel();
    if (diffClear) diffClear.hidden = true;
  });

  function renderMetadata() {
    if (!metadata || !currentView) return;
    const view = currentView;
    const meta = currentMeta ?? {};
    const context = view.context ?? {};
    const attributes = context.attributes ?? {};
    const limits = context.capabilities ?? {};
    const extensions = Array.isArray(context.extensions) ? context.extensions : [];
    const frames = view.frames ?? [];
    const overflow = context.overflow ?? null;

    const resizeTracking = context.resizeTracking
      ? ` · resize tracking ${context.resizeTracking.complete ? 'complete' : 'incomplete'}`
      : '';
    const retained = context.recordedFromContextCreation
      ? `${view.commands.length} commands since context creation (${frames.length} frame(s), ${view.events?.length ?? 0} events)`
      : `${view.commands.length} commands`;

    metadata.innerHTML = `
      <div class="capture-metadata-row">
        <div class="metadata-inspection-status">${inspectionStatusHtml(view.inspectionStatus)}</div>
        <div class="metadata-facts">
          <dl>
            <dt>Size</dt><dd>${context.width ?? '?'}×${context.height ?? '?'}${context.drawingBuffer ? ` drawing buffer ${context.drawingBuffer.width ?? '?'}×${context.drawingBuffer.height ?? '?'}` : ''}</dd>
            <dt>Attributes</dt><dd>${attributesHtml(attributes)}</dd>
            <dt>Retained history</dt><dd>${retained}</dd>
            <dt>Package</dt><dd>${escapeHtml(view.schema ?? '?')} v${view.version ?? '?'} · ${formatBytes(meta.byteSize)} serialized · ${formatBytes(view.blobBytes)} blob bytes · ${view.blobCount} blobs</dd>
            <dt>Required extensions</dt><dd>${extensionsList(extensions)}${resizeTracking}</dd>
            <dt>Limits</dt><dd>${Object.keys(limits).length} capability limit(s) queried</dd>
          </dl>
          ${overflowHtml(overflow)}
        </div>
      </div>`;
    metadata.hidden = false;
  }

  function eventSearchHaystack(event) {
    const command = currentView.commands?.[event.commandIndex];
    const semantic = command?.semantic;
    return [
      event.eid,
      event.label,
      event.kind,
      event.op,
      semantic?.object?.name,
      semantic?.object?.uuid,
      semantic?.material?.label,
      semantic?.pass?.name
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function renderRangeList() {
    if (!rangeList || !currentView) return;
    rangeList.innerHTML = '';
    let events = currentView.events ?? [];

    if (sceneFilterUuid || sceneFilterName) {
      events = events.filter((event) => {
        const cmd = currentView.commands?.[event.commandIndex];
        const obj = cmd?.semantic?.object;
        if (!obj) return false;
        if (sceneFilterUuid && (obj.uuid === sceneFilterUuid || currentEventIndex?.byObjectUuid.get(sceneFilterUuid)?.has(event.eid))) {
          return true;
        }
        if (sceneFilterName && obj.name === sceneFilterName) {
          return true;
        }
        return false;
      });
    }
    const query = search.trim().toLowerCase();
    if (query) events = events.filter((event) => eventSearchHaystack(event).includes(query));

    if (!events.length) {
      rangeList.innerHTML = '<li class="empty">No GPU events match the filter.</li>';
      return;
    }

    for (const event of events) {
      const li = document.createElement('li');
      li.dataset.eid = String(event.eid);
      const command = currentView.commands[event.commandIndex];
      const objectLabel = command?.semantic?.object?.name;
      li.innerHTML = `<span class="range-kind ${kindClass(event.kind)}">${escapeHtml(event.kind)}</span><span class="draw-item">EID ${event.eid} · ${escapeHtml(objectLabel || event.label)}</span><span class="range-meta">CMD ${event.commandIndex} · ${escapeHtml(event.op)}</span>`;
      li.classList.add('range-item');
      if (sceneFilterUuid) li.classList.add('scene-match');
      if (selectedEid === event.eid) li.classList.add('selected');
      li.addEventListener('click', () => void selectEvent(event.eid));
      rangeList.appendChild(li);
    }
  }

  searchInput?.addEventListener('input', (event) => {
    search = event.target.value;
    renderRangeList();
    renderCommandList();
  });

  sortSelect?.addEventListener('change', (event) => {
    sort = event.target.value;
    renderRangeList();
  });

  function commandSearchHaystack(command) {
    return [String(command.commandIndex), command.op, summarizeCommand(command).summary].join(' ').toLowerCase();
  }

  function renderCommandList() {
    if (!commandsPanel || !currentView) return;
    const frame = currentView.frames?.find((entry) => entry.frameId === selectedFrameId);
    if (!frame || selectedCommandIndex == null) {
      commandsPanel.hidden = true;
      commandList.innerHTML = '';
      return;
    }
    // Scope to the state-setup commands that produced the selected event: everything since the
    // previous event in this frame (or the frame start, for the first event), through the
    // selected command itself. Showing the whole frame's commands here made every EID look
    // identical, since one capture is normally a single frame.
    const frameEvents = (currentView.events ?? []).filter((event) => event.frameId === frame.frameId);
    let rangeStart = frame.startCommandIndex;
    for (const event of frameEvents) {
      if (event.commandIndex >= selectedCommandIndex) break;
      rangeStart = event.commandIndex + 1;
    }
    const rangeEnd = Math.min(selectedCommandIndex + 1, frame.endCommandIndex);

    let commands = [];
    for (let index = rangeStart; index < rangeEnd; index++) {
      commands.push(currentView.commands[index]);
    }
    const query = search.trim().toLowerCase();
    if (query) commands = commands.filter((command) => commandSearchHaystack(command).includes(query));
    const total = commands.length;
    const shown = commands.slice(0, 500);

    commandList.innerHTML = '';
    for (const command of shown) {
      const summary = summarizeCommand(command);
      const li = document.createElement('li');
      li.dataset.commandIndex = String(command.commandIndex);
      const failed = command.failed
        ? '<span class="command-failed">FAILED</span>'
        : isDrawOp(command.op)
          ? '<span class="command-draw">DRAW</span>'
          : '';
      const status = command.status && command.status !== 'valid'
        ? `<span class="command-status command-status--${command.status}">${command.status}</span>`
        : '';
      li.innerHTML = `<span class="command-index">CMD ${command.commandIndex}</span> ${failed}${status}<span class="command-summary">${escapeHtml(summary.summary)}</span>`;
      if (selectedCommandIndex === command.commandIndex) li.classList.add('selected');
      li.addEventListener('click', () => void selectCommand(command.commandIndex));
      commandList.appendChild(li);
    }
    commandsPanel.hidden = false;
    const note = document.createElement('li');
    note.className = 'empty';
    note.textContent =
      total > shown.length
        ? `Showing first ${shown.length} of ${total} commands leading to this event — refine the search to narrow.`
        : `${total} command(s) since the previous event · ${frame.frameId}`;
    commandList.appendChild(note);
  }

  function renderPipelineTab(result) {
    lastInspectionResult = result;
    const webgpu = result.details?.api === 'webgpu';
    detailsProgram = webgpu ? webGpuShaderProgram(result.details) : result.program ?? null;
    const html = webgpu
      ? renderWebGpuPipelineStages(result, { stage: pipelineStage })
      : renderPipelineStages(result, {
          stage: pipelineStage,
          commandOp: (index) => currentView?.commands?.[index]?.op
        });
    viewport.innerHTML =
      html ??
      '<p class="preview-placeholder">Pipeline state is captured for draw, clear, blit, and copy events — select one in the browser events list.</p>';
  }

  function renderDetailsTab(result) {
    detailsProgram = result.program ?? null;
    const html = renderEventDetails(result);
    viewport.innerHTML =
      html ??
      '<p class="preview-placeholder">Details are captured for draw, clear, blit, and copy events — select one in the browser events list.</p>';
  }

  function renderPreview(result) {
    const color = result.color;
    if (!color?.preview) {
      viewport.innerHTML = `<p class="preview-placeholder">${escapeHtml(color?.reason ?? result.inspectionStatus?.reasons?.[0] ?? 'No preview was captured for this event.')}</p>`;
      return;
    }
    const meta = `luma ${color.min}–${color.max} · range ${color.range} · hash ${color.hash.toString(16)}${result.colorTarget === 'framebuffer' ? ' · render target' : ''}`;
    viewport.innerHTML = `<div class="preview-color-wrap"><img class="preview-color-img" src="${color.preview}" alt="color after CMD ${result.selectedCommandIndex}" /><span class="preview-color-size muted">color after CMD ${result.selectedCommandIndex} · ${result.width}×${result.height} · ${meta}</span></div>`;
  }

  function renderInspection(result, options = {}) {
    if (options.placeholder) {
      viewport.innerHTML = `<p class="preview-placeholder">${options.placeholder}</p>`;
      return;
    }
    if (!result) {
      viewport.innerHTML = '<p class="preview-placeholder">Select an event to inspect it.</p>';
      return;
    }
    if (!result.ok) {
      viewport.innerHTML = `<p class="preview-placeholder">Could not load this event: ${escapeHtml(result.error || 'unknown error')}</p>`;
      return;
    }

    const level = result.inspectionStatus?.level ?? 'supported';
    if (level === 'unsupported') {
      const reasons = Array.isArray(result.inspectionStatus?.reasons) ? result.inspectionStatus.reasons : [];
      viewport.innerHTML = `<div class="preview-unsupported">
        <p>Inspection reached an unsupported path — no preview is shown so an apparently valid frame is never presented.</p>
        <ul>${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>
      </div>`;
      return;
    }

    if (inspectionBuffer === 'pipeline') {
      renderPipelineTab(result);
      return;
    }
    if (inspectionBuffer === 'details') {
      renderDetailsTab(result);
      return;
    }
    renderPreview(result);
  }

  async function inspectEvent(options = {}) {
    const serial = ++inspectionSerial;
    // A visible elapsed time shows the difference between a slow host and a frozen panel.
    const startedAt = Date.now();
    const showLoading = () => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      viewport.innerHTML = `<p class="preview-placeholder">Loading the event…${seconds ? ` ${seconds} s` : ''}</p>`;
    };
    showLoading();
    const loadingTimer = setInterval(() => {
      if (serial === inspectionSerial && viewport.querySelector('.preview-placeholder')?.textContent.startsWith('Loading the event')) showLoading();
      else clearInterval(loadingTimer);
    }, 1000);
    try {
      const describeOnly = currentCaptureApi === 'webgpu' && inspectionBuffer !== 'color';
      const payload = {
        command: describeOnly ? 'describeEvent' : 'inspect',
        captureId: currentCaptureId,
        hostApi: currentCaptureApi
      };
      if (options.eid != null) payload.eid = options.eid;
      if (options.commandIndex != null) payload.commandIndex = options.commandIndex;
      payload.bufferType = inspectionBuffer;
      const result = await hostRequest(payload);
      if (serial !== inspectionSerial) return;
      currentGpuTimings = result.timings ?? null;
      renderInspection(result, {});
      renderFrameStrip();
      if (clearSelection) clearSelection.hidden = false;
    } catch (error) {
      if (serial !== inspectionSerial) return;
      renderInspection(null, { placeholder: `Could not load this event: ${escapeHtml(describeHostFailure(error, 'Could not load this event'))}` });
    } finally {
      clearInterval(loadingTimer);
    }
  }

  function renderDetails(event) {
    if (!details) return;
    if (!event) {
      details.hidden = true;
      details.innerHTML = '';
      return;
    }
    const command = currentView.commands[event.commandIndex];
    const semantic = command?.semantic;
    details.hidden = false;
    details.innerHTML = `<dl>
      <div><dt>Event ID</dt><dd>EID ${event.eid}</dd></div>
      <div><dt>Kind</dt><dd>${escapeHtml(event.kind)}</dd></div>
      <div><dt>Operation</dt><dd>${escapeHtml(event.op)}</dd></div>
      <div><dt>Command</dt><dd>CMD ${event.commandIndex}</dd></div>
      <div><dt>Frame</dt><dd>${escapeHtml(event.frameId)}</dd></div>
      <div><dt>Object</dt><dd>${escapeHtml(semantic?.object?.name ?? '—')}</dd></div>
      <div><dt>Material</dt><dd>${escapeHtml(semantic?.material?.label ?? '—')}</dd></div>
      <div><dt>Pass</dt><dd>${escapeHtml(semantic?.pass?.name ?? '—')}</dd></div>
    </dl>`;
  }

  async function selectEvent(eid, options = {}) {
    if (!currentView) return;
    const event = currentEventIndex?.byEid.get(eid);
    if (!event) return;
    selectedEid = eid;
    selectedFrameId = event.frameId;
    selectedCommandIndex = event.commandIndex;
    renderRangeList();
    renderCommandList();
    rangeList
      .querySelector('.range-item.selected')
      ?.scrollIntoView({ block: 'nearest' });
    renderDetails(event);
    if (eventLabel) eventLabel.textContent = `EID ${eid} · ${event.kind} · CMD ${event.commandIndex}`;

    const level = currentView.inspectionStatus?.level ?? 'supported';
    if (level === 'unsupported') {
      renderInspection(null, {
        placeholder: `This capture is marked unsupported (${currentView.inspectionStatus.reasons?.length ?? 0} reason(s)) — no preview is shown.`
      });
      return;
    }
    await inspectEvent({ eid, bufferType: options.bufferType ?? inspectionBuffer });
  }

  async function selectCommand(commandIndex) {
    if (!currentView) return;
    if (!Number.isInteger(commandIndex) || commandIndex < 0 || commandIndex >= currentView.commands.length) return;
    const frame = currentView.frames?.find(
      (entry) => commandIndex >= entry.startCommandIndex && commandIndex < entry.endCommandIndex
    );
    const event = currentView.events?.find((entry) => entry.commandIndex === commandIndex);
    selectedFrameId = frame?.frameId ?? selectedFrameId;
    selectedEid = event?.eid ?? null;
    selectedCommandIndex = commandIndex;
    renderRangeList();
    renderCommandList();
    renderDetails(event ? currentEventIndex?.byEid.get(event.eid) : null);
    if (eventLabel) eventLabel.textContent = event ? `EID ${event.eid} · CMD ${commandIndex}` : `CMD ${commandIndex}`;
    await inspectEvent({ commandIndex });
  }

  async function openCapture(captureId) {
    try {
      const api = captureApi(captureId);
      const result = await hostRequest({ command: 'describeCapture', captureId, hostApi: api });
      currentCaptureId = captureId;
      currentCaptureApi = api;
      currentView = result.view;
      currentMeta = result.meta ?? null;
      currentEventIndex = buildEventIndex(currentView);
      currentGpuTimings = null;
      selectedEid = null;
      selectedFrameId = currentView.frames?.[0]?.frameId ?? null;
      selectedCommandIndex = null;
      await hostRequest({ command: 'loadCapture', captureId, hostApi: api });
      renderMetadata();
      renderFrameStrip();
      renderStoredList();
      renderRangeList();
      renderCommandList();
      renderInspection(null, { placeholder: 'Select an event to inspect it.' });

      const target = preferredPreviewEvent(currentView.events);
      if (target) await selectEvent(target.eid);
    } catch (error) {
      setStatus(describeHostFailure(error, `Could not open capture ${captureId}`));
    }
  }

  function setSceneFilter(uuid, name) {
    sceneFilterUuid = uuid ?? null;
    sceneFilterName = name ?? null;
    if (sceneFilterChip) {
      sceneFilterChip.hidden = !sceneFilterUuid;
      if (sceneFilterUuid) {
        sceneFilterChip.innerHTML = `Filtering draws for <strong>${escapeHtml(sceneFilterName || uuid)}</strong> <button id="scene-filter-clear" type="button" class="panel-action" data-tooltip="Clear scene filter">✕</button>`;
        sceneFilterChip.querySelector('#scene-filter-clear').addEventListener('click', () => setSceneFilter(null, null));
      } else {
        sceneFilterChip.innerHTML = '';
      }
    }
    renderRangeList();
  }

  function diffCaptureLabel(captureId) {
    const capture = storedCaptures.find((entry) => entry.captureId === captureId);
    return capture ? `${captureId} · ${captureTime(capture)} · ${captureSource(capture)}` : captureId;
  }

  async function runDiff(captureIdA, captureIdB) {
    if (!diffPanel) return;
    if (!captureIdA || !captureIdB) {
      showDiffMessage('Select two stored captures to compare.');
      return;
    }
    if (captureIdA === captureIdB) {
      showDiffMessage('Both selectors point to the same capture — pick two different captures to compare.');
      return;
    }
    const apiA = captureApi(captureIdA);
    const apiB = captureApi(captureIdB);
    if (apiA !== apiB) {
      showDiffMessage('These captures come from different graphics APIs (WebGL and WebGPU) and cannot be compared.');
      setStatus('Diff requires two captures from the same graphics API');
      return;
    }
    setStatus('Diffing captures…');
    let result;
    try {
      result = await hostRequest({ command: 'diff', captureIdA, captureIdB, hostApi: apiA });
    } catch (error) {
      const message = describeHostFailure(error, 'Unknown error');
      showDiffMessage(`The diff failed: ${escapeHtml(message)}`);
      setStatus(`Diff failed: ${message}`);
      return;
    }
    const diff = result?.diff;
    if (!diff?.commands || !diff.events) {
      showDiffMessage('The capture host returned no diff for these captures. Refresh the stored captures and try again.');
      setStatus('Diff failed');
      return;
    }
    const firstDivergence =
      diff.commands.firstDivergenceIndex == null ? 'none' : `CMD ${diff.commands.firstDivergenceIndex}`;
    const methodDelta = (diff.commands.methodDelta ?? [])
      .map((entry) => `${entry.key} ${entry.count > 0 ? '+' : ''}${entry.count}`)
      .join(', ');
    const removedEvents = diff.events.removed
      .map((event) => `EID ${event.eid} (${event.kind})`)
      .join(', ');
    const addedEvents = diff.events.added
      .map((event) => `EID ${event.eid} (${event.kind})`)
      .join(', ');
    sideBySideDiff?.destroy();
    sideBySideDiff = null;
    diffPanel.hidden = false;
    if (diffClear) diffClear.hidden = false;
    diffPanel.innerHTML = `
      <h3 class="capture-pane-title">Capture diff</h3>
      <details class="diff-summary">
        <summary>Summary · ${diff.commands.countA} → ${diff.commands.countB} commands · first divergence ${firstDivergence}</summary>
        <dl class="diff-dl">
          <dt>Command count</dt><dd>${diff.commands.countA} → ${diff.commands.countB} (${diff.commands.delta > 0 ? '+' : ''}${diff.commands.delta})</dd>
          <dt>First divergence</dt><dd>${firstDivergence}</dd>
          <dt>Frames</dt><dd>${diff.frames.countA} → ${diff.frames.countB}</dd>
          <dt>Events</dt><dd>${diff.events.countA} → ${diff.events.countB}</dd>
          <dt>Added events</dt><dd>${addedEvents || '—'}</dd>
          <dt>Removed events</dt><dd>${removedEvents || '—'}</dd>
          <dt>Changed events</dt><dd>${diff.events.changed.length} (${diff.events.changed.map((event) => `EID ${event.eid}`).join(', ') || '—'})</dd>
          <dt>Raw blob bytes</dt><dd>${formatBytes(diff.blobs.byteSizeA)} → ${formatBytes(diff.blobs.byteSizeB)}</dd>
          <dt>Context equal</dt><dd>${diff.context.equal ? 'yes' : `no (${diff.context.attributesChanged.join(', ') || 'size/overflow'} changed)`}</dd>
          <dt>Method delta</dt><dd>${methodDelta || 'none'}</dd>
        </dl>
      </details>
      <div class="diff-side-by-side"></div>`;
    const identical = diff.commands.delta === 0 && diff.commands.firstDivergenceIndex == null &&
      (diff.lines?.chunks ?? []).every((chunk) => chunk.tag === 'equal');
    if (identical) {
      diffPanel.insertAdjacentHTML(
        'beforeend',
        '<p class="preview-placeholder diff-message">The two captures record the same commands — there are no differences to show.</p>'
      );
    } else if (!diff.lines) {
      diffPanel.insertAdjacentHTML(
        'beforeend',
        '<p class="preview-placeholder diff-message">The command lists could not be aligned side by side; the summary above lists the differences.</p>'
      );
    }
    if (diff.lines && !identical) {
      const note = diff.lines.truncated
        ? 'Too many differences to align precisely — the differing region is shown as one change.'
        : diff.lines.coarse
          ? 'Aligned by command name — many argument changes.'
          : '';
      sideBySideDiff = renderSideBySideDiff(diffPanel.querySelector('.diff-side-by-side'), {
        linesA: diff.lines.a,
        linesB: diff.lines.b,
        chunks: diff.lines.chunks,
        labelA: diffCaptureLabel(captureIdA),
        labelB: diffCaptureLabel(captureIdB),
        note
      });
    }
    setStatus(identical ? 'Capture diff complete · no differences' : 'Capture diff complete');
  }

  function setContexts(next) {
    contexts = Array.isArray(next) ? next : [];
    renderContextSelect();
  }

  void refreshStored();

  return {
    setContexts,
    renderStoredList,
    refreshStored,
    openCapture,
    setSceneFilter,
    onViewActivated() {
      void refreshStored();
    }
  };
}
