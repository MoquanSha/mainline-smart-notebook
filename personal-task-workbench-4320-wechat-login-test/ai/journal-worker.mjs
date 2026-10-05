import { createHash } from 'node:crypto';
import organizationJobs from './organization-job.cjs';
import fidelity from './fidelity.cjs';
import segments from '../shared/text-segments.js';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const live = (row) => row && !row.deletedAt && !row.trashedAt && !row.permanentlyPurgedAt;
const source = (row) => String(row.rawContent ?? row.content ?? '');
// Supplements, favourite state and the title can change while a model runs.
// Only changes to its source/reading body invalidate this body's projection.
const revision = (row) => hash([source(row), row.content, row.organizedContent, row.markdown, row.checklistItems]);

export function createJournalWorker({ db, owner, read, commit, organize }) {
  let active, timer;
  const retries = new Set();
  const candidates = (state) => (state.captures || []).filter((row) => live(row) && row.organizationRequested && row.organizationHost === 'desktop');
  async function step(row, state, retry, generate) {
    const raw = source(row), before = revision(row);
    const parts = segments.splitText(raw);
    let job, content, organizedBy;
    try {
      const result = await organizationJobs.createOrganizationJobs({ db,
        leaseMs: Math.max(150000, Number(state.settings.timeoutSeconds || 120) * 1000 + 30000) }).run({
        owner, targetId: row.id, kind: 'journal_entry', parts, retry, maxParts: 1,
        promptVersion: hash(['desktop-journal-v1', fidelity.POLICY, segments.POLICY, state.settings.aiMode, state.settings.aiModel,
          state.settings.deepseekModel, state.settings.providerApiBase, state.settings.maxTokens]),
        generate: async (part) => {
          if (part.literal) return { content: part.content, organizedBy: 'rules' };
          const output = await generate(row, part.content, state);
          if (output.error) throw new Error(output.error);
          if (typeof output.content !== 'string' || !output.content.trim()) throw new Error('AI 未返回完整正文，原文已保留');
          fidelity.assertFidelity(part.content, output.content);
          return { content: output.content, organizedBy: output.organizedBy || state.settings.aiMode };
        },
        countsAsAiCall: (part) => !part.literal,
        validateOutput: (outputs) => fidelity.assertFidelity(raw, segments.joinText(parts, outputs.map((part) => part.content)),
          { aggregate: true, candidateForReview: outputs.at(-1).content }),
      });
      job = { id: result.job.id, status: result.job.status, completed: result.job.completed, total: result.job.partCount,
        reviewId: result.job.reviewId || '', reviewHost: 'desktop',
        generation: Number(result.job.outputGeneration || 0),
        automaticRetry: result.job.automaticRetry !== false, errorCode: result.job.errorCode || '',
        retryAfter: result.job.status === 'running' ? result.job.leaseUntil : result.job.retryAfter || 0,
        retryable: !['AI_OUTPUT_CAPACITY', 'JOB_RECEIPT_MISSING'].includes(result.job.errorCode), error: result.job.error || '' };
      if (result.job.status === 'complete' && !result.stale) {
        content = segments.joinText(parts, result.outputs.map((part) => part.content));
        organizedBy = result.outputs.find((part) => part.organizedBy !== 'rules')?.organizedBy || 'rules';
      }
    } catch (error) {
      job = { status: 'failed', error: String(error.message || error), retryAfter: Date.now() + 5000,
        retryable: !['AI_OUTPUT_CAPACITY', 'JOB_RECEIPT_MISSING'].includes(error.code) };
    }
    const event = { type: 'journal-organization', contentChanged: false };
    await commit((currentState) => {
      const current = currentState.captures.find((entry) => entry.id === row.id);
      if (!live(current) || current.organizationHost !== 'desktop' || !current.organizationRequested) return;
      if (revision(current) !== before) {
        // Do not leave a stale completed job eligible to reset a user's edit
        // on the next iteration or after a restart.
        current.organizationRequested = false;
        current.organizationStatus = 'failed';
        current.aiError = '整理期间正文已更新，旧结果未写入；请先核对原文与当前正文';
        current.organizationJob = { ...job, status: 'failed', error: current.aiError, retryable: false };
        event.contentChanged = true;
      } else {
        const patch = { organizationJob: job, organizationRequested: content === undefined,
          organizationStatus: content !== undefined ? organizedBy === 'rules' ? 'lightly_organized' : 'ai_organized'
            : job.status === 'failed' ? 'failed' : 'pending', aiError: job.error || '',
          ...(content !== undefined ? { organizedContent: content, markdown: content, organizedBy } : {}) };
        if (Buffer.byteLength(JSON.stringify({ ...current, ...patch }), 'utf8') > 800000) {
          delete patch.organizedContent; delete patch.markdown; delete patch.organizedBy;
          patch.organizationRequested = false; patch.organizationStatus = 'failed';
          patch.aiError = '整理稿超过单条记录容量，原文已保留';
          patch.organizationJob = { ...job, status: 'failed', error: patch.aiError, retryable: false };
        }
        event.contentChanged = patch.organizedContent !== undefined || current.organizationStatus !== patch.organizationStatus;
        Object.assign(current, patch);
      }
      if (event.contentChanged) { current.updatedAt = new Date().toISOString(); current.version = Number(current.version || 1) + 1; }
    }, event);
  }
  async function drain(generate) {
    const seen = new Set();
    while (true) {
      const state = await read(), rows = candidates(state);
      const checkpoint = (row) => hash([row.id, revision(row), row.organizationJob]);
      const row = rows.find((entry) => !seen.has(checkpoint(entry)) &&
        (retries.has(entry.id) || entry.organizationJob?.retryable !== false && entry.organizationJob?.automaticRetry !== false && Number(entry.organizationJob?.retryAfter || 0) <= Date.now()));
      if (!row) {
        const deadlines = rows.filter((entry) => entry.organizationJob?.status === 'running' && entry.organizationJob.retryAfter > Date.now()).map((entry) => entry.organizationJob.retryAfter);
        if (deadlines.length) {
          timer = setTimeout(() => { timer = null; void resume({ organize: generate }).catch(() => {}); }, Math.min(2147483647, Math.max(10, Math.min(...deadlines) - Date.now() + 10)));
          timer.unref?.();
        }
        return;
      }
      seen.add(checkpoint(row));
      await step(row, structuredClone(state), retries.delete(row.id), generate);
    }
  }
  function resume(options = {}) {
    if (options.retry && options.captureId) retries.add(options.captureId);
    if (active) return active;
    if (timer) { clearTimeout(timer); timer = null; }
    active = Promise.resolve().then(() => drain(options.organize || organize)).finally(() => { active = null; });
    return active;
  }
  return { resume };
}
