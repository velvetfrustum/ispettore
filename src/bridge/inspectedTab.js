export const getInspectedTabId = async () => {
  if (typeof chrome.devtools !== 'undefined' && chrome.devtools.inspectedWindow?.tabId != null) {
    return chrome.devtools.inspectedWindow.tabId;
  }

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
};

export const isDevToolsPanel = () =>
  typeof chrome.devtools !== 'undefined' && chrome.devtools.inspectedWindow != null;
