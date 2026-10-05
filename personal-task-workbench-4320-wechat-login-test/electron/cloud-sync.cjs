const { existsSync } = require("node:fs");
const { readFile, writeFile, mkdir, rm, rename, open } = require("node:fs/promises");
const { join } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { safeStorage } = require("electron");
const cloudbase = require("@cloudbase/js-sdk");
const { mergeRecord, mergeRows, mergeOriginals, syncMetadata } = require("./record-merge.cjs");
const { receiveOrdered } = require("./ordered-receiver.cjs");
const imageCache = require("./comment-image-cache.cjs");
const syncContext = new AsyncLocalStorage();
function assertSyncCurrent() {
  const context = syncContext.getStore();
  context?.signal?.throwIfAborted();
  context?.assertCurrent?.();
}
function receiveScope(config) {
  return createHash("sha256").update(JSON.stringify([config.endpoint, config.workspaceId, config.userId, config.deviceId, config.token])).digest("hex");
}
async function scopedFetch(url, options = {}) {
  assertSyncCurrent();
  const signals = [options.signal, syncContext.getStore()?.signal, AbortSignal.timeout(30000)].filter(Boolean);
  const response = await fetch(url, { ...options, signal: AbortSignal.any(signals) });
  assertSyncCurrent();
  return response;
}

const MAP = {
  tasks: "tasks",
  daily_tasks: "dailyTasks",
  captures: "captures",
  day_records: "days",
};
const PULL_CURSOR_VERSION = 5;
const PULL_CURSOR_REPAIR_VERSION = 2;
const PUSH_CONFIRMATION_REPAIR_VERSION = 2;
const MAX_COMMENT_IMAGE_BYTES = 10 * 1024 * 1024;

function currentShanghaiDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shanghaiDateFromValue(value) {
  const explicit = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const timestamp = Date.parse(explicit);
  if (!Number.isFinite(timestamp)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function isTodayTodo(task, dateKey = currentShanghaiDateKey()) {
  return task?.entryKind === "today_todo" && (
    task?.date === dateKey || (task?.status === "planned" && String(task?.date || "") > dateKey)
  );
}

function isTodayTodoRecord(task) {
  return task?.entryKind === "today_todo";
}

function isLiveImageRecord(task) {
  return isTodayTodoRecord(task) && !task.deletedAt && !task.trashedAt && !task.permanentlyPurgedAt;
}

function localAttachmentPath(userData, attachment) {
  const relativePath = String(attachment?.relativePath || "");
  if (!/^todo-image-\d+-[a-z0-9]+\.(jpg|png|webp)$/i.test(relativePath)) return "";
  return join(userData, "data", "comment-images", relativePath);
}

function attachmentHasLocalFile(userData, attachment) {
  const path = localAttachmentPath(userData, attachment);
  return Boolean(path && imageCache.hasImage(path, attachment.size));
}

function endpointCloudEnvironment(endpoint) {
  try {
    const hostname = new URL(String(endpoint || "")).hostname.toLowerCase();
    if (!hostname.endsWith(".app.tcloudbase.com")) return "";
    return hostname.split(".")[0].replace(/-\d+$/, "");
  } catch {
    return "";
  }
}

function fileCloudEnvironment(fileID) {
  return /^cloud:\/\/([^.\/]+)\./i.exec(String(fileID || ""))?.[1]?.toLowerCase() || "";
}

function attachmentNeedsUpload(config, userData, attachment) {
  if (attachment?.deletedAt || !attachment?.relativePath || !attachmentHasLocalFile(userData, attachment)) return false;
  if (!attachment.fileID) return true;
  const endpointEnvironment = endpointCloudEnvironment(config?.endpoint);
  const fileEnvironment = fileCloudEnvironment(attachment.fileID);
  return Boolean(endpointEnvironment && fileEnvironment && endpointEnvironment !== fileEnvironment);
}

function attachmentUploadRequired(config, userData, state) {
  return (state?.dailyTasks || []).some((task) => (
    isLiveImageRecord(task) && (task.comments || []).filter((comment) => !comment.deletedAt).some((comment) => (
      (comment.attachments || []).some((attachment) => attachmentNeedsUpload(config, userData, attachment))
    ))
  ));
}

function attachmentMaintenanceRequired(userData, state) {
  return (state?.dailyTasks || []).some((task) => (
    isLiveImageRecord(task) && (task.comments || []).filter((comment) => !comment.deletedAt).some((comment) => (
      (comment.attachments || []).some((attachment) => (
        !attachment.deletedAt && attachment.fileID && !attachmentHasLocalFile(userData, attachment)
      ))
    ))
  ));
}

function commentImageExtension(buffer) {
  return imageCache.imageExtension(buffer);
}

function cloudAttachmentCacheName(fileID, extension) {
  const digest = createHash("sha256").update(String(fileID || "")).digest("hex").slice(0, 20);
  return `todo-image-0-${digest}${extension}`;
}

function configPath(userData) {
  return join(userData, "cloud-sync.json");
}

async function loadConfig(userData) {
  const path = configPath(userData);
  if (!existsSync(path)) return null;
  const stored = JSON.parse(await readFile(path, "utf8"));
  if (!stored.encryptedToken || !safeStorage.isEncryptionAvailable()) return null;
  return {
    ...stored,
    token: safeStorage.decryptString(Buffer.from(stored.encryptedToken, "base64")),
  };
}

async function saveConfig(userData, value) {
  assertSyncCurrent();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows 安全存储当前不可用");
  }
  await mkdir(userData, { recursive: true });
  const encryptedToken = safeStorage.encryptString(value.token).toString("base64");
  const serialized = JSON.stringify({
    endpoint: value.endpoint.replace(/\/$/, ""),
    encryptedToken,
    deviceId: value.deviceId || "",
    workspaceId: value.workspaceId || "",
    userId: value.userId || "",
    pairedAt: value.pairedAt || new Date().toISOString(),
    cursor: value.cursor || "",
    orderedSync: value.orderedSync || null,
    lastPushAt: value.lastPushAt || "",
    lastSyncAt: value.lastSyncAt || "",
    lastAppliedAt: value.lastAppliedAt || "",
    syncScopeVersion: Number(value.syncScopeVersion || 0),
    historyScopeVersion: Number(value.historyScopeVersion || 0),
    taskScopeVersion: Number(value.taskScopeVersion || 0),
    pullCursorRepairVersion: Number(value.pullCursorRepairVersion || 0),
    pushConfirmationRepairVersion: Number(value.pushConfirmationRepairVersion || 0),
    lastCloudRevision: value.lastCloudRevision || "",
    pushHashes: value.pushHashes && typeof value.pushHashes === "object" ? value.pushHashes : {},
  }, null, 2);
  // Never expose a truncated cursor/token file after interruption. Flush the
  // complete sibling file before replacing the published config.
  const temporary = `${configPath(userData)}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx");
    try { await file.writeFile(serialized, "utf8"); await file.sync(); } finally { await file.close(); }
    assertSyncCurrent();
    await rename(temporary, configPath(userData));
  } finally { await rm(temporary, { force: true }); }
}

async function cloudCall(endpoint, token, action, payload = {}) {
  assertSyncCurrent();
  const scopeSignal = syncContext.getStore()?.signal;
  const response = await scopedFetch(endpoint, {
    method: "POST",
    signal: scopeSignal ? AbortSignal.any([scopeSignal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action, payload }),
  });
  const body = await response.json().catch(() => null);
  const result = body && body.ok !== undefined
    ? body
    : body && body.result && body.result.ok !== undefined
      ? body.result
      : body;
  if (!response.ok || !result || result.ok === false) {
    if (result && result.error) {
      const cloudError = new Error(result.error.message || `Cloud request failed (${response.status})`);
      cloudError.code = result.error.code || `HTTP_${response.status}`;
      throw cloudError;
    }
    throw new Error(result?.error?.message || `云端请求失败（${response.status}）`);
  }
  assertSyncCurrent();
  return result.data;
}

function sanitizeSettings(settings) {
  if (!settings) return null;
  const { codexSessionsDir, providerApiBase, ...safe } = settings;
  return safe;
}

function sanitizeDailyTask(task) {
  return {
    ...task,
    comments: (task.comments || []).map((comment) => ({
      ...comment,
      attachments: (comment.attachments || [])
        .filter((attachment) => attachment.fileID || attachment.deletedAt)
        .map(({ previewUrl, previewUrlFetchedAt, previewUrlExpiresAt, relativePath, ...attachment }) => attachment),
    })),
  };
}

function isJournalSyncCandidate(entry) {
  return Boolean(entry?.id && entry.entryKind === "journal_entry");
}

function cleanJournalSupplement(value, fallbackId = "") {
  // Supplements are written by the user as notes or evaluations. Keep the full
  // visible text; raw Codex transcripts are excluded by the journal whitelist
  // before this function is reached.
  const content = String(value?.content || "");
  if (!content.trim()) return null;
  return {
    id: String(value?.id || fallbackId).slice(0, 160),
    ...syncMetadata(value),
    kind: value?.kind === "evaluation" ? "evaluation" : "note",
    content,
    ...(value?.rawContent !== undefined ? { rawContent: String(value.rawContent) } : {}),
    createdAt: String(value?.createdAt || "").slice(0, 40),
    ...(value?.updatedAt ? { updatedAt: String(value.updatedAt) } : {}),
    ...(value?.version ? { version: Number(value.version) } : {}),
    source: ["codex", "deepseek", "rules", "wechat", "desktop"].includes(value?.source)
      ? value.source
      : "desktop",
    organizationStatus: ['organized', 'pending', 'failed'].includes(value?.organizationStatus) ? value.organizationStatus : 'fallback',
  };
}

function annotationsAsSupplements(annotations) {
  return (annotations || []).flatMap((annotation, index) => {
    const supplement = cleanJournalSupplement({
      ...syncMetadata(annotation),
      id: annotation?.id,
      kind: annotation?.kind,
      content: annotation?.content,
      rawContent: annotation?.rawContent,
      createdAt: annotation?.createdAt,
      updatedAt: annotation?.updatedAt,
      version: annotation?.version,
      source: annotation?.organizedBy || "desktop",
      organizationStatus: annotation?.organizationStatus,
    }, `annotation-${index + 1}`);
    return supplement ? [supplement] : [];
  });
}

function mergeJournalSupplements(...lists) {
  let supplements = [];
  for (const [listIndex, list] of lists.entries()) {
    const next = [];
    for (const [itemIndex, value] of (list || []).entries()) {
      const supplement = cleanJournalSupplement(value, `supplement-${listIndex + 1}-${itemIndex + 1}`);
      if (supplement) next.push(supplement);
    }
    supplements = mergeRows(supplements, next);
  }
  return supplements;
}

function journalDocumentForDesktop(document, localEntry = null) {
  const sameInput = localEntry && String(localEntry.rawContent ?? localEntry.content ?? '') === String(document.rawContent ?? document.content ?? '');
  const sameBody = sameInput && String(localEntry.organizedContent ?? localEntry.content ?? '') === String(document.organizedContent ?? document.content ?? '');
  const localAnnotations = new Map((localEntry?.annotations || []).map((entry) => [entry.id, entry]));
  const supplements = mergeJournalSupplements(
    localEntry?.journalSupplements,
    annotationsAsSupplements(localEntry?.annotations),
    document?.journalSupplements,
  );
  return {
    ...document,
    ...(sameInput ? { inputSignature: localEntry.inputSignature } : {}),
    ...(sameBody && localEntry.organizationHost === 'desktop' ? {
      organizationRequested: localEntry.organizationRequested, organizationJob: localEntry.organizationJob, aiError: localEntry.aiError,
    } : {}),
    entryKind: "journal_entry",
    journalSupplements: supplements,
    annotations: supplements.map((supplement) => {
      const local = localAnnotations.get(supplement.id);
      const sameInput = local && String(local.rawContent ?? local.content) === String(supplement.rawContent ?? supplement.content) && local.content === supplement.content;
      return {
        ...syncMetadata(supplement),
        id: supplement.id,
        kind: supplement.kind,
        content: supplement.content,
        ...(supplement.rawContent !== undefined ? { rawContent: supplement.rawContent } : {}),
        organizedBy: supplement.source,
        organizationStatus: supplement.organizationStatus,
        createdAt: supplement.createdAt,
        ...(supplement.updatedAt ? { updatedAt: supplement.updatedAt } : {}),
        ...(supplement.version ? { version: supplement.version } : {}),
        ...(sameInput ? { organizationRequested: local.organizationRequested, organizationJob: local.organizationJob, aiError: local.aiError } : {}),
      };
    }),
  };
}

function sanitizeJournalEntry(entry) {
  const fields = [
    "id", "entryKind", "source", "kind", "intent", "status",
    "occurredAt", "createdAt", "updatedAt", "version", "cloudVersion", "deletedAt",
    "journalTitle", "journalSummary", "journalType", "markdown",
    "organizedContent", "organizationSummary", "organizationStatus", "organizationHost", "aiError",
    "checklistItems", "journalSupplements", "journalDate",
    "journalArchived", "archivedAt", "favoritedAt", "hiddenAt",
    "trashedAt", "purgeAt", "trashOrigin",
  ];
  const clean = {};
  for (const field of fields) {
    if (entry?.[field] !== undefined) clean[field] = entry[field];
  }
  // User-authored journal text is primary data. Keep it in sync even when it is
  // long, while still excluding raw Codex sessions and other internal records.
  if (["manual", "import", "wechat", "mobile", "home", "wechat_official", "wecom"].includes(String(entry?.source || "").toLowerCase())) {
    if (entry?.rawContent !== undefined) clean.rawContent = entry.rawContent;
    if (entry?.content !== undefined) clean.content = entry.content;
  }
  clean.id = String(clean.id || entry?._id || "");
  clean.entryKind = "journal_entry";
  Object.assign(clean, syncMetadata(entry));
  if (String(entry?.source || "").toLowerCase() === "codex" && clean.conflictVersions) {
    clean.conflictVersions = clean.conflictVersions.map((item) => {
      const { content, rawContent, rawInput, ...body } = item.body || {};
      return { ...item, body };
    });
  }
  clean.journalDate = shanghaiDateFromValue(clean.journalDate || clean.occurredAt || clean.createdAt);
  clean.journalSupplements = mergeJournalSupplements(
    entry?.journalSupplements,
    annotationsAsSupplements(entry?.annotations),
  );
  return clean;
}

function sanitizeDayRecord(day) {
  if (!day?.date || !String(day.summary || "").trim()) return null;
  const id = `day_records_${day.date}`;
  return {
    id,
    date: String(day.date).slice(0, 10),
    ...syncMetadata(day),
    headline: String(day.headline || "今日小记").slice(0, 120),
    summary: String(day.summary || "").trim(),
    periods: (day.periods || []).slice(0, 24).map((period, index) => ({
      id: String(period?.id || `period-${index + 1}`).slice(0, 160),
      date: String(period?.date || day.date).slice(0, 10),
      startTime: String(period?.startTime || "").slice(0, 5),
      endTime: String(period?.endTime || "").slice(0, 5),
      title: String(period?.title || "").trim().slice(0, 160),
      summary: String(period?.summary || "").trim().slice(0, 1200),
      status: ["completed", "in_progress", "blocked"].includes(period?.status)
        ? period.status
        : "completed",
      outcomes: (period?.outcomes || []).map((item) => String(item).trim().slice(0, 300)).filter(Boolean).slice(0, 20),
      remaining: (period?.remaining || []).map((item) => String(item).trim().slice(0, 300)).filter(Boolean).slice(0, 20),
    })).filter((period) => period.title || period.summary),
    synthesisSource: day.synthesisSource === "llm" ? "llm" : "rules",
    synthesisUpdatedAt: String(day.synthesisUpdatedAt || day.updatedAt || "").slice(0, 40),
    organizedBy: ["deepseek", "codex", "rules"].includes(day.organizedBy) ? day.organizedBy : undefined,
    organizationStatus: ["organized", "pending", "fallback", "failed"].includes(day.organizationStatus) ? day.organizationStatus : undefined,
    inputRevision: day.inputRevision || "",
    organizationRevision: day.organizationRevision || "",
    manualInputs: mergeDailyManualInputs(day.manualInputs),
    updatedAt: String(day.updatedAt || day.synthesisUpdatedAt || "").slice(0, 40),
  };
}

function mergeDailyManualInputs(localInputs, cloudInputs = []) {
  return mergeOriginals(...[cloudInputs || [], localInputs || []].map((items) => items.map((raw) => ({
    ...raw, content: String(raw?.content || ""),
    source: ["desktop", "wechat", "mobile"].includes(raw?.source) ? raw.source : "desktop",
  }))));
}

function dayRecordPreference(row) {
  const date = String(row?.date || "").slice(0, 10);
  const id = String(row?.id || row?._id || "");
  return {
    hasSummary: Boolean(String(row?.summary || "").trim()),
    canonical: Boolean(date && id === `day_records_${date}`),
    synthesisAt: String(row?.synthesisUpdatedAt || ""),
    updatedAt: String(row?.updatedAt || row?.createdAt || ""),
    id,
  };
}

function preferDayRecord(left, right) {
  const leftRank = dayRecordPreference(left);
  const rightRank = dayRecordPreference(right);
  if (leftRank.hasSummary !== rightRank.hasSummary) return rightRank.hasSummary ? right : left;
  if (leftRank.canonical !== rightRank.canonical) return rightRank.canonical ? right : left;
  const synthesisOrder = rightRank.synthesisAt.localeCompare(leftRank.synthesisAt);
  if (synthesisOrder) return synthesisOrder > 0 ? right : left;
  const updateOrder = rightRank.updatedAt.localeCompare(leftRank.updatedAt);
  if (updateOrder) return updateOrder > 0 ? right : left;
  return rightRank.id.localeCompare(leftRank.id) > 0 ? right : left;
}

function dedupeDayRecordRows(rows = []) {
  const grouped = new Map();
  for (const row of rows || []) {
    const date = String(row?.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const group = grouped.get(date) || [];
    group.push(row);
    grouped.set(date, group);
  }
  return [...grouped.values()].map((group) => {
    const selected = group.slice(1).reduce(preferDayRecord, group[0]);
    return group.filter((row) => row !== selected).reduce((merged, row) => mergeRecord(row, merged), selected);
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function operationHash(collection, id, data) {
  const comparable = { ...data };
  for (const key of ["_id", "ownerOpenId", "workspaceId", "accessOpenIds", "_desktopContentHash", "sourceIds", "sourceCaptureIds"]) delete comparable[key];
  delete comparable.cloudVersion;
  delete comparable.version;
  delete comparable.updatedAt;
  return createHash("sha256")
    // Bump this namespace whenever the user-visible sync schema changes.
    // This safely rechecks the small scoped dataset once without ever
    // uploading the large Codex/archive collections.
    .update(`user-content-v6:${stableJson({ collection, id, data: comparable })}`)
    .digest("hex");
}

function operationKey(operation) {
  return `${operation.collection}:${operation.id}`;
}

function stateToOperations(state, since = "", dateKey = currentShanghaiDateKey(), options = {}) {
  const pairs = [
    ["tasks", state.tasks, (row) => row],
    ["daily_tasks", (state.dailyTasks || []).filter(isTodayTodoRecord), sanitizeDailyTask],
    ["captures", (state.captures || []).filter(isJournalSyncCandidate), sanitizeJournalEntry],
    ["day_records", dedupeDayRecordRows(state.days || []), sanitizeDayRecord],
  ];
  const operations = [];
  for (const [collection, rows, sanitizeRow] of pairs) {
    for (const sourceRow of rows || []) {
      const sanitized = sanitizeRow(sourceRow);
      if (!sanitized) continue;
      const row = { ...sanitized };
      for (const key of ["_id", "ownerOpenId", "workspaceId", "accessOpenIds", "_desktopContentHash", "sourceIds", "sourceCaptureIds"]) delete row[key];
      const changedAt = row.updatedAt || row.occurredAt || row.createdAt || "";
      const collectionSince = (
        (collection === "daily_tasks" && options.includeAllDailyTasks) ||
        (collection === "captures" && options.includeAllJournals) ||
        (collection === "day_records" && options.includeAllDayRecords)
      ) ? "" : since;
      const id = collection === "day_records" ? `day_${row.date}` : row.id || `${collection}_${row.date}`;
      const contentHash = operationHash(collection, id, row);
      const hashKey = `${collection}:${id}`;
      const hasHashManifest = options.pushHashes && Object.keys(options.pushHashes).length > 0;
      const previousHash = hasHashManifest ? options.pushHashes[hashKey] : undefined;
      if (previousHash === contentHash) continue;
      // Once the bounded scope migration has completed, a missing manifest
      // entry for an unchanged historical row is not proof that it needs to be
      // uploaded on every launch. A known row whose hash changes still pushes
      // even if an older writer forgot to refresh its timestamp.
      if (!options.strictConfirmation && previousHash === undefined && collectionSince && changedAt && changedAt <= collectionSince) continue;
      operations.push({
        collection,
        id,
        baseVersion: sourceRow.cloudVersion,
        contentHash,
        data: row,
      });
    }
  }
  return operations;
}

function buildPushHashes(state, dateKey = currentShanghaiDateKey()) {
  return Object.fromEntries(stateToOperations(state, "", dateKey, {
    includeAllJournals: true,
    includeAllDayRecords: true,
  }).map((operation) => [operationKey(operation), operation.contentHash]));
}

function freshPullCursor() {
  return {
    v: PULL_CURSOR_VERSION,
    positions: Object.fromEntries(Object.keys(MAP).map((collection) => [collection, {
      at: "",
      seen: {},
    }])),
  };
}

function cursorAfterTaskBaseline(cursor, taskCursor = {}) {
  const legacyAt = typeof cursor === "string" ? cursor : "";
  const rawPositions = cursor && typeof cursor === "object" ? cursor.positions || {} : {};
  const positions = Object.fromEntries(Object.keys(MAP).map((collection) => {
    const position = rawPositions[collection] || {};
    return [collection, {
      at: String(position.at || legacyAt),
      seen: Number(cursor?.v) === PULL_CURSOR_VERSION && position.seen && typeof position.seen === "object"
        ? { ...position.seen }
        : {},
    }];
  }));
  positions.tasks = {
    at: String(taskCursor.at || ""),
    // Replaying the one-time task baseline boundary is safe and avoids carrying
    // the mutable numeric offset that caused phone status updates to be skipped.
    seen: {},
  };
  return { v: PULL_CURSOR_VERSION, positions };
}

function groupChanges(changes) {
  const grouped = {};
  for (const change of changes || []) {
    const target = MAP[change.collection];
    if (!target) continue;
    if (target === "planningProfile") grouped[target] = change.document;
    else if (target === "captures") (grouped[target] ||= []).push(journalDocumentForDesktop(change.document));
    else (grouped[target] ||= []).push(change.document);
  }
  return grouped;
}

function preserveLocalAttachmentPaths(incomingTasks, currentTasks) {
  const localById = new Map();
  const identity = (task, comment, attachment) => JSON.stringify([task.id || task._id, comment.id, attachment.id]);
  for (const task of currentTasks || []) {
    for (const comment of task.comments || []) {
      for (const attachment of comment.attachments || []) {
        if (attachment.id) localById.set(identity(task, comment, attachment), attachment);
      }
    }
  }
  return (incomingTasks || []).map((task) => ({
    ...task,
    comments: (task.comments || []).map((comment) => ({
      ...comment,
      attachments: (comment.attachments || []).map((attachment) => {
        const local = localById.get(identity(task, comment, attachment));
        if (!local) return attachment;
        if (attachment.fileID && attachment.fileID !== local.fileID) {
          // Explicit empty values also invalidate the old fields in mergeRecord.
          // An attachment ID can be reused by an edit, but its file cannot.
          return { ...attachment, relativePath: "", previewUrl: attachment.previewUrl || "",
            previewUrlFetchedAt: attachment.previewUrlFetchedAt || "", previewUrlExpiresAt: attachment.previewUrlExpiresAt || "" };
        }
        return {
          ...attachment,
          ...(local.relativePath ? { relativePath: local.relativePath } : {}),
          ...(local.previewUrl ? { previewUrl: local.previewUrl } : {}),
          ...(local.previewUrlFetchedAt ? { previewUrlFetchedAt: local.previewUrlFetchedAt } : {}),
          ...(local.previewUrlExpiresAt ? { previewUrlExpiresAt: local.previewUrlExpiresAt } : {}),
        };
      }),
    })),
  }));
}

async function localJson(serverUrl, path, init) {
  assertSyncCurrent();
  const signal = syncContext.getStore()?.signal;
  const response = await scopedFetch(`${serverUrl}${path}`, { ...init, ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`本地同步接口失败（${response.status}）`);
  const data = await response.json();
  assertSyncCurrent();
  return data;
}

async function mergeLocal(serverUrl, collections) {
  if (!collections || !Object.keys(collections).length) return null;
  return localJson(serverUrl, "/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "cloud.merge", collections }),
  });
}

function groupPushChangesForLocal(changes, currentState) {
  const grouped = groupChanges(changes);
  if (grouped.dailyTasks) {
    // Cloud payloads intentionally omit desktop-only file paths and temporary
    // preview URLs. A successful push must not overwrite those local fields,
    // otherwise an AI-organized note keeps its text but loses its images.
    grouped.dailyTasks = preserveLocalAttachmentPaths(
      grouped.dailyTasks,
      currentState?.dailyTasks || [],
    );
    const localTaskById = new Map((currentState?.dailyTasks || []).map((task) => [task.id, task]));
    grouped.dailyTasks = grouped.dailyTasks.map((task) => {
      const localTask = localTaskById.get(task.id);
      const localCommentById = new Map((localTask?.comments || []).map((comment) => [comment.id, comment]));
      return {
        ...task,
        comments: (task.comments || []).map((comment) => {
          const attachmentIds = new Set((comment.attachments || []).map((attachment) => attachment.id));
          const pendingLocal = (localCommentById.get(comment.id)?.attachments || []).filter((attachment) => (
            attachment.id && attachment.relativePath && !attachment.deletedAt && !attachmentIds.has(attachment.id)
          ));
          return pendingLocal.length
            ? { ...comment, attachments: [...(comment.attachments || []), ...pendingLocal] }
            : comment;
        }),
      };
    });
  }
  return grouped;
}

async function mergePulledChanges(serverUrl, changes, localBeforePull) {
  const todayKey = currentShanghaiDateKey();
  const relevant = (changes || []).filter((change) => (
    change.collection === "tasks" ||
    (change.collection === "daily_tasks" && isTodayTodoRecord(change.document)) ||
    (change.collection === "captures" && change.document?.entryKind === "journal_entry") ||
    change.collection === "day_records"
  ));
  const maxBatchBytes = 350_000;
  const localCaptureById = new Map((localBeforePull.captures || []).map((entry) => [entry.id, entry]));
  let batch = [];
  let batchBytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    const grouped = groupChanges(batch);
    if (grouped.dailyTasks) {
      grouped.dailyTasks = preserveLocalAttachmentPaths(grouped.dailyTasks, localBeforePull.dailyTasks);
    }
    await mergeLocal(serverUrl, grouped);
    batch = [];
    batchBytes = 0;
  };
  for (const change of relevant) {
    const mergedChange = change.collection === "captures"
      ? {
          ...change,
          document: journalDocumentForDesktop(
            change.document,
            localCaptureById.get(change.document?.id || change.document?._id),
          ),
        }
      : change;
    const bytes = Buffer.byteLength(JSON.stringify(mergedChange), "utf8");
    if (batch.length && (batch.length >= 100 || batchBytes + bytes > maxBatchBytes)) await flush();
    batch.push(mergedChange);
    batchBytes += bytes;
  }
  await flush();
}

function rebasePendingOperations(pendingOperations, latestState) {
  const latestOperations = new Map(
    stateToOperations(latestState).map((operation) => [operationKey(operation), operation]),
  );
  return (pendingOperations || []).map((operation) => {
    // A freshly generated diary summary is a pending local edit. Pulling the
    // older cloud row must not replace its body before the push has a chance
    // to send it. Version conflicts are still handled by the push endpoint.
    const latest = latestOperations.get(operationKey(operation));
    if (!latest) return operation;
    const data = mergeRecord(operation.data, latest.data);
    return { ...operation, data, contentHash: operationHash(operation.collection, operation.id, data) };
  });
}

function operationChangedAt(operation) {
  return String(operation?.data?.updatedAt || operation?.data?.occurredAt || operation?.data?.createdAt || "");
}

function mergeComments(localComments, cloudComments) {
  return mergeRows(localComments || [], cloudComments || []);
}

function mergeConflictOperation(operation, latest) {
  const data = mergeRecord(operation.data, latest);
  return { ...operation, data, contentHash: operationHash(operation.collection, operation.id, data) };
}

async function pullAllChanges(config) {
  let cursor = config.cursor || "";
  const changes = [];
  for (let page = 0; page < 120; page += 1) {
    const previousCursor = JSON.stringify(cursor);
    const pulled = await cloudCall(config.endpoint, config.token, "sync.pull", {
      cursor,
      limit: 1000,
    });
    const pageChanges = pulled.changes || [];
    changes.push(...pageChanges);
    cursor = pulled.nextCursor || cursor;
    if (!pulled.hasMore) return { changes, nextCursor: cursor };
    if (!pageChanges.length && JSON.stringify(cursor) === previousCursor) {
      return { changes, nextCursor: cursor };
    }
  }
  throw new Error("云端改动过多，分页同步未能在安全上限内完成");
}

async function pushOperationBatches(config, operations) {
  const applied = [];
  const unchanged = [];
  const conflicts = [];
  let syncReceipt = null;
  for (let index = 0; index < operations.length; index += 200) {
    const result = await cloudCall(config.endpoint, config.token, "sync.push", {
      operations: operations.slice(index, index + 200),
    });
    applied.push(...(result.applied || []));
    unchanged.push(...(result.unchanged || []));
    conflicts.push(...(result.conflicts || []));
    if (result.syncReceipt) syncReceipt = result.syncReceipt;
  }
  return { applied, unchanged, conflicts, syncReceipt };
}

async function pushWithConflictResolution(config, operations) {
  const byKey = new Map(operations.map((operation) => [operationKey(operation), operation]));
  const first = await pushOperationBatches(config, operations);
  const retry = [];
  const cloudWins = [];
  for (const conflict of first.conflicts) {
    const operation = byKey.get(operationKey(conflict));
    if (!operation || !conflict.latest) continue;
    const merged = mergeConflictOperation(operation, conflict.latest);
    retry.push({ ...merged, baseVersion: conflict.latest.version });
  }
  const second = retry.length ? await pushOperationBatches(config, retry) : { applied: [], unchanged: [], conflicts: [], syncReceipt: null };
  for (const conflict of second.conflicts) {
    const operation = retry.find((item) => operationKey(item) === operationKey(conflict));
    if (conflict.latest) cloudWins.push({ collection: conflict.collection, document: mergeRecord(operation?.data, conflict.latest) });
  }
  const retriedByKey = new Map(retry.map((operation) => [operationKey(operation), operation]));
  const confirmedKeys = new Set([
    ...first.applied,
    ...first.unchanged,
    ...second.applied,
    ...second.unchanged,
  ].map(operationKey));
  const confirmedHashes = Object.fromEntries([
    ...first.applied,
    ...first.unchanged,
    ...second.applied,
    ...second.unchanged,
  ].flatMap((item) => {
    const operation = retriedByKey.get(operationKey(item)) || byKey.get(operationKey(item));
    // Hash the same portable schema used for the next upload, not raw server
    // metadata. Otherwise a confirmed record is needlessly uploaded forever.
    const normalized = item.document && stateToOperations({ [MAP[item.collection]]: [item.document] }).find((row) => operationKey(row) === operationKey(item));
    const confirmedHash = normalized?.contentHash || (!item.document ? operation?.contentHash : undefined);
    return confirmedHash ? [[operationKey(item), confirmedHash]] : [];
  }));
  const localChanges = [...first.applied, ...first.unchanged, ...second.applied, ...second.unchanged].flatMap((item) => {
    const operation = retriedByKey.get(operationKey(item)) || byKey.get(operationKey(item));
    if (!operation) return [];
    return [{
      collection: item.collection,
      document: {
        ...(item.document || operation.data),
        id: item.document?.id || operation.data?.id || operation.id,
        version: item.version,
        cloudVersion: item.version,
      },
    }];
  });
  return {
    applied: first.applied.length + second.applied.length,
    unchanged: first.unchanged.length + second.unchanged.length,
    unresolved: second.conflicts.length,
    localChanges,
    cloudWins,
    confirmedKeys: [...confirmedKeys],
    confirmedHashes,
    syncReceipt: second.syncReceipt || first.syncReceipt || null,
  };
}

function buildConfirmedPushHashes(
  finalState,
  pendingOperations,
  confirmedKeysOrHashes,
  dateKey = currentShanghaiDateKey(),
  previousHashes = {},
) {
  const hashes = buildPushHashes(finalState, dateKey);
  const confirmedHashes = !Array.isArray(confirmedKeysOrHashes) && confirmedKeysOrHashes && typeof confirmedKeysOrHashes === "object"
    ? confirmedKeysOrHashes
    : Object.fromEntries((pendingOperations || []).flatMap((operation) => (
        (confirmedKeysOrHashes || []).includes(operationKey(operation)) && operation.contentHash
          ? [[operationKey(operation), operation.contentHash]]
          : []
      )));
  const pendingKeys = new Set((pendingOperations || []).map(operationKey));
  for (const [key, contentHash] of Object.entries(hashes)) {
    if (!pendingKeys.has(key)) {
      // A record can be created or refreshed while pull/push is in flight.
      // It was not part of this round, so only an identical prior manifest
      // may carry its confirmation forward.
      if (previousHashes[key] !== contentHash) delete hashes[key];
      continue;
    }
    // A conflict resolved by temporarily accepting the cloud document is not
    // proof that every locally preserved field reached the cloud. Likewise,
    // a later local refresh must not inherit confirmation for an older body.
    // Leaving the hash unset retries just that record next time.
    if (!confirmedHashes[key] || contentHash !== confirmedHashes[key]) delete hashes[key];
  }
  return hashes;
}

function adjacentDayKeys(dateKey = currentShanghaiDateKey()) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
  return [dateKey, previous];
}

function fileExtension(attachment) {
  const fromName = String(attachment.fileName || attachment.relativePath || "")
    .split(".")
    .pop()
    .toLowerCase();
  if (["jpg", "jpeg", "png", "webp"].includes(fromName)) return fromName;
  const mime = String(attachment.mimeType || "").toLowerCase();
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

async function uploadAttachment(config, serverUrl, todo, attachment) {
  const localUrl = `${serverUrl}/api/comment-images/${encodeURIComponent(attachment.relativePath)}`;
  const localResponse = await scopedFetch(localUrl);
  if (!localResponse.ok) throw new Error(`无法读取评论图片：${attachment.fileName || attachment.id}`);
  const content = Buffer.from(await localResponse.arrayBuffer());
  if (content.length > 10 * 1024 * 1024) throw new Error("评论图片超过 10MB");
  const info = await cloudCall(config.endpoint, config.token, "attachment.uploadInfo", {
    todoId: todo.id,
    attachmentId: attachment.id,
    extension: fileExtension(attachment),
  });
  if (!info.uploadUrl || !info.fileID) throw new Error("云存储未返回有效上传信息");
  const headers = Object.fromEntries(
    Object.entries(info.headers || {}).filter(([, value]) => Boolean(value)),
  );
  const uploadResponse = await scopedFetch(info.uploadUrl, {
    method: "PUT",
    headers,
    body: content,
  });
  if (!uploadResponse.ok) throw new Error(`评论图片上传失败（${uploadResponse.status}）`);
  return { fileID: info.fileID, cloudPath: info.cloudPath, bytes: content.length };
}

async function prepareLocalAttachments(config, userData, serverUrl, state) {
  const changed = [];
  const uploadedByAttachment = new Map();
  let uploaded = 0;
  let bytes = 0;
  for (const task of (state.dailyTasks || []).filter(isLiveImageRecord)) {
    let taskChanged = false;
    const nextTask = structuredClone(task);
    for (const comment of (nextTask.comments || []).filter((item) => !item.deletedAt)) {
      for (const attachment of comment.attachments || []) {
        if (!attachmentNeedsUpload(config, userData, attachment)) continue;
        try {
          const cacheKey = `${attachment.id || ""}\n${attachment.relativePath || ""}`;
          let result = uploadedByAttachment.get(cacheKey);
          if (!result) {
            result = await uploadAttachment(config, serverUrl, nextTask, attachment);
            uploadedByAttachment.set(cacheKey, result);
            uploaded += 1;
            bytes += Number(result.bytes || 0);
          }
          attachment.fileID = result.fileID;
          attachment.cloudPath = result.cloudPath;
          taskChanged = true;
        } catch (error) {
          console.warn("Comment image sync deferred:", error.message || error);
        }
      }
    }
    if (taskChanged) {
      nextTask.updatedAt = new Date().toISOString();
      changed.push(nextTask);
    }
  }
  if (!changed.length) return { state, changedIds: [], uploaded, bytes };
  return {
    state: await mergeLocal(serverUrl, { dailyTasks: changed }),
    changedIds: changed.map((task) => task.id),
    uploaded,
    bytes,
  };
}

async function hydrateAttachmentUrls(config, userData, serverUrl, state) {
  const now = Date.now();
  const refreshBefore = now - 30 * 60 * 1000;
  const fileIDs = [];
  const references = new Map();
  for (const task of (state.dailyTasks || []).filter(isLiveImageRecord)) {
    for (const comment of (task.comments || []).filter((item) => !item.deletedAt)) {
      for (const attachment of comment.attachments || []) {
        const fetchedAt = Date.parse(attachment.previewUrlFetchedAt || "") || 0;
        if (
          !attachment.deletedAt &&
          attachment.fileID &&
          !attachmentHasLocalFile(userData, attachment) &&
          (!attachment.previewUrl || (attachment.previewUrlExpiresAt
            ? (Date.parse(attachment.previewUrlExpiresAt) || 0) < now + 10000 : fetchedAt < refreshBefore))
        ) {
          fileIDs.push(attachment.fileID);
          if (attachment.id && task.id) references.set(attachment.fileID, { todoId: task.id, attachmentId: attachment.id, fileID: attachment.fileID });
        }
      }
    }
  }
  if (!fileIDs.length) return { state, functionCalls: 0, requested: 0 };
  const urlById = new Map();
  const unique = [...new Set(fileIDs)];
  let functionCalls = 0;
  for (let index = 0; index < unique.length; index += 50) {
    const batch = unique.slice(index, index + 50);
    const result = await cloudCall(config.endpoint, config.token, "attachment.tempUrls", {
      fileIDs: batch,
      ...(batch.every((id) => references.has(id)) ? { references: batch.map((id) => references.get(id)) } : {}),
    });
    functionCalls += 1;
    for (const file of result.files || []) if (batch.includes(file.fileID)) urlById.set(file.fileID, file);
  }
  const changed = [];
  const fetchedAt = new Date(now).toISOString();
  for (const task of (state.dailyTasks || []).filter(isLiveImageRecord)) {
    let taskChanged = false;
    const nextTask = structuredClone(task);
    for (const comment of (nextTask.comments || []).filter((item) => !item.deletedAt)) {
      for (const attachment of comment.attachments || []) {
        if (attachment.deletedAt) continue;
        const file = urlById.get(attachment.fileID);
        const previewUrl = file?.url || "";
        if (file && !previewUrl && file.error && attachment.previewUrl) {
          attachment.previewUrl = "";
          attachment.previewUrlFetchedAt = "";
          attachment.previewUrlExpiresAt = "";
          taskChanged = true;
        }
        if (previewUrl && previewUrl !== attachment.previewUrl) {
          attachment.previewUrl = previewUrl;
          attachment.previewUrlFetchedAt = fetchedAt;
          taskChanged = true;
        } else if (previewUrl && attachment.previewUrlFetchedAt !== fetchedAt) {
          attachment.previewUrlFetchedAt = fetchedAt;
          taskChanged = true;
        }
        if (previewUrl && file.expiresAt && attachment.previewUrlExpiresAt !== file.expiresAt) {
          attachment.previewUrlExpiresAt = file.expiresAt;
          taskChanged = true;
        }
      }
    }
    if (taskChanged) changed.push(nextTask);
  }
  if (!changed.length) return { state, functionCalls, requested: unique.length };
  return {
    state: await mergeLocal(serverUrl, { dailyTasks: changed }),
    functionCalls,
    requested: unique.length,
  };
}

async function cacheCloudAttachmentsLocally(userData, serverUrl, state) {
  const localByFileID = new Map();
  const missingByFileID = new Map();
  for (const task of (state.dailyTasks || []).filter(isLiveImageRecord)) {
    for (const comment of (task.comments || []).filter((item) => !item.deletedAt)) {
      for (const attachment of comment.attachments || []) {
        if (attachment.deletedAt || !attachment.fileID) continue;
        if (attachmentHasLocalFile(userData, attachment)) {
          localByFileID.set(attachment.fileID, attachment.relativePath);
        } else if (!missingByFileID.has(attachment.fileID)) {
          missingByFileID.set(attachment.fileID, attachment);
        }
      }
    }
  }

  let downloaded = 0;
  let bytes = 0;
  let failed = 0;
  const imageDirectory = join(userData, "data", "comment-images");
  await mkdir(imageDirectory, { recursive: true });
  for (const [fileID, attachment] of missingByFileID) {
    if (localByFileID.has(fileID)) continue;
    const previewUrl = String(attachment.previewUrl || "");
    if (!/^https:\/\//i.test(previewUrl)) {
      failed += 1;
      continue;
    }
    try {
      const response = await scopedFetch(previewUrl, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`图片下载失败（${response.status}）`);
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > MAX_COMMENT_IMAGE_BYTES) throw new Error("图片超过 10 MB");
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_COMMENT_IMAGE_BYTES) throw new Error("图片大小无效");
      if ((declaredLength && declaredLength !== buffer.length) || (Number(attachment.size) > 0 && Number(attachment.size) !== buffer.length)) throw new Error("图片下载未完整，已保留原记录等待重试");
      const extension = commentImageExtension(buffer);
      if (!extension) throw new Error("图片格式无法识别");
      const relativePath = cloudAttachmentCacheName(fileID, extension);
      assertSyncCurrent();
      await imageCache.writeImage(imageDirectory, relativePath, buffer, assertSyncCurrent);
      localByFileID.set(fileID, relativePath);
      downloaded += 1;
      bytes += buffer.length;
    } catch (error) {
      assertSyncCurrent();
      failed += 1;
      console.warn("Cloud comment image cache deferred:", error.message || error);
    }
  }

  const changed = [];
  let relinked = 0;
  for (const task of (state.dailyTasks || []).filter(isLiveImageRecord)) {
    let taskChanged = false;
    const nextTask = structuredClone(task);
    for (const comment of (nextTask.comments || []).filter((item) => !item.deletedAt)) {
      for (const attachment of comment.attachments || []) {
        if (attachment.deletedAt || !attachment.fileID) continue;
        const relativePath = localByFileID.get(attachment.fileID) || "";
        if (relativePath && attachment.relativePath !== relativePath) {
          attachment.relativePath = relativePath;
          taskChanged = true;
          relinked += 1;
        }
      }
    }
    if (taskChanged) changed.push(nextTask);
  }
  const nextState = changed.length
    ? await mergeLocal(serverUrl, { dailyTasks: changed })
    : state;
  return { state: nextState, downloaded, bytes, failed, relinked };
}

async function qrLoginStart(options) {
  const endpoint = String(options?.endpoint || '').trim();
  if (!/^https:\/\//i.test(endpoint)) throw new Error('请输入 CloudBase HTTPS 同步地址');
  return cloudCall(endpoint, '', 'login.qr.create', { deviceName: '主线笔记 Windows' });
}

async function qrLoginPoll(userData, options) {
  const endpoint = String(options?.endpoint || '').trim();
  const sessionId = String(options?.sessionId || '').trim();
  if (!/^https:\/\//i.test(endpoint) || !sessionId) throw new Error('微信扫码登录会话无效');
  const pollToken = String(options?.pollToken || '').trim();
  const result = await cloudCall(endpoint, '', 'login.qr.poll', { sessionId, pollToken });
  if (result.status !== 'authorized') return result;
  await saveConfig(userData, {
    endpoint,
    token: result.token,
    deviceId: result.deviceId,
    workspaceId: result.workspaceId || '',
    userId: result.userId || '',
    pairedAt: result.pairedAt,
  });
  return { ...result, connected: true };
}

async function startLogin(options) {
  const endpoint = String(options?.endpoint || '').trim().replace(/\/$/, '');
  if (!/^https:\/\//i.test(endpoint)) throw new Error('请输入 CloudBase HTTPS 同步地址');
  const result = await cloudCall(endpoint, '', 'login.qr.create', {
    deviceName: String(options?.deviceName || '主线笔记可靠性测试版 Windows').slice(0, 80),
  });
  if (!result?.sessionId || !result?.pollToken || !result?.expiresAt || (!result?.qrDataUrl && !result?.loginUrl)) {
    throw new Error('云端没有返回完整的扫码登录会话');
  }
  return { ...result, endpoint };
}

async function exchangeLogin(session) {
  const endpoint = String(session?.endpoint || '').trim().replace(/\/$/, '');
  if (!/^https:\/\//i.test(endpoint) || !session?.sessionId || !session?.pollToken) {
    throw new Error('扫码登录会话不完整，请重新生成二维码');
  }
  const result = await cloudCall(endpoint, '', 'login.qr.poll', {
    sessionId: session.sessionId,
    pollToken: session.pollToken,
  });
  if (result?.status === 'waiting') {
    throw Object.assign(new Error('等待手机确认'), { code: 'LOGIN_WAITING' });
  }
  if (result?.status === 'expired') {
    throw Object.assign(new Error('二维码已过期，请重新生成'), { code: 'LOGIN_EXPIRED' });
  }
  if (result?.status !== 'authorized') {
    throw Object.assign(new Error('扫码登录会话已失效，请重新生成'), { code: 'LOGIN_USED' });
  }
  if (!result?.token || !result?.userId || !result?.workspaceId || !result?.deviceId) {
    throw new Error('云端没有返回完整的用户与工作区身份，未保存登录信息');
  }
  return { ...result, endpoint };
}

async function cancelLogin(session) {
  const endpoint = String(session?.endpoint || '').trim().replace(/\/$/, '');
  if (!/^https:\/\//i.test(endpoint) || !session?.sessionId || !session?.pollToken) {
    return { cancelled: false };
  }
  return cloudCall(endpoint, '', 'login.qr.cancel', {
    sessionId: session.sessionId,
    pollToken: session.pollToken,
  });
}

async function savePairing(userData, result) {
  const endpoint = String(result?.endpoint || '').trim().replace(/\/$/, '');
  if (!/^https:\/\//i.test(endpoint) || !result?.token || !result?.userId || !result?.workspaceId) {
    throw new Error('登录身份不完整，未保存到电脑');
  }
  await saveConfig(userData, {
    endpoint,
    token: result.token,
    deviceId: result.deviceId || '',
    workspaceId: result.workspaceId,
    userId: result.userId,
    pairedAt: result.pairedAt,
  });
  return { connected: true, endpoint, deviceId: result.deviceId, workspaceId: result.workspaceId, userId: result.userId };
}

async function sync(userData, serverUrl, options = {}) {
  return syncContext.run(options, () => syncOnce(userData, serverUrl, options));
}

async function syncOnce(userData, serverUrl, options) {
  assertSyncCurrent();
  const config = await loadConfig(userData);
  if (!config) throw new Error("电脑尚未完成微信扫码登录");

  const localBeforePull = await localJson(serverUrl, "/api/state");
  // Ordinary synchronization is always additive. A partial local collection
  // is never an instruction to delete cloud-only tasks, even on first login.
  let activeConfig = config;
  const head = await cloudCall(activeConfig.endpoint, activeConfig.token, "sync.head", { protocol: 2 });
  const ordered = head.protocol === 2;
  if (ordered && head.workspaceId !== config.workspaceId) throw Object.assign(new Error("云端空间与当前登录不一致"), { code: "WORKSPACE_MISMATCH" });
  if (!ordered && config.orderedSync) throw Object.assign(new Error("完整历史协议已停用，已保留接收进度，请核对云端配置"), { code: "SYNC_PROTOCOL_NOT_ENABLED" });
  const cursorRepairRequired = !ordered && Number(activeConfig.pullCursorRepairVersion || 0) < PULL_CURSOR_REPAIR_VERSION;
  if (cursorRepairRequired) {
    // One bounded replay repairs records skipped by the old mutable offset.
    // The cloud endpoint limits this to the three user-visible sync collections
    // and to today's daily todos, so Codex history and archives are never read.
    activeConfig = { ...activeConfig, cursor: freshPullCursor() };
  }
  const includeAllJournals = Number(activeConfig.syncScopeVersion || 0) < 4;
  const includeAllDayRecords = Number(activeConfig.syncScopeVersion || 0) < 6;
  const includeAllDailyTasks = Number(activeConfig.historyScopeVersion || 0) < 1;
  const confirmationRepairRequired = Number(activeConfig.pushConfirmationRepairVersion || 0) < PUSH_CONFIRMATION_REPAIR_VERSION;
  const pushHashesForPending = { ...(activeConfig.pushHashes || {}) };
  if (confirmationRepairRequired) {
    for (const repairDate of adjacentDayKeys()) delete pushHashesForPending[`day_records:day_${repairDate}`];
  }
  const pendingOperations = stateToOperations(
    localBeforePull,
    activeConfig.lastPushAt || "",
    currentShanghaiDateKey(),
    { includeAllDailyTasks, includeAllJournals, includeAllDayRecords, pushHashes: pushHashesForPending, strictConfirmation: true },
  );
  const localAttachmentUploadRequired = attachmentUploadRequired(activeConfig, userData, localBeforePull);
  const receiveUnchanged = ordered
    ? config.orderedSync?.scope === receiveScope(config) && config.orderedSync.phase === "idle" && config.orderedSync.after === head.sequence
    : head.revision && head.revision === activeConfig.lastCloudRevision;
  if (!cursorRepairRequired && !includeAllDailyTasks && !localAttachmentUploadRequired && !pendingOperations.length && receiveUnchanged) {
    let maintainedState = localBeforePull;
    let attachmentUrlCalls = 0;
    let attachmentUrlRequests = 0;
    let attachmentCache = { downloaded: 0, bytes: 0, failed: 0, relinked: 0 };
    if (attachmentMaintenanceRequired(userData, maintainedState)) {
      const hydrated = await hydrateAttachmentUrls(activeConfig, userData, serverUrl, maintainedState);
      maintainedState = hydrated.state;
      attachmentUrlCalls = hydrated.functionCalls;
      attachmentUrlRequests = hydrated.requested;
      attachmentCache = await cacheCloudAttachmentsLocally(userData, serverUrl, maintainedState);
      maintainedState = attachmentCache.state;
    }
    const syncedAt = new Date().toISOString();
    const pushHashes = activeConfig.pushHashes || {};
    const currentState = await localJson(serverUrl, "/api/state");
    const uploadPending = stateToOperations(currentState, "", currentShanghaiDateKey(), { pushHashes, strictConfirmation: true }).length;
    const headQuota = head.quota || { functionCalls: 1, metadataReads: 1, businessReadQueries: 0, writes: 0 };
    await saveConfig(userData, {
      ...activeConfig,
      token: activeConfig.token,
      lastSyncAt: syncedAt,
      syncScopeVersion: 6,
      historyScopeVersion: 1,
      taskScopeVersion: 1,
      pullCursorRepairVersion: PULL_CURSOR_REPAIR_VERSION,
      pushConfirmationRepairVersion: PUSH_CONFIRMATION_REPAIR_VERSION,
      lastCloudRevision: head.revision,
      pushHashes,
    });
    return {
      connected: true,
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      lastSyncAt: syncedAt,
      desktopAppliedAt: uploadPending ? "" : syncedAt,
      receivePending: false,
      uploadPending,
      receiveProtocol: ordered ? 2 : 1,
      journalsIncluded: false,
      skippedUnchanged: Object.keys(pushHashes).length,
      fastPath: true,
      quota: {
        ...headQuota,
        functionCalls: Number(headQuota.functionCalls || 1) + attachmentUrlCalls,
        objectDownloads: attachmentCache.downloaded,
        objectDownloadBytes: attachmentCache.bytes,
      },
      attachmentMaintenance: {
        tempUrlCalls: attachmentUrlCalls,
        tempUrlRequests: attachmentUrlRequests,
        downloaded: attachmentCache.downloaded,
        bytes: attachmentCache.bytes,
        failed: attachmentCache.failed,
        relinked: attachmentCache.relinked,
      },
      taskBaseline: null,
    };
  }
  let pulled;
  if (ordered) {
    pulled = await receiveOrdered({
      workspaceId: config.workspaceId, scope: receiveScope(config), checkpoint: config.orderedSync,
      headSequence: head.sequence, pageBudget: options.pageBudget, assertCurrent: assertSyncCurrent,
      readPage: (action, payload) => cloudCall(config.endpoint, config.token, action, payload),
      applyPage: async (records, checkpoint) => {
        const current = await localJson(serverUrl, "/api/state");
        await mergePulledChanges(serverUrl, records, current);
        const saved = await localJson(serverUrl, "/api/state");
        const hashes = buildPushHashes(saved);
        const pushHashes = { ...(activeConfig.pushHashes || {}) };
        // Receiving a row confirms only the exact portable cloud content, not
        // an unrelated edit made locally while that page was being fetched.
        for (const operation of stateToOperations(groupChanges(records))) {
          const key = operationKey(operation);
          if (hashes[key] === operation.contentHash) pushHashes[key] = operation.contentHash;
        }
        const next = { ...activeConfig, orderedSync: checkpoint, pushHashes };
        await saveConfig(userData, next);
        activeConfig = next;
      },
    });
  } else {
    const legacy = await pullAllChanges(activeConfig);
    if (legacy.changes?.length) await mergePulledChanges(serverUrl, legacy.changes, localBeforePull);
    pulled = { ...legacy, pulled: legacy.changes.length, pending: false };
  }

  let state = await localJson(serverUrl, "/api/state");
  const preparedAttachments = await prepareLocalAttachments(activeConfig, userData, serverUrl, state);
  state = preparedAttachments.state;
  const hydratedAttachments = await hydrateAttachmentUrls(activeConfig, userData, serverUrl, state);
  state = hydratedAttachments.state;
  const attachmentCache = await cacheCloudAttachmentsLocally(userData, serverUrl, state);
  state = attachmentCache.state;
  const attachmentChangedIds = new Set(preparedAttachments.changedIds);
  const attachmentOperations = attachmentChangedIds.size
    ? stateToOperations({
        tasks: [],
        dailyTasks: (state.dailyTasks || []).filter((task) => attachmentChangedIds.has(task.id)),
        captures: [],
        days: [],
      }, "", currentShanghaiDateKey(), { includeAllDailyTasks: true })
    : [];
  const pendingByKey = new Map(pendingOperations.map((operation) => [operationKey(operation), operation]));
  for (const operation of attachmentOperations) pendingByKey.set(operationKey(operation), operation);
  const operations = rebasePendingOperations([...pendingByKey.values()], state);
  const pushed = await pushWithConflictResolution(activeConfig, operations);
  const mergedPushChanges = [...pushed.localChanges, ...pushed.cloudWins];
  if (mergedPushChanges.length) {
    await mergeLocal(serverUrl, groupPushChangesForLocal(mergedPushChanges, state));
  }
  const finalState = await localJson(serverUrl, "/api/state");
  const finalPushHashes = buildConfirmedPushHashes(
    finalState,
    operations,
    pushed.confirmedHashes,
    currentShanghaiDateKey(),
    activeConfig.pushHashes || {},
  );
  const scopedBeforeCount = Object.keys(buildPushHashes(localBeforePull)).length;
  const uploadPending = stateToOperations(finalState, "", currentShanghaiDateKey(), { pushHashes: finalPushHashes, strictConfirmation: true }).length;
  // A push receipt can include a newer head containing other devices' writes.
  // Only a completed receive window acknowledges those writes as received.
  const latestHead = ordered && !pulled.pending ? await cloudCall(config.endpoint, config.token, "sync.head", { protocol: 2 }) : head;
  const receivePending = Boolean(pulled.pending || ordered && latestHead.sequence > pulled.checkpoint.after);
  const syncedAt = new Date().toISOString();
  await saveConfig(userData, {
    ...activeConfig,
    token: activeConfig.token,
    cursor: ordered ? activeConfig.cursor : pulled.nextCursor || syncedAt,
    lastPushAt: syncedAt,
    lastSyncAt: syncedAt,
    lastAppliedAt: activeConfig.lastAppliedAt || "",
    syncScopeVersion: 6,
    historyScopeVersion: 1,
    taskScopeVersion: 1,
    pullCursorRepairVersion: PULL_CURSOR_REPAIR_VERSION,
    pushConfirmationRepairVersion: PUSH_CONFIRMATION_REPAIR_VERSION,
    lastCloudRevision: ordered ? `sequence-${pulled.checkpoint.after}` : head.revision || activeConfig.lastCloudRevision || "",
    pushHashes: finalPushHashes,
  });
  return {
    connected: true,
    pulled: pulled.pulled,
    pushed: pushed.applied,
    conflicts: pushed.unresolved,
    lastSyncAt: syncedAt,
    desktopAppliedAt: receivePending || uploadPending || pushed.unresolved ? "" : syncedAt,
    receivePending,
    uploadPending,
    receiveProtocol: ordered ? 2 : 1,
    receivedThrough: ordered ? pulled.checkpoint.after : null,
    historyPages: pulled.pages || 0,
    journalsIncluded: includeAllJournals,
    skippedUnchanged: Math.max(0, scopedBeforeCount - pendingOperations.length),
    fastPath: false,
    cursorRepair: cursorRepairRequired,
    taskBaseline: null,
    attachmentMaintenance: {
      uploaded: preparedAttachments.uploaded,
      uploadBytes: preparedAttachments.bytes,
      tempUrlCalls: hydratedAttachments.functionCalls,
      tempUrlRequests: hydratedAttachments.requested,
      downloaded: attachmentCache.downloaded,
      bytes: attachmentCache.bytes,
      failed: attachmentCache.failed,
      relinked: attachmentCache.relinked,
    },
  };
}

async function status(userData) {
  const config = await loadConfig(userData);
  if (!config) return { connected: false };
  return {
    connected: true,
    endpoint: config.endpoint,
    pairedAt: config.pairedAt,
    lastSyncAt: config.lastSyncAt || "",
  };
}

async function disconnect(userData) {
  await rm(configPath(userData), { force: true });
  return { connected: false };
}

async function watchEventStream(url, headers, onChange, signal) {
  const response = await fetch(url, { headers, signal });
  if (!response.ok || !response.body) {
    throw new Error(`实时同步连接失败（${response.status}）`);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").find((line) => line.startsWith("data:"));
      if (data) {
        const event = JSON.parse(data.slice(5).trim());
        if (event.type === "changed") onChange(event);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  if (!signal.aborted) throw new Error("实时同步连接已断开");
}

async function watchLocal(serverUrl, onChange, signal) {
  return watchEventStream(`${serverUrl}/api/events`, {}, onChange, signal);
}

async function watchRemote(userData, onChange, signal, onReady = () => {}) {
  signal.throwIfAborted();
  const config = await loadConfig(userData);
  if (!config) {
    const error = new Error("电脑尚未完成微信扫码登录");
    error.code = "UNPAIRED";
    throw error;
  }
  const realtime = await cloudCall(config.endpoint, config.token, "realtime.ticket", { protocol: 2 });
  signal.throwIfAborted();
  if (!realtime?.available) {
    const error = new Error("CloudBase custom login is not configured yet");
    error.code = "REALTIME_NOT_CONFIGURED";
    throw error;
  }
  if (realtime.workspaceId !== config.workspaceId) throw Object.assign(new Error("实时连接不属于当前空间"), { code: "WORKSPACE_MISMATCH" });

  const cloudApp = cloudbase.init({ env: realtime.envId, timeout: 20000 });
  const auth = cloudApp.auth({ persistence: "none" });
  await auth.signInWithCustomTicket(() => Promise.resolve(realtime.ticket));
  signal.throwIfAborted();
  const user = await auth.getCurrentUser();
  signal.throwIfAborted();
  const uid = user && user.uid;
  if (!uid) {
    const error = new Error("CloudBase custom login did not return a user identity");
    error.code = "REALTIME_AUTH_FAILED";
    throw error;
  }
  await cloudCall(config.endpoint, config.token, "realtime.bind", { uid });
  signal.throwIfAborted();

  const database = cloudApp.database();
  return new Promise((resolveWatch, rejectWatch) => {
    let settled = false;
    let watcher = null;
    let ready = false, lastRevision = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", close);
      try { watcher?.close(); } catch {}
      if (error) rejectWatch(error); else resolveWatch();
    };
    const close = () => finish();
    signal.addEventListener("abort", close, { once: true });
    try { watcher = database.collection("sync_signals").where({
      _id: realtime.signalId,
      kind: realtime.signalKind || "sync_signal",
      workspaceId: realtime.workspaceId,
    }).watch({
      onChange(snapshot) {
        if (settled || signal.aborted) return;
        if (!ready) { ready = true; onReady(); }
        const signalDocument = snapshot?.docs?.[0] || {};
        const revision = signalDocument.revision || "";
        if (revision !== lastRevision && (realtime.protocol === 2 || signalDocument.sourceDeviceId !== config.deviceId)) {
          lastRevision = revision;
          onChange({
            type: "changed",
            revision,
          });
        }
      },
      onError(error) {
        finish(error);
      },
    }); } catch (error) { finish(error); }
    if (settled) { try { watcher?.close(); } catch {} }
    if (signal.aborted) close();
  });
}

module.exports = {
  qrLoginStart,
  qrLoginPoll,
  startLogin,
  exchangeLogin,
  cancelLogin,
  savePairing,
  sync,
  status,
  disconnect,
  stateToOperations,
  groupChanges,
  watchLocal,
  watchRemote,
  watchEventStream,
  preserveLocalAttachmentPaths,
  groupPushChangesForLocal,
  sanitizeDailyTask,
  sanitizeJournalEntry,
  sanitizeDayRecord,
  isJournalSyncCandidate,
  operationHash,
  buildPushHashes,
  buildConfirmedPushHashes,
  annotationsAsSupplements,
  mergeJournalSupplements,
  journalDocumentForDesktop,
  mergeComments,
  mergeDailyManualInputs,
  dedupeDayRecordRows,
  mergeConflictOperation,
  rebasePendingOperations,
  pushWithConflictResolution,
  cursorAfterTaskBaseline,
  freshPullCursor,
  attachmentHasLocalFile,
  attachmentMaintenanceRequired,
  endpointCloudEnvironment,
  fileCloudEnvironment,
  attachmentNeedsUpload,
  attachmentUploadRequired,
  prepareLocalAttachments,
  cacheCloudAttachmentsLocally,
  hydrateAttachmentUrls,
  cloudAttachmentCacheName,
};
