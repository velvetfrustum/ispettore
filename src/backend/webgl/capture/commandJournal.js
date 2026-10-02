import { textByteLength } from '../../../shared/storage/hash.js';
import { installWebGlContextWrappers } from '../intercept/contextWrappers.js';
import { WEBGL_API_SPEC } from '../intercept/apiSpec.js';
import { wrapWebGlExtensionObject } from '../intercept/extensions.js';

function estimateSnapshotBytes(values) {
  if (!Array.isArray(values)) return 0;
  let bytes = 0;
  const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
  for (const value of values) {
    if (value == null) bytes += 1;
    else if (typeof value === 'string') bytes += textByteLength(value);
    else if (typeof value === 'number') bytes += 8;
    else if (typeof value === 'boolean') bytes += 1;
    else if (ArrayBuffer.isView(value)) bytes += value.byteLength;
    else if (value instanceof ArrayBuffer || (hasSharedArrayBuffer && value instanceof SharedArrayBuffer)) bytes += value.byteLength;
    else if (Array.isArray(value)) bytes += value.length * 8;
    else bytes += ArrayBuffer.isView(value.pixels) ? value.pixels.byteLength : 24;
  }
  return bytes + 32;
}

import {
  captureWebGlContextInfo,
  captureWebGlDrawingBufferSize,
  trackWebGlCanvasResize
} from './contextInfo.js';
import {
  getWebGlContextId,
  registerWebGlObject,
  resolveWebGlObjectId,
  retireWebGlObject
} from './objectRegistry.js';
import { bakeEventPreview } from './livePreview.js';
import { createEventDetailsRecorder, mergeCommandStatus } from './eventDetails.js';
import { webGlEventKind } from '../../../inspection/webgl/events.js';

function requestExtension(context, name) {
  try {
    return typeof context.getExtension === 'function' ? context.getExtension(name) : null;
  } catch (_) {
    return null;
  }
}

// WebGL2 times draws with core query objects plus EXT_disjoint_timer_query_webgl2's
// TIME_ELAPSED_EXT target; WebGL1 has no core queries, so EXT_disjoint_timer_query carries
// the whole query API on the extension object. Both are exposed through one small adapter.
function createGpuTimer(context) {
  if (typeof context.createQuery === 'function') {
    const extension = requestExtension(context, 'EXT_disjoint_timer_query_webgl2');
    if (!extension) return null;
    return {
      begin() {
        const query = context.createQuery();
        context.beginQuery(extension.TIME_ELAPSED_EXT, query);
        return query;
      },
      end: () => context.endQuery(extension.TIME_ELAPSED_EXT),
      isAvailable: (query) => context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE),
      result: (query) => context.getQueryParameter(query, context.QUERY_RESULT),
      discard: (query) => context.deleteQuery(query)
    };
  }
  const extension = requestExtension(context, 'EXT_disjoint_timer_query');
  if (!extension) return null;
  return {
    begin() {
      const query = extension.createQueryEXT();
      extension.beginQueryEXT(extension.TIME_ELAPSED_EXT, query);
      return query;
    },
    end: () => extension.endQueryEXT(extension.TIME_ELAPSED_EXT),
    isAvailable: (query) => extension.getQueryObjectEXT(query, extension.QUERY_RESULT_AVAILABLE_EXT),
    result: (query) => extension.getQueryObjectEXT(query, extension.QUERY_RESULT_EXT),
    discard: (query) => extension.deleteQueryEXT(query)
  };
}

// Commands that can change buffer contents: queued buffer samples must be read before they run.
const BUFFER_WRITE_OPS = new Set([
  'bufferData',
  'bufferSubData',
  'copyBufferSubData',
  'deleteBuffer',
  'beginTransformFeedback',
  'readPixels'
]);

function validateBudget(name, value, { integer = false } = {}) {
  if (value === Infinity) return value;
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new TypeError(`${name} must be a non-negative ${integer ? 'integer' : 'number'} or Infinity`);
  }
  return value;
}

function failureReason(stage, captureError) {
  if (captureError?.error?.message) return captureError.error.message;
  return `WebGL ${stage} capture failed`;
}

function resolveReference(context, descriptor, value) {
  if (value == null) return null;
  const id = resolveWebGlObjectId(context, value);
  if (id == null) {
    throw new TypeError(`${descriptor.name} referenced an untracked or deleted WebGL object`);
  }
  return { ref: id };
}

function encodeArgs(context, descriptor, snapshot) {
  const refIndexes = descriptor.argResourceIndexes;
  return snapshot.values.map((value, index) =>
    refIndexes.includes(index) ? resolveReference(context, descriptor, value) : value
  );
}

export function createWebGlCommandJournal(
  context,
  {
    spec = WEBGL_API_SPEC,
    shouldCapture,
    invoke,
    commandBudget = Infinity,
    byteBudget = Infinity,
    maxCommands = Infinity,
    annotate,
    describeTexture,
    getProgramLabel,
    // Eager preview baking and live GPU timing call GL methods on this same wrapped
    // context (getParameter, readPixels, createQuery, ...) purely to introspect state —
    // without this, every one of those introspection calls would recurse back into
    // recordCommand and pollute the captured command log with our own instrumentation
    // traffic instead of the app's. Callers (injected.js) pass their existing
    // "suppress the journal" toggle (`withoutWebGlJournal`); tests default to a no-op.
    runIsolated = (fn) => fn()
  } = {}
) {
  commandBudget = validateBudget('commandBudget', commandBudget, { integer: true });
  byteBudget = validateBudget('byteBudget', byteBudget, { integer: true });
  maxCommands = validateBudget('maxCommands', maxCommands, { integer: true });
  const commands = [];
  const commandBytes = [];
  const failures = [];
  const contextId = getWebGlContextId(context);
  const contextInfo = captureWebGlContextInfo(context);
  const enabledExtensions = new Map();
  const detailsRecorder = createEventDetailsRecorder(context, {
    version: contextInfo.version,
    enabledExtensions,
    describeTexture,
    getProgramLabel
  });
  const nativeGetParameter =
    typeof context.getParameter === 'function' ? context.getParameter.bind(context) : null;
  const nativeActiveTexture =
    typeof context.activeTexture === 'function' ? context.activeTexture.bind(context) : null;
  const resizes = [];
  const frames = [];
  let currentFrame = null;
  let capturedBytes = 0;
  let overflow = null;
  let overLimit = false;
  let evictedCommandCount = 0;
  let lastTimestamp = performance.now();

  // Spector-style bounded capture: nothing is recorded until `arm()` is called, and
  // recording stops automatically as soon as the next full animation frame ends — so a
  // capture is always exactly one frame, regardless of how long the page has been
  // running. `armed` only flips `recording` on at a clean frame boundary (markFrameStart)
  // so a mid-flight frame is never partially captured.
  let armed = false;
  let recording = false;
  let onDemandSeq = 0;

  const gpuTimer = createGpuTimer(context);
  const pendingGpuQueries = [];
  let queryForNextCommand = null;

  function nextDurationMs() {
    const now = performance.now();
    const durationMs = Math.max(0, Math.round((now - lastTimestamp) * 1000) / 1000);
    lastTimestamp = now;
    return durationMs;
  }

  function evictOldest() {
    if (!Number.isFinite(maxCommands) || commands.length <= maxCommands) return;
    const excess = commands.length - maxCommands;
    commands.splice(0, excess);
    const evictedBytes = commandBytes.splice(0, excess).reduce((sum, bytes) => sum + bytes, 0);
    capturedBytes = Math.max(0, capturedBytes - evictedBytes);
    evictedCommandCount += excess;
    const boundary = evictedCommandCount;
    if (currentFrame && currentFrame.startCommandIndex < boundary) {
      currentFrame.startCommandIndex = boundary;
    }
    for (let index = frames.length - 1; index >= 0; index--) {
      const frame = frames[index];
      if (frame.endCommandIndex <= boundary) {
        frames.splice(index, 1);
      } else if (frame.startCommandIndex < boundary) {
        frame.startCommandIndex = boundary;
        frame.commandCount = frame.endCommandIndex - boundary;
      }
    }
    for (let index = resizes.length - 1; index >= 0; index--) {
      if (resizes[index].commandIndex < boundary) resizes.splice(index, 1);
    }
  }

  function setOverflow() {
    if (overflow) return;
    if (Number.isFinite(commandBudget) && commands.length >= commandBudget) {
      overflow = { kind: 'command-count', limit: commandBudget, captured: commands.length };
    } else if (Number.isFinite(byteBudget) && capturedBytes >= byteBudget) {
      overflow = { kind: 'bytes', limit: byteBudget, captured: capturedBytes };
    }
    if (overflow) overLimit = true;
  }

  const overBudget = () =>
    (Number.isFinite(commandBudget) && commands.length >= commandBudget) ||
    (Number.isFinite(byteBudget) && capturedBytes >= byteBudget);

  const pushCommand = (entry, bytes = 0) => {
    commands.push({ durationMs: nextDurationMs(), ...entry });
    commandBytes.push(bytes);
    capturedBytes += bytes;
    evictOldest();
    setOverflow();
  };

  const resizeTracker = trackWebGlCanvasResize(context.canvas, (size) => {
    resizes.push({
      commandIndex: evictedCommandCount + commands.length,
      canvasWidth: size.width,
      canvasHeight: size.height,
      ...captureWebGlDrawingBufferSize(context)
    });
  });
  contextInfo.resizeTracking = {
    complete:
      resizeTracker.trackedProperties.includes('width') &&
      resizeTracker.trackedProperties.includes('height'),
    trackedProperties: [...resizeTracker.trackedProperties]
  };

  const discardQuery = (query) => {
    if (!query) return;
    try {
      runIsolated(() => gpuTimer.discard(query));
    } catch (_) {
      /* best-effort cleanup */
    }
  };

  const setCommandStatus = (commandIndex, status) => {
    const command = commands[commandIndex - evictedCommandCount];
    if (command) command.status = mergeCommandStatus(command.status, status);
  };

  // Apps request extensions once at startup, long before a capture is armed, so extension
  // objects are wrapped and remembered whenever the app obtains them, not only while recording.
  const trackExtension = (name, extension) => {
    if (enabledExtensions.get(name) !== extension) {
      enabledExtensions.set(name, extension);
      detailsRecorder.addExtension(extension);
    }
    wrapWebGlExtensionObject(context, extension, name, {
      shouldCapture,
      invoke,
      onCommand: recordCommand,
      onCaptureError: recordFailure
    });
  };

  const recordCommand = ({ descriptor, args, result, captureError }) => {
    const query = queryForNextCommand;
    queryForNextCommand = null;
    if (descriptor.name === 'getExtension' && result != null && !captureError) {
      trackExtension(args.values[0], result);
    }
    if (!recording && armed && !currentFrame) startOnDemandFrame();
    if (!recording) {
      discardQuery(query);
      // Resource ids must stay assigned for the whole context lifetime, independent of
      // whether we're inside a bounded recording window — otherwise a resource created
      // before arm() (the normal case: real scenes set up their buffers/textures/programs
      // once at startup) could never be referenced once a later frame that uses it is
      // captured. Nothing is logged here, so there is no command to encode a reference for.
      if (!captureError) {
        if (descriptor.category === 'resource' && result != null) {
          try {
            registerWebGlObject(context, result, descriptor.resultKind);
          } catch (_) {
            /* already registered, or an invalid object — a later recording pass will report this */
          }
        } else if (descriptor.category === 'resource-delete') {
          for (const index of descriptor.argResourceIndexes) {
            if (args.values[index] != null) retireWebGlObject(context, args.values[index]);
          }
        }
      }
      return;
    }
    if (overLimit) {
      discardQuery(query);
      return;
    }
    if (overBudget()) {
      setOverflow();
      discardQuery(query);
      return;
    }
    if (captureError) {
      discardQuery(query);
      failures.push({ descriptor, captureError });
      pushCommand({
        op: descriptor.name,
        argTypes: null,
        args: null,
        resultId: null,
        failed: captureError.stage,
        error: failureReason(captureError.stage, captureError)
      });
      return;
    }

    const argTypes = args.types;
    let encodedArgs;
    try {
      encodedArgs = encodeArgs(context, descriptor, args);
    } catch (error) {
      discardQuery(query);
      failures.push({ descriptor, captureError: { stage: 'reference', error } });
      pushCommand({
        op: descriptor.name,
        argTypes,
        args: null,
        resultId: null,
        failed: 'reference',
        error: failureReason('reference', { error })
      });
      return;
    }

    let resultId = null;
    if (descriptor.category === 'resource' && result != null) {
      try {
        resultId = registerWebGlObject(context, result, descriptor.resultKind);
      } catch (error) {
        discardQuery(query);
        failures.push({ descriptor, captureError: { stage: 'result', error } });
        pushCommand({
          op: descriptor.name,
          argTypes,
          args: encodedArgs,
          resultId: null,
          failed: 'result',
          error: failureReason('result', { error })
        });
        return;
      }
    }

    if (descriptor.category === 'resource-delete') {
      for (const index of descriptor.argResourceIndexes) {
        if (args.values[index] != null) {
          retireWebGlObject(context, args.values[index]);
        }
      }
    }

    let semantic = null;
    if (typeof annotate === 'function') {
      try {
        semantic =
          annotate({
            descriptor,
            args,
            result,
            commandIndex: commands.length,
            nativeGetParameter,
            nativeActiveTexture,
            context
          }) ?? null;
      } catch (_) {
        /* semantic instrumentation must never break capture */
      }
    }

    const commandIndex = evictedCommandCount + commands.length;
    pushCommand(
      { op: descriptor.name, argTypes, args: encodedArgs, resultId, failed: null, error: null, semantic },
      estimateSnapshotBytes(args.values)
    );
    detailsRecorder.noteCommand(descriptor.name, args.values, commandIndex);

    if (webGlEventKind(descriptor.name)) {
      const pushed = commands[commands.length - 1];
      const stackTrace = detailsRecorder.captureStack();
      try {
        pushed.preview = runIsolated(() => bakeEventPreview(context));
      } catch (_) {
        /* eager preview baking is best-effort and must never break capture */
      }
      try {
        pushed.details = runIsolated(() =>
          detailsRecorder.consume(
            { op: descriptor.name, values: args.values, types: argTypes, encodedArgs, stackTrace },
            setCommandStatus
          )
        );
      } catch (_) {
        /* command details are best-effort and must never break capture */
      }
      if (query) {
        pendingGpuQueries.push({ commandIndex, query });
      } else {
        discardQuery(query);
      }
    } else {
      discardQuery(query);
    }
  };

  // Render-on-demand pages (e.g. OrbitControls 'change' -> renderer.render()) draw from event
  // handlers, never inside a requestAnimationFrame callback, so an armed capture would wait
  // forever. A GL command issued while armed outside any frame opens an on-demand frame that
  // closes once the current task's synchronous work finishes; it only counts if it drew.
  function startOnDemandFrame() {
    const frameId = `on-demand:${++onDemandSeq}`;
    journal.markFrameStart({ frameId, label: 'on-demand render', kind: 'on-demand' });
    queueMicrotask(() => {
      if (currentFrame?.frameId === frameId) journal.markFrameEnd();
    });
  }

  function rangeHasRenderEvent(start, end) {
    for (let index = start; index < end; index++) {
      const kind = webGlEventKind(commands[index - evictedCommandCount]?.op);
      if (kind === 'draw' || kind === 'clear') return true;
    }
    return false;
  }

  const recordFailure = (failure) => {
    if (!recording) return;
    if (overLimit) return;
    if (overBudget()) {
      setOverflow();
      return;
    }
    if (failure.stage !== 'command') return;
    failures.push(failure);
    pushCommand({
      op: failure.descriptor.name,
      argTypes: null,
      args: null,
      resultId: null,
      failed: 'command',
      error: failureReason('command', failure)
    });
  };

  // GPU timing must bracket the real GL call itself (beginQuery/endQuery around it), but
  // `invoke` runs before `onCommand`/recordCommand ever sees the descriptor — so timing is
  // wired in here, one layer below the journal's own command recording.
  const timedInvoke = ({ descriptor, original, thisArg, args }) => {
    const runOriginal = () => (invoke ? invoke({ descriptor, original, thisArg, args }) : Reflect.apply(original, thisArg, args));
    const willBeRecorded = typeof shouldCapture === 'function' ? shouldCapture() : true;
    if (recording && willBeRecorded && BUFFER_WRITE_OPS.has(descriptor.name)) {
      try {
        runIsolated(() => detailsRecorder.flushSamples());
      } catch (_) {
        /* buffer samples are best-effort */
      }
    }
    if (!recording || !willBeRecorded || !gpuTimer || !webGlEventKind(descriptor.name)) {
      return runOriginal();
    }
    let query = null;
    runIsolated(() => {
      try {
        query = gpuTimer.begin();
      } catch (_) {
        query = null;
      }
    });
    try {
      return runOriginal();
    } finally {
      if (query) {
        runIsolated(() => {
          try {
            gpuTimer.end();
            queryForNextCommand = query;
          } catch (_) {
            queryForNextCommand = null;
          }
        });
      }
    }
  };

  const controller = installWebGlContextWrappers(context, {
    spec,
    shouldCapture,
    invoke: timedInvoke,
    onCommand: recordCommand,
    onCaptureError: recordFailure
  });

  const journal = {
    contextId,
    contextInfo,
    commands,
    get evictedCommandCount() {
      return evictedCommandCount;
    },
    get resizes() {
      return resizes.slice();
    },
    get frames() {
      return frames.slice();
    },
    get capturedBytes() {
      return capturedBytes;
    },
    get overflow() {
      return overflow ? { ...overflow } : null;
    },
    get armed() {
      return armed;
    },
    get recording() {
      return recording;
    },
    /**
     * Spector-style arm: recording starts at the next clean frame boundary and stops
     * automatically once that one frame ends, so a capture is always exactly one frame.
     */
    arm() {
      if (recording) return false;
      armed = true;
      return true;
    },
    /** Best-effort GPU timings for this capture's baked events (commandIndex -> ms). */
    async collectPendingGpuTimings() {
      if (!pendingGpuQueries.length) return new Map();
      const pending = pendingGpuQueries.splice(0, pendingGpuQueries.length);
      const timings = new Map();
      const deadline = performance.now() + 500;
      try {
        while (performance.now() < deadline) {
          const allAvailable = pending.every(({ query }) => {
            try {
              return gpuTimer.isAvailable(query);
            } catch (_) {
              return true;
            }
          });
          if (allAvailable) break;
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
        for (const { commandIndex, query } of pending) {
          try {
            if (!gpuTimer.isAvailable(query)) continue;
            const nanoseconds = gpuTimer.result(query);
            const ms = Number(nanoseconds) / 1e6;
            if (Number.isFinite(ms) && ms >= 0) timings.set(commandIndex, Math.round(ms * 1000) / 1000);
          } catch (_) {
            /* GPU timing is best effort */
          }
        }
      } finally {
        for (const { query } of pending) discardQuery(query);
      }
      return timings;
    },
    markFrameStart({ frameId, label, kind }) {
      if (typeof frameId !== 'string' || !frameId) throw new TypeError('Capture frames require a frame id');
      if (currentFrame) this.markFrameEnd();
      if (armed) {
        armed = false;
        recording = true;
        commands.length = 0;
        commandBytes.length = 0;
        capturedBytes = 0;
        failures.length = 0;
        overflow = null;
        overLimit = false;
        evictedCommandCount = 0;
        frames.length = 0;
        pendingGpuQueries.length = 0;
        queryForNextCommand = null;
        try {
          runIsolated(() => detailsRecorder.beginFrame());
        } catch (_) {
          /* the state baseline is best-effort */
        }
      }
      if (overLimit) return;
      lastTimestamp = performance.now();
      currentFrame = { frameId, label: typeof label === 'string' ? label : 'frame', kind: typeof kind === 'string' ? kind : 'animation-frame', startCommandIndex: evictedCommandCount + commands.length };
    },
    markFrameEnd() {
      if (!currentFrame) {
        return;
      }
      const endCommandIndex = evictedCommandCount + commands.length;
      const emptyOnDemand =
        currentFrame.kind === 'on-demand' && !rangeHasRenderEvent(currentFrame.startCommandIndex, endCommandIndex);
      if (endCommandIndex === currentFrame.startCommandIndex || emptyOnDemand) {
        // A page can have more than one requestAnimationFrame-driven callback running (e.g. a
        // GUI's own polling loop alongside the renderer's animation loop) — each one brackets
        // its own markFrameStart/markFrameEnd against this same journal. If the armed frame
        // that just ended happened to be one of those no-op callbacks rather than the real
        // render, the arm token must survive to the next tick instead of being silently spent
        // on a frame that issued no GL commands at all.
        const wasArmedFrame = recording;
        currentFrame = null;
        recording = false;
        if (wasArmedFrame) armed = true;
        return;
      }
      frames.push({
        ...currentFrame,
        endCommandIndex,
        commandCount: endCommandIndex - currentFrame.startCommandIndex
      });
      if (recording) runIsolated(() => detailsRecorder.finishFrame(setCommandStatus));
      currentFrame = null;
      recording = false;
    },
    setBudget({ commandBudget: nextCommandBudget, byteBudget: nextByteBudget }) {
      const validatedCommandBudget = nextCommandBudget == null
        ? commandBudget
        : validateBudget('commandBudget', nextCommandBudget, { integer: true });
      const validatedByteBudget = nextByteBudget == null
        ? byteBudget
        : validateBudget('byteBudget', nextByteBudget, { integer: true });
      commandBudget = validatedCommandBudget;
      byteBudget = validatedByteBudget;
      setOverflow();
    },
    get programSources() {
      return detailsRecorder.programSources;
    },
    wrappedMethods: controller.wrappedMethods,
    get valid() {
      return failures.length === 0;
    },
    get failures() {
      return failures.slice();
    },
    uninstall() {
      controller.uninstall();
      resizeTracker.uninstall();
    }
  };
  return journal;
}
