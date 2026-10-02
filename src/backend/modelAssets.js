const MODEL_FORMATS = {
  gltf: 'glTF',
  glb: 'glTF binary',
  obj: 'Wavefront OBJ'
};

/**
 * Returns the model format key (`gltf`, `glb`, `obj`) for a URL whose path ends in a
 * supported model extension, or null.
 */
export function modelFormatOf(url, base = undefined) {
  let pathname;
  try {
    pathname = new URL(url, base).pathname;
  } catch (_) {
    return null;
  }
  const match = /\.([a-z0-9]+)$/i.exec(pathname);
  const extension = match?.[1]?.toLowerCase();
  return extension && Object.prototype.hasOwnProperty.call(MODEL_FORMATS, extension) ? extension : null;
}

function fileNameOf(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return decodeURIComponent(segments.at(-1) ?? url);
  } catch (_) {
    return url;
  }
}

/**
 * Builds a model asset record from a Resource Timing entry, or null when the entry is not a
 * model file.
 */
export function modelAssetFromEntry(entry, base = undefined) {
  const url = entry?.name;
  if (typeof url !== 'string') return null;
  const format = modelFormatOf(url, base);
  if (!format) return null;
  const size = [entry.decodedBodySize, entry.encodedBodySize, entry.transferSize].find(
    (value) => Number.isFinite(value) && value > 0
  );
  return {
    url,
    fileName: fileNameOf(url),
    format,
    formatLabel: MODEL_FORMATS[format],
    byteSize: size ?? null,
    initiatorType: entry.initiatorType ?? null
  };
}

/**
 * Watches the page's Resource Timing entries for glTF / GLB / OBJ downloads. Resource Timing
 * sees every fetch/XHR the page makes (including loads that started before injection) without
 * wrapping any network API.
 */
export function installModelAssetTracker(win = globalThis) {
  const assets = new Map();
  const base = win.location?.href;

  function record(entry) {
    const asset = modelAssetFromEntry(entry, base);
    if (asset && !assets.has(asset.url)) assets.set(asset.url, asset);
  }

  try {
    for (const entry of win.performance?.getEntriesByType?.('resource') ?? []) record(entry);
  } catch (_) {
    /* Resource Timing unavailable */
  }

  try {
    const Observer = win.PerformanceObserver;
    if (typeof Observer === 'function') {
      const observer = new Observer((list) => {
        for (const entry of list.getEntries()) record(entry);
      });
      observer.observe({ type: 'resource', buffered: true });
    }
  } catch (_) {
    /* PerformanceObserver unavailable */
  }

  return {
    list() {
      return Array.from(assets.values());
    }
  };
}
