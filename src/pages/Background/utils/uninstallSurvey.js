import { supportContextQuery } from "../../utils/buildSupportContext";

const UNINSTALL_FORM = "https://tally.so/r/3Ex6kX";

export const syncUninstallSurvey = async () => {
  try {
    const { isLoggedIn } = await chrome.storage.local.get("isLoggedIn");
    if (isLoggedIn) {
      chrome.runtime.setUninstallURL("");
      return;
    }
    const qs = await supportContextQuery({ source: "uninstall" });
    chrome.runtime.setUninstallURL(`${UNINSTALL_FORM}?${qs}`);
  } catch {}
};

export const initUninstallSurvey = () => {
  syncUninstallSurvey();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.isLoggedIn) return;
    syncUninstallSurvey();
  });
};
