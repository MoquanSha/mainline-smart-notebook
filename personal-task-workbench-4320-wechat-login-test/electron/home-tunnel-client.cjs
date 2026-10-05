const { EventEmitter } = require("node:events");
const { sign } = require("node:crypto");
const WebSocket = require("ws");
const { allowedTarget, scopedHeaders, MAX_BODY_BYTES } = require('../relay/home-forwarding.cjs');

function websocketUrl(relayBaseUrl, homeId) {
  const url = new URL(relayBaseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("中继地址必须使用 HTTPS");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/tunnel/home/${encodeURIComponent(homeId)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

class HomeTunnelClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.localBaseUrl = options.localBaseUrl;
    this.WebSocket = options.WebSocket || WebSocket;
    this.fetch = options.fetch || globalThis.fetch;
    this.config = null;
    this.socket = null;
    this.timer = null;
    this.stopped = true;
    this.retryMs = 1000;
    this.requests = new Map();
    this.notifications = new Map();
    this.snapshot = { configured: false, connected: false, state: "disabled" };
  }

  status() {
    return {
      ...this.snapshot,
      publicEndpoint: this.config
        ? `${this.config.relayBaseUrl.replace(/\/$/, "")}/h/${this.config.homeId}`
        : "",
      relayBaseUrl: this.config?.relayBaseUrl || "",
      homeId: this.config?.homeId || "",
      activeRequests: this.requests.size,
      notificationConnections: this.notifications.size,
    };
  }

  setStatus(patch) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit("status", this.status());
  }

  start(config) {
    this.stop(false);
    this.config = config;
    this.stopped = false;
    this.retryMs = 1000;
    this.setStatus({ configured: true, connected: false, state: "connecting", lastError: "" });
    this.connect();
  }

  stop(clearConfig = true) {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      this.dispose(socket);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.close();
    }
    if (clearConfig) this.config = null;
    this.setStatus({ configured: Boolean(this.config), connected: false, state: this.config ? "stopped" : "disabled" });
  }

  scheduleReconnect() {
    if (this.stopped || this.timer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    this.setStatus({ connected: false, state: "waiting" });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  connect() {
    if (this.stopped || !this.config) return;
    let url;
    try {
      url = websocketUrl(this.config.relayBaseUrl, this.config.homeId);
    } catch (error) {
      this.setStatus({ connected: false, state: "error", lastError: error.message });
      return;
    }
    this.setStatus({ connected: false, state: "connecting", lastError: "" });
    const timestamp = String(Date.now());
    const keyAuth = String(this.config.tunnelToken || "").includes("BEGIN PRIVATE KEY");
    const headers = keyAuth
      ? {
          "X-Mainline-Timestamp": timestamp,
          "X-Mainline-Signature": sign(
            null,
            Buffer.from(`${this.config.homeId}:${timestamp}`),
            this.config.tunnelToken,
          ).toString("base64url"),
          "X-Mainline-Client": "desktop-home-tunnel/2",
        }
      : {
          Authorization: `Bearer ${this.config.tunnelToken}`,
          "X-Mainline-Client": "desktop-home-tunnel/1",
        };
    headers['X-Mainline-Tunnel-Protocol'] = '3';
    const socket = new this.WebSocket(url, {
      headers,
      handshakeTimeout: 12_000,
      maxPayload: 20 * 1024 * 1024,
    });
    this.socket = socket;
    socket.homeLocalBase = String(this.localBaseUrl).replace(/\/$/, '');
    socket.on("open", () => {
      if (!this.active(socket)) return;
      this.retryMs = 1000;
      this.setStatus({ connected: true, state: "connected", lastConnectedAt: new Date().toISOString(), lastError: "" });
    });
    socket.on("message", (raw) => this.handleMessage(socket, raw));
    socket.on("error", (error) => {
      if (!this.active(socket)) return;
      this.setStatus({ connected: false, state: "error", lastError: String(error?.message || error).slice(0, 300) });
    });
    socket.on("close", () => {
      this.dispose(socket);
      if (this.socket === socket) { this.socket = null; this.scheduleReconnect(); }
    });
  }

  active(socket) { return !this.stopped && this.socket === socket; }

  send(socket, message) {
    if (!this.active(socket) || socket.readyState !== 1) return;
    if (socket.bufferedAmount > 24 * 1024 * 1024) { socket.terminate(); return; }
    try { socket.send(JSON.stringify(message), error => { if (error) socket.terminate(); }); }
    catch { socket.terminate(); }
  }

  dispose(socket) {
    for (const [id, request] of this.requests) {
      if (request.tunnel !== socket) continue;
      this.requests.delete(id); clearTimeout(request.timer); request.controller.abort();
    }
    for (const [id, entry] of this.notifications) {
      if (entry.tunnel !== socket) continue;
      this.notifications.delete(id); entry.local.close();
    }
  }

  openNotification(socket, request) {
    if (request.path !== '/api/home/socket' || this.notifications.has(request.id)) return;
    if (this.notifications.size >= 32) {
      this.send(socket, { type: 'watch-close', id: request.id, code: 1013, reason: 'Too many notification connections' });
      return;
    }
    let local;
    try {
      const url = new URL('/api/home/socket', socket.homeLocalBase);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      local = new this.WebSocket(url.toString(), { headers: scopedHeaders(request.headers),
        maxPayload: 8192, handshakeTimeout: 12000, perMessageDeflate: false });
    } catch {
      this.send(socket, { type: 'watch-close', id: request.id, code: 1011, reason: 'Home notification unavailable' });
      return;
    }
    const entry = { tunnel: socket, local };
    this.notifications.set(request.id, entry);
    const active = () => this.active(socket) && this.notifications.get(request.id) === entry;
    local.on('message', raw => {
      if (!active()) return;
      let event;
      try { event = JSON.parse(String(raw)); } catch { local.close(1008); return; }
      if (!['connected', 'changed', 'error'].includes(event?.type)) { local.close(1008); return; }
      this.send(socket, { type: 'watch-event', id: request.id, event });
    });
    local.on('error', () => {
      if (active()) this.send(socket, { type: 'watch-event', id: request.id,
        event: { type: 'error', code: 'HOME_NOTIFICATIONS_OFFLINE', message: '电脑变更通知连接中断', retryable: true } });
    });
    local.on('close', (code, reason) => {
      if (!active()) return;
      this.notifications.delete(request.id);
      this.send(socket, { type: 'watch-close', id: request.id, code: code === 1008 ? 1008 : 1011, reason: String(reason).slice(0, 80) });
    });
  }

  async handleMessage(socket, raw) {
    if (!this.active(socket)) return;
    let request;
    try { request = JSON.parse(String(raw)); } catch { return; }
    if (typeof request?.id !== 'string' || request.id.length > 100) return;
    if (request.type === 'watch-open') { this.openNotification(socket, request); return; }
    if (request.type === 'watch-close') {
      const entry = this.notifications.get(request.id);
      if (entry?.tunnel === socket) { this.notifications.delete(request.id); entry.local.close(); }
      return;
    }
    if (request.type === 'cancel') {
      const pending = this.requests.get(request.id);
      if (pending?.tunnel === socket) { this.requests.delete(request.id); clearTimeout(pending.timer); pending.controller.abort(); }
      return;
    }
    if (request.type !== "request" || this.requests.has(request.id)) return;
    const target = allowedTarget(request.method, request.path);
    if (!target) {
      this.send(socket, {
        type: "response",
        id: request.id,
        statusCode: 403,
        contentType: "application/json; charset=utf-8",
        body: Buffer.from(JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "不允许转发这个接口" } })).toString("base64"),
      });
      return;
    }
    const controller = new AbortController();
    const pending = { tunnel: socket, controller };
    this.requests.set(request.id, pending);
    const timer = setTimeout(() => controller.abort(), target.startsWith('/api/home/changes') ? 32000 : 20000);
    pending.timer = timer;
    const active = () => this.active(socket) && this.requests.get(request.id) === pending;
    try {
      if (String(request.body || '').length > Math.ceil(MAX_BODY_BYTES / 3) * 4) throw Object.assign(new Error('请求内容超过 12MB'), { code: 'PAYLOAD_TOO_LARGE', retryable: false });
      const body = Buffer.from(request.body || "", "base64");
      if (body.length > MAX_BODY_BYTES) throw Object.assign(new Error('请求内容超过 12MB'), { code: 'PAYLOAD_TOO_LARGE', retryable: false });
      const fetchOptions = {
        method: request.method,
        headers: scopedHeaders(request.headers, request.headers?.['x-mainline-public-base']),
        signal: controller.signal,
        redirect: 'error',
      };
      if (request.method === "POST") fetchOptions.body = body;
      const response = await this.fetch(`${socket.homeLocalBase}${target}`, fetchOptions);
      const chunks = []; let size = 0;
      for await (const chunk of response.body || []) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { controller.abort(); throw Object.assign(new Error('家庭服务器响应超过 12MB'), { code: 'PAYLOAD_TOO_LARGE', retryable: false }); }
        chunks.push(Buffer.from(chunk));
      }
      const responseBody = Buffer.concat(chunks);
      if (!active()) return;
      this.send(socket, {
        type: "response",
        id: request.id,
        statusCode: response.status,
        contentType: response.headers.get("content-type") || "application/json; charset=utf-8",
        cacheControl: response.headers.get("cache-control") || "no-store",
        body: responseBody.toString("base64"),
      });
    } catch (error) {
      if (!active()) return;
      this.send(socket, {
        type: "response",
        id: request.id,
        statusCode: error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 502,
        contentType: "application/json; charset=utf-8",
        body: Buffer.from(JSON.stringify({
          ok: false,
          error: { code: error.code === 'PAYLOAD_TOO_LARGE' ? error.code : "HOME_FORWARD_FAILED", message: error?.message || "家庭服务器转发失败", retryable: error.retryable !== false },
        })).toString("base64"),
      });
    } finally {
      clearTimeout(timer);
      if (this.requests.get(request.id) === pending) this.requests.delete(request.id);
    }
  }
}

module.exports = { HomeTunnelClient, websocketUrl };
