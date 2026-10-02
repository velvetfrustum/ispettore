import { diffSequences } from '../shared/sequenceDiff.js';

const FOLD_CONTEXT = 3;
const GUTTER_WIDTH = 44;
const TOKEN_PATTERN = /(\s+|[(),[\]‹›])/;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Splits two changed lines into tokens and flags the ones that differ, so a changed row can
 * highlight only its differing arguments.
 */
export function inlineTokenDiff(lineA, lineB) {
  const tokensA = lineA.split(TOKEN_PATTERN).filter(Boolean);
  const tokensB = lineB.split(TOKEN_PATTERN).filter(Boolean);
  const changedA = new Array(tokensA.length).fill(false);
  const changedB = new Array(tokensB.length).fill(false);
  for (const chunk of diffSequences(tokensA, tokensB, { maxEditDistance: 200 }).chunks) {
    if (chunk.tag === 'equal') continue;
    for (let index = chunk.a0; index < chunk.a1; index++) changedA[index] = true;
    for (let index = chunk.b0; index < chunk.b1; index++) changedB[index] = true;
  }
  return {
    a: tokensA.map((text, index) => ({ text, changed: changedA[index] })),
    b: tokensB.map((text, index) => ({ text, changed: changedB[index] }))
  };
}

/**
 * Summarizes chunk counts for the diff toolbar: changed, inserted (only in B) and removed
 * (only in A) lines.
 */
export function summarizeChunks(chunks) {
  const summary = { changes: 0, changed: 0, inserted: 0, removed: 0 };
  for (const chunk of chunks) {
    if (chunk.tag === 'equal') continue;
    summary.changes++;
    const lengthA = chunk.a1 - chunk.a0;
    const lengthB = chunk.b1 - chunk.b0;
    if (chunk.tag === 'replace') {
      summary.changed += Math.min(lengthA, lengthB);
      summary.inserted += Math.max(0, lengthB - lengthA);
      summary.removed += Math.max(0, lengthA - lengthB);
    } else {
      summary.inserted += lengthB;
      summary.removed += lengthA;
    }
  }
  return summary;
}

function tokensHtml(tokens) {
  return tokens
    .map((token) => (token.changed ? `<mark class="meld-inline">${escapeHtml(token.text)}</mark>` : escapeHtml(token.text)))
    .join('');
}

function rowHtml(index, html) {
  return `<div class="meld-row"><span class="meld-ln">${index}</span><span class="meld-code">${html}</span></div>`;
}

function lineOp(line) {
  const open = line.indexOf('(');
  return open === -1 ? line.split(' ')[0] : line.slice(0, open);
}

/**
 * Pairs the lines of a changed chunk that share a command name, so inline highlighting
 * compares `uniform4fv` with `uniform4fv` rather than whatever sits at the same offset.
 * Returns a Map from A line index to B line index.
 */
export function pairChangedLines(chunk, linesA, linesB) {
  const pairs = new Map();
  const opsA = linesA.slice(chunk.a0, chunk.a1).map(lineOp);
  const opsB = linesB.slice(chunk.b0, chunk.b1).map(lineOp);
  for (const inner of diffSequences(opsA, opsB, { maxEditDistance: 200 }).chunks) {
    if (inner.tag !== 'equal') continue;
    for (let offset = 0; offset < inner.a1 - inner.a0; offset++) {
      pairs.set(chunk.a0 + inner.a0 + offset, chunk.b0 + inner.b0 + offset);
    }
  }
  return pairs;
}

function chunkSideHtml(chunk, side, lines, otherLines, expanded, pairs) {
  const start = side === 'a' ? chunk.a0 : chunk.b0;
  const end = side === 'a' ? chunk.a1 : chunk.b1;
  const length = end - start;
  const rows = [];
  if (chunk.tag === 'equal' && !expanded && length > FOLD_CONTEXT * 2 + 1) {
    for (let index = start; index < start + FOLD_CONTEXT; index++) rows.push(rowHtml(index, escapeHtml(lines[index])));
    const hidden = length - FOLD_CONTEXT * 2;
    rows.push(
      `<div class="meld-row meld-fold" data-fold="${chunk.index}"><span class="meld-ln">⋯</span><span class="meld-code">${hidden} identical commands — click to expand</span></div>`
    );
    for (let index = end - FOLD_CONTEXT; index < end; index++) rows.push(rowHtml(index, escapeHtml(lines[index])));
  } else {
    for (let index = start; index < end; index++) {
      const otherIndex = pairs?.get(index);
      if (otherIndex != null) {
        const tokens = side === 'a' ? inlineTokenDiff(lines[index], otherLines[otherIndex]).a : inlineTokenDiff(otherLines[otherIndex], lines[index]).b;
        rows.push(rowHtml(index, tokensHtml(tokens)));
      } else {
        rows.push(rowHtml(index, escapeHtml(lines[index])));
      }
    }
  }
  return `<div class="meld-chunk meld-chunk--${chunk.tag}" data-chunk="${chunk.index}">${rows.join('')}</div>`;
}

function findChunkAt(layout, y, topKey) {
  let low = 0;
  let high = layout.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (layout[mid][topKey] <= y) low = mid;
    else high = mid - 1;
  }
  return layout[low];
}

/**
 * Renders a Meld-style side-by-side diff of two line sequences into `container`: changed
 * chunks in blue, inserted/removed chunks in green, curved connectors between matching chunks,
 * and synchronized scrolling that keeps corresponding chunks level.
 */
export function renderSideBySideDiff(container, { linesA, linesB, chunks, labelA, labelB, note = '' }) {
  const indexed = chunks.map((chunk, index) => ({ ...chunk, index }));
  const changeIndexes = indexed.filter((chunk) => chunk.tag !== 'equal').map((chunk) => chunk.index);
  const expanded = new Set();
  const pairsA = new Map();
  const pairsB = new Map();
  for (const chunk of indexed) {
    if (chunk.tag !== 'replace') continue;
    const pairs = pairChangedLines(chunk, linesA, linesB);
    pairsA.set(chunk.index, pairs);
    pairsB.set(chunk.index, new Map(Array.from(pairs, ([a, b]) => [b, a])));
  }
  const summary = summarizeChunks(indexed);
  let currentChange = -1;

  container.innerHTML = `
    <div class="meld">
      <div class="meld-toolbar">
        <span class="meld-stats">
          <span class="meld-stat meld-stat--changes">${summary.changes} change(s)</span>
          <span class="meld-stat meld-stat--replace">~${summary.changed} changed</span>
          <span class="meld-stat meld-stat--insert">+${summary.inserted} added</span>
          <span class="meld-stat meld-stat--delete">−${summary.removed} removed</span>
        </span>
        ${note ? `<span class="meld-note muted">${escapeHtml(note)}</span>` : ''}
        <span class="meld-nav">
          <button type="button" class="panel-action meld-prev" data-tooltip="Previous change">↑</button>
          <button type="button" class="panel-action meld-next" data-tooltip="Next change">↓</button>
        </span>
      </div>
      <div class="meld-head">
        <span class="meld-label" title="${escapeHtml(labelA)}">${escapeHtml(labelA)}</span>
        <span></span>
        <span class="meld-label" title="${escapeHtml(labelB)}">${escapeHtml(labelB)}</span>
      </div>
      <div class="meld-body">
        <div class="meld-pane meld-pane--a"><div class="meld-content"></div></div>
        <svg class="meld-gutter" width="${GUTTER_WIDTH}" preserveAspectRatio="none" aria-hidden="true"></svg>
        <div class="meld-pane meld-pane--b"><div class="meld-content"></div></div>
      </div>
    </div>`;

  const paneA = container.querySelector('.meld-pane--a');
  const paneB = container.querySelector('.meld-pane--b');
  const contentA = paneA.querySelector('.meld-content');
  const contentB = paneB.querySelector('.meld-content');
  const gutter = container.querySelector('.meld-gutter');
  let layout = [];
  let syncLock = false;
  let frame = 0;

  function measure() {
    const elementsA = contentA.children;
    const elementsB = contentB.children;
    layout = indexed.map((chunk, index) => ({
      chunk,
      top: elementsA[index].offsetTop,
      height: elementsA[index].offsetHeight,
      topB: elementsB[index].offsetTop,
      heightB: elementsB[index].offsetHeight
    }));
  }

  function render() {
    contentA.innerHTML = indexed
      .map((chunk) => chunkSideHtml(chunk, 'a', linesA, linesB, expanded.has(chunk.index), pairsA.get(chunk.index)))
      .join('');
    contentB.innerHTML = indexed
      .map((chunk) => chunkSideHtml(chunk, 'b', linesB, linesA, expanded.has(chunk.index), pairsB.get(chunk.index)))
      .join('');
    for (const fold of container.querySelectorAll('.meld-fold')) {
      fold.addEventListener('click', () => {
        expanded.add(Number(fold.dataset.fold));
        render();
      });
    }
    measure();
    drawGutter();
  }

  function drawGutter() {
    // The gutter spans the full row, while the panes' clientHeight excludes their horizontal
    // scrollbar; a viewBox taller or shorter than the element would be letterboxed. Pane
    // coordinates start at the same top edge, so a 1:1 viewBox keeps the bands aligned.
    const height = gutter.getBoundingClientRect().height || paneA.clientHeight;
    gutter.setAttribute('viewBox', `0 0 ${GUTTER_WIDTH} ${height}`);
    const scrollA = paneA.scrollTop;
    const scrollB = paneB.scrollTop;
    const mid = GUTTER_WIDTH / 2;
    const paths = [];
    for (const entry of layout) {
      if (entry.chunk.tag === 'equal') continue;
      const a0 = entry.top - scrollA;
      const a1 = a0 + entry.height;
      const b0 = entry.topB - scrollB;
      const b1 = b0 + entry.heightB;
      if ((a1 < 0 && b1 < 0) || (a0 > height && b0 > height)) continue;
      const d = `M0 ${a0} C${mid} ${a0} ${mid} ${b0} ${GUTTER_WIDTH} ${b0} L${GUTTER_WIDTH} ${b1} C${mid} ${b1} ${mid} ${a1} 0 ${a1} Z`;
      const current = changeIndexes[currentChange] === entry.chunk.index ? ' meld-band--current' : '';
      paths.push(`<path class="meld-band meld-band--${entry.chunk.tag}${current}" d="${d}" />`);
    }
    gutter.innerHTML = paths.join('');
  }

  function scheduleGutter() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawGutter();
    });
  }

  function mapScroll(fromPane, toPane, fromKey, toKey) {
    if (!layout.length) return;
    const half = fromPane.clientHeight / 2;
    const y = fromPane.scrollTop + half;
    const topKey = fromKey === 'a' ? 'top' : 'topB';
    const heightKey = fromKey === 'a' ? 'height' : 'heightB';
    const entry = findChunkAt(layout, y, topKey);
    const fraction = entry[heightKey] > 0 ? Math.min(1, Math.max(0, (y - entry[topKey]) / entry[heightKey])) : 0;
    const targetTop = toKey === 'a' ? entry.top : entry.topB;
    const targetHeight = toKey === 'a' ? entry.height : entry.heightB;
    toPane.scrollTop = targetTop + fraction * targetHeight - half;
  }

  function onScroll(fromPane, toPane, fromKey, toKey) {
    if (syncLock) return;
    syncLock = true;
    mapScroll(fromPane, toPane, fromKey, toKey);
    toPane.scrollLeft = fromPane.scrollLeft;
    requestAnimationFrame(() => {
      syncLock = false;
    });
    scheduleGutter();
  }

  paneA.addEventListener('scroll', () => onScroll(paneA, paneB, 'a', 'b'));
  paneB.addEventListener('scroll', () => onScroll(paneB, paneA, 'b', 'a'));

  function goToChange(step) {
    if (!changeIndexes.length) return;
    currentChange = (currentChange + step + changeIndexes.length) % changeIndexes.length;
    const entry = layout[changeIndexes[currentChange]];
    syncLock = true;
    paneA.scrollTop = Math.max(0, entry.top - paneA.clientHeight / 3);
    paneB.scrollTop = Math.max(0, entry.topB - paneB.clientHeight / 3);
    requestAnimationFrame(() => {
      syncLock = false;
    });
    for (const element of container.querySelectorAll('.meld-chunk--current')) element.classList.remove('meld-chunk--current');
    for (const content of [contentA, contentB]) content.children[entry.chunk.index].classList.add('meld-chunk--current');
    drawGutter();
  }

  container.querySelector('.meld-prev').addEventListener('click', () => goToChange(-1));
  container.querySelector('.meld-next').addEventListener('click', () => goToChange(1));

  const resizeObserver = new ResizeObserver(() => {
    measure();
    scheduleGutter();
  });
  resizeObserver.observe(paneA);

  render();

  return {
    goToChange,
    destroy() {
      resizeObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
      container.innerHTML = '';
    }
  };
}
