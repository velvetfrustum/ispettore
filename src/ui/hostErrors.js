const TIMEOUT_PATTERN = /did not (?:load|respond) within \d+ seconds/i;
const STORAGE_PATTERN = /IndexedDB|quota|storage failed|transaction (?:failed|aborted)/i;
const MISSING_CAPTURE_PATTERN = /capture (?:is )?(?:not )?(?:loaded|found)|no longer exists/i;
const UNSUPPORTED_PACKAGE_PATTERN =
  /Unsupported WebGL capture package|Unsupported WebGPU capture package|not valid JSON|Imported capture is empty/i;

/**
 * Maps inspection-host failures to actionable panel messages. The returned message always
 * states what happened and what the user should do next.
 */
export function describeHostFailure(error, fallback = 'Capture host operation failed') {
  const raw = error?.message || String(error || fallback);

  if (TIMEOUT_PATTERN.test(raw)) {
    return `${raw.replace(/\s*$/, '')} Close and reopen Ispettore, then reload the inspected page before retrying.`;
  }
  if (MISSING_CAPTURE_PATTERN.test(raw)) {
    return `This stored capture is gone or was evicted (${raw}). Refresh the stored captures list and reopen an available capture.`;
  }
  if (UNSUPPORTED_PACKAGE_PATTERN.test(raw)) {
    return `${raw} This build accepts Ispettore WebGL capture packages (schema ispettore-webgl-capture, version 1) and WebGPU capture packages (schema ispettore-webgpu-capture, versions 1 and 2) exported by a compatible release. Older WebGPU events without stored images require a new capture.`;
  }
  if (STORAGE_PATTERN.test(raw)) {
    return `Capture storage failed: ${raw} Captures are kept in extension-origin IndexedDB — check available disk space, then retry.`;
  }
  return raw || fallback;
}
