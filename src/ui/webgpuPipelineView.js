import { escapeHtml } from './html.js';
import { box, formatDetailValue, rows, table, valueRows } from './detailsView.js';

const GRAPHICS_STAGES = [
  { id: 'vertex-input', label: 'Vertex Input' },
  { id: 'vertex-shader', label: 'Vertex Shader' },
  { id: 'rasterizer', label: 'Rasterizer' },
  { id: 'fragment-shader', label: 'Fragment Shader' },
  { id: 'output-merger', label: 'Output Merger' }
];
const COMPUTE_STAGE = { id: 'compute-shader', label: 'Compute Shader' };

function writeMask(mask) {
  if (!Number.isInteger(mask)) return mask;
  return ['R', 'G', 'B', 'A'].filter((_, index) => mask & (1 << index)).join('') || 'none';
}

function blendText(blend) {
  if (!blend) return 'disabled';
  const part = (component) =>
    component ? `${component.operation ?? 'add'}(${component.srcFactor ?? 'one'}, ${component.dstFactor ?? 'zero'})` : 'add(one, zero)';
  return `color ${part(blend.color)} · alpha ${part(blend.alpha)}`;
}

function resourceSummary(entry) {
  if (entry.kind === 'buffer') {
    const range = entry.bindingSize != null ? ` · ${entry.bindingSize} B at ${entry.offset}` : entry.offset ? ` · from ${entry.offset}` : '';
    return `${escapeHtml(entry.label || entry.buffer)} · ${entry.size ?? '?'} B${range}<br /><span class="muted">${escapeHtml(entry.usage ?? '')}</span>`;
  }
  if (entry.kind === 'textureView') {
    return `${escapeHtml(entry.label || entry.texture || entry.view)} · ${escapeHtml(entry.format ?? '?')} · ${escapeHtml(entry.size ?? '?')}${entry.canvas ? ' · canvas' : ''}`;
  }
  if (entry.kind === 'sampler') {
    return `${escapeHtml(entry.sampler)} · ${escapeHtml(entry.magFilter ?? 'nearest')}/${escapeHtml(entry.minFilter ?? 'nearest')} · ${escapeHtml(entry.addressModeU ?? 'clamp-to-edge')}${entry.compare ? ` · compare ${escapeHtml(entry.compare)}` : ''}`;
  }
  return escapeHtml(entry.id ?? entry.kind);
}

function bindGroupBoxes(bindGroups) {
  if (!bindGroups?.length) return [box('Bind groups', '<p class="muted details-empty">No bind groups visible to this stage</p>')];
  return bindGroups.map((group) =>
    box(
      `Bind group ${group.group}${group.label ? ` · ${group.label}` : ''}`,
      (group.visibilityKnown ? '' : '<p class="muted details-empty">Layout is "auto": shown for every stage.</p>') +
        table(
          [
            ['binding', 'binding'],
            ['bindingType', 'type'],
            ['resource', 'resource', resourceSummary],
            ['words', 'contents (f32)', (entry) => (entry.words ? formatDetailValue(entry.words) : '<span class="muted">—</span>')]
          ],
          group.entries
        ),
      { wide: true }
    )
  );
}

const CPU_NOTE = '<p class="muted details-empty">Samples show known CPU uploads within this frame, up to command encoding (first 4 KiB per buffer). Pre-frame and potentially GPU-written bytes are unavailable. Later queue uploads can change what a submitted draw actually reads.</p>';

function vertexInput(details) {
  const input = details.vertexInput;
  const boxes = [
    box('Draw', rows([['command', escapeHtml(details.command?.name ?? '?')], ...Object.entries(input.arguments).map(([name, value]) => [name, formatDetailValue(value)])])),
    box('Primitive assembly', rows([['topology', formatDetailValue(input.topology)], ['stripIndexFormat', formatDetailValue(input.stripIndexFormat)]]))
  ];
  if (input.indexBuffer) {
    const index = input.indexBuffer;
    boxes.push(
      box(
        'Index buffer',
        rows([
          ['buffer', formatDetailValue(index.label || index.buffer)],
          ['format', formatDetailValue(index.format)],
          ['offset', formatDetailValue(index.offset)],
          ['size', formatDetailValue(index.size)],
          ['indices', index.sample ? formatDetailValue(index.sample) : formatDetailValue(null)]
        ])
      )
    );
  }
  boxes.push(
    box(
      'Vertex buffers',
      table(
        [
          ['slot', 'slot'],
          ['buffer', 'buffer', (slot) => formatDetailValue(slot.buffer?.label || slot.buffer?.buffer || (slot.unused ? 'unused' : null))],
          ['arrayStride', 'stride'],
          ['stepMode', 'step'],
          ['offset', 'offset'],
          ['attributes', 'attributes', (slot) => (slot.attributes ?? []).map((attribute) => `@location(${attribute.shaderLocation}) ${escapeHtml(attribute.format)} +${attribute.offset}`).join('<br />')]
        ],
        input.vertexBuffers
      ),
      { wide: true }
    )
  );
  const samples = input.vertexBuffers.flatMap((slot) =>
    (slot.attributes ?? [])
      .filter((attribute) => attribute.sample?.length)
      .map((attribute) => `<div class="details-sub"><h5>@location(${attribute.shaderLocation}) · slot ${slot.slot} · ${escapeHtml(attribute.format)}</h5>${table([['vertex', 'vertex'], ['value', 'value']], attribute.sample)}</div>`)
  );
  if (samples.length) boxes.push(box('Vertex buffer contents', `${CPU_NOTE}<div class="pipeline-buffer-samples">${samples.join('')}</div>`, { wide: true }));
  return boxes;
}

function shaderBox(title, stage, stageName) {
  return box(
    title,
    rows([
      ['module', formatDetailValue(stage.moduleLabel ? `${stage.moduleLabel} (${stage.module})` : stage.module)],
      ['entryPoint', stage.entryPoint ? formatDetailValue(stage.entryPoint) : '<span class="muted">default (the module\'s only entry point)</span>'],
      ['constants', stage.constants ? formatDetailValue(stage.constants) : undefined],
      ['workgroup_size', stage.workgroupSize ? escapeHtml(stage.workgroupSize) : undefined]
    ]) +
      (stage.source
        ? `<button type="button" class="panel-action details-open-shader" data-open-program data-stage="${stageName}">Open ${stageName} WGSL</button>`
        : '')
  );
}

function shaderStage(details, stageKey, stageName, title) {
  const stage = details[stageKey];
  if (!stage) return [box(title, '<p class="muted details-empty">This pipeline has no fragment stage.</p>')];
  return [shaderBox(title, stage, stageName), ...bindGroupBoxes(stage.bindGroups), box('Buffer contents', CPU_NOTE)];
}

function rasterizer(details) {
  const raster = details.rasterizer;
  return [
    box('Primitive', rows([
      ['topology', formatDetailValue(raster.topology)],
      ['frontFace', formatDetailValue(raster.frontFace)],
      ['cullMode', formatDetailValue(raster.cullMode)],
      ['unclippedDepth', formatDetailValue(raster.unclippedDepth)]
    ])),
    box('Viewport & scissor', rows([['viewport', formatDetailValue(raster.viewport)], ['scissor', formatDetailValue(raster.scissor)]])),
    box('Multisample', valueRows(raster.multisample)),
    raster.depthBias ? box('Depth bias', valueRows(raster.depthBias)) : ''
  ];
}

function outputMerger(details) {
  const output = details.output;
  const boxes = [
    box(
      'Color attachments',
      table(
        [
          ['index', '#'],
          ['texture', 'texture', (attachment) => formatDetailValue(attachment.label || attachment.texture)],
          ['format', 'format'],
          ['size', 'size'],
          ['sampleCount', 'samples'],
          ['loadOp', 'load'],
          ['storeOp', 'store'],
          ['clearValue', 'clear', (attachment) => formatDetailValue(attachment.clearValue ? [attachment.clearValue.r, attachment.clearValue.g, attachment.clearValue.b, attachment.clearValue.a] : null)],
          ['resolveTarget', 'resolve']
        ],
        output.colorAttachments
      ),
      { wide: true }
    ),
    box(
      'Color targets',
      table(
        [
          ['index', '#'],
          ['format', 'format'],
          ['writeMask', 'write mask', (target) => escapeHtml(writeMask(target.writeMask))],
          ['blend', 'blend', (target) => escapeHtml(blendText(target.blend))]
        ],
        output.targets
      ),
      { wide: true }
    )
  ];
  if (output.depthAttachment) {
    const { view, texture, label, ...attachment } = output.depthAttachment;
    boxes.push(box('Depth-stencil attachment', rows([['texture', formatDetailValue(label || texture)]]) + valueRows(attachment, ['usage', 'viewDimension', 'baseMipLevel', 'baseArrayLayer'])));
  }
  if (output.depthStencil) {
    const { stencilFront, stencilBack, depthBias, depthBiasSlopeScale, depthBiasClamp, ...depth } = output.depthStencil;
    boxes.push(box('Depth-stencil state', valueRows(depth) + rows([
      ['stencilFront', formatDetailValue(stencilFront ?? null)],
      ['stencilBack', formatDetailValue(stencilBack ?? null)]
    ])));
  }
  boxes.push(box('Pass constants', rows([
    ['blendConstant', formatDetailValue(output.blendConstant)],
    ['stencilReference', formatDetailValue(output.stencilReference)]
  ])));
  return boxes;
}

function compute(details) {
  const stage = details.computeShader;
  if (!stage) return [box('Compute shader', '<p class="muted details-empty">No compute pipeline is set.</p>')];
  return [
    box('Dispatch', rows([['command', escapeHtml(details.command?.name ?? '?')], ...Object.entries(stage.arguments).map(([name, value]) => [name, formatDetailValue(value)])])),
    shaderBox('Compute shader', stage, 'compute'),
    ...bindGroupBoxes(stage.bindGroups),
    box('Buffer contents', CPU_NOTE)
  ];
}

/** The program shape the shader tabs open: one entry per stage with its WGSL module source. */
export function webGpuShaderProgram(details) {
  const shaders = [
    ['vertex', details.vertexShader],
    ['fragment', details.fragmentShader],
    ['compute', details.computeShader]
  ]
    .filter(([, stage]) => stage?.source)
    .map(([type, stage]) => ({ type, source: stage.source }));
  if (!shaders.length) return null;
  return { label: details.pipeline?.label || details.pipeline?.id || 'WebGPU pipeline', attributeCount: null, shaders };
}

/**
 * RenderDoc-style pipeline view for a WebGPU event: the graphics stages for draws, and a
 * separate Compute Shader stage for dispatches. Other events (writes, copies) run no stage.
 */
export function renderWebGpuPipelineStages(result, { stage }) {
  const details = result?.details;
  if (!details) return null;
  const available = (id) => (details.kind === 'render' ? id !== COMPUTE_STAGE.id : details.kind === 'compute' ? id === COMPUTE_STAGE.id : false);
  const all = [...GRAPHICS_STAGES, COMPUTE_STAGE];
  const selected = all.find((entry) => entry.id === stage && available(entry.id)) ?? all.find((entry) => available(entry.id)) ?? null;

  const button = (entry) =>
    `<button type="button" class="pipeline-stage${entry.id === selected?.id ? ' pipeline-stage--selected' : ''}" data-pipeline-stage="${entry.id}"${available(entry.id) ? '' : ' disabled'} aria-pressed="${entry.id === selected?.id}">${entry.label}</button>`;
  const strip = `${GRAPHICS_STAGES.map((entry, index) => `${index ? '<span class="pipeline-stage-arrow" aria-hidden="true">→</span>' : ''}${button(entry)}`).join('')}<span class="pipeline-stage-gap"></span>${button(COMPUTE_STAGE)}`;

  let boxes;
  if (!selected) {
    boxes = [box(details.command?.name ?? 'Event', `<p class="muted details-empty">This ${escapeHtml(details.command?.name ?? 'command')} runs no pipeline stage. See Call Info for its arguments.</p>`)];
  } else if (selected.id === 'vertex-input') boxes = vertexInput(details);
  else if (selected.id === 'vertex-shader') boxes = shaderStage(details, 'vertexShader', 'vertex', 'Vertex shader');
  else if (selected.id === 'rasterizer') boxes = rasterizer(details);
  else if (selected.id === 'fragment-shader') boxes = shaderStage(details, 'fragmentShader', 'fragment', 'Fragment shader');
  else if (selected.id === 'output-merger') boxes = outputMerger(details);
  else boxes = compute(details);

  const header = details.pipeline?.label || details.pass?.label
    ? `<p class="muted pipeline-context">${details.pipeline?.label ? `Pipeline ${escapeHtml(details.pipeline.label)}` : ''}${details.pass?.label ? ` · pass ${escapeHtml(details.pass.label)}` : ''}</p>`
    : '';
  const error = details.error ? `<p class="preview-placeholder">${escapeHtml(details.error)}</p>` : '';
  return `${error}<div class="pipeline-stages" role="toolbar" aria-label="Pipeline stages">${strip}</div>${header}
    <div class="pipeline-groups details-groups">${boxes.filter(Boolean).join('')}</div>`;
}
