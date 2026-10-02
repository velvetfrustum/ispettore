const STORAGE_KEYS = {
  vertical: 'ispettore.frameSplitPct',
  horizontal: 'ispettore.frameTopHeight'
};

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function writeStored(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (_) {
    /* persistence is best effort */
  }
}

function applyVertical(split, pct) {
  const clamped = Math.min(75, Math.max(15, pct));
  split.style.gridTemplateColumns = `${clamped}% 6px minmax(0, 1fr)`;
  return clamped;
}

function applyHorizontal(stack, heightPx) {
  stack.style.setProperty('--frame-top-max', `${Math.round(heightPx)}px`);
}

export function initCaptureSplitters() {
  const split = document.getElementById('frame-split');
  const verticalHandle = document.getElementById('frame-split-v');
  const topStack = document.getElementById('frame-top-stack');
  const horizontalHandle = document.getElementById('frame-split-h');
  if (!split || !verticalHandle || !topStack || !horizontalHandle) return;

  const storedPct = Number(readStored(STORAGE_KEYS.vertical));
  if (Number.isFinite(storedPct) && storedPct > 0) applyVertical(split, storedPct);

  const storedHeight = Number(readStored(STORAGE_KEYS.horizontal));
  if (Number.isFinite(storedHeight) && storedHeight >= 48) {
    applyHorizontal(topStack, Math.min(storedHeight, window.innerHeight * 0.7));
  }

  let activePointer = null;

  verticalHandle.addEventListener('pointerdown', (event) => {
    activePointer = {
      kind: 'vertical',
      pointerId: event.pointerId,
      rect: split.getBoundingClientRect()
    };
    verticalHandle.setPointerCapture(event.pointerId);
    verticalHandle.classList.add('dragging');
    event.preventDefault();
  });

  horizontalHandle.addEventListener('pointerdown', (event) => {
    activePointer = {
      kind: 'horizontal',
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: topStack.getBoundingClientRect().height
    };
    horizontalHandle.setPointerCapture(event.pointerId);
    horizontalHandle.classList.add('dragging');
    event.preventDefault();
  });

  verticalHandle.addEventListener('dblclick', () => {
    split.style.removeProperty('grid-template-columns');
    writeStored(STORAGE_KEYS.vertical, null);
  });

  horizontalHandle.addEventListener('dblclick', () => {
    topStack.style.removeProperty('--frame-top-max');
    writeStored(STORAGE_KEYS.horizontal, null);
  });

  window.addEventListener('pointermove', (event) => {
    if (!activePointer || event.pointerId !== activePointer.pointerId) return;
    if (activePointer.kind === 'vertical') {
      const rect = activePointer.rect;
      const pct = ((event.clientX - rect.left) / rect.width) * 100;
      const applied = applyVertical(split, pct);
      writeStored(STORAGE_KEYS.vertical, String(Math.round(applied)));
    } else {
      const next = activePointer.startHeight + (event.clientY - activePointer.startY);
      const maxHeight = window.innerHeight * 0.7;
      const applied = Math.min(maxHeight, Math.max(48, next));
      applyHorizontal(topStack, applied);
      writeStored(STORAGE_KEYS.horizontal, String(Math.round(applied)));
    }
  });

  const release = (event) => {
    if (!activePointer || event.pointerId !== activePointer.pointerId) return;
    activePointer = null;
    verticalHandle.classList.remove('dragging');
    horizontalHandle.classList.remove('dragging');
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
}
