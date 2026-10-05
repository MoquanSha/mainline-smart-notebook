import { createReadStream, existsSync, statSync } from "node:fs";
import { createHmac, createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { WebSocketServer } from 'ws';
import { extname, isAbsolute, relative, resolve } from "node:path";
import { updateHomeHistory, homeHistoryPage } from './home-history.mjs';

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const MAX_BATCH_OPERATIONS = 50;
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const IMAGE_ACCESS_TTL_MS = 30 * 60 * 1000;

export function parseHomePrincipal(value) {
  if (!value) return null;
  let principal;
  try { principal = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new Error('电脑同步账号配置无效'); }
  const valid = key => typeof principal?.[key] === 'string' && principal[key].trim() &&
    principal[key].length <= 160 && !/[\u0000-\u001f]/.test(principal[key]);
  if (!valid('userId') || !valid('workspaceId')) throw new Error('电脑同步缺少有效账号与个人空间');
  return { userId: principal.userId, workspaceId: principal.workspaceId };
}

function homeScopeError(code, message) { return Object.assign(new Error(message), { code, status: 403, retryable: false }); }
function headerScope(request) {
  const value = request.headers['x-mainline-scope'];
  if (!value) return undefined;
  try { if (typeof value !== 'string' || value.length > 8192) throw new Error(); return JSON.parse(decodeURIComponent(value)); }
  catch { throw homeScopeError('HOME_SCOPE_REQUIRED', '电脑同步请求的账号归属无效，原操作已保留'); }
}
const samePrincipal = (left, right) => Boolean(left && right && left.userId === right.userId && left.workspaceId === right.workspaceId);

function nowIso() {
  return new Date().toISOString();
}

function dayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function dayOffset(offset) {
  const value = new Date(`${dayKey()}T12:00:00+08:00`);
  value.setUTCDate(value.getUTCDate() + Number(offset || 0));
  return dayKey(value);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("请求内容过大");
      error.status = 413;
      error.code = 'PAYLOAD_TOO_LARGE';
      error.retryable = false;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
  } catch {
    const error = new Error("请求不是有效的 JSON");
    error.status = 400;
    error.code = 'VALIDATION';
    error.retryable = false;
    throw error;
  }
}

function tokenFromRequest(request, url) {
  const authorization = String(request.headers.authorization || "");
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, "").trim();
  return String(request.headers["x-mainline-token"] || url.searchParams.get("token") || "").trim();
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function imageAccessToken(secret, fileName, expiresAt = Date.now() + IMAGE_ACCESS_TTL_MS) {
  const expiry = Math.floor(Number(expiresAt));
  const signature = createHmac("sha256", String(secret || ""))
    .update(`${fileName}\n${expiry}`)
    .digest("base64url");
  return `v1.${expiry}.${signature}`;
}

function verifyImageAccessToken(candidate, secret, fileName, now = Date.now()) {
  const match = /^v1\.(\d{13})\.([A-Za-z0-9_-]{40,50})$/.exec(String(candidate || ""));
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (!Number.isFinite(expiresAt) || expiresAt < now || expiresAt > now + IMAGE_ACCESS_TTL_MS + 60_000) return false;
  return safeEqual(candidate, imageAccessToken(secret, fileName, expiresAt));
}

function assertAuthorized(request, url, token) {
  const candidate = tokenFromRequest(request, url);
  let imageFileName = "";
  if (request.method === "GET" && url.pathname.startsWith("/api/home/comment-images/")) {
    try { imageFileName = decodeURIComponent(url.pathname.slice("/api/home/comment-images/".length)); } catch { imageFileName = ""; }
  }
  const authorized = Boolean(token) && (
    safeEqual(candidate, token)
    || (imageFileName && verifyImageAccessToken(candidate, token, imageFileName))
  );
  if (!authorized) {
    const error = new Error("家庭服务器连接凭证无效");
    error.status = 401;
    error.code = "UNAUTHORIZED";
    throw error;
  }
}

function isTodayTodo(item) {
  return Boolean(item && (item.entryKind === "today_todo" || String(item.id || "").startsWith("today-todo-")));
}

function todoSortValue(item) {
  const explicit = Number(item?.sortRank);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const created = Date.parse(item?.createdAt || "");
  return Number.isFinite(created) ? created : 0;
}

function todoPinTier(item) {
  if (item?.pinned && item?.priorityPinned) return 0;
  if (item?.pinned) return 1;
  return 2;
}

function compareTodos(left, right) {
  if (left?.status === "planned" && right?.status !== "planned") return -1;
  if (right?.status === "planned" && left?.status !== "planned") return 1;
  const pinTierDelta = todoPinTier(left) - todoPinTier(right);
  if (pinTierDelta) return pinTierDelta;
  return todoSortValue(right) - todoSortValue(left)
    || String(right?.createdAt || "").localeCompare(String(left?.createdAt || ""))
    || String(left?.id || "").localeCompare(String(right?.id || ""));
}

function withVersion(item) {
  if (!item) return item;
  return { ...item, version: Math.max(1, Number(item.version) || 1) };
}

function publicBaseUrl(request) {
  const tunneledBase = String(request.headers["x-mainline-public-base"] || "").trim();
  if (tunneledBase) {
    try {
      const parsed = new URL(tunneledBase);
      if (["http:", "https:"].includes(parsed.protocol)) return parsed.toString().replace(/\/$/, "");
    } catch {}
  }
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const protocol = forwardedProto || "http";
  const host = forwardedHost || request.headers.host || "127.0.0.1";
  return `${protocol}://${host}`.replace(/\/$/, "");
}

function decorateAttachments(value, request, token) {
  if (Array.isArray(value)) return value.map((item) => decorateAttachments(item, request, token));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) output[key] = decorateAttachments(entry, request, token);
  if (output.relativePath && !output.previewUrl && /\.(jpg|png|webp)$/i.test(String(output.relativePath))) {
    const accessToken = imageAccessToken(token, String(output.relativePath));
    output.previewUrl = `${publicBaseUrl(request)}/api/home/comment-images/${encodeURIComponent(output.relativePath)}?token=${encodeURIComponent(accessToken)}`;
  }
  return output;
}

function todoBundle(state, historyDays = 14) {
  const today = dayKey();
  const rows = (state.dailyTasks || []).filter(isTodayTodo).filter((item) => !item.trashedAt);
  const todos = rows
    .filter((item) => item.date === today && ["planned", "done"].includes(item.status))
    .map(withVersion)
    .sort(compareTodos);
  const scheduled = rows
    .filter((item) => item.date > today && item.status === "planned")
    .map(withVersion)
    .sort((left, right) => String(left.date || "").localeCompare(String(right.date || "")) || compareTodos(left, right));
  const completedHistory = rows
    .filter((item) => item.status === "done" && item.completedAt)
    .map(withVersion)
    .sort((left, right) => String(right.completedAt || "").localeCompare(String(left.completedAt || "")));
  const history = [];
  for (let offset = 1; offset <= Math.max(1, Math.min(60, Number(historyDays) || 14)); offset += 1) {
    const date = dayOffset(-offset);
    const dayRows = rows.filter((item) => item.date === date).map(withVersion).sort(compareTodos);
    if (dayRows.length) history.push({ date, todos: dayRows });
  }
  return { date: today, todos, scheduled, completedHistory, history };
}

function completedTodoBundle(state, date = dayKey()) {
  const rows = (state.dailyTasks || [])
    .filter((item) => isTodayTodo(item) && !item.trashedAt && item.status === "done")
    .filter((item) => dayKey(new Date(item.completedAt || 0)) === date)
    .map(withVersion)
    .sort((left, right) => String(right.completedAt || "").localeCompare(String(left.completedAt || "")));
  return { date, todos: rows };
}

function captureDate(capture) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(capture.journalDate || ''))) return capture.journalDate;
  return dayKey(new Date(capture.occurredAt || capture.createdAt || Date.now()));
}

function journalSupplements(capture) {
  const rows = new Map();
  for (const item of [...(capture.journalSupplements || []), ...(capture.annotations || [])]) {
    const previous = rows.get(item.id);
    if (!previous) { rows.set(item.id, { ...item }); continue; }
    const deleted = row => Boolean(row.deletedAt || row.trashedAt || row.permanentlyPurgedAt);
    if (deleted(previous) || deleted(item)) {
      if (!deleted(previous) || (deleted(item) && Number(item.version || 1) > Number(previous.version || 1))) rows.set(item.id, { ...item });
      continue;
    }
    const original = row => String(row.rawContent ?? row.content ?? '');
    if (original(previous) !== original(item)) {
      // Legacy copies can contain two originals under one ID. Keep both in
      // the view instead of silently selecting one text during adaptation.
      const id = `journal_conflict_${createHash('sha256').update(JSON.stringify([item.id, original(item)])).digest('hex').slice(0, 40)}`;
      rows.set(id, { ...item, id, conflictOf: item.id });
    } else if (Number(item.version || 1) > Number(previous.version || 1)) rows.set(item.id, { ...item });
  }
  return [...rows.values()];
}

function presentCapture(capture) {
  const rawContent = String(capture.content || capture.rawContent || "");
  return withVersion({
    ...capture,
    entryKind: "journal_entry",
    rawContent,
    journalDate: capture.journalDate || captureDate(capture),
    journalSummary: capture.journalSummary || capture.organizedContent || capture.organizationSummary || rawContent,
    checklistItems: (capture.checklistItems || []).map((item) => ({ ...item, done: Boolean(item.done ?? item.checked) })),
    journalSupplements: journalSupplements(capture),
  });
}

const journalCaptureSources = new Set([
  "manual",
  "import",
  "wechat_official",
  "wecom",
  "wechat",
  "mobile",
  "home",
]);

function isCanonicalJournalCapture(capture) {
  if (!capture?.id || capture.trashedAt || capture.status === "ignored") return false;
  if (capture.entryKind === "journal_entry") return true;
  if (!journalCaptureSources.has(String(capture.source || "").toLowerCase())) return false;
  return ["note", "import", "journal_entry"].includes(String(capture.kind || ""));
}

function historyRecords(state) {
  const capture = row => row.source !== 'codex' && (row.entryKind === 'journal_entry' ||
    journalCaptureSources.has(String(row.source || '').toLowerCase()) && ['note', 'import', 'journal_entry'].includes(row.kind || ''));
  return [
    ...(state.tasks || []).filter(row => row.id).map(row => ({ collection: 'tasks', document: withVersion(row) })),
    ...(state.dailyTasks || []).filter(isTodayTodo).map(row => ({ collection: 'daily_tasks', document: withVersion(row) })),
    ...(state.captures || []).filter(row => row.id && capture(row)).map(row => ({ collection: 'captures', document: presentCapture(row) })),
    ...(state.days || []).filter(row => row.date).map(row => ({ collection: 'day_records', document: withVersion({ ...row, id: row.id || 'day_records_' + row.date }) }))
  ];
}

export function prepareHomeHistory(state, previous = state.meta?.homeHistory) {
  return updateHomeHistory(state, historyRecords, previous);
}

function journalOverview(state, historyDays = 14) {
  const today = dayKey();
  const captures = (state.captures || []).filter(isCanonicalJournalCapture).map(presentCapture);
  const entries = captures.filter((item) => captureDate(item) === today && !item.hiddenAt);
  const favorites = captures.filter((item) => item.favoritedAt && !item.hiddenAt);
  const hidden = captures.filter((item) => item.hiddenAt);
  const history = [];
  for (let offset = 1; offset <= Math.max(1, Math.min(60, Number(historyDays) || 14)); offset += 1) {
    const date = dayOffset(-offset);
    const dayEntries = captures.filter((item) => captureDate(item) === date && !item.hiddenAt);
    if (dayEntries.length) history.push({ date, entries: dayEntries });
  }
  const sortNewest = (left, right) => String(right.occurredAt || right.createdAt || "").localeCompare(String(left.occurredAt || left.createdAt || ""));
  entries.sort(sortNewest);
  favorites.sort(sortNewest);
  hidden.sort(sortNewest);
  return { entries, favorites, hidden, history };
}

function archiveEntries(state) {
  return (state.captures || [])
    .filter((item) => !item.trashedAt && item.archivedAt)
    .map(presentCapture)
    .sort((left, right) => String(right.archivedAt || "").localeCompare(String(left.archivedAt || "")));
}

function remainingDays(purgeAt) {
  if (!purgeAt) return 15;
  return Math.max(1, Math.ceil((new Date(purgeAt).getTime() - Date.now()) / 86400000));
}

function trashItems(state) {
  const captures = (state.captures || []).filter((item) => item.trashedAt).map((item) => ({
    ...presentCapture(item),
    entityType: "capture",
    displayTitle: item.journalTitle || String(item.content || "").slice(0, 48) || "灵光一现",
    remainingDays: remainingDays(item.purgeAt),
  }));
  const todos = (state.dailyTasks || []).filter((item) => isTodayTodo(item) && item.trashedAt).map((item) => ({
    ...withVersion(item),
    entityType: "today_todo",
    displayTitle: item.title || "今日待办",
    remainingDays: remainingDays(item.purgeAt),
  }));
  return [...captures, ...todos].sort((left, right) => String(right.trashedAt || "").localeCompare(String(left.trashedAt || "")));
}

function activeProposals(state) {
  return (state.proposals || []).filter((item) => !item.deletedAt && ["pending", "deferred"].includes(item.status)).map(withVersion);
}

function activeTasks(state) {
  return (state.tasks || []).filter((item) => !item.deletedAt).map(withVersion);
}

function mergeNestedRows(localRows = [], cloudRows = []) {
  const merged = new Map((localRows || []).filter((item) => item?.id).map((item) => [item.id, { ...item }]));
  for (const cloudRow of cloudRows || []) {
    if (!cloudRow?.id) continue;
    const localRow = merged.get(cloudRow.id) || {};
    const next = { ...localRow, ...cloudRow };
    if (Array.isArray(cloudRow.attachments)) {
      next.attachments = mergeNestedRows(localRow.attachments || [], cloudRow.attachments);
    }
    merged.set(cloudRow.id, next);
  }
  return [...merged.values()];
}

function mergeEntities(localRows = [], cloudRows = []) {
  const merged = new Map((localRows || []).filter((item) => item?.id).map((item) => [item.id, { ...item }]));
  for (const cloudRow of cloudRows || []) {
    if (!cloudRow?.id) continue;
    const localRow = merged.get(cloudRow.id) || {};
    const next = { ...localRow, ...cloudRow };
    if (Array.isArray(cloudRow.comments)) {
      next.comments = mergeNestedRows(localRow.comments || [], cloudRow.comments);
    }
    if (Array.isArray(cloudRow.checklistItems)) {
      next.checklistItems = mergeNestedRows(localRow.checklistItems || [], cloudRow.checklistItems);
    }
    if (Array.isArray(cloudRow.journalSupplements)) {
      next.journalSupplements = mergeNestedRows(localRow.journalSupplements || [], cloudRow.journalSupplements);
    }
    merged.set(cloudRow.id, next);
  }
  return [...merged.values()];
}

function flattenHistoryRows(groups = [], key) {
  return (groups || []).flatMap((group) => Array.isArray(group?.[key]) ? group[key] : []);
}

function mergeCloudReadIntoState(state, payload = {}) {
  const action = String(payload.sourceAction || "");
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  if (action === "todayTodo.list" || action === "todayTodo.history") {
    const rows = [...(data.todos || []), ...flattenHistoryRows(data.history, "todos")];
    state.dailyTasks = mergeEntities(state.dailyTasks, rows);
  } else if (action === "journal.overview") {
    const rows = [
      ...(data.entries || []),
      ...(data.favorites || []),
      ...(data.hidden || []),
      ...flattenHistoryRows(data.history, "entries"),
    ];
    state.captures = mergeEntities(state.captures, rows);
  } else if (action === "journal.listArchive") {
    state.captures = mergeEntities(state.captures, data.entries || []);
  } else if (action === "proposal.list") {
    state.proposals = mergeEntities(state.proposals, data.proposals || []);
  } else if (action === "task.list") {
    state.tasks = mergeEntities(state.tasks, data.tasks || []);
  } else if (action === "trash.list") {
    const items = data.items || [];
    state.dailyTasks = mergeEntities(state.dailyTasks, items.filter((item) => item.entityType === "today_todo"));
    state.captures = mergeEntities(state.captures, items.filter((item) => item.entityType === "capture"));
  } else {
    const error = new Error(`家庭服务器无法接收云端快照 ${action}`);
    error.status = 400;
    error.code = "VALIDATION";
    throw error;
  }
  state.meta ||= {};
  state.meta.lastCloudWarmAt = nowIso();
  state.meta.lastCloudWarmAction = action;
}

function sourceRows(state, payload) {
  const ids = new Set(Array.isArray(payload.sourceIds) ? payload.sourceIds : []);
  if (payload.taskId) {
    const task = (state.tasks || []).find((item) => item.id === payload.taskId);
    for (const id of task?.sourceCaptureIds || task?.sourceIds || []) ids.add(id);
  }
  return (state.captures || []).filter((item) => ids.has(item.id)).map(presentCapture);
}

function bootstrapData(state) {
  const pending = activeProposals(state).filter((item) => item.status === "pending").length;
  return {
    onboardingRequired: false,
    mode: "home-server",
    counts: { proposals: pending, tasks: activeTasks(state).length },
    storagePrefix: "",
    account: {
      user: { id: "home-owner", displayName: "家庭服务器" },
      role: "owner",
      workspaces: [{ id: "home", name: "家庭服务器版", role: "owner", plan: "本地", active: true }],
    },
  };
}

function readAction(state, action, payload) {
  if (action === "bootstrap") return bootstrapData(state);
  if (action === "todayTodo.list") return todoBundle(state, payload.historyDays);
  if (action === "todayTodo.completedByDate") return completedTodoBundle(state, payload.date);
  if (action === "journal.overview") return journalOverview(state, payload.historyDays);
  if (action === "journal.listArchive") return { entries: archiveEntries(state) };
  if (action === "trash.list") return { items: trashItems(state) };
  if (action === "proposal.list") return { proposals: activeProposals(state) };
  if (action === "task.list") return { tasks: activeTasks(state) };
  if (action === "source.list") return { sources: sourceRows(state, payload) };
  if (action === "device.status") return {
    paired: true,
    connected: true,
    deviceCount: 1,
    lastSyncStatus: "applied",
    lastSyncAt: state.meta?.lastHomeSyncAt || "",
    desktopAppliedAt: state.meta?.lastHomeSyncAt || "",
  };
  return null;
}

const READ_ACTIONS = new Set([
  "bootstrap",
  "todayTodo.list",
  "todayTodo.completedByDate",
  "journal.overview",
  "journal.listArchive",
  "trash.list",
  "proposal.list",
  "task.list",
  "source.list",
  "device.status",
]);

function targetForAction(state, action, payload) {
  if (action.startsWith("todayTodo.")) return (state.dailyTasks || []).find((item) => item.id === payload.todoId);
  if (action.startsWith("journal.") || action.startsWith("capture.")) {
    return (state.captures || []).find((item) => item.id === (payload.entryId || payload.id || payload.captureId));
  }
  if (action.startsWith("proposal.")) return (state.proposals || []).find((item) => item.id === payload.id);
  if (action.startsWith("task.")) return (state.tasks || []).find((item) => item.id === (payload.taskId || payload.id));
  if (action === "trash.restore") {
    const list = payload.entityType === "today_todo" ? state.dailyTasks : state.captures;
    return (list || []).find((item) => item.id === payload.id);
  }
  return null;
}

function assertVersion(state, action, payload) {
  if (payload.baseVersion === undefined || payload.baseVersion === null || payload.baseVersion === "") return;
  const target = targetForAction(state, action, payload);
  if (!target) return;
  const actual = Math.max(1, Number(target.version) || 1);
  if (Number(payload.baseVersion) === actual) return;
  const error = new Error("内容已在另一端更新，请重新同步后再操作");
  error.status = 409;
  error.code = "CONFLICT";
  error.latest = withVersion(target);
  throw error;
}

function touchVersion(target) {
  if (!target) return;
  target.version = Math.max(1, Number(target.version) || 1) + 1;
  target.updatedAt = nowIso();
}

const proposalFailure = (code, message, latest) => Object.assign(new Error(message), { code, status: code === 'CONFLICT' ? 409 : 400, ...(latest ? { latest } : {}) });
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

async function applySelectedProposals(state, payload, handleAction) {
  const selected = payload.selections;
  if (!Array.isArray(selected) || !selected.length) throw proposalFailure('SELECTION_REQUIRED', '请更新客户端，并明确选择本次要采用的建议');
  const ids = new Set();
  if (selected.length > 1000) throw proposalFailure('VALIDATION', '一次最多采用 1000 条建议');
  for (const item of selected) {
    if (!item?.id || typeof item.id !== 'string' || ids.has(item.id) || !Number.isSafeInteger(item.baseVersion) || item.baseVersion < 1) {
      throw proposalFailure('VALIDATION', '建议编号或确认版本无效，请刷新后重试');
    }
    ids.add(item.id);
  }
  const results = [];
  for (const item of selected) {
    // Isolate each selection. A handler can mutate several collections before
    // failing; none of those partial writes may leak into the committed file.
    const draft = structuredClone(state);
    try {
      const proposal = draft.proposals.find(row => row.id === item.id);
      if (!proposal) throw proposalFailure('NOT_FOUND', '建议不存在');
      if (proposal.deletedAt || proposal.trashedAt || proposal.permanentlyPurgedAt) throw proposalFailure('RECORD_DELETED', '建议已删除');
      if (proposal.status !== 'pending') {
        if (proposal.status !== 'applied') throw proposalFailure('CONFLICT', '这条建议已被忽略或推迟，请查看最新状态后重新确认', proposal);
        results.push({ id: item.id, ok: true, data: { proposal: structuredClone(proposal), alreadyHandled: true } });
        continue;
      }
      assertVersion(draft, 'proposal.apply', item);
      if (proposal.type === 'task_update') {
        const target = draft.tasks.find(row => row.id === proposal.taskId);
        if (!target || target.deletedAt || target.trashedAt) throw proposalFailure('RECORD_DELETED', '目标任务不存在或已删除');
        const base = item.taskBaseVersion ?? proposal.taskBaseVersion;
        if (base !== undefined && Number(base) !== Number(target.version || 1)) throw proposalFailure('CONFLICT', '目标任务已更新，请重新确认', target);
      }
      await handleAction(draft, { action: 'proposal.apply', proposalId: item.id });
      const applied = draft.proposals.find(row => row.id === item.id);
      if (applied?.status !== 'applied') throw proposalFailure('VALIDATION', '建议未被采用，请查看最新状态');
      touchVersion(applied);
      Object.assign(state, draft);
      results.push({ id: item.id, ok: true, data: { proposal: structuredClone(applied), entity: structuredClone(applied.after || null) } });
    } catch (error) {
      results.push({ id: item.id, ok: false, error: { code: error.code || 'SERVER_ERROR', message: error.message, ...(error.latest ? { latest: error.latest } : {}) } });
    }
  }
  return { results, applied: results.filter(row => row.ok).length, failed: results.filter(row => !row.ok).length };
}

export async function runSelectedProposalDecision(state, payload, requestId, handleAction) {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 180) throw proposalFailure('VALIDATION', '采用建议需要有效的固定操作编号');
  const digest = createHash('sha256').update(JSON.stringify(canonical({ action: 'proposal.applySelected', payload }))).digest('hex');
  state.meta ||= {};
  if (state.meta.homeOperationReceipts?.some(row => row.id === requestId)) throw proposalFailure('REQUEST_ID_CONFLICT', '操作编号已用于另一项操作');
  state.meta.homeSelectionReceipts ||= [];
  const previous = state.meta.homeSelectionReceipts.find(row => row.id === requestId);
  if (previous) {
    if (previous.digest !== digest) throw proposalFailure('REQUEST_ID_CONFLICT', '操作编号已用于不同的建议选择');
    return structuredClone(previous.result);
  }
  if (state.meta.homeSyncReceipts?.some(row => row.id === requestId)) throw proposalFailure('LEGACY_RECEIPT', '这次操作存在旧回执，请先同步核对采用结果');
  const data = await applySelectedProposals(state, payload, handleAction);
  const appliedAt = nowIso();
  state.meta.homeSelectionReceipts.push({ id: requestId, digest, result: structuredClone(data), appliedAt });
  state.meta.lastHomeSyncAt = appliedAt;
  return data;
}

function validateHomeOperation(action, payload, requestId) {
  if (!action || READ_ACTIONS.has(action)) throw proposalFailure('VALIDATION', '补传只接受数据修改操作');
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 180 || /[\u0000-\u001f]/u.test(requestId)) {
    throw proposalFailure('VALIDATION', '补传需要有效的固定操作编号');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.hasOwn(payload, 'action')) {
    throw proposalFailure('VALIDATION', '操作参数无效，请保留本机记录并核对');
  }
}

async function runHomeOperation(current, action, payload, requestId, handleAction) {
  validateHomeOperation(action, payload, requestId);
  const selected = action === 'proposal.applySelected' || action === 'proposal.applyAll';
  // Each item has its own isolated snapshot. Receipt and data become visible
  // together only when the enclosing disk mutation commits successfully.
  const draft = structuredClone(current);
  draft.meta ||= {};
  if (selected) {
    const previous = draft.meta.homeSelectionReceipts?.find(row => row.id === requestId);
    const data = await runSelectedProposalDecision(draft, payload, requestId, handleAction);
    const receipt = draft.meta.homeSelectionReceipts.find(row => row.id === requestId);
    Object.assign(current, draft);
    return { requestId, action, ok: true, duplicate: Boolean(previous), appliedAt: receipt.appliedAt, data };
  }
  // A changed precondition after an explicit conflict rebase is still the same
  // intent. Match the cloud ledger: hash every other field, never just the ID.
  const { baseVersion, requestId: embeddedId, ...intent } = payload;
  const digest = createHash('sha256').update(JSON.stringify(canonical({ action, payload: intent }))).digest('hex');
  const receipts = draft.meta.homeOperationReceipts ||= [];
  const previous = receipts.find(row => row.id === requestId);
  if (previous) {
    if (previous.digest !== digest || previous.action !== action) throw proposalFailure('REQUEST_ID_CONFLICT', '操作编号已用于不同的内容，请保留本机记录并核对');
    return { requestId, action, ok: true, duplicate: true, appliedAt: previous.appliedAt, entityId: previous.entityId, date: previous.date, inputId: previous.inputId };
  }
  if (draft.meta.homeSelectionReceipts?.some(row => row.id === requestId)) throw proposalFailure('REQUEST_ID_CONFLICT', '操作编号已用于另一项建议选择');
  if (draft.meta.homeSyncReceipts?.some(row => row.id === requestId)) throw proposalFailure('LEGACY_RECEIPT', '旧回执无法核对原始内容，请先同步确认，本机操作已保留');
  const appliedPayload = { ...payload, requestId };
  if (action === 'journal.create') appliedPayload.id ||= `home_capture_${createHash('sha256').update(requestId).digest('hex').slice(0, 40)}`;
  const diary = ['diary.appendInput', 'diary.organizeInput'].includes(action);
  if (diary) {
    appliedPayload.date ||= dayKey();
    appliedPayload.inputId ||= requestId;
  }
  await applyWrite(draft, action, appliedPayload, handleAction);
  const appliedAt = nowIso();
  const entityId = action === 'journal.create' ? appliedPayload.id : undefined;
  const target = { ...(entityId ? { entityId } : {}), ...(diary ? { date: appliedPayload.date, inputId: appliedPayload.inputId } : {}) };
  receipts.push({ id: requestId, action, digest, appliedAt, ...target });
  // Never discard an old acknowledgement merely because a device has been
  // offline for a long time. Fail explicitly before committing on capacity.
  if (Buffer.byteLength(JSON.stringify(receipts), 'utf8') > MAX_RECEIPT_BYTES) throw proposalFailure('RECEIPT_CAPACITY', '电脑操作回执容量已满，本机补传仍保留，请先处理回执归档');
  draft.meta.lastHomeSyncAt = appliedAt;
  Object.assign(current, draft);
  return { requestId, action, ok: true, duplicate: false, appliedAt, ...target };
}

async function applyWrite(state, action, payload, handleAction) {
  assertVersion(state, action, payload);
  if (['diary.appendInput', 'diary.organizeInput'].includes(action)) {
    // This transaction saves originals only. The worker starts after the
    // enclosing mutation and its operation receipt are durably committed.
    await handleAction(state, { ...payload, action: 'diary.appendInput', source: 'wechat' });
    return;
  }
  if (action === "hybrid.mergeCloudRead") {
    mergeCloudReadIntoState(state, payload);
    return;
  }
  if (action === "todayTodo.setPin") {
    const todo = targetForAction(state, action, payload);
    if (!todo || Boolean(todo.pinned) === Boolean(payload.pinned)) return;
    await handleAction(state, { action: "todayTodo.togglePin", todoId: payload.todoId });
    touchVersion(todo);
    return;
  }
  if (action.startsWith("todayTodo.")) {
    const before = targetForAction(state, action, payload);
    const normalizedPayload = action === "todayTodo.commentAdd"
      ? {
          ...payload,
          attachmentIds: (Array.isArray(payload.attachments) ? payload.attachments : [])
            .map((item) => item?.id || item?.attachmentId)
            .filter(Boolean),
        }
      : payload;
    await handleAction(state, { ...normalizedPayload, action });
    if (action === "todayTodo.reorder") {
      for (const id of payload.orderedIds || []) touchVersion((state.dailyTasks || []).find((item) => item.id === id));
    } else if (before) touchVersion(before);
    else {
      for (const todo of (state.dailyTasks || []).filter(isTodayTodo)) if (!todo.version) todo.version = 1;
    }
    return;
  }
  if (action === "journal.create") {
    const known = new Set((state.captures || []).map((item) => item.id));
    await handleAction(state, {
      action: "capture.add",
      id: payload.id,
      requestId: payload.requestId,
      journalDate: payload.date || payload.journalDate,
      occurredAt: payload.occurredAt,
      content: payload.content,
      source: payload.source || "manual",
      intent: payload.favorite ? "favorite" : "note",
    });
    const created = (state.captures || []).find((item) => !known.has(item.id));
    if (created) {
      created.version = 1;
      created.organizationRequested = true;
      created.organizationHost = 'desktop';
      created.organizationStatus = 'pending';
    }
    return;
  }
  if (action === "journal.toggleItem") {
    await handleAction(state, { action: "capture.toggleChecklistItem", captureId: payload.entryId, itemId: payload.itemId, checked: payload.done });
    return;
  }
  if (action === "journal.append") {
    const annotationId = payload.supplementId || payload.annotationId;
    const capture = targetForAction(state, action, payload);
    const existing = annotationId && capture?.journalSupplements?.find(item => item.id === annotationId);
    if (existing) {
      if (capture.deletedAt || capture.trashedAt || capture.permanentlyPurgedAt || existing.deletedAt || existing.trashedAt) throw proposalFailure('RECORD_DELETED', '这条补充已删除，旧请求不会恢复它');
      if (String(existing.rawContent ?? existing.content ?? '') !== String(payload.content ?? '')) throw proposalFailure('INPUT_ID_CONFLICT', '补充编号对应另一份原文，请保留并核对');
      return;
    }
    await handleAction(state, { action: "capture.annotationAdd", captureId: payload.entryId, content: payload.content, annotationId, requestId: payload.requestId });
    return;
  }
  if (action === "journal.archive" || action === "journal.restore") {
    const capture = (state.captures || []).find((item) => item.id === payload.entryId);
    if (!capture || capture.deletedAt || capture.trashedAt || capture.permanentlyPurgedAt) throw proposalFailure('RECORD_DELETED', '这条记录已删除或不存在，请从回收站明确恢复');
    capture.journalArchived = action === 'journal.archive';
    capture.archivedAt = capture.journalArchived ? nowIso() : '';
    if (!capture.journalArchived) capture.journalDate = dayKey();
    touchVersion(capture);
    return;
  }
  if (action === "journal.delete") {
    await handleAction(state, { action: "capture.delete", captureId: payload.entryId });
    return;
  }
  if (["capture.hide", "capture.setFavorite", "capture.restoreHidden"].includes(action)) {
    await handleAction(state, { ...payload, action, captureId: payload.id || payload.captureId });
    return;
  }
  if (action === "trash.restore") {
    await handleAction(state, { action, entityId: payload.id, entityType: payload.entityType });
    touchVersion(targetForAction(state, action, payload));
    return;
  }
  if (action === "proposal.refreshCodexCandidates") {
    await handleAction(state, { action: "codex.scanRecent" });
    return;
  }
  if (action === "proposal.applyAll") {
    payload.__selectedResult = await applySelectedProposals(state, payload, handleAction);
    return;
  }
  if (["proposal.apply", "proposal.reject", "proposal.defer"].includes(action)) {
    const proposal = (state.proposals || []).find((item) => item.id === payload.id);
    await handleAction(state, { action, proposalId: payload.id });
    touchVersion(proposal);
    return;
  }
  if (action === "proposal.restore") {
    const proposal = (state.proposals || []).find((item) => item.id === payload.id && !item.deletedAt);
    if (proposal && proposal.status === "deferred") {
      proposal.status = "pending";
      touchVersion(proposal);
    }
    return;
  }
  if (action === "proposal.delete") {
    const proposal = (state.proposals || []).find((item) => item.id === payload.id);
    if (proposal) {
      proposal.status = "rejected";
      proposal.deletedAt = nowIso();
      touchVersion(proposal);
    }
    return;
  }
  if (action === "proposal.update") {
    const proposal = (state.proposals || []).find((item) => item.id === payload.id);
    if (proposal) {
      for (const key of ["title", "detail", "nextAction", "eventDate", "eventTime", "eventEndTime"]) {
        if (payload.patch && Object.hasOwn(payload.patch, key)) proposal[key] = payload.patch[key];
      }
      touchVersion(proposal);
    }
    return;
  }
  if (action === "task.update") {
    await handleAction(state, { action, taskId: payload.id, patch: payload.patch });
    return;
  }
  if (action === "task.completeStep") {
    await handleAction(state, { action: "task.stepComplete", taskId: payload.taskId, stepId: payload.stepId });
    touchVersion((state.tasks || []).find((item) => item.id === payload.taskId));
    return;
  }
  if (action === "task.reanalyze") {
    await handleAction(state, { action, taskId: payload.id });
    return;
  }
  if (action === "task.archive") {
    const task = (state.tasks || []).find((item) => item.id === payload.id);
    if (task) {
      task.status = "archived";
      task.archivedAt = nowIso();
      if (payload.deletePermanently) task.deletedAt = nowIso();
      touchVersion(task);
    }
    return;
  }
  if (action === "device.requestSync") return;
  const error = new Error(`家庭服务器版暂不支持操作 ${action}`);
  error.status = 400;
  error.code = "VALIDATION";
  throw error;
}

const COMPACT_JOURNAL_ACTIONS = new Set(['capture.hide', 'capture.setFavorite', 'capture.restoreHidden', 'journal.archive', 'journal.restore', 'journal.delete']);

function writeActionResponse(state, action, payload, responseMode) {
  if (['diary.appendInput', 'diary.organizeInput'].includes(action)) {
    const day = (state.days || []).find(item => item.date === payload.date);
    return { day: day ? structuredClone(day) : null, acceptedInputId: payload.inputId,
      organizationPending: Boolean(day?.organizationRequested) };
  }
  if (action === "hybrid.mergeCloudRead") return {
    merged: true,
    sourceAction: payload.sourceAction,
    mergedAt: state.meta?.lastCloudWarmAt || nowIso(),
  };
  if (responseMode === 'record-v1' && COMPACT_JOURNAL_ACTIONS.has(action)) {
    // Deletions are returned as records too. Do not filter a tombstone out of
    // a replay and accidentally let a phone's older body become authoritative.
    const record = targetForAction(state, action, payload);
    return record ? presentCapture(record) : {};
  }
  if (action.startsWith("todayTodo.")) return todoBundle(state, 14);
  if (action === "journal.create") {
    const created = (state.captures || []).find(item => item.id === payload.id);
    return created ? presentCapture(created) : {};
  }
  if (["journal.toggleItem", "journal.append"].includes(action)) {
    const capture = (state.captures || []).find((item) => item.id === payload.entryId);
    return capture ? presentCapture(capture) : {};
  }
  if (action === "trash.restore") return { items: trashItems(state) };
  if (action.startsWith("proposal.")) return action === "proposal.applyAll"
    ? payload.__selectedResult
    : { proposals: activeProposals(state) };
  if (action.startsWith("task.")) return { tasks: activeTasks(state) };
  if (action.startsWith("capture.") || action.startsWith("journal.")) return journalOverview(state, 14);
  if (action === "device.requestSync") return { requestedAt: nowIso() };
  return {};
}

function receiptData(state, outcome, payload, responseMode) {
  return outcome.data || writeActionResponse(state, outcome.action, {
    ...payload, requestId: outcome.requestId,
    ...(outcome.entityId ? { id: outcome.entityId } : {}),
    ...(outcome.date ? { date: outcome.date, inputId: outcome.inputId } : {})
  }, responseMode);
}

export function createHomeSyncHandler(options) {
  const {
    token,
    readState,
    mutateState,
    handleAction,
    receiveTodoCommentImage,
    commentImagesDir,
    afterCommit,
  } = options;
  // The desktop process supplies its authenticated profile. Never learn the
  // authoritative owner from a phone payload or from the first caller.
  const principal = parseHomePrincipal(options.principal);
  const strictScope = Boolean(options.requireScope || principal);
  const assertScope = (scope, optional = false) => {
    if (!principal) {
      if (strictScope) throw homeScopeError('HOME_IDENTITY_UNBOUND', '电脑同步未绑定账号，请先在电脑登录同一个微信账号');
      return;
    }
    if (scope == null && optional) return;
    if (scope == null) throw homeScopeError('HOME_SCOPE_REQUIRED', '操作缺少原账号归属，请更新小程序后恢复待传内容');
    if (!samePrincipal(scope, principal)) throw homeScopeError('WORKSPACE_MISMATCH', '手机操作与这台电脑的账号或个人空间不一致，原内容已保留');
  };
  const assertStoreOwner = (state, bind = false) => {
    if (!principal) return;
    if (state.meta?.homeOwner && !samePrincipal(state.meta.homeOwner, principal)) {
      throw homeScopeError('WORKSPACE_MISMATCH', '电脑数据的原账号与当前登录不一致，请先核对数据目录');
    }
    if (bind && !state.meta?.homeOwner) { state.meta ||= {}; state.meta.homeOwner = { ...principal }; }
  };
  const resumeCommitted = outcomes => {
    const accepted = outcomes.filter(item => item.ok);
    if (accepted.length && afterCommit) {
      // A worker failure must not turn a committed save into a failed receipt.
      void Promise.resolve().then(() => afterCommit(accepted)).catch(error => {
        console.error('Home organization continuation paused:', error.message);
      });
    }
  };

  const eventClients = new Set();
  const changeWaiters = new Set();
  const socketClients = new Set();
  const notificationEpoch = randomUUID();
  let socketServer = null, heartbeat = null, notificationSequence = 0;
  let currentRevision = `${notificationEpoch}:0`;
  const sendSocket = (client, event) => {
    if (client.readyState !== 1) return;
    if (client.bufferedAmount > 65536) { client.terminate(); return; }
    try { client.send(JSON.stringify(event), error => { if (error) client.terminate(); }); }
    catch { client.terminate(); }
  };
  const notifyChange = (revision = nowIso()) => {
    // Two commits in one millisecond and a process restart still have distinct
    // notifications. This opaque revision is only a hint to read durable pages.
    currentRevision = `${notificationEpoch}:${++notificationSequence}`;
    const changedAt = String(revision || nowIso());
    const event = { type: "changed", revision: currentRevision, changedAt };
    const message = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of eventClients) {
      try { client.write(message); } catch { eventClients.delete(client); }
    }
    for (const waiter of [...changeWaiters]) waiter.finish(event);
    for (const client of socketClients) sendSocket(client, event);
  };

  const homeSyncHandler = async function homeSyncHandler(request, response, url) {
    if (!url.pathname.startsWith("/api/home/")) return false;
    try {
      if (request.method === "GET" && url.pathname === "/api/home/health") {
        return sendJson(response, 200, { ok: true, data: { mode: "home-server", version: 2, time: nowIso() } }), true;
      }
      assertAuthorized(request, url, token);
      const imageRead = request.method === 'GET' && url.pathname.startsWith('/api/home/comment-images/');
      assertScope(headerScope(request), imageRead || url.pathname === '/api/home/ping');

      // Connection checks must stay independent from notebook.json.  The old
      // client used bootstrap here, which parsed the entire notebook merely to
      // tell the user whether the computer was reachable.
      if (request.method === "GET" && url.pathname === "/api/home/ping") {
        return sendJson(response, 200, {
          ok: true,
          data: {
            connected: true,
            protocolVersion: 2,
            ...(principal ? { scopeProtocol: 1, principal } : {}),
            revision: currentRevision,
            time: nowIso(),
          },
        }), true;
      }

      if (request.method === "GET" && url.pathname === "/api/home/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.write(`data: ${JSON.stringify({ type: "connected", connectedAt: nowIso() })}\n\n`);
        eventClients.add(response);
        const heartbeat = setInterval(() => {
          try { response.write(`: heartbeat ${Date.now()}\n\n`); } catch {}
        }, 25_000);
        request.on("close", () => {
          clearInterval(heartbeat);
          eventClients.delete(response);
        });
        return true;
      }

      if (request.method === "GET" && url.pathname === "/api/home/changes") {
        const since = String(url.searchParams.get("since") || "");
        if (!since) {
          return sendJson(response, 200, {
            ok: true,
            data: { type: "connected", revision: currentRevision, changed: false, checkedAt: nowIso() },
          }), true;
        }
        if (since !== currentRevision) {
          return sendJson(response, 200, {
            ok: true,
            data: { type: "changed", revision: currentRevision, changed: true, changedAt: nowIso() },
          }), true;
        }
        return await new Promise((resolveRequest) => {
          let settled = false;
          let timer;
          const waiter = {
            finish(event) {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              changeWaiters.delete(waiter);
              if (!response.writableEnded && !response.destroyed) {
                sendJson(response, 200, {
                  ok: true,
                  data: {
                    ...event,
                    changed: event.type === "changed",
                    revision: event.revision || currentRevision,
                  },
                });
              }
              resolveRequest(true);
            },
          };
          changeWaiters.add(waiter);
          timer = setTimeout(() => waiter.finish({
            type: "heartbeat",
            revision: currentRevision,
            checkedAt: nowIso(),
          }), 25_000);
          response.once("close", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            changeWaiters.delete(waiter);
            resolveRequest(true);
          });
          if (since !== currentRevision) waiter.finish({
            type: "changed",
            revision: currentRevision,
            changedAt: nowIso(),
          });
        });
      }

      if (request.method === "POST" && url.pathname === "/api/home/comment-image") {
        if (principal) assertStoreOwner(await readState());
        const attachment = await receiveTodoCommentImage(request);
        return sendJson(response, 201, { ok: true, data: { attachment } }), true;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/home/comment-images/")) {
        if (principal) assertStoreOwner(await readState());
        const requestedName = decodeURIComponent(url.pathname.slice("/api/home/comment-images/".length));
        if (!/^todo-image-\d+-[a-z0-9]+\.(jpg|png|webp)$/i.test(requestedName)) {
          return sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "图片不存在" } }), true;
        }
        const filePath = resolve(commentImagesDir, requestedName);
        const relativePath = relative(commentImagesDir, filePath);
        if (relativePath.startsWith("..") || isAbsolute(relativePath) || !existsSync(filePath) || !statSync(filePath).isFile()) {
          return sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "图片不存在" } }), true;
        }
        const mimeType = extname(filePath).toLowerCase() === ".png"
          ? "image/png"
          : extname(filePath).toLowerCase() === ".webp"
            ? "image/webp"
            : "image/jpeg";
        response.writeHead(200, { "Content-Type": mimeType, "Cache-Control": "private, max-age=300" });
        createReadStream(filePath).pipe(response);
        return true;
      }

      if (request.method === "POST" && url.pathname === "/api/home/batch") {
        const body = await readJson(request, 2 * 1024 * 1024);
        assertScope(body.scope);
        const operations = Array.isArray(body.operations) ? body.operations.slice(0, MAX_BATCH_OPERATIONS) : [];
        if (!operations.length) {
          const error = new Error("批量同步中没有可处理的操作");
          error.status = 400;
          error.code = "VALIDATION";
          throw error;
        }
        if (operations.length !== body.operations.length) {
          const error = new Error(`一次最多补传 ${MAX_BATCH_OPERATIONS} 条操作`);
          error.status = 413;
          error.code = "BATCH_TOO_LARGE";
          throw error;
        }

        const results = [];
        const state = await mutateState(async (current) => {
          assertStoreOwner(current);
          for (const operation of operations) {
            const action = String(operation?.action || "");
            const payload = operation?.payload ?? {};
            const requestId = operation?.requestId || payload.requestId || '';
            try {
              assertScope(operation.scope);
              results.push(await runHomeOperation(current, action, payload, requestId, handleAction));
            } catch (error) {
              results.push({
                requestId,
                action,
                ok: false,
                error: {
                  code: error.code || (error.status === 409 ? "CONFLICT" : "SERVER_ERROR"),
                  message: error instanceof Error ? error.message : "操作没有完成",
                  latest: error.latest,
                },
              });
            }
          }
          if (results.some(item => item.ok)) assertStoreOwner(current, true);
        });
        const data = decorateAttachments(todoBundle(state, 14), request, token);
        for (let index = 0; index < results.length; index++) {
          const result = results[index];
          if (result.ok && /^(diary|journal|capture)\./.test(result.action)) {
            result.data = decorateAttachments(receiptData(state, result, operations[index].payload || {}, 'record-v1'), request, token);
          }
        }
        data.results = results;
        data.syncReceipt = {
          batch: true,
          applied: results.filter((item) => item.ok).length,
          failed: results.filter((item) => !item.ok).length,
          revision: state.meta?.updatedAt || nowIso(),
        };
        resumeCommitted(results);
        return sendJson(response, 200, { ok: true, data }), true;
      }

      if (request.method !== "POST" || url.pathname !== "/api/home/rpc") {
        return sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } }), true;
      }

      const body = await readJson(request);
      assertScope(body.scope);
      const action = String(body.action || "");
      const payload = body.payload ?? {};
      const requestId = body.requestId || payload.requestId || '';
      if (!action) {
        const error = new Error("缺少操作名称");
        error.status = 400;
        error.code = "VALIDATION";
        throw error;
      }

      if (['sync.snapshot', 'sync.historyPage', 'sync.changes'].includes(action)) {
        // Capture notification revision before the read. A concurrent commit
        // can cause one extra receive, but can never be skipped by a new watch.
        const notificationRevision = currentRevision;
        let state = await readState();
        assertStoreOwner(state);
        if (!state.meta?.homeHistory) {
          await mutateState(current => { assertStoreOwner(current, true); if (!current.meta?.homeHistory) prepareHomeHistory(current); });
          state = await readState();
        }
        const data = action === 'sync.snapshot' ? {
          source: 'home', streamProtocol: 2, historyProtocol: 2, epoch: state.meta.homeHistory.epoch,
          sequence: state.meta.homeHistory.sequence, notificationRevision, date: dayKey(),
          revision: 'home:' + state.meta.homeHistory.epoch + ':' + state.meta.homeHistory.sequence,
          capabilities: { history: 1, socket: socketServer ? 1 : 0 }
        } : homeHistoryPage(state, historyRecords, action, payload, token);
        return sendJson(response, 200, { ok: true, data: decorateAttachments(data, request, token) }), true;
      }

      if (READ_ACTIONS.has(action)) {
        const state = await readState();
        assertStoreOwner(state);
        const result = readAction(state, action, payload);
        if (action === 'bootstrap' && principal) result.account = { user: { id: principal.userId, displayName: '微信用户' },
          workspaceId: principal.workspaceId, role: 'owner', workspaces: [{ id: principal.workspaceId, name: '个人空间', role: 'owner', active: true }] };
        const data = decorateAttachments(result, request, token);
        return sendJson(response, 200, { ok: true, data }), true;
      }

      let outcome;
      const state = await mutateState(async (current) => {
        assertStoreOwner(current, true);
        outcome = await runHomeOperation(current, action, payload, requestId, handleAction);
      });
      resumeCommitted([outcome]);
      if (outcome.data) return sendJson(response, 200, { ok: true, data: decorateAttachments(outcome.data, request, token) }), true;
      const data = decorateAttachments(receiptData(state, outcome, payload, body.responseMode), request, token);
      data.syncReceipt = {
        requestId,
        duplicate: outcome.duplicate,
        appliedAt: outcome.appliedAt,
        revision: state.meta?.updatedAt || nowIso(),
      };
      return sendJson(response, 200, { ok: true, data }), true;
    } catch (error) {
      return sendJson(response, Number(error.status) || 500, {
        ok: false,
        error: {
          code: error.code || (error.status === 401 ? "UNAUTHORIZED" : "SERVER_ERROR"),
          message: error instanceof Error ? error.message : "家庭服务器暂时不可用",
          latest: error.latest,
          retryable: error.retryable,
        },
      }), true;
    }
  };
  homeSyncHandler.notifyChange = notifyChange;
  homeSyncHandler.attachServer = server => {
    if (socketServer) throw new Error('Home notification socket already attached');
    socketServer = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      let url;
      try { url = new URL(request.url || '/', 'http://localhost'); }
      catch { socket.destroy(); return; }
      if (url.pathname !== '/api/home/socket') { socket.destroy(); return; }
      socketServer.handleUpgrade(request, socket, head, client => {
        client.on('error', () => client.terminate());
        try { assertAuthorized(request, url, token); assertScope(headerScope(request)); }
        catch (error) {
          // An explicit application error lets native clients stop retrying bad
          // credentials. No profile revision or data is disclosed beforehand.
          sendSocket(client, { type: 'error', code: error.code || 'UNAUTHORIZED', message: error.message });
          client.close(1008, 'Unauthorized');
          return;
        }
        client.homeAlive = true;
        client.on('pong', () => { client.homeAlive = true; });
        client.on('message', () => client.close(1008, 'Notifications only'));
        client.on('close', () => {
          socketClients.delete(client);
          if (!socketClients.size) { clearInterval(heartbeat); heartbeat = null; }
        });
        socketClients.add(client);
        sendSocket(client, { type: 'connected', revision: currentRevision });
        if (!heartbeat) {
          // Transport liveness only: no database read, state write or app RPC.
          heartbeat = setInterval(() => {
            for (const peer of socketClients) {
              if (!peer.homeAlive || peer.bufferedAmount > 65536) { peer.terminate(); continue; }
              peer.homeAlive = false;
              try { peer.ping(); } catch { peer.terminate(); }
            }
          }, 25000);
          heartbeat.unref();
        }
      });
    });
    server.on('close', () => { homeSyncHandler.closeEventStreams(); socketServer.close(); });
  };
  homeSyncHandler.closeEventStreams = () => {
    clearInterval(heartbeat); heartbeat = null;
    for (const client of socketClients) client.terminate();
    socketClients.clear();
    for (const client of eventClients) {
      try { client.end(); } catch {}
    }
    eventClients.clear();
    for (const waiter of [...changeWaiters]) waiter.finish({
      type: "closed",
      revision: currentRevision,
      checkedAt: nowIso(),
    });
    changeWaiters.clear();
  };
  return homeSyncHandler;
}
