import {
  registerWebGpuObject,
  resolveWebGpuObjectId
} from './objectRegistry.js';
import { createWebGpuDeviceJournal } from './deviceJournal.js';
import { snapshotBinary } from './snapshotValue.js';
import { previewTextureDescriptor } from './livePreview.js';
import { createWebGpuPreviewCapture } from '../spies/previewCapture.js';

const CREATOR_METHODS = [
  ['createBuffer', 'buffer'],
  ['createTexture', 'texture'],
  ['createSampler', 'sampler'],
  ['createShaderModule', 'shaderModule'],
  ['createBindGroupLayout', 'bindGroupLayout'],
  ['createPipelineLayout', 'pipelineLayout'],
  ['createBindGroup', 'bindGroup'],
  ['createRenderPipeline', 'renderPipeline'],
  ['createComputePipeline', 'computePipeline'],
  ['createQuerySet', 'querySet'],
  ['createCommandEncoder', 'commandEncoder']
];

const ENCODER_COPY_OPS = [
  'copyBufferToBuffer',
  'copyBufferToTexture',
  'copyTextureToBuffer',
  'copyTextureToTexture',
  'clearBuffer',
  'resolveQuerySet'
];

const RENDER_PASS_OPS = [
  'setPipeline',
  'setBindGroup',
  'setIndexBuffer',
  'setVertexBuffer',
  'setViewport',
  'setScissorRect',
  'setBlendConstant',
  'setStencilReference',
  'draw',
  'drawIndexed',
  'drawIndirect',
  'drawIndexedIndirect'
];

const COMPUTE_PASS_OPS = [
  'setPipeline',
  'setBindGroup',
  'dispatchWorkgroups',
  'dispatchWorkgroupsIndirect'
];

const GPU_BUFFER_USAGE_MAP_WRITE = 0x2;
const METADATA_OPS = new Set([
  ...CREATOR_METHODS.filter(([, kind]) => kind !== 'commandEncoder').map(([name]) => name),
  'createView', 'getBindGroupLayout', 'configure', 'getCurrentTexture'
]);

function classify(value) {
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) return 'sequence';
    return 'descriptor';
  }
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return 'value';
}

export function installWebGpuCapture({ shouldCapture = () => true, onJournal, gpu } = {}) {
  const root = gpu ?? (typeof navigator === 'undefined' ? null : navigator.gpu);
  if (!root || root.__ispettoreCaptured) {
    return { observeCanvasContext() {}, installWarnings: [] };
  }
  root.__ispettoreCaptured = true;

  const wrappedInstances = new WeakSet();
  const journalsByDevice = new WeakMap();
  const mappedAtCreation = new WeakSet();
  const installWarnings = [];

  function defineHook(owner, name, wrapper) {
    try {
      Object.defineProperty(owner, name, {
        value: wrapper,
        configurable: true,
        writable: true,
        enumerable: false
      });
    } catch (_) {
      try {
        owner[name] = wrapper;
      } catch (_) {
        /* handled by verification below */
      }
    }
    if (owner[name] !== wrapper) {
      installWarnings.push(
        `${owner.constructor?.name ?? owner.__ispettoreLabel ?? 'WebGPU object'}.${name} could not be overridden`
      );
      return false;
    }
    return true;
  }

  function resolveValue(journal, value, depth = 0) {
    if (depth > 16) throw new Error('WebGPU descriptor nesting exceeds the capture limit');
    if (ArrayBuffer.isView(value)) return Array.from(value);
    if (Array.isArray(value)) return value.map((item) => resolveValue(journal, item, depth + 1));
    if (value && typeof value === 'object') {
      const ref = resolveWebGpuObjectId(journal.device, value);
      if (ref != null) return { ref };
      if (/^\[object GPU/.test(Object.prototype.toString.call(value))) throw new Error('A referenced WebGPU resource was not observed');
      const out = {};
      for (const [key, item] of Object.entries(value)) out[key] = resolveValue(journal, item, depth + 1);
      return out;
    }
    return value;
  }

  function captureEntry(journal, opName, build) {
    if (!shouldCapture()) return null;
    if (!journal.ensureFrame() && !METADATA_OPS.has(opName)) return null;
    try {
      return build();
    } catch (error) {
      journal.recordFailure(opName, 'arguments', error?.message || String(error));
      if (!journal.recording && METADATA_OPS.has(opName)) {
        const warning = `${opName} metadata could not be captured: ${error?.message || error}`;
        if (!installWarnings.includes(warning)) installWarnings.push(warning);
      }
      return null;
    }
  }

  function wrapUnsupported(instance, journal, ops) {
    for (const name of ops) {
      const original = instance[name];
      if (typeof original !== 'function') continue;
      defineHook(instance, name, (...args) => {
        if (shouldCapture() && journal.ensureFrame()) {
          journal.recordFailure(name, 'unsupported', `${name} arguments and output are not yet captured`);
        }
        return original.apply(instance, args);
      });
    }
  }

  function recordSimpleOp(journal, instance, name) {
    const original = instance[name];
    if (typeof original !== 'function') return;
    defineHook(instance, name, (...args) => {
      const entry = captureEntry(journal, name, () => {
        const resolved = resolveValue(journal, args);
        return { argTypes: resolved.map(classify), args: resolved };
      });
      const command = entry ? journal.record({ op: name, receiverId: resolveWebGpuObjectId(journal.device, instance), ...entry }) : null;
      const result = original.apply(instance, args);
      if (name.startsWith('draw')) journal.previews.draw(instance, command);
      if (ENCODER_COPY_OPS.includes(name)) journal.previews.copy(instance, name, args, command);
      return result;
    });
  }

  function wrapPass(pass, journal, passKind) {
    if (!pass || wrappedInstances.has(pass)) return pass;
    wrappedInstances.add(pass);
    const ops = passKind === 'renderPass' ? RENDER_PASS_OPS : COMPUTE_PASS_OPS;
    for (const name of ops) recordSimpleOp(journal, pass, name);

    const originalEnd = pass.end;
    if (typeof originalEnd === 'function') {
      defineHook(pass, 'end', (...args) => {
        const entry = captureEntry(journal, `${passKind}.end`, () => ({ argTypes: [], args: [] }));
        if (entry) journal.record({ op: `${passKind}.end`, receiverId: resolveWebGpuObjectId(journal.device, pass), ...entry });
        const result = originalEnd.apply(pass, args);
        if (passKind === 'renderPass') journal.previews.endPass(pass);
        return result;
      });
    }
    wrapUnsupported(pass, journal, ['executeBundles', 'writeTimestamp', 'beginOcclusionQuery']);
    return pass;
  }

  function wrapEncoder(encoder, journal) {
    if (!encoder || wrappedInstances.has(encoder)) return encoder;
    wrappedInstances.add(encoder);
    journal.previews.encoder(encoder);

    for (const name of ENCODER_COPY_OPS) recordSimpleOp(journal, encoder, name);

    for (const [name, passKind] of [
      ['beginRenderPass', 'renderPass'],
      ['beginComputePass', 'computePass']
    ]) {
      const original = encoder[name];
      if (typeof original !== 'function') continue;
      defineHook(encoder, name, (...args) => {
        const entry = captureEntry(journal, name, () => {
          const resolved = resolveValue(journal, args);
          return { argTypes: resolved.map(classify), args: resolved };
        });
        const pass = original.apply(encoder, args);
        const passId = registerWebGpuObject(journal.device, pass, passKind);
        const command = entry ? journal.record({ op: name, resultId: passId, receiverId: resolveWebGpuObjectId(journal.device, encoder), ...entry }) : null;
        if (passKind === 'renderPass') journal.previews.beginPass(encoder, pass, args[0] ?? {}, command);
        wrapPass(pass, journal, passKind);
        return pass;
      });
    }

    const originalFinish = encoder.finish;
    if (typeof originalFinish === 'function') {
      defineHook(encoder, 'finish', (...args) => {
        const commandBuffer = originalFinish.apply(encoder, args);
        try {
          const id = registerWebGpuObject(journal.device, commandBuffer, 'commandBuffer');
          const entry = captureEntry(journal, 'finish', () => ({ argTypes: [], args: [] }));
          if (entry) journal.record({ op: 'finish', resultId: id, receiverId: resolveWebGpuObjectId(journal.device, encoder), ...entry });
          journal.previews.finish(encoder, commandBuffer);
        } catch (_) {
          /* identity tracking is best effort */
        }
        return commandBuffer;
      });
    }

    wrapUnsupported(encoder, journal, ['writeTimestamp']);
    return encoder;
  }

  function wrapTexture(texture, journal) {
    if (!texture || wrappedInstances.has(texture)) return texture;
    const originalCreateView = texture.createView;
    if (typeof originalCreateView !== 'function') return texture;
    wrappedInstances.add(texture);
    defineHook(texture, 'createView', (...args) => {
      const view = originalCreateView.apply(texture, args);
      try {
        if (!wrappedInstances.has(view)) {
          wrappedInstances.add(view);
          const entry = captureEntry(journal, 'createView', () => {
            const resolved = resolveValue(journal, [texture, ...args]);
            return { argTypes: resolved.map(classify), args: resolved };
          });
          const existing = resolveWebGpuObjectId(journal.device, view);
          const id = existing ?? registerWebGpuObject(journal.device, view, 'view');
          if (entry && existing == null) {
            journal.registerResource(id, view, { op: 'createView', args: entry.args });
            journal.record({ op: 'createView', resultId: id, ...entry });
          }
          journal.previews.view(view, texture, args[0]);
        }
      } catch (_) {
        /* identity tracking is best effort */
      }
      return view;
    });
    return texture;
  }

  function wrapQueue(queue, journal) {
    if (!queue || wrappedInstances.has(queue)) return queue;
    wrappedInstances.add(queue);

    const originalSubmit = queue.submit;
    if (typeof originalSubmit === 'function') {
      defineHook(queue, 'submit', (...args) => {
        const commandBuffers = Array.from(args[0] ?? []);
        const entry = captureEntry(journal, 'submit', () => {
          const resolved = commandBuffers.map((buffer) => ({
            ref: resolveWebGpuObjectId(journal.device, buffer)
          }));
          return { argTypes: ['sequence'], args: [resolved] };
        });
        const command = entry ? journal.record({ op: 'submit', ...entry }) : null;
        const result = originalSubmit.call(queue, commandBuffers);
        journal.submissionCount++;
        journal.previews.submit(commandBuffers, command);
        return result;
      });
    }

    const originalWriteBuffer = queue.writeBuffer;
    if (typeof originalWriteBuffer === 'function') {
      defineHook(queue, 'writeBuffer', (...args) => {
        const entry = captureEntry(journal, 'writeBuffer', () => {
          const [buffer, offset, data, dataOffset, size] = args;
          const binary = snapshotBinary(data);
          if (!binary) throw new TypeError('writeBuffer data must be an ArrayBuffer view or buffer');
          const resolvedArgs = [{ ref: resolveWebGpuObjectId(journal.device, buffer) }, offset, binary.value];
          const resolvedTypes = ['resource', 'number', binary.type];
          if (dataOffset !== undefined) {
            resolvedArgs.push(dataOffset);
            resolvedTypes.push('number');
            if (size !== undefined) {
              resolvedArgs.push(size);
              resolvedTypes.push('number');
            }
          }
          return { argTypes: resolvedTypes, args: resolvedArgs };
        });
        if (entry) journal.record({ op: 'writeBuffer', ...entry });
        return originalWriteBuffer.apply(queue, args);
      });
    }

    const originalWriteTexture = queue.writeTexture;
    if (typeof originalWriteTexture === 'function') {
      defineHook(queue, 'writeTexture', (...args) => {
        const entry = captureEntry(journal, 'writeTexture', () => {
          const [destination, data, dataLayout, size] = args;
          const binary = snapshotBinary(data);
          if (!binary) throw new TypeError('writeTexture data must be an ArrayBuffer view or buffer');
          const resolvedDestination = resolveValue(journal, [destination])[0];
          const resolvedLayout = resolveValue(journal, [dataLayout ?? {}])[0];
          const resolvedSize = resolveValue(journal, [size ?? null])[0];
          return {
            argTypes: ['descriptor', binary.type, 'descriptor', classify(resolvedSize)],
            args: [resolvedDestination, binary.value, resolvedLayout, resolvedSize]
          };
        });
        if (entry) journal.record({ op: 'writeTexture', ...entry });
        return originalWriteTexture.apply(queue, args);
      });
    }

    wrapUnsupported(queue, journal, ['copyExternalImageToTexture']);
    return queue;
  }

  function wrapWritableBuffer(buffer, journal) {
    const writable =
      mappedAtCreation.has(buffer) || (Number(buffer.usage) & GPU_BUFFER_USAGE_MAP_WRITE) !== 0;
    if (!writable) return;

    const capturedRanges = [];
    const originalGetMappedRange = buffer.getMappedRange;
    if (typeof originalGetMappedRange === 'function') {
      // The app writes into the mapped range after getMappedRange returns, so only the range is
      // remembered here; its bytes are copied at unmap, right before WebGPU detaches it.
      defineHook(buffer, 'getMappedRange', (...args) => {
        const view = originalGetMappedRange.apply(buffer, args);
        capturedRanges.push({ start: typeof args[0] === 'number' ? args[0] : 0, view });
        return view;
      });
    }

    const originalUnmap = buffer.unmap;
    if (typeof originalUnmap === 'function') {
      defineHook(buffer, 'unmap', (...args) => {
      if (buffer.mapState === 'mapped' && capturedRanges.length > 0 && shouldCapture() && journal.ensureFrame()) {
        const id = resolveWebGpuObjectId(journal.device, buffer);
        for (const range of capturedRanges.splice(0)) {
          let bytes;
          try {
            bytes = new Uint8Array(range.view).slice();
          } catch (_) {
            continue;
          }
          if (id == null || bytes.byteLength === 0) continue;
          journal.record({
            op: 'mappedWrite',
            argTypes: ['resource', 'number', 'array-buffer'],
            args: [{ ref: id }, range.start, bytes.buffer],
            resultId: null,
            failed: null,
            error: null
          });
        }
      } else if (buffer.mapState === 'mapped' && shouldCapture() && journal.recording) {
        journal.recordFailure(
          'unmap',
          'arguments',
          'a writable mapping was released without any getMappedRange capture'
        );
      }
      capturedRanges.length = 0;
      return originalUnmap.apply(buffer, args);
      });
    }
  }

  function wrapDevice(device, adapter, deviceRequest) {
    if (!device || wrappedInstances.has(device)) return device;
    wrappedInstances.add(device);

    const journal = createWebGpuDeviceJournal(device, { adapter, deviceRequest });
    journal.captureWarnings = installWarnings;
    journalsByDevice.set(device, journal);
    journal.previews = createWebGpuPreviewCapture(device, journal, device.createBuffer);
    try {
      registerWebGpuObject(device, device, 'device');
    } catch (_) {
      /* identity tracking is best effort */
    }

    for (const [method, kind] of CREATOR_METHODS) {
      const original = device[method];
      if (typeof original === 'function') {
        defineHook(device, method, (...args) => {
          const prepared = captureEntry(journal, method, () => {
            const resolved = resolveValue(journal, args);
            return { argTypes: resolved.map(classify), args: resolved };
          });
          const callArgs = kind === 'texture' ? [previewTextureDescriptor(args[0]), ...args.slice(1)] : args;
          const result = original.apply(device, callArgs);
          try {
            const id = registerWebGpuObject(device, result, kind);
            if (prepared && kind !== 'commandEncoder') journal.registerResource(id, result, { op: method, args: prepared.args });
            if (prepared) journal.record({ op: method, resultId: id, ...prepared });
            if (kind === 'buffer' || kind === 'texture') trackResource(journal, id, result);
            if (kind === 'buffer') {
              if (args[0]?.mappedAtCreation) mappedAtCreation.add(result);
              wrapWritableBuffer(result, journal);
            }
            if (kind === 'commandEncoder') wrapEncoder(result, journal);
            if (kind === 'renderPipeline' || kind === 'computePipeline') wrapPipeline(result, journal);
            if (kind === 'texture') {
              journal.previews.texture(result);
              wrapTexture(result, journal);
            }
          } catch (error) {
            journal.recordFailure(method, 'result', error?.message || String(error));
          }
          return result;
        });
      }

      if (kind === 'renderPipeline' || kind === 'computePipeline') {
        const asyncName = method + 'Async';
        const originalAsync = device[asyncName];
        if (typeof originalAsync === 'function') {
          defineHook(device, asyncName, async (...args) => {
            const prepared = captureEntry(journal, method, () => {
              const resolved = resolveValue(journal, args);
              return { argTypes: resolved.map(classify), args: resolved };
            });
            const result = await originalAsync.apply(device, args);
            try {
              const id = registerWebGpuObject(device, result, kind);
              if (prepared) journal.registerResource(id, result, { op: method, args: prepared.args });
              if (prepared) journal.record({ op: method, resultId: id, ...prepared });
              wrapPipeline(result, journal);
            } catch (error) {
              journal.recordFailure(asyncName, 'result', error?.message || String(error));
            }
            return result;
          });
        }
      }
    }

    wrapQueue(device.queue, journal);

    const refused = installWarnings.filter(
      (warning) => warning.startsWith('GPUDevice.') || warning.startsWith('GPUQueue.')
    );
    if (refused.length) {
      journal.recordFailure(
        'installWebGpuCapture',
        'capture',
        `browser refused method hooks: ${refused.join('; ')}`
      );
    }

    const originalDestroy = typeof device.destroy === 'function' ? device.destroy.bind(device) : null;
    if (originalDestroy) {
      defineHook(device, 'destroy', (...args) => {
        const entry = captureEntry(journal, 'destroy', () => ({ argTypes: [], args: [] }));
        if (entry) journal.record({ op: 'destroy', ...entry });
        return originalDestroy(...args);
      });
    }

    onJournal?.(journal);
    return device;
  }

  function trackResource(journal, id, object) {
    const originalDestroy = object.destroy;
    if (typeof originalDestroy !== 'function') return;
    defineHook(object, 'destroy', (...args) => {
      if (shouldCapture() && journal.ensureFrame()) journal.record({ op: 'resource.destroy', receiverId: id });
      journal.forgetResource(id);
      return originalDestroy.apply(object, args);
    });
  }

  function wrapPipeline(pipeline, journal) {
    if (!pipeline || wrappedInstances.has(pipeline)) return pipeline;
    wrappedInstances.add(pipeline);
    const original = pipeline.getBindGroupLayout;
    if (typeof original !== 'function') return pipeline;
    defineHook(pipeline, 'getBindGroupLayout', (...args) => {
      const layout = original.apply(pipeline, args);
      if (!wrappedInstances.has(layout)) {
        wrappedInstances.add(layout);
        const entry = captureEntry(journal, 'getBindGroupLayout', () => {
          const resolved = resolveValue(journal, [pipeline, ...args]);
          return { argTypes: resolved.map(classify), args: resolved };
        });
        if (entry) {
          const id = registerWebGpuObject(journal.device, layout, 'bindGroupLayout');
          journal.registerResource(id, layout, { op: 'getBindGroupLayout', args: entry.args });
          journal.record({ op: 'getBindGroupLayout', resultId: id, ...entry });
        }
      }
      return layout;
    });
    return pipeline;
  }

  const wrappedAdapters = new WeakSet();
  const originalRequestAdapter = root.requestAdapter.bind(root);
  defineHook(root, 'requestAdapter', async (...args) => {
    const adapter = await originalRequestAdapter(...args);
    if (adapter && !wrappedAdapters.has(adapter)) {
      wrappedAdapters.add(adapter);
      const originalRequestDevice = adapter.requestDevice.bind(adapter);
      defineHook(adapter, 'requestDevice', async (...deviceArgs) => {
        const descriptor = deviceArgs[0] ?? {};
        const deviceRequest = {
          requiredFeatures: [...(descriptor.requiredFeatures ?? [])],
          requiredLimits: descriptor.requiredLimits ? { ...descriptor.requiredLimits } : null,
          defaultQueue: descriptor.defaultQueue ? JSON.parse(JSON.stringify(descriptor.defaultQueue)) : null
        };
        const device = await originalRequestDevice(...deviceArgs);
        return wrapDevice(device, adapter, deviceRequest);
      });
      if (adapter.requestDevice === originalRequestDevice) {
        installWarnings.push('GPUAdapter.requestDevice could not be overridden; WebGPU capture is inactive');
      }
    }
    return adapter;
  });
  if (root.requestAdapter === originalRequestAdapter) {
    installWarnings.push('navigator.gpu.requestAdapter could not be overridden; WebGPU capture is inactive');
  }

  function observeCanvasContext(context) {
    if (!context || wrappedInstances.has(context)) return context;
    wrappedInstances.add(context);

    const originalConfigure = context.configure;
    if (typeof originalConfigure === 'function') {
      defineHook(context, 'configure', (...args) => {
        const [descriptor] = args;
        const journal = descriptor?.device ? journalsByDevice.get(descriptor.device) ?? null : null;
        const entry = journal
          ? captureEntry(journal, 'configure', () => {
              const resolved = resolveValue(journal, args);
              return { argTypes: resolved.map(classify), args: resolved };
            })
          : null;
        if (entry && journal) {
          journal.configuration = {
            format: descriptor.format ?? null,
            alphaMode: descriptor.alphaMode ?? null,
            colorSpace: descriptor.colorSpace ?? null,
            usage: descriptor.usage != null ? Number(descriptor.usage) : null,
            size: descriptor.size
              ? { width: descriptor.size.width ?? null, height: descriptor.size.height ?? null }
              : null
          };
          journal.canvas = { width: context.canvas?.width ?? null, height: context.canvas?.height ?? null };
          journal.record({ op: 'configure', ...entry });
        }
        context.__ispettoreJournal = journal;
        const callArgs = journal
          ? [{ ...descriptor, usage: (descriptor.usage ?? 0x10) | 0x01 }, ...args.slice(1)]
          : args;
        return originalConfigure.apply(context, callArgs);
      });
    }

    const originalGetCurrentTexture = context.getCurrentTexture;
    if (typeof originalGetCurrentTexture === 'function') {
      defineHook(context, 'getCurrentTexture', (...args) => {
        const texture = originalGetCurrentTexture.apply(context, args);
        const journal = context.__ispettoreJournal;
        if (journal) {
          journal.canvas = { width: texture.width, height: texture.height };
          journal.previews.texture(texture, { canvas: true, alphaMode: journal.configuration?.alphaMode ?? 'opaque' });
          wrapTexture(texture, journal);
          if (shouldCapture()) {
            journal.ensureFrame();
            try {
              const existing = resolveWebGpuObjectId(journal.device, texture);
              const id = existing ?? registerWebGpuObject(journal.device, texture, 'canvasTexture');
              if (existing == null) {
                journal.registerResource(id, texture, { op: 'getCurrentTexture', args: [] });
                journal.record({ op: 'getCurrentTexture', resultId: id, argTypes: [], args: [] });
              }
            } catch (_) {
              /* identity tracking is best effort */
            }
          }
        }
        return texture;
      });
    }

    return context;
  }

  return { observeCanvasContext, journalsByDevice, installWarnings };
}
