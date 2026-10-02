let contextSequence = 0;
const registries = new WeakMap();

function getRegistry(device) {
  let registry = registries.get(device);
  if (!registry) {
    registry = {
      contextId: `gpuctx-${++contextSequence}`,
      objectSequence: 0,
      idsByObject: new WeakMap()
    };
    registries.set(device, registry);
  }
  return registry;
}

export function getWebGpuContextId(device) {
  return getRegistry(device).contextId;
}

export function registerWebGpuObject(device, object, kind) {
  if (!object || typeof object !== 'object') {
    throw new TypeError('WebGPU registry can only register created objects');
  }
  const registry = getRegistry(device);
  if (registry.idsByObject.has(object)) {
    throw new Error('WebGPU object is already registered');
  }
  const id = `${registry.contextId}:${kind}-${++registry.objectSequence}`;
  registry.idsByObject.set(object, id);
  return id;
}

export function resolveWebGpuObjectId(device, object) {
  const registry = registries.get(device);
  if (!registry) return null;
  return registry.idsByObject.get(object) ?? null;
}
