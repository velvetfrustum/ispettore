import { decodeBinaryBlob } from '../../shared/capture/blobs.js';
import { webGpuEventKind } from './events.js';

/**
 * Rebuilds the pipeline state of one WebGPU event from a stored capture package. WebGPU keeps
 * almost all state in descriptors (pipelines, passes, bind groups), which the capture records as
 * command arguments, so this is a pure walk over the package: no GPU work. Buffer contents are
 * rebuilt from the CPU uploads recorded up to the event (writeBuffer, mapped writes); data the
 * GPU itself writes (compute shaders, copies) is not in the package.
 */

const SAMPLE_VERTICES = 8;
const SAMPLE_INDICES = 24;
const SAMPLE_WORDS = 64;

const PARAMETER_NAMES = {
  draw: ['vertexCount', 'instanceCount', 'firstVertex', 'firstInstance'],
  drawIndexed: ['indexCount', 'instanceCount', 'firstIndex', 'baseVertex', 'firstInstance'],
  drawIndirect: ['indirectBuffer', 'indirectOffset'],
  drawIndexedIndirect: ['indirectBuffer', 'indirectOffset'],
  dispatchWorkgroups: ['workgroupCountX', 'workgroupCountY', 'workgroupCountZ'],
  dispatchWorkgroupsIndirect: ['indirectBuffer', 'indirectOffset'],
  copyBufferToBuffer: ['source', 'sourceOffset', 'destination', 'destinationOffset', 'size'],
  copyBufferToTexture: ['source', 'destination', 'copySize'],
  copyTextureToBuffer: ['source', 'destination', 'copySize'],
  copyTextureToTexture: ['source', 'destination', 'copySize'],
  clearBuffer: ['buffer', 'offset', 'size'],
  writeBuffer: ['buffer', 'bufferOffset', 'data', 'dataOffset', 'size'],
  writeTexture: ['destination', 'data', 'dataLayout', 'size'],
  mappedWrite: ['buffer', 'offset', 'data']
};

const MDN_INTERFACE = {
  draw: 'GPURenderPassEncoder',
  drawIndexed: 'GPURenderPassEncoder',
  drawIndirect: 'GPURenderPassEncoder',
  drawIndexedIndirect: 'GPURenderPassEncoder',
  dispatchWorkgroups: 'GPUComputePassEncoder',
  dispatchWorkgroupsIndirect: 'GPUComputePassEncoder',
  copyBufferToBuffer: 'GPUCommandEncoder',
  copyBufferToTexture: 'GPUCommandEncoder',
  copyTextureToBuffer: 'GPUCommandEncoder',
  copyTextureToTexture: 'GPUCommandEncoder',
  clearBuffer: 'GPUCommandEncoder',
  writeBuffer: 'GPUQueue',
  writeTexture: 'GPUQueue'
};

const BUFFER_USAGE = [
  ['MAP_READ', 0x1], ['MAP_WRITE', 0x2], ['COPY_SRC', 0x4], ['COPY_DST', 0x8], ['INDEX', 0x10],
  ['VERTEX', 0x20], ['UNIFORM', 0x40], ['STORAGE', 0x80], ['INDIRECT', 0x100], ['QUERY_RESOLVE', 0x200]
];
const TEXTURE_USAGE = [
  ['COPY_SRC', 0x1], ['COPY_DST', 0x2], ['TEXTURE_BINDING', 0x4], ['STORAGE_BINDING', 0x8], ['RENDER_ATTACHMENT', 0x10]
];
const SHADER_STAGE = { vertex: 0x1, fragment: 0x2, compute: 0x4 };

// Vertex format → [DataView getter, bytes per component, components, normalization divisor].
const VERTEX_FORMATS = {
  uint8: ['getUint8', 1, 1, null], uint8x2: ['getUint8', 1, 2, null], uint8x4: ['getUint8', 1, 4, null],
  sint8: ['getInt8', 1, 1, null], sint8x2: ['getInt8', 1, 2, null], sint8x4: ['getInt8', 1, 4, null],
  unorm8: ['getUint8', 1, 1, 255], unorm8x2: ['getUint8', 1, 2, 255], unorm8x4: ['getUint8', 1, 4, 255],
  snorm8: ['getInt8', 1, 1, 127], snorm8x2: ['getInt8', 1, 2, 127], snorm8x4: ['getInt8', 1, 4, 127],
  uint16: ['getUint16', 2, 1, null], uint16x2: ['getUint16', 2, 2, null], uint16x4: ['getUint16', 2, 4, null],
  sint16: ['getInt16', 2, 1, null], sint16x2: ['getInt16', 2, 2, null], sint16x4: ['getInt16', 2, 4, null],
  unorm16: ['getUint16', 2, 1, 65535], unorm16x2: ['getUint16', 2, 2, 65535], unorm16x4: ['getUint16', 2, 4, 65535],
  snorm16: ['getInt16', 2, 1, 32767], snorm16x2: ['getInt16', 2, 2, 32767], snorm16x4: ['getInt16', 2, 4, 32767],
  float16: ['half', 2, 1, null], float16x2: ['half', 2, 2, null], float16x4: ['half', 2, 4, null],
  float32: ['getFloat32', 4, 1, null], float32x2: ['getFloat32', 4, 2, null], float32x3: ['getFloat32', 4, 3, null],
  float32x4: ['getFloat32', 4, 4, null],
  uint32: ['getUint32', 4, 1, null], uint32x2: ['getUint32', 4, 2, null], uint32x3: ['getUint32', 4, 3, null],
  uint32x4: ['getUint32', 4, 4, null],
  sint32: ['getInt32', 4, 1, null], sint32x2: ['getInt32', 4, 2, null], sint32x3: ['getInt32', 4, 3, null],
  sint32x4: ['getInt32', 4, 4, null]
};

function flags(value, table) {
  if (!Number.isInteger(value)) return value ?? null;
  const names = table.filter(([, bit]) => value & bit).map(([name]) => name);
  return names.length ? names.join(' | ') : String(value);
}

function round(value) {
  return Number.isInteger(value) ? value : Math.round(value * 1e6) / 1e6;
}

function halfToFloat(half) {
  const exponent = (half >> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  const sign = half & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

function refId(value) {
  return value && typeof value === 'object' && typeof value.ref === 'string' ? value.ref : null;
}

function bytesOf(decoded) {
  if (decoded instanceof ArrayBuffer) return new Uint8Array(decoded);
  if (ArrayBuffer.isView(decoded)) return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  return null;
}

function mdnLink(op) {
  const owner = MDN_INTERFACE[op];
  if (owner) return `https://developer.mozilla.org/en-US/docs/Web/API/${owner}/${op}`;
  if (op === 'mappedWrite') return 'https://developer.mozilla.org/en-US/docs/Web/API/GPUBuffer/getMappedRange';
  return null;
}

function createContext(capture, commandIndex) {
  const commands = capture.commands ?? [];
  const blobs = new Map((capture.blobs ?? []).map((blob) => [blob.id, blob]));
  const created = new Map(Object.entries(capture.resources ?? {}).map(([id, resource]) => [id, { ...resource, commandIndex: -1 }]));
  const bufferBytes = new Map();
  const knownBytes = new Map();
  let canvasFormat = capture.context?.configuration?.format ?? null;

  const decodeBlob = (value) => {
    const blob = value && typeof value === 'object' ? blobs.get(value.blob) : null;
    if (!blob) return null;
    try {
      return decodeBinaryBlob(blob);
    } catch (_) {
      return null;
    }
  };

  const writeInto = (bufferId, offset, bytes) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !bytes) return;
    if (!bufferBytes.has(bufferId)) {
      const size = Math.min(4096, Number(created.get(bufferId)?.args?.[0]?.size) || 0);
      if (size <= 0) return;
      bufferBytes.set(bufferId, new Uint8Array(size));
      knownBytes.set(bufferId, new Uint8Array(size));
    }
    const target = bufferBytes.get(bufferId);
    if (!target || !bytes || offset >= target.byteLength) return;
    const length = Math.min(bytes.byteLength, target.byteLength - offset);
    target.set(bytes.subarray(0, length), offset);
    knownBytes.get(bufferId).fill(1, offset, offset + length);
  };

  for (let index = 0; index <= commandIndex && index < commands.length; index++) {
    const command = commands[index];
    if (!command || command.failed) continue;
    const args = command.args ?? [];
    if (command.resultId) created.set(command.resultId, { op: command.op, args, commandIndex: index });
    if (command.op === 'configure') {
      canvasFormat = args[0]?.format ?? canvasFormat;
    } else if (command.op === 'mappedWrite') {
      writeInto(refId(args[0]), Number(args[1]) || 0, bytesOf(decodeBlob(args[2])));
    } else if (command.op === 'writeBuffer') {
      const decoded = decodeBlob(args[2]);
      const all = bytesOf(decoded);
      if (!all) continue;
      const elementSize = ArrayBuffer.isView(decoded) && !(decoded instanceof DataView) ? decoded.BYTES_PER_ELEMENT : 1;
      const start = (Number(args[3]) || 0) * elementSize;
      const length = args[4] != null ? Number(args[4]) * elementSize : all.byteLength - start;
      writeInto(refId(args[0]), Number(args[1]) || 0, all.subarray(start, start + length));
    }
    if (index < commandIndex && ['draw', 'dispatch'].includes(webGpuEventKind(command.op))) {
      for (const id of bufferBytes.keys()) {
        if (created.get(id)?.args?.[0]?.usage & 0x80) { bufferBytes.delete(id); knownBytes.delete(id); }
      }
    }
    if (['copy', 'clear'].includes(webGpuEventKind(command.op))) {
      bufferBytes.clear();
      knownBytes.clear();
    }
  }

  const descriptor = (id) => created.get(id)?.args?.[0] ?? null;
  const known = (id, offset, length) => {
    const mask = knownBytes.get(id);
    return mask && offset >= 0 && offset + length <= mask.length && mask.subarray(offset, offset + length).every(Boolean);
  };

  function describeTexture(textureId) {
    const entry = created.get(textureId);
    if (!entry) return { texture: textureId };
    if (entry.op === 'getCurrentTexture') return { texture: textureId, canvas: true, format: canvasFormat };
    const desc = entry.args[0] ?? {};
    const size = desc.size ?? {};
    return {
      texture: textureId,
      label: desc.label || null,
      format: desc.format ?? null,
      size: [size.width ?? size[0], size.height ?? size[1] ?? 1, size.depthOrArrayLayers ?? size[2] ?? 1].join('×'),
      mipLevelCount: desc.mipLevelCount ?? 1,
      sampleCount: desc.sampleCount ?? 1,
      dimension: desc.dimension ?? '2d',
      usage: flags(desc.usage, TEXTURE_USAGE)
    };
  }

  function describeView(viewId) {
    const entry = created.get(viewId);
    if (!entry) return { view: viewId };
    const [textureRef, viewDesc = {}] = entry.args;
    return {
      view: viewId,
      ...describeTexture(refId(textureRef)),
      viewDimension: viewDesc.dimension ?? null,
      baseMipLevel: viewDesc.baseMipLevel ?? 0,
      baseArrayLayer: viewDesc.baseArrayLayer ?? 0
    };
  }

  function describeBuffer(bufferId) {
    const desc = descriptor(bufferId) ?? {};
    return { buffer: bufferId, label: desc.label || null, size: desc.size ?? null, usage: flags(desc.usage, BUFFER_USAGE) };
  }

  function bufferWords(bufferId, offset = 0) {
    const bytes = bufferBytes.get(bufferId);
    if (!bytes) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const words = [];
    for (let at = offset; at + 4 <= bytes.byteLength && words.length < SAMPLE_WORDS && known(bufferId, at, 4); at += 4) words.push(round(view.getFloat32(at, true)));
    return words.length ? words : null;
  }

  function sampleVertices(bufferId, bufferOffset, layout, attribute, firstVertex) {
    const reader = VERTEX_FORMATS[attribute.format];
    const bytes = bufferBytes.get(bufferId);
    if (!reader || !bytes) return null;
    const [getter, componentBytes, components, divisor] = reader;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = [];
    for (let vertex = firstVertex; vertex < firstVertex + SAMPLE_VERTICES; vertex++) {
      const base = bufferOffset + vertex * layout.arrayStride + attribute.offset;
      if (base + componentBytes * components > bytes.byteLength) break;
      if (!known(bufferId, base, componentBytes * components)) break;
      const value = [];
      for (let component = 0; component < components; component++) {
        const at = base + component * componentBytes;
        let raw = getter === 'half' ? halfToFloat(view.getUint16(at, true)) : view[getter](at, true);
        if (divisor) raw = Math.max(raw / divisor, -1);
        value.push(round(raw));
      }
      values.push({ vertex, value });
    }
    return values.length ? values : null;
  }

  function sampleIndices(bufferId, format, offset, firstIndex) {
    const bytes = bufferBytes.get(bufferId);
    if (!bytes) return null;
    const size = format === 'uint16' ? 2 : 4;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = [];
    for (let at = offset + firstIndex * size; at + size <= bytes.byteLength && values.length < SAMPLE_INDICES; at += size) {
      if (!known(bufferId, at, size)) break;
      values.push(size === 2 ? view.getUint16(at, true) : view.getUint32(at, true));
    }
    return values.length ? values : null;
  }

  return { commands, created, descriptor, describeTexture, describeView, describeBuffer, bufferWords, sampleVertices, sampleIndices };
}

function argumentDisplay(value, type, blobs) {
  if (value && typeof value === 'object') {
    if (typeof value.ref === 'string') return value.ref;
    if (typeof value.blob === 'string') {
      const blob = blobs.get(value.blob);
      return blob ? `${blob.arrayType}(${blob.byteLength} bytes)` : value.blob;
    }
    return JSON.stringify(value);
  }
  return value ?? null;
}

function commandSection(capture, command) {
  const blobs = new Map((capture.blobs ?? []).map((blob) => [blob.id, blob]));
  const names = PARAMETER_NAMES[command.op] ?? [];
  return {
    name: command.op,
    help: mdnLink(command.op),
    arguments: (command.args ?? []).map((value, index) => ({
      name: names[index] ?? `arg${index}`,
      value: argumentDisplay(value, command.argTypes?.[index], blobs)
    }))
  };
}

// The pass an event belongs to: the nearest begin*Pass before it with no matching end between.
function findPass(commands, commandIndex) {
  const receiverId = commands[commandIndex]?.receiverId;
  for (let index = commandIndex - 1; index >= 0; index--) {
    const op = commands[index]?.op;
    if (receiverId) {
      if (commands[index].resultId === receiverId && (op === 'beginRenderPass' || op === 'beginComputePass')) {
        return { begin: index, kind: op === 'beginRenderPass' ? 'render' : 'compute' };
      }
      continue;
    }
    if (op === 'renderPass.end' || op === 'computePass.end') return null;
    if (op === 'beginRenderPass' || op === 'beginComputePass') return { begin: index, kind: op === 'beginRenderPass' ? 'render' : 'compute' };
  }
  return null;
}

function passBindings(commands, begin, end) {
  const state = { pipeline: null, bindGroups: new Map(), vertexBuffers: new Map(), indexBuffer: null, viewport: null, scissor: null, blendConstant: null, stencilReference: null };
  for (let index = begin + 1; index < end; index++) {
    const command = commands[index];
    if (!command || command.failed) continue;
    if (commands[end]?.receiverId && command.receiverId !== commands[end].receiverId) continue;
    const args = command.args ?? [];
    if (command.op === 'setPipeline') state.pipeline = refId(args[0]);
    else if (command.op === 'setBindGroup') state.bindGroups.set(args[0], { bindGroup: refId(args[1]), dynamicOffsets: Array.isArray(args[2]) ? args[2] : null });
    else if (command.op === 'setVertexBuffer') state.vertexBuffers.set(args[0], { buffer: refId(args[1]), offset: Number(args[2]) || 0, size: args[3] ?? null });
    else if (command.op === 'setIndexBuffer') state.indexBuffer = { buffer: refId(args[0]), format: args[1], offset: Number(args[2]) || 0, size: args[3] ?? null };
    else if (command.op === 'setViewport') state.viewport = args.slice(0, 6);
    else if (command.op === 'setScissorRect') state.scissor = args.slice(0, 4);
    else if (command.op === 'setBlendConstant') state.blendConstant = args[0];
    else if (command.op === 'setStencilReference') state.stencilReference = args[0];
  }
  return state;
}

function bindGroupLayoutEntries(ctx, pipelineDesc, groupIndex) {
  const layoutId = refId(pipelineDesc?.layout);
  const layoutDesc = layoutId ? ctx.descriptor(layoutId) : null;
  const groupLayoutId = refId(layoutDesc?.bindGroupLayouts?.[groupIndex]);
  const groupLayout = groupLayoutId ? ctx.descriptor(groupLayoutId) : null;
  return groupLayout?.entries ?? null;
}

function describeBufferBinding(ctx, bufferId, offset, size) {
  return { kind: 'buffer', ...ctx.describeBuffer(bufferId), offset, bindingSize: size ?? null, words: ctx.bufferWords(bufferId, offset) };
}

// A binding resource is a buffer binding ({ buffer, offset, size }), or — in the current spec —
// a GPUBuffer, GPUTexture, GPUTextureView, GPUSampler, or external texture used directly.
function describeResource(ctx, resource) {
  if (!resource || typeof resource !== 'object') return { kind: 'unknown' };
  if (resource.buffer) return describeBufferBinding(ctx, refId(resource.buffer), Number(resource.offset) || 0, resource.size);
  const id = refId(resource);
  const entry = id ? ctx.created.get(id) : null;
  if (entry?.op === 'createBuffer') return describeBufferBinding(ctx, id, 0, null);
  if (entry?.op === 'createTexture' || entry?.op === 'getCurrentTexture') return { kind: 'textureView', ...ctx.describeTexture(id) };
  if (entry?.op === 'createView') return { kind: 'textureView', ...ctx.describeView(id) };
  if (entry?.op === 'createSampler') return { kind: 'sampler', sampler: id, ...(entry.args[0] ?? {}) };
  if (entry?.op === 'importExternalTexture') return { kind: 'externalTexture', externalTexture: id };
  return { kind: entry?.op ?? 'unknown', id };
}

function bindGroupsForStage(ctx, state, pipelineDesc, stage) {
  const groups = [];
  for (const [groupIndex, bound] of [...state.bindGroups.entries()].sort(([a], [b]) => a - b)) {
    const desc = ctx.descriptor(bound.bindGroup) ?? {};
    const layoutEntries = bindGroupLayoutEntries(ctx, pipelineDesc, groupIndex);
    const entries = (desc.entries ?? [])
      .map((entry) => {
        const layout = layoutEntries?.find((candidate) => candidate.binding === entry.binding) ?? null;
        return { binding: entry.binding, layout, ...describeResource(ctx, entry.resource) };
      })
      .filter((entry) => !entry.layout || (entry.layout.visibility & SHADER_STAGE[stage]));
    if (!entries.length) continue;
    groups.push({
      group: groupIndex,
      bindGroup: bound.bindGroup,
      label: desc.label || null,
      dynamicOffsets: bound.dynamicOffsets,
      visibilityKnown: Boolean(layoutEntries),
      entries: entries.map(({ layout, ...entry }) => ({ ...entry, bindingType: layout ? layoutType(layout) : null }))
    });
  }
  return groups;
}

function layoutType(layout) {
  if (layout.buffer) return `buffer (${layout.buffer.type ?? 'uniform'})`;
  if (layout.texture) return `texture (${layout.texture.sampleType ?? 'float'}, ${layout.texture.viewDimension ?? '2d'})`;
  if (layout.storageTexture) return `storage texture (${layout.storageTexture.access ?? 'write-only'}, ${layout.storageTexture.format ?? '?'})`;
  if (layout.sampler) return `sampler (${layout.sampler.type ?? 'filtering'})`;
  if (layout.externalTexture) return 'external texture';
  return null;
}

function shaderStage(ctx, stageDesc, state, pipelineDesc, stage) {
  if (!stageDesc) return null;
  const moduleId = refId(stageDesc.module);
  const moduleDesc = moduleId ? ctx.descriptor(moduleId) : null;
  return {
    module: moduleId,
    moduleLabel: moduleDesc?.label || null,
    entryPoint: stageDesc.entryPoint ?? null,
    constants: stageDesc.constants ?? null,
    source: moduleDesc?.code ?? null,
    bindGroups: bindGroupsForStage(ctx, state, pipelineDesc, stage)
  };
}

function argumentValues(command) {
  const names = PARAMETER_NAMES[command.op] ?? [];
  return Object.fromEntries((command.args ?? []).map((value, index) => [names[index] ?? `arg${index}`, value]));
}

function describeRender(ctx, command, pass, state) {
  const passDesc = ctx.commands[pass.begin]?.args?.[0] ?? {};
  const pipelineDesc = state.pipeline ? ctx.descriptor(state.pipeline) ?? {} : {};
  const args = argumentValues(command);
  const firstVertex = Number(args.firstVertex ?? args.baseVertex) || 0;

  const vertexBuffers = (pipelineDesc.vertex?.buffers ?? []).map((layout, slot) => {
    if (!layout) return { slot, unused: true };
    const bound = state.vertexBuffers.get(slot) ?? null;
    return {
      slot,
      arrayStride: layout.arrayStride,
      stepMode: layout.stepMode ?? 'vertex',
      buffer: bound ? ctx.describeBuffer(bound.buffer) : null,
      offset: bound?.offset ?? null,
      attributes: (layout.attributes ?? []).map((attribute) => ({
        shaderLocation: attribute.shaderLocation,
        format: attribute.format,
        offset: attribute.offset,
        sample: bound ? ctx.sampleVertices(bound.buffer, bound.offset, layout, attribute, layout.stepMode === 'instance' ? 0 : firstVertex) : null
      }))
    };
  });

  const colorAttachments = (passDesc.colorAttachments ?? []).map((attachment, index) => attachment && {
    index,
    ...ctx.describeView(refId(attachment.view)),
    resolveTarget: refId(attachment.resolveTarget),
    loadOp: attachment.loadOp,
    storeOp: attachment.storeOp,
    clearValue: attachment.clearValue ?? null
  }).filter(Boolean);
  const depthAttachment = passDesc.depthStencilAttachment
    ? {
        ...ctx.describeView(refId(passDesc.depthStencilAttachment.view)),
        depthLoadOp: passDesc.depthStencilAttachment.depthLoadOp ?? null,
        depthStoreOp: passDesc.depthStencilAttachment.depthStoreOp ?? null,
        depthClearValue: passDesc.depthStencilAttachment.depthClearValue ?? null,
        depthReadOnly: passDesc.depthStencilAttachment.depthReadOnly ?? false,
        stencilLoadOp: passDesc.depthStencilAttachment.stencilLoadOp ?? null,
        stencilStoreOp: passDesc.depthStencilAttachment.stencilStoreOp ?? null,
        stencilClearValue: passDesc.depthStencilAttachment.stencilClearValue ?? null
      }
    : null;

  return {
    kind: 'render',
    pass: { label: passDesc.label || null, command: pass.begin },
    pipeline: { id: state.pipeline, label: pipelineDesc.label || null, layout: refId(pipelineDesc.layout) ?? pipelineDesc.layout ?? null },
    vertexInput: {
      arguments: args,
      topology: pipelineDesc.primitive?.topology ?? 'triangle-list',
      stripIndexFormat: pipelineDesc.primitive?.stripIndexFormat ?? null,
      indexBuffer: state.indexBuffer
        ? {
            ...ctx.describeBuffer(state.indexBuffer.buffer),
            format: state.indexBuffer.format,
            offset: state.indexBuffer.offset,
            sample: command.op.startsWith('drawIndexed')
              ? ctx.sampleIndices(state.indexBuffer.buffer, state.indexBuffer.format, state.indexBuffer.offset, Number(args.firstIndex) || 0)
              : null
          }
        : null,
      vertexBuffers
    },
    vertexShader: shaderStage(ctx, pipelineDesc.vertex, state, pipelineDesc, 'vertex'),
    rasterizer: {
      topology: pipelineDesc.primitive?.topology ?? 'triangle-list',
      frontFace: pipelineDesc.primitive?.frontFace ?? 'ccw',
      cullMode: pipelineDesc.primitive?.cullMode ?? 'none',
      unclippedDepth: pipelineDesc.primitive?.unclippedDepth ?? false,
      viewport: state.viewport ?? 'full attachment',
      scissor: state.scissor ?? 'full attachment',
      multisample: pipelineDesc.multisample ?? { count: 1 },
      depthBias: pipelineDesc.depthStencil
        ? {
            depthBias: pipelineDesc.depthStencil.depthBias ?? 0,
            depthBiasSlopeScale: pipelineDesc.depthStencil.depthBiasSlopeScale ?? 0,
            depthBiasClamp: pipelineDesc.depthStencil.depthBiasClamp ?? 0
          }
        : null
    },
    fragmentShader: pipelineDesc.fragment ? shaderStage(ctx, pipelineDesc.fragment, state, pipelineDesc, 'fragment') : null,
    output: {
      colorAttachments,
      depthAttachment,
      targets: (pipelineDesc.fragment?.targets ?? []).map((target, index) => target && {
        index,
        format: target.format,
        writeMask: target.writeMask ?? 0xf,
        blend: target.blend ?? null
      }).filter(Boolean),
      depthStencil: pipelineDesc.depthStencil ?? null,
      blendConstant: state.blendConstant,
      stencilReference: state.stencilReference
    }
  };
}

function workgroupSize(source, entryPoint) {
  if (!source) return null;
  const pattern = new RegExp(`@workgroup_size\\s*\\(([^)]*)\\)[^{]*?fn\\s+${entryPoint ?? '\\w+'}\\b`, 's');
  return pattern.exec(source)?.[1]?.trim() ?? null;
}

function describeCompute(ctx, command, pass, state) {
  const pipelineDesc = state.pipeline ? ctx.descriptor(state.pipeline) ?? {} : {};
  const stage = shaderStage(ctx, pipelineDesc.compute, state, pipelineDesc, 'compute');
  return {
    kind: 'compute',
    pass: { label: ctx.commands[pass.begin]?.args?.[0]?.label || null, command: pass.begin },
    pipeline: { id: state.pipeline, label: pipelineDesc.label || null, layout: refId(pipelineDesc.layout) ?? pipelineDesc.layout ?? null },
    computeShader: stage && { ...stage, workgroupSize: workgroupSize(stage.source, stage.entryPoint), arguments: argumentValues(command) }
  };
}

export function describeWebGpuEvent(capture, commandIndex) {
  const command = capture?.commands?.[commandIndex];
  if (!command || !webGpuEventKind(command.op, command)) return null;
  const ctx = createContext(capture, commandIndex);
  const details = { api: 'webgpu', command: commandSection(capture, command), stackTrace: command.stackTrace ?? [] };
  const pass = findPass(ctx.commands, commandIndex);
  if (!pass) return { ...details, kind: 'other' };
  const state = passBindings(ctx.commands, pass.begin, commandIndex);
  if (pass.kind === 'render' && webGpuEventKind(command.op) === 'draw') return { ...details, ...describeRender(ctx, command, pass, state) };
  if (pass.kind === 'compute' && webGpuEventKind(command.op) === 'dispatch') return { ...details, ...describeCompute(ctx, command, pass, state) };
  return { ...details, kind: 'other' };
}
