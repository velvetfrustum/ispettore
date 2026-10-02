import { escapeHtml } from './html.js';
import { box, commandChips, formatDetailValue, framebufferBox, rows, table, uniformValue, valueRows } from './detailsView.js';

export const PIPELINE_STAGES = [
  { id: 'vertex-input', label: 'Vertex Input', drawOnly: true },
  { id: 'vertex-shader', label: 'Vertex Shader', drawOnly: true },
  { id: 'rasterizer', label: 'Rasterizer', drawOnly: true },
  { id: 'fragment-shader', label: 'Fragment Shader', drawOnly: true },
  { id: 'output-merger', label: 'Output Merger', drawOnly: false }
];

function stateGroup(details, name) {
  return details.states?.find((group) => group.name === name) ?? null;
}

function pick(group, keys) {
  if (!group) return {};
  return Object.fromEntries(keys.filter((key) => key in group.entries).map((key) => [key, group.entries[key]]));
}

function stateBox(details, title, groupName, keys, commandOp) {
  const group = stateGroup(details, groupName);
  if (!group) return '';
  const entries = keys ? pick(group, keys) : group.entries;
  return box(title, valueRows(entries) + commandChips(group.commands, commandOp));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Default-block uniforms have no per-stage query in WebGL; a uniform belongs to a stage when
// that stage's source declares it.
function declaredIn(source, uniformName) {
  const base = uniformName.split(/[[.]/)[0];
  return new RegExp(`\\buniform\\b[^;]*\\b${escapeRegExp(base)}\\b`).test(source);
}

function stageUniforms(drawCall, program, stage) {
  const source = program?.shaders?.find((shader) => shader.type === stage)?.source;
  if (!source) return { uniforms: drawCall.uniforms ?? [], filtered: false };
  return { uniforms: (drawCall.uniforms ?? []).filter((uniform) => declaredIn(source, uniform.name)), filtered: true };
}

function argumentsOf(details) {
  return Object.fromEntries((details.command?.arguments ?? []).map(({ name, value }) => [name, value]));
}

function vertexInput(details) {
  const drawCall = details.drawCall;
  const args = argumentsOf(details);
  const boxes = [
    box(
      'Draw',
      rows([
        ['command', escapeHtml(details.command?.name ?? '?')],
        ...Object.entries(args).map(([name, value]) => [name, formatDetailValue(value)])
      ])
    )
  ];
  if (drawCall.elementArray !== undefined) {
    const sample = drawCall.indexSample;
    const indices = sample?.unavailable
      ? `<span class="muted">${escapeHtml(sample.unavailable)}</span>`
      : sample
        ? `${formatDetailValue(sample.values)}${sample.values.length ? ` <span class="muted">(first ${sample.values.length} from byte ${sample.offset})</span>` : ''}`
        : formatDetailValue(null);
    boxes.push(
      box('Index buffer', rows([['ELEMENT_ARRAY_BUFFER', formatDetailValue(drawCall.elementArray)], ['type', formatDetailValue(sample?.type ?? args.type)], ['indices', indices]]))
    );
  }
  boxes.push(
    box(
      'Vertex attributes',
      table(
        [
          ['location', 'loc'], ['name', 'name'], ['type', 'type'], ['enabled', 'enabled'], ['bufferBinding', 'buffer'],
          ['format', 'format', (attribute) => formatDetailValue(attribute.arraySize != null ? `${attribute.arraySize} × ${attribute.arrayType}` : attribute.type)],
          ['normalized', 'norm'], ['integer', 'int'], ['stride', 'stride'], ['offsetPointer', 'offset'], ['divisor', 'divisor'],
          ['vertexAttrib', 'current value']
        ],
        drawCall.attributes
      ),
      { wide: true }
    )
  );
  const sampled = (drawCall.attributes ?? []).filter((attribute) => attribute.sample);
  if (sampled.length) {
    const body = sampled
      .map((attribute) => {
        if (attribute.sample.unavailable) {
          return `<div class="details-sub"><h5>${escapeHtml(attribute.name)}</h5><p class="muted details-empty">${escapeHtml(attribute.sample.unavailable)}</p></div>`;
        }
        const records = attribute.sample.values.map((value, index) => ({ vertex: attribute.sample.firstVertex + index, value }));
        return `<div class="details-sub"><h5>${escapeHtml(attribute.name)} · ${escapeHtml(attribute.bufferBinding ?? '')}</h5>${table([['vertex', 'vertex'], ['value', 'value']], records)}</div>`;
      })
      .join('');
    boxes.push(box('Vertex buffer contents', `<div class="pipeline-buffer-samples">${body}</div>`, { wide: true }));
  }
  return boxes;
}

function shaderStage(details, program, stage) {
  const drawCall = details.drawCall;
  const shader = drawCall.shaders?.find((entry) => entry.type === stage);
  const status = drawCall.programStatus ?? {};
  const open = program
    ? `<button type="button" class="panel-action details-open-shader" data-open-program data-stage="${stage}">Open ${stage} shader</button>`
    : '';
  const boxes = [
    box(
      `${stage === 'vertex' ? 'Vertex' : 'Fragment'} shader`,
      rows([
        ['program', formatDetailValue(status.label ? `${status.label} (${status.program})` : status.program)],
        ['shader', formatDetailValue(shader?.name ?? shader?.shaderType ?? null)],
        ['COMPILE_STATUS', formatDetailValue(shader?.COMPILE_STATUS)],
        ['LINK_STATUS', formatDetailValue(status.LINK_STATUS)]
      ]) + open
    )
  ];
  const { uniforms, filtered } = stageUniforms(drawCall, program, stage);
  boxes.push(
    box(
      filtered ? `Uniforms declared in the ${stage} shader` : 'Uniforms (program-wide)',
      table([['name', 'name'], ['type', 'type'], ['size', 'size'], ['value', 'value', uniformValue], ['blockName', 'block'], ['offset', 'offset']], uniforms),
      { wide: true }
    )
  );
  const blocks = (drawCall.uniformBlocks ?? []).filter((block) => block[stage]);
  if (blocks.length) {
    boxes.push(
      box('Uniform blocks', table([['name', 'name'], ['bindingPoint', 'binding'], ['size', 'bytes'], ['activeUniformCount', 'uniforms'], ['buffer', 'buffer']], blocks), { wide: true })
    );
  }
  if (stage === 'vertex' && drawCall.transformFeedback) {
    boxes.push(
      box(
        'Transform feedback',
        rows([['mode', formatDetailValue(drawCall.transformFeedback.mode)]]) +
          table([['name', 'name'], ['size', 'size'], ['type', 'type'], ['buffer', 'buffer'], ['bufferStart', 'start'], ['bufferSize', 'bytes']], drawCall.transformFeedback.varyings)
      )
    );
  }
  return boxes;
}

function rasterizer(details, commandOp) {
  return [
    stateBox(details, 'Culling', 'CullState', null, commandOp),
    stateBox(details, 'Viewport & primitive', 'DrawState', ['VIEWPORT', 'FRONT_FACE', 'RASTERIZER_DISCARD'], commandOp),
    stateBox(details, 'Depth range', 'DepthState', ['DEPTH_RANGE'], commandOp),
    stateBox(details, 'Scissor', 'ScissorState', null, commandOp),
    stateBox(details, 'Polygon offset', 'PolygonOffsetState', null, commandOp),
    stateBox(details, 'Multisample coverage', 'CoverageState', null, commandOp)
  ];
}

function outputMerger(details, commandOp) {
  return [
    framebufferBox(details),
    details.drawCall ? '' : stateBox(details, 'Scissor', 'ScissorState', null, commandOp),
    stateBox(details, 'Clear values', 'ClearState', null, commandOp),
    stateBox(details, 'Blend', 'BlendState', null, commandOp),
    stateBox(details, 'Depth', 'DepthState', ['DEPTH_TEST', 'DEPTH_FUNC', 'DEPTH_WRITEMASK'], commandOp),
    stateBox(details, 'Stencil', 'StencilState', null, commandOp),
    stateBox(details, 'Color mask', 'ColorState', null, commandOp),
    stateBox(details, 'Dither', 'DrawState', ['DITHER'], commandOp)
  ];
}

/**
 * RenderDoc-style pipeline view for the selected event: a row of WebGL pipeline stages, and
 * the state of the selected stage below it. Stages that a non-draw event (clear, blit, copy)
 * does not run are shown greyed out.
 */
export function renderPipelineStages(result, { stage, commandOp }) {
  const details = result?.details;
  if (!details) return null;
  const isDraw = Boolean(details.drawCall);
  const available = (entry) => isDraw || !entry.drawOnly;
  const selected = PIPELINE_STAGES.find((entry) => entry.id === stage && available(entry)) ??
    PIPELINE_STAGES.find(available);

  const strip = PIPELINE_STAGES.map((entry, index) => {
    const arrow = index ? '<span class="pipeline-stage-arrow" aria-hidden="true">→</span>' : '';
    const classes = ['pipeline-stage'];
    if (entry.id === selected.id) classes.push('pipeline-stage--selected');
    const disabled = available(entry) ? '' : ' disabled';
    return `${arrow}<button type="button" class="${classes.join(' ')}" data-pipeline-stage="${entry.id}"${disabled} aria-pressed="${entry.id === selected.id}">${entry.label}</button>`;
  }).join('');

  let boxes;
  if (selected.id === 'vertex-input') boxes = vertexInput(details);
  else if (selected.id === 'vertex-shader') boxes = shaderStage(details, result.program, 'vertex');
  else if (selected.id === 'rasterizer') boxes = rasterizer(details, commandOp);
  else if (selected.id === 'fragment-shader') boxes = shaderStage(details, result.program, 'fragment');
  else boxes = outputMerger(details, commandOp);

  return `<div class="pipeline-stages" role="toolbar" aria-label="Pipeline stages">${strip}</div>
    <div class="pipeline-groups details-groups">${boxes.filter(Boolean).join('')}</div>`;
}
