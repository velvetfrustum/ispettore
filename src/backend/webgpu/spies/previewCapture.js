import { enqueueTexturePreview } from '../capture/livePreview.js';

export function createWebGpuPreviewCapture(device, journal, createBuffer) {
  const views = new WeakMap();
  const textures = new WeakMap();
  const encoders = new WeakMap();
  const passes = new WeakMap();
  const buffers = new WeakMap();
  let previewFrameId = null;
  let previewCount = 0;

  function unavailable(command, reason) {
    if (command) command.preview = { color: { available: false, reason }, reasons: [reason] };
  }

  function enqueue(encoder, texture, command, options = {}) {
    if (!command || !journal.recording) return;
    const state = encoders.get(encoder);
    if (!state || state.frameId !== journal.frameId) {
      unavailable(command, 'The command encoder was created outside this captured frame.');
      return;
    }
    if (previewFrameId !== journal.frameId) { previewFrameId = journal.frameId; previewCount = 0; }
    if (++previewCount > 128) {
      unavailable(command, 'The live preview budget of 128 images per frame was reached.');
      return;
    }
    try {
      const job = enqueueTexturePreview(device, texture, { createBuffer, copyTextureToBuffer: state.copy }, options);
      unavailable(command, 'The encoded output was not submitted during the captured frame.');
      state.jobs.push({ job, command });
    } catch (error) {
      unavailable(command, error?.message || String(error));
    }
  }

  return {
    texture(texture, options = {}) { textures.set(texture, options); },
    view(view, texture, descriptor = {}) { views.set(view, { texture, descriptor }); },
    encoder(encoder) {
      encoders.set(encoder, { copy: encoder.copyTextureToBuffer?.bind(encoder), frameId: journal.frameId, jobs: [] });
    },
    beginPass(encoder, pass, descriptor, command) {
      if (command) passes.set(pass, { encoder, descriptor, command, draw: null, frameId: journal.frameId });
    },
    draw(pass, command) {
      const state = passes.get(pass);
      if (state && command) state.draw = command;
    },
    endPass(pass) {
      const state = passes.get(pass);
      passes.delete(pass);
      if (!state || state.frameId !== journal.frameId || !journal.recording) return;
      const command = state.draw ?? state.command;
      if (!Array.isArray(state.descriptor.colorAttachments)) {
        unavailable(command, 'Live previews require an array of color attachments.');
        return;
      }
      const attachments = (state.descriptor.colorAttachments ?? []).filter(Boolean);
      if (attachments.length !== 1) {
        unavailable(command, 'Live color previews currently require exactly one color attachment.');
        return;
      }
      const attachment = attachments[0];
      if (!attachment.resolveTarget && attachment.storeOp !== 'store') {
        unavailable(command, 'This render pass discards its color attachment.');
        return;
      }
      const view = views.get(attachment.resolveTarget ?? attachment.view);
      if (!view) { unavailable(command, 'The output texture view was not observed.'); return; }
      const { texture, descriptor } = view;
      if ((descriptor.arrayLayerCount ?? 1) !== 1 || (descriptor.dimension && descriptor.dimension !== '2d') || texture.dimension === '3d') {
        unavailable(command, 'Layered and 3D attachment previews are not supported.');
        return;
      }
      enqueue(state.encoder, texture, command, {
        ...textures.get(texture), mipLevel: descriptor.baseMipLevel ?? 0, layer: descriptor.baseArrayLayer ?? 0
      });
    },
    copy(encoder, op, args, command) {
      if (op !== 'copyTextureToTexture' && op !== 'copyBufferToTexture') return;
      if ((args[2]?.depthOrArrayLayers ?? args[2]?.[2] ?? 1) !== 1) {
        unavailable(command, 'Multi-layer texture copies do not have a single captured color image.');
        return;
      }
      const destination = args[1];
      if (destination?.texture) enqueue(encoder, destination.texture, command, {
        ...textures.get(destination.texture), mipLevel: destination.mipLevel ?? 0,
        layer: destination.origin?.z ?? destination.origin?.[2] ?? 0
      });
    },
    finish(encoder, buffer) {
      const state = encoders.get(encoder);
      if (state) buffers.set(buffer, state);
      encoders.delete(encoder);
    },
    submit(commandBuffers, command) {
      for (const buffer of commandBuffers) {
        const state = buffers.get(buffer);
        buffers.delete(buffer);
        if (!state) {
          unavailable(command, 'Submitted commands were encoded outside the captured frame; their outputs were not captured.');
          continue;
        }
        for (const { job, command: event } of state.jobs) {
          const captured = journal.recording && state.frameId === journal.frameId;
          const pending = job.read().then((preview) => {
            if (captured) event.preview = preview;
          }).catch((error) => {
            if (captured) unavailable(event, error?.message || String(error));
          });
          if (captured) journal.addPreview(pending);
        }
      }
    }
  };
}
