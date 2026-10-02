import { highlightGlsl } from './glslHighlight.js';
import { escapeHtml } from './html.js';

const SHADER_TYPE_LABEL = { vertex: 'Vertex shader', fragment: 'Fragment shader', compute: 'Compute shader' };

function shaderStagesLabel(shaders) {
  const types = (shaders ?? []).map((shader) => shader.type ?? 'unknown');
  return types.length ? types.join(' + ') : 'no shaders';
}

export function programTitle(program) {
  return `${program.label || 'Program'} · ${shaderStagesLabel(program.shaders)}`;
}

function renderShaderSection(shader, truncatedAt) {
  const label = SHADER_TYPE_LABEL[shader.type] ?? shader.type;
  const truncated = truncatedAt != null && shader.source.length >= truncatedAt;
  return `
    <section class="shader-block" data-shader-type="${escapeHtml(shader.type)}">
      <h2 class="shader-block-title">${escapeHtml(label)}</h2>
      ${truncated ? `<p class="shader-truncated-note">Truncated at ${truncatedAt.toLocaleString()} characters.</p>` : ''}
      <pre class="shader-source"><code>${highlightGlsl(shader.source)}</code></pre>
    </section>
  `;
}

function renderShaderPanel(program, truncatedAt) {
  return `
    <header class="shader-header">
      <h1 class="shader-title">${escapeHtml(programTitle(program))}</h1>
      <p class="shader-meta muted">${program.shaders.length} shader(s) · ${program.attributeCount ?? '?'} active attribute(s)</p>
    </header>
    ${program.shaders.map((shader) => renderShaderSection(shader, truncatedAt)).join('')}
  `;
}

/**
 * Shader sources open as closable panel tabs after the fixed tabs. Each program gets at most
 * one tab, keyed by the caller (a hash of its sources), so reopening it focuses that tab.
 */
export function createShaderTabs({ nav, views, showView, fallbackView, truncatedAt }) {
  const open = new Map();

  function close(key) {
    const entry = open.get(key);
    if (!entry) return;
    const wasActive = entry.tab.getAttribute('aria-selected') === 'true';
    const neighbor = entry.wrapper.previousElementSibling;
    const neighborTab = neighbor?.matches('[role="tab"]') ? neighbor : neighbor?.querySelector('[role="tab"]');
    entry.wrapper.remove();
    entry.panel.remove();
    open.delete(key);
    if (wasActive) showView(neighborTab?.dataset.view ?? fallbackView);
  }

  function reveal(entry, stage) {
    showView(entry.view);
    if (stage) entry.panel.querySelector(`[data-shader-type="${stage}"]`)?.scrollIntoView({ block: 'start' });
  }

  function openProgram(key, program, { stage = null } = {}) {
    const existing = open.get(key);
    if (existing) {
      reveal(existing, stage);
      return existing.view;
    }

    const view = `shader:${key}`;
    const label = programTitle(program);

    const wrapper = document.createElement('span');
    wrapper.className = 'mode-tab-closable';

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.id = `mode-shader-${key}`;
    tab.dataset.view = view;
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('aria-controls', `view-shader-${key}`);
    tab.className = 'mode-tab-shader';
    tab.title = label;
    tab.textContent = label;
    tab.addEventListener('click', () => showView(view));

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'mode-tab-close';
    closeButton.setAttribute('aria-label', `Close ${label}`);
    closeButton.textContent = '×';
    closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      close(key);
    });

    wrapper.append(tab, closeButton);
    nav.appendChild(wrapper);

    const panel = document.createElement('section');
    panel.id = `view-shader-${key}`;
    panel.className = 'view view--shader';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.hidden = true;
    panel.innerHTML = renderShaderPanel(program, truncatedAt);
    views.appendChild(panel);

    const entry = { view, wrapper, tab, panel };
    open.set(key, entry);
    reveal(entry, stage);
    return view;
  }

  return { open: openProgram, close };
}
