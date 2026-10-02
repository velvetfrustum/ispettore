const IMAGE_SOURCE_TAGS = new Set([
  '[object HTMLCanvasElement]',
  '[object OffscreenCanvas]',
  '[object ImageBitmap]',
  '[object HTMLImageElement]',
  '[object HTMLVideoElement]',
  '[object VideoFrame]',
  '[object SVGImageElement]'
]);

const COLORSPACE_NONE_UNSAFE_TAGS = new Set([
  '[object HTMLImageElement]',
  '[object HTMLVideoElement]',
  '[object SVGImageElement]',
  '[object VideoFrame]'
]);

export function isImageSource(value) {
  return value != null && typeof value === 'object' && IMAGE_SOURCE_TAGS.has(Object.prototype.toString.call(value));
}

function flipRows(pixels, width, height) {
  const converted = new Uint8ClampedArray(pixels.length);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    converted.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), (height - 1 - y) * rowBytes);
  }
  return converted;
}

function premultiplyAlpha(pixels) {
  const converted = new Uint8ClampedArray(pixels);
  for (let index = 0; index < converted.length; index += 4) {
    const alpha = converted[index + 3];
    if (alpha === 255) continue;
    converted[index] = Math.round((converted[index] * alpha) / 255);
    converted[index + 1] = Math.round((converted[index + 1] * alpha) / 255);
    converted[index + 2] = Math.round((converted[index + 2] * alpha) / 255);
  }
  return converted;
}

/**
 * Bakes the WebGL flip and premultiply conversions into the RGBA8 bytes read from the 2D
 * canvas. Color management has already happened while drawing the source into that canvas;
 * converting again based on the texture's internal format would corrupt sRGB textures.
 */
export function bakeImageUpload(pixels, { width, height, flipY, premultiply }) {
  let result = pixels;
  if (flipY) result = flipRows(result, width, height);
  if (premultiply) result = premultiplyAlpha(result);
  return result;
}

function imageDimensions(value) {
  if (typeof value.naturalWidth === 'number') return { width: value.naturalWidth, height: value.naturalHeight };
  if (typeof value.videoWidth === 'number') return { width: value.videoWidth, height: value.videoHeight };
  if (typeof value.width === 'number' && typeof value.height === 'number') {
    return { width: value.width, height: value.height };
  }
  return null;
}

function drawToCanvas(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new TypeError('DOM image source cannot be read in this environment');
  context.drawImage(source, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}

/**
 * Reads the raw RGBA8 pixels of a readable TexImageSource. Canvas, bitmap, and video sources
 * are drawn into an offscreen 2D canvas; the resulting bytes are the exact sRGB values the
 * browser would upload for the default color-space conversion. Unreadable (tainted or
 * cross-origin) sources throw, matching the "where readable" capture rule.
 */
export function canonicalizeImageSource(source, options = {}) {
  const sourceTag = Object.prototype.toString.call(source);
  if (!IMAGE_SOURCE_TAGS.has(sourceTag)) {
    throw new TypeError('WebGL texture upload received an unsupported image source');
  }
  if (options.unpackColorSpaceName && options.unpackColorSpaceName !== 'srgb') {
    throw new TypeError(`WebGL texture image source uses unsupported unpack color space ${options.unpackColorSpaceName}`);
  }
  if (options.colorSpaceConversion === 0 && COLORSPACE_NONE_UNSAFE_TAGS.has(sourceTag)) {
    throw new TypeError('WebGL texture image source disables a color conversion that cannot be captured synchronously');
  }
  const dimensions = imageDimensions(source);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
    throw new TypeError('WebGL texture image source has no readable dimensions');
  }

  let pixels;
  try {
    pixels = drawToCanvas(source, dimensions.width, dimensions.height);
  } catch (error) {
    throw new TypeError(
      `WebGL texture image source is not readable (${error.message || 'tainted or cross-origin'})`
    );
  }

  return {
    kind: sourceTag.slice(8, -1),
    width: dimensions.width,
    height: dimensions.height,
    depth: typeof source.depth === 'number' ? source.depth : 1,
    pixels: bakeImageUpload(pixels, {
      width: dimensions.width,
      height: dimensions.height,
      flipY: options.flipY,
      premultiply: options.premultiplyAlpha
    })
  };
}
