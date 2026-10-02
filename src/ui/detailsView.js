import { escapeHtml } from './html.js';

const STATUS_ORDER = ['valid', 'redundant', 'disabled'];

export function formatDetailValue(value) {
  if (value === null || value === undefined) return '<span class="muted">—</span>';
  if (typeof value === 'boolean') return `<span class="details-bool details-bool--${value}">${value}</span>`;
  if (typeof value === 'number') return escapeHtml(Number.isInteger(value) ? value : Number(value.toFixed(6)));
  if (Array.isArray(value)) {
    if (value.every((entry) => entry === null || typeof entry !== 'object')) {
      return `<span class="details-array">[${value.map((entry) => formatDetailValue(entry)).join(', ')}]</span>`;
    }
    return value.map((entry) => formatDetailValue(entry)).join('<br />');
  }
  if (typeof value === 'object') return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
  return escapeHtml(value);
}

export function box(title, body, { wide = false } = {}) {
  return `<section class="inspector-block pipeline-group details-group${wide ? ' details-group--wide' : ''}">
    <h4 class="inspector-heading">${escapeHtml(title)}</h4>
    ${body}
  </section>`;
}

export function rows(entries) {
  const html = entries
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`)
    .join('');
  return `<dl class="details-dl">${html}</dl>`;
}

export function valueRows(object, skip = []) {
  return rows(
    Object.entries(object ?? {})
      .filter(([key]) => !skip.includes(key))
      .map(([key, value]) => [key, formatDetailValue(value)])
  );
}

export function table(columns, records) {
  if (!records?.length) return '<p class="muted details-empty">None</p>';
  const head = columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('');
  const body = records
    .map((record) => `<tr>${columns.map(([key, , render]) => `<td>${render ? render(record) : formatDetailValue(record[key])}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="details-table-wrap"><table class="details-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function commandChips(commands, commandOp) {
  const chips = STATUS_ORDER.flatMap((status) =>
    (commands?.[status] ?? []).map(
      (index) =>
        `<span class="details-cmd details-cmd--${status}" title="${status}">CMD ${index} · ${escapeHtml(commandOp(index) ?? '?')}</span>`
    )
  );
  return chips.length ? `<div class="details-cmds">${chips.join('')}</div>` : '';
}

function globalBox(result, details) {
  const command = result.command ?? {};
  const name = details.command?.help
    ? `<a href="${escapeHtml(details.command.help)}" target="_blank" rel="noopener">${escapeHtml(details.command.name)}</a>`
    : escapeHtml(details.command?.name ?? command.op ?? '?');
  return box(
    'Global',
    rows([
      ['name', name],
      ['command', `CMD ${command.commandIndex ?? '?'}`],
      ['CPU duration', command.durationMs != null ? `${formatDetailValue(command.durationMs)} ms` : formatDetailValue(null)],
      ['GPU duration', command.gpuTimingMs != null ? `${formatDetailValue(command.gpuTimingMs)} ms` : formatDetailValue(null)],
      ['result', command.resultId ? escapeHtml(command.resultId) : undefined],
      ['status', command.status ? escapeHtml(command.status) : undefined]
    ])
  );
}

function argumentsBox(details) {
  const args = details.command?.arguments ?? [];
  return box('Arguments', args.length ? rows(args.map(({ name, value }) => [name, formatDetailValue(value)])) : '<p class="muted details-empty">No arguments</p>');
}

function stackBox(details) {
  const frames = details.stackTrace ?? [];
  if (!frames.length) return '';
  return box('Stack trace', `<ol class="details-stack">${frames.map((frame) => `<li>${escapeHtml(frame)}</li>`).join('')}</ol>`, { wide: true });
}

function attachmentRows(attachment) {
  return `<div class="details-sub"><h5>${escapeHtml(attachment.attachment)}</h5>${valueRows(attachment, ['attachment'])}</div>`;
}

export function framebufferBox(details) {
  const fb = details.frameBuffer;
  if (!fb) return '';
  if (!fb.frameBuffer) {
    return box('Framebuffer', rows([['target', `Canvas (default framebuffer) · ${fb.width}×${fb.height}`]]));
  }
  const attachments = [...(fb.colorAttachments ?? []), fb.depthAttachment, fb.stencilAttachment, fb.depthStencilAttachment].filter(Boolean);
  return box(
    'Framebuffer',
    rows([
      ['frameBuffer', escapeHtml(fb.frameBuffer)],
      ['status', escapeHtml(fb.status ?? '—')]
    ]) + attachments.map(attachmentRows).join('')
  );
}

// Program state the Pipeline tab does not already show (it shows the program, shader names,
// compile and link status).
function programBox(drawCall) {
  const { program, label, LINK_STATUS, ...status } = drawCall.programStatus ?? {};
  const shaders = table(
    [
      ['type', 'type', (shader) => escapeHtml(shader.type)],
      ['shaderType', 'shader type'],
      ['DELETE_STATUS', 'deleted'],
      ['shader', 'id']
    ],
    drawCall.shaders
  );
  return box('Program', valueRows(status) + `<div class="details-sub"><h5>Shaders</h5>${shaders}</div>`);
}

function hintsBox(details) {
  const group = details.states?.find((entry) => entry.name === 'DrawState');
  const hints = Object.fromEntries(Object.entries(group?.entries ?? {}).filter(([key]) => key.endsWith('_HINT') || key.endsWith('_HINT_OES')));
  if (!Object.keys(hints).length) return '';
  return box('Hints', valueRows(hints));
}

function textureSummary(texture) {
  if (!texture?.texture) return `<span class="muted">unit ${texture?.unit ?? '?'} · no texture bound</span>`;
  const size = texture.width && texture.height ? ` · ${texture.width}×${texture.height}` : '';
  const { unit, target, texture: id, width, height, ...parameters } = texture;
  const detail = Object.entries(parameters)
    .map(([key, value]) => `${escapeHtml(key)}: ${formatDetailValue(value)}`)
    .join(' · ');
  return `<div class="details-texture"><strong>unit ${unit} · ${escapeHtml(target)} · ${escapeHtml(id)}${size}</strong><br /><span class="muted">${detail}</span></div>`;
}

export function uniformValue(uniform) {
  const value = uniform.values ?? uniform.value;
  const textures = uniform.textures?.map(textureSummary).join('') ?? '';
  return `${formatDetailValue(value)}${textures}`;
}

/**
 * Spector-style command details that the Pipeline tab does not already show: the command
 * itself (name, MDN link, timings, result), arguments of non-draw events (draw arguments are in
 * Pipeline → Vertex Input), remaining program and shader state, hints, and the stack trace.
 */
export function renderEventDetails(result) {
  const details = result?.details;
  if (!details) return null;
  const isDraw = Boolean(details.drawCall);
  const argumentsInPipeline = isDraw || (details.api === 'webgpu' && details.kind !== 'other');
  const boxes = [
    globalBox(result, details),
    argumentsInPipeline ? '' : argumentsBox(details),
    isDraw ? programBox(details.drawCall) : '',
    isDraw ? hintsBox(details) : '',
    stackBox(details)
  ].filter(Boolean);
  const error = details.error ? `<p class="preview-placeholder">${escapeHtml(details.error)}</p>` : '';
  return `${error}<div class="pipeline-groups details-groups">${boxes.join('')}</div>`;
}
