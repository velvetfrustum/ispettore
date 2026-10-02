import { TRANSFER_CHANNEL, TRANSFER_MESSAGE_TYPES } from '../shared/storage/transferProtocol.js';

const CHANNEL = TRANSFER_CHANNEL;

// Bump when this file runs; stale listeners from a previous extension load see a mismatch.
window.__ispettoreGeneration = (window.__ispettoreGeneration || 0) + 1;
const MY_GENERATION = window.__ispettoreGeneration;

let reloadNoticeShown = false;

function isActiveInstance() {
  return window.__ispettoreGeneration === MY_GENERATION;
}

function scheduleReloadNotice() {
  if (reloadNoticeShown || !isActiveInstance()) return;
  reloadNoticeShown = true;

  const paint = () => {
    try {
      if (!document.body || document.getElementById('ispettore-reload-notice')) return;
      const notice = document.createElement('div');
      notice.id = 'ispettore-reload-notice';
      notice.textContent = 'Ispettore was updated — reload this page to capture again.';
      notice.style.cssText = [
        'position:fixed',
        'bottom:12px',
        'left:50%',
        'transform:translateX(-50%)',
        'z-index:2147483646',
        'padding:10px 16px',
        'border-radius:8px',
        'background:#0f1218',
        'color:#e8eaed',
        'border:1px solid #6ea8fe',
        'font:13px system-ui,sans-serif',
        'box-shadow:0 4px 20px rgba(0,0,0,.4)',
        'pointer-events:none'
      ].join(';');
      document.body.appendChild(notice);
    } catch (_) {
      /* DOM only — must not throw */
    }
  };

  if (document.body) paint();
  else document.addEventListener('DOMContentLoaded', paint, { once: true });
}

function staleInstance() {
  if (isActiveInstance()) return false;
  scheduleReloadNotice();
  return true;
}

function safeRuntimeSend(message) {
  if (staleInstance()) return;

  try {
    chrome.runtime.sendMessage(message, () => {});
  } catch (_) {
    scheduleReloadNotice();
  }
}

function onPageMessage(event) {
  if (staleInstance()) return;
  if (event.source !== window || !event.data || event.data.channel !== CHANNEL) return;

  if (event.data.type === 'CAPTURE') {
    safeRuntimeSend({
      type: 'ISPETTORE_CAPTURE',
      payload: event.data.payload
    });
    return;
  }

  if (isTransferMessageType(event.data.type)) {
    forwardTransferMessage(event.data);
  }
}

const TRANSFER_PHASE_BY_TYPE = {
  [TRANSFER_MESSAGE_TYPES.BEGIN]: 'begin',
  [TRANSFER_MESSAGE_TYPES.CHUNK]: 'chunk',
  [TRANSFER_MESSAGE_TYPES.END]: 'end',
  [TRANSFER_MESSAGE_TYPES.CANCEL]: 'cancel'
};

function isTransferMessageType(type) {
  return Object.prototype.hasOwnProperty.call(TRANSFER_PHASE_BY_TYPE, type);
}

function runtimeSendForTransfer(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(response ?? { ok: false, error: 'Extension did not respond' });
      });
    } catch (error) {
      reject(error);
    }
  });
}

function relayToPage(message, response) {
  window.postMessage(
    {
      channel: CHANNEL,
      transferId: message.transferId,
      phase: TRANSFER_PHASE_BY_TYPE[message.type],
      index: message.index,
      ...response
    },
    '*'
  );
}

async function forwardTransferMessage(message) {
  const phase = TRANSFER_PHASE_BY_TYPE[message.type];
  const runtimeMessage = {
    type: 'ISPETTORE_TRANSFER',
    phase,
    transferId: message.transferId,
    payload: message.payload,
    index: message.index,
    data: message.data
  };

  try {
    const result = await runtimeSendForTransfer(runtimeMessage);
    if (phase === 'cancel') return;
    const ok = result?.ok === true;
    relayToPage(message, {
      type: ok ? TRANSFER_MESSAGE_TYPES.ACK : TRANSFER_MESSAGE_TYPES.ERROR,
      ok,
      ...(result ?? {})
    });
  } catch (error) {
    if (phase === 'cancel') return;
    relayToPage(message, {
      type: TRANSFER_MESSAGE_TYPES.ERROR,
      ok: false,
      error: error?.message || String(error)
    });
  }
}

function ensureBridge() {
  if (staleInstance()) return false;

  if (window.__ispettoreMessageHandler) {
    window.removeEventListener('message', window.__ispettoreMessageHandler);
  }

  window.__ispettoreMessageHandler = onPageMessage;
  window.addEventListener('message', window.__ispettoreMessageHandler);

  return true;
}

function safeSendResponse(sendResponse, payload) {
  if (staleInstance()) return;
  try {
    sendResponse(payload);
  } catch (_) {
    scheduleReloadNotice();
  }
}

if (!staleInstance()) {
  ensureBridge();
}

if (!staleInstance()) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (staleInstance()) {
      safeSendResponse(sendResponse, { ok: false, error: 'Extension reloaded — refresh this page' });
      return true;
    }

    if (message.type === 'ISPETTORE_PING') {
      ensureBridge();
      safeSendResponse(sendResponse, { ok: true });
      return true;
    }

    if (message.type !== 'ISPETTORE_COMMAND') return;

    if (!ensureBridge()) {
      safeSendResponse(sendResponse, { ok: false, error: 'Extension reloaded — refresh this page' });
      return true;
    }

    window.postMessage({ channel: CHANNEL, type: 'COMMAND', command: message.command }, '*');
    safeSendResponse(sendResponse, { ok: true });
    return true;
  });
}
