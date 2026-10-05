import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const fail = (code, message) => Object.assign(new Error(message), { code, status: 409, retryable: false });
const keyOf = row => JSON.stringify([row.collection, row.document.id]);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = ({ _homeEpoch, _homeSequence, ...document }) => document;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Store metadata and removal markers in the same atomic file as business rows.
// A new sequence belongs to one record; timestamps and array offsets are never
// receive cursors. Keep only each record's latest sequence, not full snapshots.
export function updateHomeHistory(state, select, previous = state.meta?.homeHistory) {
  const old = previous?.version === 1 ? previous : { version: 1, epoch: randomUUID(), sequence: 0, rows: [] };
  const prior = new Map(old.rows.map(row => [row.key, row])), next = new Map();
  let sequence = old.sequence;
  for (const entry of select(state)) {
    const document = clean(entry.document), key = keyOf({ ...entry, document });
    const hash = digest(document), before = prior.get(key);
    next.set(key, before && before.hash === hash && !before.tombstone ? before
      : { key, collection: entry.collection, id: document.id, date: document.date,
          version: Number(document.version || 0), hash, sequence: ++sequence });
  }
  for (const [key, before] of prior) {
    if (next.has(key)) continue;
    if (before.tombstone) { next.set(key, before); continue; }
    const tombstone = { id: before.id, ...(before.date ? { date: before.date } : {}),
      version: Number(before.version || 0) + 1, deletedAt: new Date().toISOString(), deletionId: randomUUID() };
    next.set(key, { ...before, sequence: ++sequence, tombstone, hash: digest(tombstone) });
  }
  const index = { version: 1, epoch: old.epoch, sequence, rows: [...next.values()].sort((a, b) => compare(a.key, b.key)) };
  if (Buffer.byteLength(JSON.stringify(index), 'utf8') > 16 * 1024 * 1024) throw fail('HOME_HISTORY_CAPACITY', '电脑同步索引已达容量，操作尚未提交，请先处理归档');
  state.meta ||= {};
  state.meta.homeHistory = index;
  return index;
}

export function homeHistoryPage(state, select, action, options, token) {
  const index = state.meta?.homeHistory;
  if (!index || index.version !== 1) throw fail('HISTORY_NOT_READY', '电脑历史索引尚未就绪');
  const changes = action === 'sync.changes', kind = changes ? 'changes' : 'history';
  const sign = value => createHmac('sha256', token).update(JSON.stringify([value.version, value.epoch, value.kind,
    value.after, value.from, value.through, value.changeAfter])).digest('hex');
  let cursor = options.cursor;
  if (cursor) {
    if (cursor.epoch !== index.epoch) throw fail('WORKSPACE_MISMATCH', '历史进度来自另一电脑数据空间，已停止接收');
    const expected = Buffer.from(sign(cursor)), supplied = Buffer.from(String(cursor.mac || ''));
    if (cursor.version !== 1 || cursor.kind !== kind || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw fail('HISTORY_CURSOR_INVALID', '历史进度无效，已接收的内容仍保留');
  } else {
    const from = Number(options.after || 0);
    if (!Number.isSafeInteger(from) || from < 0 || from > index.sequence) throw fail('HISTORY_CURSOR_INVALID', '增量起点无效，已停止接收');
    cursor = changes
      ? { version: 1, epoch: index.epoch, kind, from, through: index.sequence, after: from }
      : { version: 1, epoch: index.epoch, kind, after: '', changeAfter: index.sequence };
  }
  if (changes && (![cursor.from, cursor.through, cursor.after].every(Number.isSafeInteger) ||
      cursor.from < 0 || cursor.after < cursor.from || cursor.after > cursor.through || cursor.through > index.sequence) ||
      !changes && (typeof cursor.after !== 'string' || !Number.isSafeInteger(cursor.changeAfter) || cursor.changeAfter > index.sequence)) {
    throw fail('HISTORY_CURSOR_INVALID', '历史进度越界，已停止接收');
  }
  const limit = Math.max(1, Math.min(99, Math.floor(Number(options.limit) || 99)));
  const candidates = index.rows.filter(row => changes ? row.sequence > cursor.after && row.sequence <= cursor.through : compare(row.key, cursor.after) > 0)
    .sort((a, b) => changes ? a.sequence - b.sequence : compare(a.key, b.key));
  const documents = new Map(select(state).map(row => [keyOf(row), clean(row.document)]));
  const records = [];
  let bytes = 0, after = cursor.after;
  for (const row of candidates.slice(0, limit)) {
    const document = row.tombstone || documents.get(row.key);
    if (!document) throw fail('HISTORY_INDEX_MISMATCH', '电脑历史索引与原文不一致，进度尚未更新');
    const entry = { collection: row.collection, document: { ...document, _homeEpoch: index.epoch, _homeSequence: row.sequence } };
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    if (records.length && bytes + size > 600000) break;
    if (size > 950000) throw fail('RECORD_CAPACITY', '单条原文超过传输容量，原文与进度均保留');
    records.push(entry); bytes += size; after = changes ? row.sequence : row.key;
  }
  const nextCursor = { ...cursor, after };
  nextCursor.mac = sign(nextCursor);
  return { source: 'home', epoch: index.epoch, records, nextCursor, hasMore: records.length < candidates.length,
    quota: { functionCalls: 0, localRequests: 1, metadataReads: 0, businessReadQueries: 0, returnedDocuments: records.length, payloadBytes: bytes, writes: 0 } };
}
