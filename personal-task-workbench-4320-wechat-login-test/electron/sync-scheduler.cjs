"use strict";

const terminal = (error) => error?.retryable === false || /UNAUTH|PERMISSION|FORBIDDEN|WORKSPACE|UNPAIRED|NOT_CONFIGURED|NOT_ENABLED|CHECKPOINT_INVALID|CAPACITY/.test(String(error?.code || ""));
const aborted = () => Object.assign(new Error("账号已切换，本轮同步已停止"), { code: "SYNC_SCOPE_CHANGED", retryable: false });

// All callers share one job for the same profile. A request received during a
// job requests one FOLLOW-UP execution, never just reuses the stale result.
function createSyncRunner(execute) {
  let active = null, generation = 0;
  function run(scope, options = {}) {
    if (active) {
      if (active.scope.key !== scope.key || active.controller.signal.aborted) return Promise.reject(aborted());
      active.dirty = true;
      return active.promise;
    }
    const job = { scope, generation, controller: new AbortController(), dirty: false, promise: null };
    active = job;
    const assertCurrent = () => {
      if (active !== job || generation !== job.generation || job.controller.signal.aborted) throw aborted();
    };
    job.promise = Promise.resolve().then(async () => {
      let result;
      do {
        job.dirty = false;
        assertCurrent();
        result = await execute(scope, { ...options, signal: job.controller.signal, assertCurrent });
        assertCurrent();
      } while (job.dirty);
      return result;
    }).finally(() => { if (active === job) active = null; });
    return job.promise;
  }
  async function cancel() {
    generation++;
    const job = active;
    job?.controller.abort();
    if (job) await job.promise.catch(() => {});
  }
  return { run, cancel };
}

// Event-driven receiving. Timers exist only for a coalesced change, unfinished
// history, or a failed connection. A connected idle desktop never polls.
function createRemoteSyncLifecycle({ watch, sync, onResult = () => {}, onError = () => {}, isActive = () => true,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  let stopped = true, generation = 0, watcher = null, pullTimer = null, reconnectTimer = null;
  let running = false, dirty = false, watchFailures = 0, pullFailures = 0;
  const alive = (epoch) => !stopped && epoch === generation && isActive();
  const delay = (failures) => Math.min(60000, 2000 * 2 ** Math.min(5, failures));
  function request(wait = 450) {
    if (!alive(generation)) return;
    dirty = true;
    if (running || pullTimer !== null) return;
    const epoch = generation;
    pullTimer = setTimer(() => { pullTimer = null; void pull(epoch); }, wait);
  }
  async function pull(epoch) {
    if (!alive(epoch) || running) return;
    dirty = false; running = true;
    let retry = false, nextDelay = 50;
    try {
      const result = await sync();
      if (!alive(epoch)) return;
      if (result?.error) throw Object.assign(new Error(result.error), { code: result.code, retryable: result.retryable });
      pullFailures = 0;
      onResult(result);
      if (result?.receivePending || result?.uploadPending && !result?.conflicts) dirty = true;
    } catch (error) {
      if (!alive(epoch)) return;
      onError(error, "receive");
      if (terminal(error)) dirty = false;
      else { retry = true; nextDelay = delay(pullFailures++); }
    } finally {
      if (epoch === generation) running = false;
      if (alive(epoch) && (dirty || retry)) request(nextDelay);
    }
  }
  function connect(epoch) {
    if (!alive(epoch)) return;
    const controller = new AbortController();
    watcher = controller;
    const started = now();
    Promise.resolve().then(() => watch(() => { if (alive(epoch)) request(); }, controller.signal,
      () => { if (alive(epoch)) request(0); })).then(() => {
      if (alive(epoch) && !controller.signal.aborted) throw new Error("实时连接已结束");
    }).catch((error) => {
      if (!alive(epoch) || controller.signal.aborted) return;
      onError(error, "watch");
      if (terminal(error)) return;
      if (now() - started >= 30000) watchFailures = 0;
      reconnectTimer = setTimer(() => { reconnectTimer = null; connect(epoch); }, delay(watchFailures++));
    }).finally(() => { if (watcher === controller) watcher = null; });
  }
  function stop() {
    stopped = true; generation++; dirty = false; running = false;
    if (pullTimer !== null) clearTimer(pullTimer);
    if (reconnectTimer !== null) clearTimer(reconnectTimer);
    pullTimer = reconnectTimer = null;
    watcher?.abort(); watcher = null;
  }
  function start() {
    if (!stopped) return;
    stopped = false; watchFailures = pullFailures = 0;
    connect(++generation);
    request(0);
  }
  return { start, stop, request };
}

module.exports = { createSyncRunner, createRemoteSyncLifecycle };
