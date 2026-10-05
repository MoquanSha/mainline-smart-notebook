import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import { createRelayServer } from '../relay/server.mjs';
const require = createRequire(import.meta.url);
const { HomeTunnelClient } = require('../electron/home-tunnel-client.cjs');
const { scopedClient } = require('../../wechat-mini-program-0.10.37-login-copy-20260905/tests/helpers/scoped-client.cjs');
const miniRoot = path.resolve(import.meta.dirname, '../../wechat-mini-program-0.10.37-login-copy-20260905/miniprogram');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-home-realtime-'));
process.env.SMART_NOTEBOOK_DATA_DIR = directory; process.env.SMART_NOTEBOOK_HOME_TOKEN = 'synthetic';
process.env.SMART_NOTEBOOK_HOME_OWNER = JSON.stringify({ userId: 'synthetic', workspaceId: 'A' });
process.env.DEEPSEEK_API_KEY = 'synthetic';
const { server, STORE_PATH, createCloudInitialState, mutateState, diaryJobStore, resumeDiaryOrganizations } = await import('../server.mjs');
const requests = [], sockets = [], frames = [], metrics = { actualCloudMeasured: false, cloudRequests: 0, modelCalls: 0, transportPings: 0 };
const idleWindowMs = Math.max(300, Math.min(35000, Number(process.env.MAINLINE_HOME_IDLE_MS) || 300));
let releaseAI, enteredAI, app, mutateBeforeConnect, failReceive;
const waiting = new Promise(resolve => { releaseAI = resolve; });
const entered = new Promise(resolve => { enteredAI = resolve; });
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const body = JSON.parse(raw), context = JSON.parse(body.messages[1].content.split('上下文：\n')[1]);
  metrics.modelCalls++; enteredAI(); await waiting;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ date: context.date,
    daySummary: '## 今日记录\n\n' + context.manualInputs.map(row => row.content).join('\n'), periods: [] }) } }] }));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const initial = createCloudInitialState();
Object.assign(initial.settings, { aiMode: 'deepseek', autoOrganize: false, autoUpdateEnabled: false,
  codexSessionsDir: path.join(directory, 'absent'), providerApiBase: `http://127.0.0.1:${provider.address().port}` });
fs.writeFileSync(STORE_PATH, JSON.stringify(initial));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let base = `http://127.0.0.1:${server.address().port}`, relay, tunnel;
if (process.env.MAINLINE_TEST_TUNNEL === 'true') {
  relay = createRelayServer({ homes: new Map([['realtime-test', 'synthetic-relay']]) });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const relayBaseUrl = `http://127.0.0.1:${relay.server.address().port}`;
  tunnel = new HomeTunnelClient({ localBaseUrl: base });
  const connected = new Promise(resolve => tunnel.on('status', status => { if (status.connected) resolve(); }));
  tunnel.start({ relayBaseUrl, homeId: 'realtime-test', tunnelToken: 'synthetic-relay' });
  await connected;
  base = relayBaseUrl + '/h/realtime-test';
  metrics.transport = 'actual local relay and desktop tunnel';
}
const owner = workspaceId => ({ account: { user: { id: 'synthetic' }, workspaceId } });
const r = scopedClient(async () => { metrics.cloudRequests++; throw new Error('Cloud forbidden'); }, new Map(), {
  request(options) {
    const item = { action: options.data?.action || 'batch', bytes: Buffer.byteLength(JSON.stringify(options.data || {})) };
    requests.push(item);
    if (failReceive && item.action === failReceive) { failReceive = null; item.failed = true; options.fail({ errMsg: 'synthetic lost receive response' }); return; }
    fetch(options.url, { method: options.method, headers: options.header, body: JSON.stringify(options.data) }).then(async response => {
      const raw = await response.text(); item.responseBytes = Buffer.byteLength(raw);
      options.success({ statusCode: response.status, data: JSON.parse(raw) });
    }).catch(error => options.fail({ errMsg: error.message }));
  },
  connectSocket(options) {
    let ws, closed = false;
    const callbacks = {};
    const task = { onOpen(fn) { callbacks.open = fn }, onMessage(fn) { callbacks.message = fn },
      onClose(fn) { callbacks.close = fn }, onError(fn) { callbacks.error = fn },
      close() { closed = true; ws?.close(); } };
    Promise.resolve().then(async () => {
      if (mutateBeforeConnect) { const mutate = mutateBeforeConnect; mutateBeforeConnect = null; await mutate(); }
      if (closed) return;
      ws = new WebSocket(options.url, { headers: options.header, handshakeTimeout: 500 }); sockets.push(ws);
      ws.on('open', () => callbacks.open?.({}));
      ws.on('ping', () => { metrics.transportPings++; });
      ws.on('message', data => { frames.push(JSON.parse(String(data))); callbacks.message?.({ data: String(data) }); });
      ws.on('error', error => callbacks.error?.({ errMsg: error.message }));
      ws.on('close', code => callbacks.close?.({ code }));
    });
    return task;
  }
}, { cloudSyncEnabled: false, manualSyncOnly: true });
r.cache.adoptScope(owner('A')); r.cache.writeConnection({ serverBaseUrl: base, token: 'synthetic' });
r.cache.write(r.cache.KEYS.bootstrap, owner('A'));
vm.runInNewContext(fs.readFileSync(path.join(miniRoot, 'app.js'), 'utf8'), {
  App(value) { app = value }, require: id => id === './utils/api' ? r.api : id === './utils/cache' ? r.cache : { cloudSyncEnabled: false },
  wx: global.wx, setTimeout, clearTimeout, Set, Date, Promise, Math, String, Number
});
global.getApp = () => app;
app.appVisible = true;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 1800) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error('Timed out: ' + label); await pause(10); }
}
const currentDiary = () => r.cache.read(r.cache.KEYS.diaryDays, []).find(row => row.date === '2026-09-20');
test.after(async () => {
  releaseAI(); app.onHide(); r.api.__test.cancelDirtyFlushTimer(); clearTimeout(app.syncNotifyTimer);
  await resumeDiaryOrganizations();
  for (const ws of sockets) ws.terminate();
  tunnel?.stop(); if (relay) await relay.close();
  server.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  await diaryJobStore.close();
  if (process.env.MAINLINE_TEST_EVIDENCE) fs.writeFileSync(path.join(process.env.MAINLINE_TEST_EVIDENCE, tunnel ? 'home-tunnel-realtime-local-metrics.json' : 'home-realtime-local-metrics.json'), JSON.stringify({ ...metrics, requests, frames }, null, 2));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('mainline-home-realtime-'));
  fs.rmSync(directory, { recursive: true, force: true });
});

test('actual app receives durable AI completion through home notifications without replaying its save', { timeout: idleWindowMs + 10000 }, async () => {
  await app.requestSync('initial');
  await until(() => app.globalData.realtimeConnected, 'authenticated socket');
  await r.api.call('diary.appendInput', { date: '2026-09-20', inputId: 'raw', content: '今天散步 30 分钟，可能还没有完全想明白。' }, { requestId: 'raw' });
  await r.api.flushQueue(); await entered;
  assert.equal(currentDiary().organizationStatus, 'pending');
  releaseAI(); await resumeDiaryOrganizations();
  assert.equal(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')).days.find(row => row.date === '2026-09-20').organizationStatus, 'organized');
  await until(() => currentDiary()?.organizationStatus === 'organized', 'AI result received automatically');
  assert.equal(currentDiary().summary, '## 今日记录\n\n今天散步 30 分钟，可能还没有完全想明白。');
  assert.equal(metrics.modelCalls, 1);
  assert.equal(requests.filter(item => item.action === 'batch').length, 1);
  await until(() => !app.syncPromise && !app.receiveTimer, 'receiver idle');
  const before = requests.length, disk = fs.readFileSync(STORE_PATH, 'utf8'), frameCount = frames.length, pings = metrics.transportPings;
  await pause(idleWindowMs);
  assert.equal(requests.length, before); assert.equal(frames.length, frameCount);
  assert.equal(fs.readFileSync(STORE_PATH, 'utf8'), disk);
  Object.assign(metrics, { idleWindowMs, idleHttpRequests: requests.length - before,
    idleApplicationFrames: frames.length - frameCount, idleTransportPings: metrics.transportPings - pings, idleDiskChanged: false });
  if (idleWindowMs >= 30000) assert.ok(metrics.idleTransportPings >= 1, 'the measurement crosses a real liveness heartbeat');
});

test('background closes notification connection and foreground catches edits and deletions', { timeout: 6000 }, async () => {
  app.onHide(); const before = requests.length;
  await mutateState(state => { state.days = state.days.filter(row => row.date !== '2026-09-20'); state.tasks.push({ id: 'background', title: '后台新增', version: 1 }); });
  await pause(300); assert.equal(requests.length, before);
  app.onShow();
  await until(() => !currentDiary() && r.cache.read(r.cache.KEYS.tasks, []).some(row => row.id === 'background'), 'foreground catch-up');
  assert.equal(app.globalData.receiveError || '', '');
});

test('snapshot-to-socket race cannot miss a desktop mutation', { timeout: 6000 }, async () => {
  await until(() => !app.syncPromise && !app.receiveTimer, 'prior receive idle');
  app.stopHomeRealtimeSync();
  mutateBeforeConnect = () => mutateState(state => { state.tasks.find(row => row.id === 'background').title = '连接建立期间修改'; });
  await app.requestSync('restart-watch');
  await until(() => r.cache.read(r.cache.KEYS.tasks, []).some(row => row.title === '连接建立期间修改'), 'gap catch-up');
  assert.equal(metrics.cloudRequests, 0);
});

test('a lost page or header is retried after backoff while the socket stays healthy', { timeout: 10000 }, async () => {
  for (const action of ['sync.changes', 'sync.snapshot']) {
    await until(() => !app.syncPromise && !app.receiveTimer, 'prior receive idle');
    failReceive = action;
    await mutateState(state => { state.tasks.find(row => row.id === 'background').title = action; });
    await until(() => r.cache.read(r.cache.KEYS.tasks, []).some(row => row.title === action), 'lost response retry', 4000);
    assert.equal(app.globalData.realtimeConnected, true);
    assert.equal(app.receiveRetryTimer, null);
  }
});

test('unauthorized socket discloses no revision or records and closes permanently', { timeout: 3000 }, async () => {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/home/socket', { headers: { Authorization: 'Bearer wrong' }, handshakeTimeout: 500 });
  sockets.push(ws); const messages = [];
  const result = await new Promise((resolve, reject) => {
    ws.on('message', raw => messages.push(JSON.parse(String(raw)))); ws.on('close', code => resolve(code)); ws.on('error', reject);
  });
  assert.equal(result, 1008); assert.equal(messages.length, 1);
  assert.equal(messages[0].code, 'UNAUTHORIZED'); assert.equal(messages[0].revision, undefined); assert.equal(messages[0].records, undefined);
});
