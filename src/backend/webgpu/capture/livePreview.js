const COLOR_FORMATS = new Set(['rgba8unorm', 'rgba8unorm-srgb', 'bgra8unorm', 'bgra8unorm-srgb']);

export function previewTextureDescriptor(descriptor) {
  if (!descriptor || !COLOR_FORMATS.has(descriptor.format) || (descriptor.sampleCount ?? 1) !== 1) return descriptor;
  return { ...descriptor, usage: descriptor.usage | 0x01 };
}

export function enqueueTexturePreview(device, texture, raw, options = {}) {
  const { format } = texture;
  if (!COLOR_FORMATS.has(format)) throw new Error(`Texture format ${format} has no live color preview path`);
  if (texture.sampleCount > 1) throw new Error('Multisampled output requires a resolve target for a live preview');
  const mipLevel = options.mipLevel ?? 0;
  const width = Math.max(1, texture.width >> mipLevel);
  const height = Math.max(1, texture.height >> mipLevel);
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const buffer = raw.createBuffer.call(device, { size: bytesPerRow * height, usage: 0x09 });
  let validation = Promise.resolve(null);
  try {
    device.pushErrorScope?.('validation');
    try {
      raw.copyTextureToBuffer(
        { texture, mipLevel, origin: [0, 0, options.layer ?? 0] },
        { buffer, bytesPerRow, rowsPerImage: height }, [width, height, 1]
      );
    } finally {
      if (device.popErrorScope) validation = device.popErrorScope();
      validation.catch(() => {});
    }
  } catch (error) {
    buffer.destroy();
    throw error;
  }
  return {
    async read() {
      let timer;
      try {
        await Promise.race([
          (async () => {
            const error = await validation;
            if (error) throw new Error(error.message);
            await buffer.mapAsync(0x01);
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('The GPU did not return the captured image within 10 seconds')), 10000);
          })
        ]);
        const bytes = new Uint8Array(buffer.getMappedRange());
        const pixels = new Uint8ClampedArray(width * height * 4);
        const bgra = format.startsWith('bgra');
        let min = 255;
        let max = 0;
        let hash = 0x811c9dc5;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const source = y * bytesPerRow + x * 4;
            const target = (y * width + x) * 4;
            const alpha = options.alphaMode === 'opaque' ? 255 : bytes[source + 3];
            for (let channel = 0; channel < 3; channel++) {
              const value = bytes[source + (bgra ? 2 - channel : channel)];
              pixels[target + channel] = options.alphaMode === 'premultiplied' && alpha > 0 ? value * 255 / alpha : value;
              min = Math.min(min, pixels[target + channel]);
              max = Math.max(max, pixels[target + channel]);
            }
            pixels[target + 3] = alpha;
            for (let channel = 0; channel < 4; channel++) hash = Math.imul(hash ^ pixels[target + channel], 0x01000193) >>> 0;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
        return {
          width, height, colorTarget: options.canvas ? 'default' : 'framebuffer',
          color: { preview: canvas.toDataURL('image/png'), min, max, range: max - min, hash }
        };
      } finally {
        clearTimeout(timer);
        buffer.destroy();
      }
    }
  };
}
