import { snapshotWebGlArguments } from '../capture/snapshotArguments.js';
import { WEBGL_API_SPEC } from './apiSpec.js';

const installedContexts = new WeakMap();
const alwaysCapture = () => true;

function reportCaptureError(onCaptureError, failure) {
  try {
    onCaptureError?.(failure);
  } catch (_) {
    /* instrumentation must not change application behavior */
  }
}

export function installWebGlContextWrappers(
  context,
  {
    spec = WEBGL_API_SPEC,
    snapshotArguments = snapshotWebGlArguments,
    shouldCapture = alwaysCapture,
    invoke,
    onCommand,
    onCaptureError
  } = {}
) {
  if (!context || typeof context !== 'object') throw new TypeError('A WebGL context is required');
  const installed = installedContexts.get(context);
  if (installed) {
    if (
      installed.options.spec !== spec ||
      installed.options.snapshotArguments !== snapshotArguments ||
      installed.options.shouldCapture !== shouldCapture ||
      installed.options.invoke !== invoke ||
      installed.options.onCommand !== onCommand ||
      installed.options.onCaptureError !== onCaptureError
    ) {
      throw new Error('WebGL context wrappers are already installed with different options');
    }
    return installed;
  }

  const originals = new Map();
  const wrappedMethods = [];
  const failures = [];
  const nativeGetParameter =
    typeof context.getParameter === 'function' ? context.getParameter.bind(context) : null;

  function invalidate(failure) {
    failures.push(failure);
    reportCaptureError(onCaptureError, failure);
  }

  for (const descriptor of spec) {
    const original = context[descriptor.name];
    if (typeof original !== 'function') continue;
    originals.set(descriptor.name, original);

    context[descriptor.name] = function (...args) {
      const capture = shouldCapture();
      let capturedArgs = null;
      let captureError = null;
      if (capture) {
        try {
          capturedArgs = snapshotArguments(context, args, descriptor, nativeGetParameter);
        } catch (error) {
          captureError = { stage: 'arguments', descriptor, error };
          invalidate(captureError);
        }
      }

      const result = invoke
        ? invoke({ descriptor, original, thisArg: this, args })
        : Reflect.apply(original, this, args);

      if (capture) {
        try {
          onCommand?.({ descriptor, args: capturedArgs, result, captureError });
        } catch (error) {
          invalidate({ stage: 'command', descriptor, error });
        }
      }
      return result;
    };
    wrappedMethods.push(descriptor.name);
  }

  const controller = {
    context,
    options: Object.freeze({
      spec,
      snapshotArguments,
      shouldCapture,
      invoke,
      onCommand,
      onCaptureError
    }),
    wrappedMethods: Object.freeze(wrappedMethods),
    get valid() {
      return failures.length === 0;
    },
    get failures() {
      return failures.slice();
    },
    uninstall() {
      for (const [name, original] of originals) context[name] = original;
      installedContexts.delete(context);
    }
  };
  installedContexts.set(context, controller);
  return controller;
}
