// Main-thread ChunkWriter delegating to a worker that holds a
// FileSystemSyncAccessHandle. On worker crash/timeout/quota, pending
// writes reject and the writer marks dead; recorder stops and opens
// the editor on the partial (no mid-recording backend swap).

const WORKER_URL = () =>
  chrome.runtime.getURL("recorderopfsworker.bundle.js");

// Write is short (chunks ~200KB; commit fast or hung). Close is long:
// syncHandle.flush() on multi-GB recordings on slow disks can exceed
// 10s; close() scales the timeout dynamically by file size.
const WRITE_TIMEOUT_MS = 5000;
const OPEN_TIMEOUT_MS = 15000;
const CLOSE_TIMEOUT_BASE_MS = 30000;
const CLOSE_TIMEOUT_PER_GB_MS = 30000;
const CLOSE_TIMEOUT_MAX_MS = 180000;
const ABORT_TIMEOUT_MS = 10000;
// A hung or crashed worker is replaced and the write retried on the same file.
const MAX_WRITER_RECOVERIES = 3;
// Recoveries are per stall episode: a long take on a slow disk can see several
// unrelated hiccups, so the budget refills after this many clean writes.
const HEALTHY_WRITES_TO_REFILL = 30;

// Used by Recorder.jsx's handleChunk to detect OPFS writer failure.
export const OPFS_WRITER_FAILED_CODE = "opfs-writer-failed";

const opfsDiag = (event, data = {}) => {
  try {
    chrome.runtime.sendMessage({
      type: "diag-forward",
      event: `opfs-${event}`,
      data,
    });
  } catch {}
};

export class OpfsChunkWriter {
  constructor() {
    this.worker = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this._byteSize = 0;
    this._chunkCount = 0;
    this._fileName = null;
    this._closed = false;
    this._aborted = false;
    // after failure (crash/timeout/quota) the writer is permanently dead;
    // file state past the failure point is unknown.
    this._dead = false;
    this._deathError = null;
    this._recoveries = 0;
    this._healthyWrites = 0;
  }

  _isRecoverable(err) {
    return err?.errorName === "TimeoutError" || err?.errorName === "WorkerError";
  }

  _abandonWorker(err) {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {}
      this.worker = null;
    }
    for (const [, entry] of this.pending) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      entry.reject(err);
    }
    this.pending.clear();
  }

  _markDead(err) {
    if (this._dead) return;
    this._dead = true;
    const tagged = err instanceof Error ? err : new Error(String(err));
    tagged.code = OPFS_WRITER_FAILED_CODE;
    tagged.fileName = this._fileName;
    this._deathError = tagged;
    opfsDiag("dead", {
      errorName: tagged.errorName || tagged.name || "Error",
      message: String(tagged.message || "").slice(0, 200),
      fileName: this._fileName,
      byteSize: this._byteSize,
      chunkCount: this._chunkCount,
      pendingCount: this.pending.size,
    });
    for (const [, entry] of this.pending) entry.reject(tagged);
    this.pending.clear();
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {}
      this.worker = null;
    }
  }

  _attachWorker() {
    this.worker = new Worker(WORKER_URL());
    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (!msg || !msg.requestId) return;
      const entry = this.pending.get(msg.requestId);
      if (!entry) return;
      this.pending.delete(msg.requestId);
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      if (msg.ok) {
        entry.resolve(msg);
      } else {
        const err = new Error(msg.error || "opfs-worker-error");
        err.errorName = msg.errorName || "Error";
        entry.reject(err);
      }
    };
    this.worker.onerror = (e) => {
      const err = new Error(String(e?.message || "opfs-worker-crashed"));
      err.errorName = "WorkerError";
      if (this._fileName && this._recoveries < MAX_WRITER_RECOVERIES) {
        this._abandonWorker(err);
      } else {
        this._markDead(err);
      }
    };
  }

  _request(message, timeout = WRITE_TIMEOUT_MS) {
    if (this._dead) {
      return Promise.reject(this._deathError);
    }
    if (!this.worker) this._attachWorker();
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.pending.set(requestId, entry);
      entry.timeoutId = setTimeout(() => {
        // Terminal even if the worker eventually replies; file state is
        // unknowable past this point.
        if (this.pending.delete(requestId)) {
          const timeoutErr = new Error(
            `opfs-${message.type}-timeout after ${timeout}ms`,
          );
          timeoutErr.errorName = "TimeoutError";
          if (
            message.type === "write" &&
            this._recoveries < MAX_WRITER_RECOVERIES
          ) {
            this._abandonWorker(timeoutErr);
            reject(timeoutErr);
          } else {
            this._markDead(timeoutErr);
            reject(this._deathError);
          }
        }
      }, timeout);
      // E2E seam: swallow N writes so the worker never answers, like a hang.
      const g = /** @type {any} */ (globalThis);
      if (message.type === "write" && g.__screenityDropOpfsWrites > 0) {
        g.__screenityDropOpfsWrites -= 1;
        return;
      }
      this.worker.postMessage({ ...message, requestId });
    });
  }

  async open(recordingId, opts = {}) {
    if (this._closed || this._aborted) {
      throw new Error("opfs-chunk-writer-reused");
    }
    const extension = opts.extension === "webm" ? "webm" : "mp4";
    // Recordings whose editor tab is still open. The worker skips deleting them.
    const keepNames = Array.isArray(opts.keepNames) ? opts.keepNames : [];
    const resp = await this._request(
      { type: "open", recordingId, extension, keepNames },
      OPEN_TIMEOUT_MS,
    );
    if (this._aborted || this._closed) {
      // open reply lands after abort; skip storage write so it doesn't
      // overwrite a real recording's backendRef.
      return { backendRef: { backend: "opfs", fileName: resp.fileName || null } };
    }
    this._fileName = resp.fileName || null;
    opfsDiag("open-ok", { fileName: this._fileName });
    if (this._fileName) {
      try {
        await chrome.storage.local.set({
          lastRecordingBackendRef: {
            backend: "opfs",
            fileName: this._fileName,
          },
        });
      } catch {}
    }
    return { backendRef: { backend: "opfs", fileName: this._fileName } };
  }

  async write({ chunk, index, timestamp }) {
    if (this._closed || this._aborted) {
      throw new Error("opfs-chunk-writer-closed");
    }
    // index/timestamp accepted to match IdbChunkWriter; OPFS is ordered
    // by write position so they aren't stored.
    for (;;) {
      if (this._closed || this._aborted) {
        throw new Error("opfs-chunk-writer-closed");
      }
      try {
        // An onerror between writes leaves no worker; recover before posting.
        if (!this.worker && this._fileName && !this._dead) {
          if (this._recoveries >= MAX_WRITER_RECOVERIES) {
            this._markDead(new Error("opfs-worker-missing"));
            throw this._deathError;
          }
          await this._recover(new Error("opfs-worker-missing"));
        }
        const resp = await this._request({
          type: "write",
          chunk,
          index,
          timestamp,
        });
        this._byteSize = resp.totalSize ?? this._byteSize;
        this._chunkCount += 1;
        this._healthyWrites += 1;
        if (
          this._recoveries > 0 &&
          this._healthyWrites >= HEALTHY_WRITES_TO_REFILL
        ) {
          this._recoveries = 0;
        }
        return;
      } catch (err) {
        if (this._dead || !this._isRecoverable(err)) throw err;
        if (this._recoveries >= MAX_WRITER_RECOVERIES) {
          this._markDead(err);
          throw this._deathError;
        }
        await this._recover(err);
      }
    }
  }

  // Replace the worker and resume at the last acknowledged byte. The retried
  // write then lands exactly where the failed one started.
  async _recover(cause) {
    if (this._closed || this._aborted) {
      throw new Error("opfs-chunk-writer-closed");
    }
    this._recoveries += 1;
    this._healthyWrites = 0;
    opfsDiag("recovering", {
      attempt: this._recoveries,
      cause: String(cause?.message || cause).slice(0, 120),
      fileName: this._fileName,
      ackedBytes: this._byteSize,
    });
    this._abandonWorker(cause);
    this._attachWorker();
    try {
      await this._request(
        { type: "reopen", fileName: this._fileName, at: this._byteSize },
        OPEN_TIMEOUT_MS,
      );
    } catch (err) {
      this._markDead(err);
      throw this._deathError;
    }
    if (this._closed || this._aborted) {
      // close()/abort() raced the reopen; don't leave a second handle open.
      this._teardown();
      throw new Error("opfs-chunk-writer-closed");
    }
    opfsDiag("recovered", {
      attempt: this._recoveries,
      ackedBytes: this._byteSize,
    });
  }

  async close() {
    if (this._closed) {
      return {
        byteSize: this._byteSize,
        chunkCount: this._chunkCount,
        backendRef: { backend: "opfs", fileName: this._fileName },
      };
    }
    // 30s base + 30s/GB, capped at 3min. A 4GB recording on slow HDD
    // can take 90s to flush; the old fixed 30s lost bytes-on-disk recordings.
    const sizeGb = this._byteSize / (1024 * 1024 * 1024);
    const closeTimeoutMs = Math.min(
      CLOSE_TIMEOUT_BASE_MS + Math.ceil(sizeGb) * CLOSE_TIMEOUT_PER_GB_MS,
      CLOSE_TIMEOUT_MAX_MS,
    );
    opfsDiag("close-start", {
      byteSize: this._byteSize,
      chunkCount: this._chunkCount,
      timeoutMs: closeTimeoutMs,
    });
    const tBeforeReq = (typeof performance !== "undefined" ? performance.now() : Date.now());
    try {
      const resp = await this._request({ type: "close" }, closeTimeoutMs);
      const tAfterReq = (typeof performance !== "undefined" ? performance.now() : Date.now());
      this._byteSize = resp.byteSize ?? this._byteSize;
      this._chunkCount = Math.max(this._chunkCount, resp.chunkCount ?? 0);
      this._fileName = resp.fileName || this._fileName;
      // Surface per-phase timings so a diag can attribute the 10s
      // close-stall we've seen on macOS: flush vs handle.close vs
      // worker round-trip overhead.
      try {
        const { perfMark } = await import("../../../utils/perfMarks");
        perfMark("OPFSWriter.close.detail", {
          byteSize: this._byteSize,
          chunkCount: this._chunkCount,
          requestRoundTripMs: Math.round(tAfterReq - tBeforeReq),
          workerFlushMs: resp.timings?.flushMs ?? null,
          workerGetSizeMs: resp.timings?.getSizeMs ?? null,
          workerCloseHandleMs: resp.timings?.closeHandleMs ?? null,
        });
      } catch {}
      opfsDiag("close-ok", {
        byteSize: this._byteSize,
        chunkCount: this._chunkCount,
      });
    } catch (err) {
      // close rejected (worker timeout/crash/quota mid-flush). Log it so a
      // never-finalized recording points at close, not a silent finalized=0.
      opfsDiag("close-fail", {
        message: String(err?.message || err).slice(0, 200),
        byteSize: this._byteSize,
        chunkCount: this._chunkCount,
        fileName: this._fileName,
      });
      throw err;
    } finally {
      // Fire-and-forget; the storage.set under SW contention added 2s
      // to close() and delayed the editor open. The editor reads this
      // key seconds later, so async lands in time.
      if (this._fileName) {
        try {
          chrome.storage.local.set({
            lastRecordingFinalizedFileName: this._fileName,
          });
          // Log which file the marker named, so a finalized=0 report can tell
          // an unwritten marker from one pointing at the wrong file.
          opfsDiag("finalize-marker-set", {
            fileName: this._fileName,
            byteSize: this._byteSize,
            chunkCount: this._chunkCount,
          });
        } catch {}
      }
      this._closed = true;
      this._teardown();
    }
    return {
      byteSize: this._byteSize,
      chunkCount: this._chunkCount,
      backendRef: { backend: "opfs", fileName: this._fileName },
    };
  }

  async abort() {
    if (this._aborted) return;
    this._aborted = true;
    // Clear storage only if it still points at this writer's file; the
    // next recording may have already claimed it.
    try {
      const { lastRecordingBackendRef } = await chrome.storage.local.get([
        "lastRecordingBackendRef",
      ]);
      if (
        lastRecordingBackendRef?.backend === "opfs" &&
        lastRecordingBackendRef.fileName === this._fileName
      ) {
        await chrome.storage.local.set({ lastRecordingBackendRef: null });
      }
    } catch {}
    try {
      await this._request({ type: "abort" }, ABORT_TIMEOUT_MS);
    } catch {} finally {
      this._teardown();
    }
  }

  _teardown() {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {}
      this.worker = null;
    }
    const closedErr = new Error("opfs-chunk-writer-closed");
    for (const [, entry] of this.pending) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      entry.reject(closedErr);
    }
    this.pending.clear();
  }
}
