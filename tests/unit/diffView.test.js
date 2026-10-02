import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineTokenDiff, pairChangedLines, summarizeChunks } from '../../src/ui/diffView.js';

test('inline token diff flags only the differing arguments', () => {
  const { a, b } = inlineTokenDiff('uniform1f(loc-2, 0.5)', 'uniform1f(loc-2, 0.75)');
  assert.deepEqual(a.filter((token) => token.changed).map((token) => token.text), ['0.5']);
  assert.deepEqual(b.filter((token) => token.changed).map((token) => token.text), ['0.75']);
  assert.equal(a.map((token) => token.text).join(''), 'uniform1f(loc-2, 0.5)');
});

test('chunk summary counts changed, added and removed lines', () => {
  const summary = summarizeChunks([
    { tag: 'equal', a0: 0, a1: 4, b0: 0, b1: 4 },
    { tag: 'replace', a0: 4, a1: 6, b0: 4, b1: 7 },
    { tag: 'equal', a0: 6, a1: 8, b0: 7, b1: 9 },
    { tag: 'delete', a0: 8, a1: 10, b0: 9, b1: 9 },
    { tag: 'insert', a0: 10, a1: 10, b0: 9, b1: 10 }
  ]);
  assert.deepEqual(summary, { changes: 3, changed: 2, inserted: 2, removed: 2 });
});

test('changed lines pair by command name, not by offset', () => {
  const linesA = ['clear()', 'drawElements(4, 66)', 'uniform4fv(a, 1)'];
  const linesB = ['clear()', 'uniform4fv(a, 2)'];
  const pairs = pairChangedLines({ tag: 'replace', a0: 1, a1: 3, b0: 1, b1: 2 }, linesA, linesB);
  assert.deepEqual(Array.from(pairs), [[2, 1]]);
});
