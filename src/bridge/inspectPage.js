const evalInPage = (expression) =>
  new Promise((resolve, reject) => {
    if (!chrome.devtools?.inspectedWindow?.eval) {
      reject(new Error('Page eval only available in DevTools'));
      return;
    }

    chrome.devtools.inspectedWindow.eval(expression, (result, exceptionInfo) => {
      if (exceptionInfo) {
        reject(new Error(exceptionInfo.value || exceptionInfo.description || 'Eval failed'));
        return;
      }
      resolve(result);
    });
  });

export const pullPageSnapshot = async () => {
  try {
    return await evalInPage(
      'window.__ISPETTORE__?.getSnapshot?.({ ping: true, skipGpuSnapshot: true })'
    );
  } catch (_) {
    return null;
  }
};
