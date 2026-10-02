import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebGlDrawSemantics, isWebGlDrawOp } from '../../src/backend/webgl/semantic/drawSemantics.js';

function fakeContext() {
  const state = { currentProgram: null, activeUnit: 8420, bindings: [null, null, null, null, null, null, null, null] };
  return {
    TEXTURE0: 33984,
    CURRENT_PROGRAM: 0x86b7,
    ACTIVE_TEXTURE: 0x84e0,
    TEXTURE_BINDING_2D: 0x8069,
    getParameter(name) {
      if (name === this.CURRENT_PROGRAM) return state.currentProgram;
      if (name === this.ACTIVE_TEXTURE) return state.activeUnit;
      if (name === this.TEXTURE_BINDING_2D) return state.bindings[state.activeUnit - this.TEXTURE0];
      throw new Error(`unexpected pname ${name}`);
    },
    activeTexture(unit) {
      state.activeUnit = unit;
    },
    __state: state
  };
}

function buildAnnotator(overrides = {}) {
  const programs = new Map();
  const textureByObject = new Map();
  const annotator = createWebGlDrawSemantics({
    getRenderObject: () => null,
    getActivePass: () => null,
    getProgramEntry: (program) => programs.get(program),
    getTextureEntry: (texture) => textureByObject.get(texture),
    summarizeMesh: () => null,
    ...overrides
  });
  return { annotator, programs, textureByObject };
}

test('draw operations are annotated', () => {
  const { annotator } = buildAnnotator();
  for (const op of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
    assert.equal(isWebGlDrawOp(op), true);
    assert.notEqual(annotator({ descriptor: { name: op }, context: null }), null);
  }
});

test('clear and blit get pass-only annotation — no object, material, program, or textures', () => {
  const { annotator } = buildAnnotator({
    getActivePass: () => ({ index: 0, name: 'Scene', kind: 'scene', renderTarget: 'offscreen' })
  });
  for (const op of ['clear', 'blitFramebuffer']) {
    assert.equal(isWebGlDrawOp(op), false);
    const semantic = annotator({ descriptor: { name: op }, context: null });
    assert.notEqual(semantic, null);
    assert.equal(semantic.object, null);
    assert.equal(semantic.material, null);
    assert.equal(semantic.program, null);
    assert.deepEqual(semantic.textures, []);
    assert.equal(semantic.pass.name, 'Scene');
  }
});

test('operations unrelated to draws, clears, or blits are not annotated', () => {
  const { annotator } = buildAnnotator();
  for (const op of ['bindBuffer', undefined]) {
    assert.equal(isWebGlDrawOp(op), false);
    assert.equal(annotator({ descriptor: { name: op }, context: null }), null);
  }
});

test('draw semantics capture object, material, pass, program, and bound textures', () => {
  const program = {};
  const textureA = {};
  const textureB = {};
  const { annotator, programs, textureByObject } = buildAnnotator({
    getRenderObject: () => ({
      object: { uuid: 'mesh-1', name: 'HeroCube', type: 'Mesh' },
      material: [{ type: 'MeshStandardMaterial', name: '', transparent: false }],
      group: { materialIndex: 2 }
    }),
    getActivePass: () => ({ index: 1, name: 'Bloom', kind: 'post', role: null, renderTarget: 'offscreen' })
  });
  programs.set(program, { label: 'standard-pbr' });
  textureByObject.set(textureA, { width: 64, height: 64 });
  textureByObject.set(textureB, {});

  const ctx = fakeContext();
  ctx.__state.currentProgram = program;
  ctx.__state.bindings[0] = textureA;
  ctx.__state.bindings[2] = textureB;

  const semantic = annotator({ descriptor: { name: 'drawElements' }, nativeGetParameter: (n) => ctx.getParameter(n), nativeActiveTexture: (u) => ctx.activeTexture(u), context: ctx });

  assert.deepEqual(semantic.object, { uuid: 'mesh-1', name: 'HeroCube', type: 'Mesh', summary: null });
  assert.deepEqual(semantic.material, {
    type: 'MeshStandardMaterial',
    name: null,
    label: 'MeshStandardMaterial',
    index: 2,
    transparent: false
  });
  assert.deepEqual(semantic.pass, { index: 1, name: 'Bloom', kind: 'post', role: null, renderTarget: 'offscreen', effect: null, step: null });
  assert.deepEqual(semantic.program, { ref: null, label: 'standard-pbr' });
  assert.equal(semantic.textures.length, 2);
  assert.deepEqual(semantic.textures[0], { ref: null, target: 'TEXTURE_2D', width: 64, height: 64, label: 'TEXTURE_2D 64×64' });
  assert.deepEqual(semantic.textures[1], { ref: null, target: 'TEXTURE_2D', width: null, height: null, label: 'TEXTURE_2D' });

  assert.equal(ctx.__state.activeUnit, 8420);
});

test('active texture unit is restored even when a binding query throws', () => {
  let active = 8420;
  const ctx = {
    TEXTURE0: 33984,
    CURRENT_PROGRAM: 0x86b7,
    ACTIVE_TEXTURE: 0x84e0,
    TEXTURE_BINDING_2D: 0x8069,
    getParameter(name) {
      if (name === this.CURRENT_PROGRAM || name === this.ACTIVE_TEXTURE) return name === this.ACTIVE_TEXTURE ? active : null;
      throw new Error('driver exploded');
    },
    activeTexture(unit) {
      active = unit;
    }
  };
  const { annotator } = buildAnnotator();

  const semantic = annotator({
    descriptor: { name: 'drawArrays' },
    nativeGetParameter: (name) => ctx.getParameter(name),
    nativeActiveTexture: (unit) => ctx.activeTexture(unit),
    context: ctx
  });

  assert.equal(active, 8420);
  assert.deepEqual(semantic.textures, []);
  assert.equal(semantic.program, null);
});
