const DEFAULT_MAX_EDIT_DISTANCE = 2000;

function internSequences(a, b) {
  const ids = new Map();
  const intern = (items) => {
    const out = new Int32Array(items.length);
    for (let index = 0; index < items.length; index++) {
      const key = items[index];
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size;
        ids.set(key, id);
      }
      out[index] = id;
    }
    return out;
  };
  return [intern(a), intern(b)];
}

// Myers' O((N+M)D) greedy diff. Returns the edit script as [kind, aIndex, bIndex] steps, or
// null once the edit distance exceeds maxD (callers then fall back to one replace chunk).
function myersEdits(a, b, aStart, aEnd, bStart, bEnd, maxD) {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  const max = Math.min(n + m, maxD);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, d);
    }
    v = next;
  }
  return null;
}

function backtrack(trace, n, m, finalD) {
  const steps = [];
  let x = n;
  let y = m;
  for (let d = finalD; d > 0; d--) {
    const v = trace[d];
    const at = (k) => v[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      steps.push(['equal', --x, --y]);
    }
    if (x === prevX) steps.push(['insert', x, --y]);
    else steps.push(['delete', --x, y]);
  }
  while (x > 0 && y > 0) steps.push(['equal', --x, --y]);
  return steps.reverse();
}

function pushChunk(chunks, tag, a0, a1, b0, b1) {
  if (a0 === a1 && b0 === b1) return;
  const last = chunks.at(-1);
  if (last && last.tag === tag) {
    last.a1 = a1;
    last.b1 = b1;
    return;
  }
  if (last && tag !== 'equal' && last.tag !== 'equal') {
    last.tag = 'replace';
    last.a1 = a1;
    last.b1 = b1;
    return;
  }
  chunks.push({ tag, a0, a1, b0, b1 });
}

function refineEqualChunk(chunks, a, b, chunk) {
  for (let offset = 0; offset < chunk.a1 - chunk.a0; offset++) {
    const ai = chunk.a0 + offset;
    const bi = chunk.b0 + offset;
    pushChunk(chunks, a[ai] === b[bi] ? 'equal' : 'replace', ai, ai + 1, bi, bi + 1);
  }
}

/**
 * Aligns two sequences of comparable keys (strings or numbers) and returns Meld-style chunks
 * covering both sides end to end: `equal`, `replace` (changed), `insert` (only in B) and
 * `delete` (only in A), each with half-open `[a0, a1)` / `[b0, b1)` ranges. When the exact
 * alignment exceeds `maxEditDistance`, `coarseKeys: [keysA, keysB]` (one key per item) are
 * aligned instead.
 */
export function diffSequences(a, b, { maxEditDistance = DEFAULT_MAX_EDIT_DISTANCE, coarseKeys = null } = {}) {
  const fine = diffExact(a, b, maxEditDistance);
  if (!fine.truncated || !coarseKeys) return fine;
  // Too many line edits to align exactly (e.g. every matrix uniform changes between frames):
  // align on coarser keys instead, then mark coarse-equal lines whose full text differs.
  const coarse = diffExact(coarseKeys[0], coarseKeys[1], maxEditDistance);
  if (coarse.truncated) return fine;
  const chunks = [];
  for (const chunk of coarse.chunks) {
    if (chunk.tag === 'equal') refineEqualChunk(chunks, a, b, chunk);
    else pushChunk(chunks, chunk.tag, chunk.a0, chunk.a1, chunk.b0, chunk.b1);
  }
  return { chunks, truncated: false, coarse: true };
}

function diffExact(a, b, maxEditDistance) {
  const [left, right] = internSequences(a, b);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix++;
  }
  const aEnd = left.length - suffix;
  const bEnd = right.length - suffix;

  const chunks = [];
  pushChunk(chunks, 'equal', 0, prefix, 0, prefix);
  const steps = myersEdits(left, right, prefix, aEnd, prefix, bEnd, maxEditDistance);
  if (steps) {
    for (const [kind, x, y] of steps) {
      const a0 = prefix + x;
      const b0 = prefix + y;
      if (kind === 'equal') pushChunk(chunks, 'equal', a0, a0 + 1, b0, b0 + 1);
      else if (kind === 'delete') pushChunk(chunks, 'delete', a0, a0 + 1, b0, b0);
      else pushChunk(chunks, 'insert', a0, a0, b0, b0 + 1);
    }
  } else {
    const tag = prefix === aEnd ? 'insert' : prefix === bEnd ? 'delete' : 'replace';
    pushChunk(chunks, tag, prefix, aEnd, prefix, bEnd);
  }
  pushChunk(chunks, 'equal', aEnd, left.length, bEnd, right.length);
  return { chunks, truncated: !steps };
}
