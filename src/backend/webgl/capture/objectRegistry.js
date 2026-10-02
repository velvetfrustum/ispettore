let contextSequence = 0;
const registries = new WeakMap();

function getRegistry(context) {
  let registry = registries.get(context);
  if (!registry) {
    registry = {
      contextId: `ctx-${++contextSequence}`,
      objectSequence: 0,
      idsByObject: new WeakMap()
    };
    registries.set(context, registry);
  }
  return registry;
}

export function getWebGlContextId(context) {
  return getRegistry(context).contextId;
}

export function registerWebGlObject(context, object, kind) {
  if (!object || typeof object !== 'object') {
    throw new TypeError('WebGL registry can only register created objects');
  }
  const registry = getRegistry(context);
  if (registry.idsByObject.has(object)) {
    throw new Error('WebGL object is already registered');
  }
  const id = `${registry.contextId}:${kind}-${++registry.objectSequence}`;
  registry.idsByObject.set(object, id);
  return id;
}

export function resolveWebGlObjectId(context, object) {
  const registry = registries.get(context);
  if (!registry) return null;
  return registry.idsByObject.get(object) ?? null;
}

export function retireWebGlObject(context, object) {
  const registry = registries.get(context);
  if (!registry) return null;
  const id = registry.idsByObject.get(object);
  if (id == null) return null;
  registry.idsByObject.delete(object);
  return id;
}
