/**
 * Chrome messaging helpers (MV3). Uses lastError callbacks — promises alone miss some failures.
 */

export const tabsSendMessage = (tabId, message) =>
  new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(response);
      });
    } catch (e) {
      reject(e);
    }
  });

export const isConnectionError = (err) => {
  const msg = err?.message || '';
  return /receiving end does not exist|could not establish connection/i.test(msg);
};
