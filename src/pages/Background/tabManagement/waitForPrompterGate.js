// With the countdown off the recorder starts as soon as ready-to-record is sent, so a
// full-screen capture could record the floating script before the page closes it. The
// page marks the gate done; this waits for that mark, up to a second.
export const waitForPrompterGate = async (tabId, sentAt, timeoutMs = 1000) => {
  try {
    const { prompterScriptTab, prompterGateDone } =
      await chrome.storage.local.get(["prompterScriptTab", "prompterGateDone"]);
    if (prompterScriptTab == null || prompterScriptTab !== tabId) return;
    if (prompterGateDone >= sentAt) return;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        chrome.storage.onChanged.removeListener(onChanged);
        resolve();
      };
      const onChanged = (changes, area) => {
        if (area === "local" && changes.prompterGateDone?.newValue >= sentAt) {
          finish();
        }
      };
      const timer = setTimeout(finish, timeoutMs);
      chrome.storage.onChanged.addListener(onChanged);
    });
  } catch {}
};
