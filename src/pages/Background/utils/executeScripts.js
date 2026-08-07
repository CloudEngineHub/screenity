// Backfills content scripts into tabs that were already open at install/update.
// Manifest content_scripts only auto-inject on future page loads, so without
// this those tabs can't record until they're reloaded.
//
// Paced deliberately: the bundle is ~1MB, and injecting it into every open tab
// at once has each tab's renderer parse, execute and mount the React tree
// simultaneously. With a couple of dozen tabs that saturates the CPU and the
// whole browser goes sluggish, tab switching included.
const INJECT_CONCURRENCY = 3;

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

export const executeScripts = async () => {
  const contentScripts = chrome.runtime.getManifest().content_scripts;
  const tabQueries = contentScripts.map((cs) =>
    chrome.tabs.query({ url: cs.matches })
  );
  const tabResults = await Promise.all(tabQueries);

  const jobs = [];
  for (let i = 0; i < tabResults.length; i++) {
    const cs = contentScripts[i];
    // Discarded and unloaded tabs have no renderer to inject into, and the
    // manifest registration covers them whenever they do load. Injecting here
    // would only wake tabs Chrome deliberately put to sleep.
    const tabs = tabResults[i].filter(
      (tab) =>
        typeof tab.id === "number" && !tab.discarded && tab.status !== "unloaded",
    );
    // Visible tabs first: those are the ones where a missing content script is
    // immediately noticeable, and they finish before the pool reaches the rest.
    tabs.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
    for (const tab of tabs) {
      jobs.push(() => injectInto(tab.id, cs.js));
    }
  }

  await runPool(jobs, INJECT_CONCURRENCY);
};
