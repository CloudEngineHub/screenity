// Backfills content scripts into tabs that were already open at install/update.
// Manifest content_scripts only auto-inject on future page loads, so without
// this those tabs can't record until they're reloaded.
//
// Paced deliberately: the bundle is ~1MB, and injecting it into every open tab
// at once has each tab's renderer parse, execute and mount the React tree
// simultaneously. With a couple of dozen tabs that saturates the CPU and the
// whole browser goes sluggish, tab switching included.
const INJECT_CONCURRENCY = 3;
// Long tail: one at a time with a gap, so a few hundred stale tabs cost
// background time instead of a pinned CPU.
const BACKFILL_CONCURRENCY = 1;
const BACKFILL_GAP_MS = 250;


// executeScript resolves as a promise only when no callback is passed. The
// callback form returns undefined, so awaiting these used to wait on nothing.
// Restricted or closed tabs reject; there's nothing to do about those.
const injectInto = (tabId, files) =>
  chrome.scripting
    .executeScript({ target: { tabId }, files })
    .catch(() => {});

const runPool = async (jobs, limit) => {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, jobs.length) },
    async () => {
      while (next < jobs.length) {
        const job = jobs[next];
        next += 1;
        await job();
      }
    },
  );
  await Promise.all(workers);
};

// A reload orphans every tab's content script, and the clicked tab shouldn't
// wait behind the backfill queue.
export const injectContentScriptIntoTab = async (tabId) => {
  if (typeof tabId !== "number") return false;
  const contentScripts = chrome.runtime.getManifest().content_scripts || [];
  const files = contentScripts.flatMap((cs) => cs.js || []);
  if (files.length === 0) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
    return true;
  } catch {
    return false;
  }
};

// The backfill is no longer guaranteed to have reached the tab, so callers
// can't assume a content script is there.
export const sendMessageEnsuringContentScript = async (tabId, message) => {
  const { sendMessageTab } = await import("../tabManagement");
  try {
    return await sendMessageTab(tabId, message);
  } catch (err) {
    if (!String(err).includes("Receiving end does not exist")) throw err;
  }
  if (!(await injectContentScriptIntoTab(tabId))) {
    throw new Error(`content script injection failed for tab ${tabId}`);
  }
  return sendMessageTab(tabId, message);
};

// Recently-used first. Sinks collapsed-group tabs without needing the
// tabGroups permission to identify them.
const injectionPriority = (tab, focusedWindowId) => {
  if (tab.active) return 0;
  if (focusedWindowId != null && tab.windowId === focusedWindowId) return 1;
  return 2;
};

// Skips the ~1MB re-parse when the script is already there. Only absence
// reads "Receiving end does not exist", so any other reply means it is.
const hasContentScript = async (tabId) => {
  const { sendMessageTab } = await import("../tabManagement");
  try {
    await sendMessageTab(tabId, { type: "screenity-ping" });
    return true;
  } catch (err) {
    return !String(err).includes("Receiving end does not exist");
  }
};

// Recording start is latency-critical and runs on this same worker. Backfilling
// hundreds of tabs alongside it is what the user feels.
const recordingInFlight = async () => {
  try {
    const s = await chrome.storage.local.get([
      "recording",
      "pendingRecording",
      "restarting",
    ]);
    return Boolean(s.recording || s.pendingRecording || s.restarting);
  } catch {
    return false;
  }
};

const injectIfMissing = async (tabId, files, gapMs = 0) => {
  // gapMs > 0 marks the background tier, which waits out a live recording.
  while (gapMs > 0 && (await recordingInFlight())) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (await hasContentScript(tabId)) return;
  await injectInto(tabId, files);
  if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
};

export const executeScripts = async () => {
  const contentScripts = chrome.runtime.getManifest().content_scripts;
  const tabQueries = contentScripts.map((cs) =>
    chrome.tabs.query({ url: cs.matches })
  );
  const tabResults = await Promise.all(tabQueries);

  let focusedWindowId = null;
  try {
    focusedWindowId = (await chrome.windows.getLastFocused()).id;
  } catch {}

  const urgent = [];
  const background = [];
  for (let i = 0; i < tabResults.length; i++) {
    const cs = contentScripts[i];
    // Discarded and unloaded tabs have no renderer to inject into, and the
    // manifest registration covers them whenever they do load. Injecting here
    // would only wake tabs Chrome deliberately put to sleep.
    const tabs = tabResults[i].filter(
      (tab) =>
        typeof tab.id === "number" && !tab.discarded && tab.status !== "unloaded",
    );
    tabs.sort((a, b) => {
      const byTier =
        injectionPriority(a, focusedWindowId) -
        injectionPriority(b, focusedWindowId);
      if (byTier !== 0) return byTier;
      return (b.lastAccessed || 0) - (a.lastAccessed || 0);
    });
    for (const tab of tabs) {
      if (injectionPriority(tab, focusedWindowId) === 0) {
        urgent.push(() => injectIfMissing(tab.id, cs.js));
      } else {
        background.push(() => injectIfMissing(tab.id, cs.js, BACKFILL_GAP_MS));
      }
    }
  }

  await runPool(urgent, INJECT_CONCURRENCY);
  // Not awaited: tabs the trickle hasn't reached get injected on demand by
  // whatever needs them.
  void runPool(background, BACKFILL_CONCURRENCY);
};
