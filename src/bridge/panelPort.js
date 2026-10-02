import { getInspectedTabId } from './inspectedTab.js';

const PORT_NAME = 'ispettore-panel';

let port = null;
let pending = null;

const connect = () => {
  if (port) return port;

  port = chrome.runtime.connect({ name: PORT_NAME });

  port.onMessage.addListener((response) => {
    pending?.resolve(response);
    pending = null;
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (pending) {
      pending.reject(new Error(err?.message || 'Disconnected from extension'));
      pending = null;
    }
    port = null;
  });

  return port;
};

const sendNow = async (command, payload) => {
  const tabId = await getInspectedTabId();

  return new Promise((resolve, reject) => {
    pending = { resolve, reject };

    try {
      connect().postMessage({ type: 'COMMAND', command, tabId, payload });
    } catch (e) {
      port = null;
      pending = null;
      reject(e);
    }
  });
};

// The port carries one command at a time, so commands wait for the previous one instead of
// failing — automatic refreshes and user clicks can overlap.
let queue = Promise.resolve();

/**
 * @param {string} command
 * @param {Record<string, unknown>} [payload]
 */
export const sendPanelCommand = (command, payload = {}) => {
  const run = queue.then(() => sendNow(command, payload));
  queue = run.catch(() => {});
  return run;
};

export const isConnectionError = (err) => {
  const msg = String(err?.message || err || '');
  return /extension context invalidated|receiving end does not exist|could not establish connection|disconnected from extension|message port closed/i.test(msg);
};
