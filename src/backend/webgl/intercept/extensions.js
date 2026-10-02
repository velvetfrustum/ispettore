import { snapshotWebGlArguments } from '../capture/snapshotArguments.js';

const wrappedObjects = new WeakSet();

function method(name, extension, category, { resultKind = null, argResourceIndexes = [] } = {}) {
  return Object.freeze({
    extension,
    name,
    category,
    resultKind,
    argResourceIndexes: Object.freeze([...argResourceIndexes])
  });
}

const EXTENSION_METHODS = Object.freeze([
  method('framebufferTexture2DMultisampleEXT', 'WEBGL_multisampled_render_to_texture', 'resource-state', {
    argResourceIndexes: [3]
  }),
  method('renderbufferStorageMultisampleEXT', 'WEBGL_multisampled_render_to_texture', 'resource-state'),
  method('multiDrawArraysWEBGL', 'WEBGL_multi_draw', 'action'),
  method('multiDrawElementsWEBGL', 'WEBGL_multi_draw', 'action'),
  method('getTranslatedShaderSource', 'WEBGL_debug_shaders', 'readback', {
    argResourceIndexes: [0]
  }),
  method('beginQueryEXT', 'EXT_disjoint_timer_query_webgl2', 'resource-state', {
    argResourceIndexes: [1]
  }),
  method('endQueryEXT', 'EXT_disjoint_timer_query_webgl2', 'resource-state'),
  method('queryCounterEXT', 'EXT_disjoint_timer_query_webgl2', 'resource-state', {
    argResourceIndexes: [0]
  }),
  method('drawArraysInstancedANGLE', 'ANGLE_instanced_arrays', 'action'),
  method('drawElementsInstancedANGLE', 'ANGLE_instanced_arrays', 'action'),
  method('vertexAttribDivisorANGLE', 'ANGLE_instanced_arrays', 'context-state'),
  method('createVertexArrayOES', 'OES_vertex_array_object', 'resource', { resultKind: 'vertex-array' }),
  method('deleteVertexArrayOES', 'OES_vertex_array_object', 'resource-delete', { argResourceIndexes: [0] }),
  method('isVertexArrayOES', 'OES_vertex_array_object', 'resource-state', { argResourceIndexes: [0] }),
  method('bindVertexArrayOES', 'OES_vertex_array_object', 'resource-state', { argResourceIndexes: [0] }),
  method('drawBuffersWEBGL', 'WEBGL_draw_buffers', 'context-state'),
  method('createQueryEXT', 'EXT_disjoint_timer_query', 'resource', { resultKind: 'query' }),
  method('deleteQueryEXT', 'EXT_disjoint_timer_query', 'resource-delete', { argResourceIndexes: [0] }),
  method('isQueryEXT', 'EXT_disjoint_timer_query', 'resource-state', { argResourceIndexes: [0] }),
  method('beginQueryEXT', 'EXT_disjoint_timer_query', 'resource-state', { argResourceIndexes: [1] }),
  method('endQueryEXT', 'EXT_disjoint_timer_query', 'resource-state'),
  method('queryCounterEXT', 'EXT_disjoint_timer_query', 'resource-state', { argResourceIndexes: [0] }),
  method('getQueryEXT', 'EXT_disjoint_timer_query', 'context-state'),
  method('getQueryObjectEXT', 'EXT_disjoint_timer_query', 'resource-state', { argResourceIndexes: [0] })
]);

const METHODS_BY_EXTENSION = new Map();
for (const descriptor of EXTENSION_METHODS) {
  const list = METHODS_BY_EXTENSION.get(descriptor.extension) ?? [];
  list.push(descriptor);
  METHODS_BY_EXTENSION.set(descriptor.extension, list);
}

export function extensionMethodsFor(extensionName) {
  return METHODS_BY_EXTENSION.get(extensionName) ?? [];
}

function reportCaptureError(onCaptureError, failure) {
  try {
    onCaptureError?.(failure);
  } catch (_) {
    /* instrumentation must not change application behavior */
  }
}

/**
 * Wraps the state-affecting methods of a WebGL extension object so their calls are recorded
 * into the same journal as the context that produced them. Extension objects are per-context
 * singletons, so a module-level WeakSet is enough to keep wrapping idempotent.
 */
export function wrapWebGlExtensionObject(context, extension, extensionName, options = {}) {
  if (!extension || typeof extension !== 'object' || wrappedObjects.has(extension)) return null;

  const {
    shouldCapture = () => true,
    snapshotArguments = snapshotWebGlArguments,
    invoke,
    onCommand,
    onCaptureError
  } = options;
  const descriptors = extensionMethodsFor(extensionName);
  const wrappedMethods = [];

  for (const descriptor of descriptors) {
    const original = extension[descriptor.name];
    if (typeof original !== 'function') continue;

    extension[descriptor.name] = function (...args) {
      const capture = shouldCapture();
      let capturedArgs = null;
      let captureError = null;
      if (capture) {
        try {
          capturedArgs = snapshotArguments(context, args, descriptor, null);
        } catch (error) {
          captureError = { stage: 'arguments', descriptor, error };
          reportCaptureError(onCaptureError, captureError);
        }
      }

      const result = invoke
        ? invoke({ descriptor, original, thisArg: this, args })
        : Reflect.apply(original, this, args);

      if (capture) {
        try {
          onCommand?.({ descriptor, args: capturedArgs, result, captureError });
        } catch (error) {
          reportCaptureError(onCaptureError, { stage: 'command', descriptor, error });
        }
      }
      return result;
    };
    wrappedMethods.push(descriptor.name);
  }

  wrappedObjects.add(extension);
  return { extensionName, wrappedMethods };
}