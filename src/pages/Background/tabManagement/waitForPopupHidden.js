// With the countdown off, capture is already live when ready-to-record is sent, so the
// popup would land in the first frames. The page marks the frame after hiding it; wait
// for that, up to the timeout (a hidden tab never paints).
export const waitForPopupHidden = async (sentAt, timeoutMs = 400) => {
  try {
    const { popupHiddenAt } = await chrome.storage.local.get(["popupHiddenAt"]);
    if (popupHiddenAt >= sentAt) return;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        chrome.storage.onChanged.removeListener(onChanged);
        resolve();
      };
      const onChanged = (changes, area) => {
        if (area === "local" && changes.popupHiddenAt?.newValue >= sentAt) {
          finish();
        }
      };
      const timer = setTimeout(finish, timeoutMs);
      chrome.storage.onChanged.addListener(onChanged);
    });
  } catch {}
};
