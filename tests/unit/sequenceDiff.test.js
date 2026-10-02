import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSequences } from '../../src/shared/sequenceDiff.js';

function applyChunks(a, b, chunks) {
  const rebuilt = [];
  let aCursor = 0;
  let bCursor = 0;
  for (const chunk of chunks) {
    assert.equal(chunk.a0, aCursor);
    assert.equal(chunk.b0, bCursor);
    if (chunk.tag === 'equal') assert.deepEqual(a.slice(chunk.a0, chunk.a1), b.slice(chunk.b0, chunk.b1));
    rebuilt.push(...b.slice(chunk.b0, chunk.b1));
    aCursor = chunk.a1;
    bCursor = chunk.b1;
  }
  assert.equal(aCursor, a.length);
  assert.equal(bCursor, b.length);
  assert.deepEqual(rebuilt, b);
}

test('identical sequences produce one equal chunk', () => {
  const { chunks, truncated } = diffSequences(['a', 'b', 'c'], ['a', 'b', 'c']);
  assert.equal(truncated, false);
  assert.deepEqual(chunks, [{ tag: 'equal', a0: 0, a1: 3, b0: 0, b1: 3 }]);
});

test('empty inputs produce no chunks', () => {
  assert.deepEqual(diffSequences([], []).chunks, []);
  assert.deepEqual(diffSequences([], ['x']).chunks, [{ tag: 'insert', a0: 0, a1: 0, b0: 0, b1: 1 }]);
  assert.deepEqual(diffSequences(['x'], []).chunks, [{ tag: 'delete', a0: 0, a1: 1, b0: 0, b1: 0 }]);
});

test('insertions, deletions and replacements become separate chunks', () => {
  const a = ['bind', 'uniform 1', 'draw', 'clear', 'flush'];
  const b = ['bind', 'uniform 2', 'draw', 'draw', 'flush', 'end'];
  const { chunks } = diffSequences(a, b);
  applyChunks(a, b, chunks);
  assert.deepEqual(
    chunks.map((chunk) => chunk.tag),
    ['equal', 'replace', 'equal', 'replace', 'equal', 'insert']
  );
});

test('a lone removal is a delete chunk with an empty B range', () => {
  const a = ['a', 'b', 'x', 'c'];
  const b = ['a', 'b', 'c'];
  const { chunks } = diffSequences(a, b);
  assert.deepEqual(chunks, [
    { tag: 'equal', a0: 0, a1: 2, b0: 0, b1: 2 },
    { tag: 'delete', a0: 2, a1: 3, b0: 2, b1: 2 },
    { tag: 'equal', a0: 3, a1: 4, b0: 2, b1: 3 }
  ]);
});

test('random edits always rebuild B from the chunks', () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let round = 0; round < 50; round++) {
    const a = Array.from({ length: Math.floor(random() * 40) }, () => String(Math.floor(random() * 6)));
    const b = a.filter(() => random() > 0.2).flatMap((item) => (random() > 0.8 ? [item, 'new'] : [item]));
    applyChunks(a, b, diffSequences(a, b).chunks);
  }
});

test('edit distance beyond the budget falls back to one replace chunk', () => {
  const a = Array.from({ length: 50 }, (_, index) => `a${index}`);
  const b = Array.from({ length: 50 }, (_, index) => `b${index}`);
  const { chunks, truncated } = diffSequences(['same', ...a], ['same', ...b], { maxEditDistance: 10 });
  assert.equal(truncated, true);
  assert.deepEqual(chunks, [
    { tag: 'equal', a0: 0, a1: 1, b0: 0, b1: 1 },
    { tag: 'replace', a0: 1, a1: 51, b0: 1, b1: 51 }
  ]);
});

test('coarse keys keep a precise alignment when most lines change', () => {
  const ops = Array.from({ length: 61 }, (_, index) => (index % 3 === 0 ? 'draw' : 'uniform'));
  const a = ops.map((op, index) => `${op}(${index})`);
  const b = ops.map((op, index) => `${op}(${index % 3 === 0 ? index : index + 1000})`);
  const opsB = [...ops, 'flush'];
  b.push('flush()');
  const result = diffSequences(a, b, { maxEditDistance: 10, coarseKeys: [ops, opsB] });
  assert.equal(result.truncated, false);
  assert.equal(result.coarse, true);
  applyChunks(a, b, result.chunks);
  assert.deepEqual(result.chunks.slice(0, 3), [
    { tag: 'equal', a0: 0, a1: 1, b0: 0, b1: 1 },
    { tag: 'replace', a0: 1, a1: 3, b0: 1, b1: 3 },
    { tag: 'equal', a0: 3, a1: 4, b0: 3, b1: 4 }
  ]);
  assert.deepEqual(result.chunks.at(-1), { tag: 'insert', a0: 61, a1: 61, b0: 61, b1: 62 });
});
