import test from 'node:test';
import assert from 'node:assert/strict';
import { programTitle } from '../../src/ui/shaderTabs.js';

test('program titles name the shader stages they contain', () => {
  const vertex = { type: 'vertex', source: 'void main() {}' };
  const fragment = { type: 'fragment', source: 'void main() {}' };
  assert.equal(programTitle({ label: 'program#1', shaders: [vertex, fragment] }), 'program#1 · vertex + fragment');
  assert.equal(programTitle({ label: 'program#2', shaders: [fragment] }), 'program#2 · fragment');
  assert.equal(programTitle({ label: 'program#3', shaders: [{ type: 'compute', source: '' }] }), 'program#3 · compute');
  assert.equal(programTitle({ label: '', shaders: [] }), 'Program · no shaders');
});
