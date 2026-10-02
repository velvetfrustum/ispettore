import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getWebGlContextId,
  registerWebGlObject,
  resolveWebGlObjectId,
  retireWebGlObject
} from '../../src/backend/webgl/capture/objectRegistry.js';

describe('WebGL object registry', () => {
  it('assigns stable ids that never alias after deletion and recreation', () => {
    const context = {};
    const bufferA = {};
    const idA = registerWebGlObject(context, bufferA, 'buffer');
    assert.equal(resolveWebGlObjectId(context, bufferA), idA);

    assert.equal(retireWebGlObject(context, bufferA), idA);
    assert.equal(resolveWebGlObjectId(context, bufferA), null);

    const bufferB = {};
    const idB = registerWebGlObject(context, bufferB, 'buffer');
    assert.notEqual(idB, idA);
  });

  it('isolates ids and context identity across contexts', () => {
    const contextA = {};
    const contextB = {};
    assert.notEqual(getWebGlContextId(contextA), getWebGlContextId(contextB));

    const objectA = {};
    const objectB = {};
    const idA = registerWebGlObject(contextA, objectA, 'buffer');
    const idB = registerWebGlObject(contextB, objectB, 'buffer');
    assert.notEqual(idA, idB);
    assert.equal(resolveWebGlObjectId(contextB, objectA), null);
  });

  it('rejects registering a non-object result', () => {
    assert.throws(() => registerWebGlObject({}, null, 'buffer'), /created objects/);
  });

  it('rejects registering the same object twice', () => {
    const context = {};
    const object = {};
    registerWebGlObject(context, object, 'buffer');
    assert.throws(() => registerWebGlObject(context, object, 'buffer'), /already registered/);
  });

  it('treats an unobserved context as having no known objects', () => {
    assert.equal(resolveWebGlObjectId({}, {}), null);
    assert.equal(retireWebGlObject({}, {}), null);
  });
});
