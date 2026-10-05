import { createServer } from "node:http";
import { randomUUID, timingSafeEqual, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import forwarding from './home-forwarding.cjs';
const { allowedTarget, scopedHeaders, MAX_BODY_BYTES } = forwarding;

const DEFAULT_PORT = 8787;
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_REQUESTS_PER_MINUTE = 120;
const HOME_PATH = /^\/h\/([A-Za-z0-9_-]{3,64})(\/api\/home\/(?:rpc|batch|ping|changes|socket|comment-image|comment-images\/todo-image-\d+-[a-z0-9]+\.(?:jpg|png|webp)))$/;
const TUNNEL_PATH = /^\/tunnel\/home\/([A-Za-z0-9_-]{3,64})$/;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(request) {
  const value = String(request.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function json(response, statusCode, value) {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  response.end(body);
}

function parseHomes(environment = process.env) {
  if (environment.RELAY_HOMES_JSON) {
    const parsed = JSON.parse(environment.RELAY_HOMES_JSON);
    return new Map(Object.entries(parsed).map(([id, token]) => [String(id), String(token)]));
  }
  const id = String(environment.RELAY_HOME_ID || "").trim();
  const token = String(environment.RELAY_TUNNEL_TOKEN || "").trim();
  if (id && token) return new Map([[id, token]]);
  try {
    const publicConfig = JSON.parse(readFileSync(new URL("./relay-public.json", import.meta.url), "utf8"));
    return new Map(Object.entries(publicConfig.homes || {}).map(([homeId, publicKey]) => [
      String(homeId),
      { publicKey: String(publicKey) },
    ]));
  } catch {
    return new Map();
  }
}

function tunnelAuthorized(request, homeId, expected) {
  if (typeof expected === "string") return safeEqual(bearer(request), expected);
  const publicKey = String(expected?.publicKey || "");
  const timestamp = String(request.headers["x-mainline-timestamp"] || "");
  const signature = String(request.headers["x-mainline-signature"] || "");
  const time = Number(timestamp);
  if (!publicKey || !signature || !Number.isFinite(time) || Math.abs(Date.now() - time) > 60_000) return false;
  try {
    return verify(
      null,
      Buffer.from(`${homeId}:${timestamp}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("请求内容超过 12MB");
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function forwardedHeaders(headers, publicBaseUrl) {
  return scopedHeaders(headers, publicBaseUrl);
}

function publicHomeBase(request, homeId) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const protocol = forwardedProto === "https" ? "https" : "http";
  const host = forwardedHost || request.headers.host || "localhost";
  return `${protocol}://${host}/h/${encodeURIComponent(homeId)}`;
}

export function createRelayServer(options = {}) {
  const homes = options.homes || parseHomes(options.environment);
  if (!homes.size) throw new Error("至少需要配置一个家庭服务器 ID 和隧道令牌");

  const requestTimeoutMs = options.requestTimeoutMs || DEFAULT_TIMEOUT_MS;
  const sockets = new Map();
  const pending = new Map();
  const notifications = new Map();
  const rateBuckets = new Map();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 20 * 1024 * 1024 });
  const phoneSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });

  function send(socket, message) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 24 * 1024 * 1024) { socket.terminate(); return false; }
    try { socket.send(JSON.stringify(message), error => { if (error) socket.terminate(); }); return true; }
    catch { socket.terminate(); return false; }
  }

  function finishPending(id, error, result) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer);
    if (error) { send(entry.socket, { type: 'cancel', id }); entry.reject(error); }
    else entry.resolve(result);
  }

  function closeNotification(id, code = 1011, reason = 'Home connection closed') {
    const entry = notifications.get(id);
    if (!entry) return;
    notifications.delete(id);
    send(entry.socket, { type: 'watch-close', id });
    entry.peer.close(code, reason.slice(0, 80));
  }

  function rateAllowed(request) {
    const now = Date.now();
    const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const key = forwarded || request.socket.remoteAddress || "unknown";
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= 60_000) {
      rateBuckets.set(key, { startedAt: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= MAX_REQUESTS_PER_MINUTE;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true, service: "mainline-home-relay" });
    }
    if (!rateAllowed(request)) {
      return json(response, 429, { ok: false, error: { code: "RATE_LIMITED", message: "请求过于频繁" } });
    }

    const match = HOME_PATH.exec(url.pathname);
    if (!match) {
      return json(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } });
    }
    const [, homeId, homePath] = match;
    const target = allowedTarget(request.method, `${homePath}${url.search}`);
    if (!target) {
      return json(response, 403, { ok: false, error: { code: "FORBIDDEN", message: "不允许转发这个接口或参数", retryable: false } });
    }
    if (!homes.has(homeId)) {
      return json(response, 404, { ok: false, error: { code: "HOME_NOT_FOUND", message: "家庭服务器不存在" } });
    }
    const socket = sockets.get(homeId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return json(response, 503, { ok: false, error: { code: "HOME_OFFLINE", message: "家庭电脑当前未在线", retryable: true } });
    }
    if (['/api/home/ping', '/api/home/batch', '/api/home/changes'].includes(homePath) && socket.tunnelProtocol < 3) {
      return json(response, 501, { ok: false, error: { code: 'HOME_UPGRADE_REQUIRED', message: '请先更新电脑同步组件', retryable: false } });
    }
    if (pending.size >= 128) return json(response, 503, { ok: false, error: { code: 'RELAY_BUSY', message: '同步连接繁忙，请稍后重试', retryable: true } });

    let requestId;
    const cancelled = () => {
      if (!response.writableEnded && requestId) finishPending(requestId, Object.assign(new Error('请求已取消'), { code: 'CLIENT_DISCONNECTED' }));
    };
    response.once('close', cancelled);
    try {
      const body = await readBody(request);
      if (response.destroyed) return;
      const id = requestId = randomUUID();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const error = new Error("家庭电脑响应超时");
          error.code = "HOME_TIMEOUT";
          finishPending(id, error);
        }, homePath === '/api/home/changes' ? Math.max(35000, requestTimeoutMs) : requestTimeoutMs);
        pending.set(id, { homeId, socket, resolve, reject, timer });
        const sent = send(socket, {
          type: "request",
          id,
          method: request.method,
          path: target,
          headers: forwardedHeaders(request.headers, publicHomeBase(request, homeId)),
          body: body.toString("base64"),
        });
        if (!sent) finishPending(id, Object.assign(new Error('家庭电脑连接已断开'), { code: 'HOME_OFFLINE' }));
      });
      if (response.destroyed) return;
      if (String(result.body || '').length > Math.ceil(MAX_BODY_BYTES / 3) * 4) throw Object.assign(new Error('响应内容超过 12MB'), { code: 'PAYLOAD_TOO_LARGE' });
      const resultBody = Buffer.from(result.body || "", "base64");
      if (resultBody.length > MAX_BODY_BYTES) throw Object.assign(new Error('响应内容超过 12MB'), { code: 'PAYLOAD_TOO_LARGE' });
      response.writeHead(Number(result.statusCode || 502), {
        "content-type": result.contentType || "application/json; charset=utf-8",
        "content-length": String(resultBody.length),
        "cache-control": result.cacheControl || "no-store",
      });
      response.end(resultBody);
    } catch (error) {
      const tooLarge = error?.code === "PAYLOAD_TOO_LARGE";
      json(response, tooLarge ? 413 : 502, {
        ok: false,
        error: {
          code: error?.code || "RELAY_ERROR",
          message: error?.message || "家庭服务器中继失败",
          retryable: !tooLarge,
        },
      });
    } finally { response.removeListener('close', cancelled); }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const phoneMatch = HOME_PATH.exec(url.pathname);
    if (phoneMatch?.[2] === '/api/home/socket' && !url.search && rateAllowed(request)) {
      const homeId = phoneMatch[1];
      phoneSocketServer.handleUpgrade(request, socket, head, peer => {
        peer.on('error', () => peer.terminate());
        const tunnel = sockets.get(homeId);
        const code = !homes.has(homeId) ? 'HOME_NOT_FOUND' : !tunnel || tunnel.readyState !== 1 ? 'HOME_OFFLINE'
          : tunnel.tunnelProtocol < 3 ? 'HOME_UPGRADE_REQUIRED' : notifications.size >= 1024 ? 'RELAY_BUSY' : null;
        if (code) {
          const permanent = ['HOME_NOT_FOUND', 'HOME_UPGRADE_REQUIRED'].includes(code);
          send(peer, { type: 'error', code, message: permanent ? '请核对电脑同步组件与连接配置' : '电脑通知连接暂时不可用', retryable: !permanent });
          peer.close(permanent ? 1008 : 1013); return;
        }
        const id = randomUUID();
        notifications.set(id, { homeId, socket: tunnel, peer });
        peer.isAlive = true;
        peer.on('pong', () => { peer.isAlive = true; });
        peer.on('message', () => closeNotification(id, 1008, 'Notifications only'));
        peer.on('close', () => closeNotification(id, 1000, 'Phone disconnected'));
        if (!send(tunnel, { type: 'watch-open', id, path: '/api/home/socket', headers: forwardedHeaders(request.headers) })) closeNotification(id);
      });
      return;
    }
    const match = TUNNEL_PATH.exec(url.pathname);
    const homeId = match?.[1];
    const expected = homeId ? homes.get(homeId) : "";
    if (!homeId || !expected || !tunnelAuthorized(request, homeId, expected)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request, homeId);
    });
  });

  websocketServer.on("connection", (socket, request, homeId) => {
    const previous = sockets.get(homeId);
    if (previous && previous !== socket) previous.close(4001, "replaced");
    sockets.set(homeId, socket);
    socket.tunnelProtocol = Number(request.headers['x-mainline-tunnel-protocol'] || 1);
    socket.on('error', () => socket.terminate());
    socket.isAlive = true;
    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (sockets.get(homeId) !== socket) return;
      if (message?.type === 'watch-event' || message?.type === 'watch-close') {
        const entry = notifications.get(message.id);
        if (!entry || entry.socket !== socket) return;
        if (message.type === 'watch-close') { closeNotification(message.id, message.code === 1008 ? 1008 : message.code === 1013 ? 1013 : 1011); return; }
        if (!['connected', 'changed', 'error'].includes(message.event?.type) || Buffer.byteLength(JSON.stringify(message.event)) > 8192) { closeNotification(message.id); return; }
        if (entry.peer.bufferedAmount > 65536 || !send(entry.peer, message.event)) closeNotification(message.id);
        return;
      }
      if (message?.type !== "response" || !message.id) return;
      const entry = pending.get(message.id);
      if (!entry || entry.socket !== socket) return;
      finishPending(message.id, null, message);
    });
    socket.on("close", () => {
      if (sockets.get(homeId) === socket) sockets.delete(homeId);
      for (const [id, entry] of pending) {
        if (entry.socket !== socket) continue;
        const error = new Error("家庭电脑连接已断开");
        error.code = "HOME_OFFLINE";
        finishPending(id, error);
      }
      for (const [id, entry] of notifications) if (entry.socket === socket) closeNotification(id);
    });
  });

  const heartbeat = setInterval(() => {
    for (const [key, bucket] of rateBuckets) if (Date.now() - bucket.startedAt >= 60000) rateBuckets.delete(key);
    for (const socket of [...sockets.values(), ...[...notifications.values()].map(entry => entry.peer)]) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try { socket.ping(); } catch { socket.terminate(); }
    }
  }, 25_000);
  heartbeat.unref?.();

  return {
    server,
    status: () => ({ connectedHomes: [...sockets.keys()], pendingRequests: pending.size, notificationConnections: notifications.size }),
    close: async () => {
      clearInterval(heartbeat);
      for (const id of pending.keys()) finishPending(id, Object.assign(new Error('中继服务已关闭'), { code: 'HOME_OFFLINE' }));
      for (const id of notifications.keys()) closeNotification(id, 1001, 'shutdown');
      for (const socket of websocketServer.clients) socket.terminate();
      for (const socket of phoneSocketServer.clients) socket.terminate();
      websocketServer.close(); phoneSocketServer.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = createRelayServer();
  const port = Number(process.env.PORT || DEFAULT_PORT);
  relay.server.listen(port, "0.0.0.0", () => {
    console.log(`Mainline Home Relay listening on ${port}`);
  });
}
