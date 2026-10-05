import { createHash } from 'node:crypto';
import organizationJobs from './organization-job.cjs';
import fidelity from './fidelity.cjs';
import segments from '../shared/text-segments.js';

const signature = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const live = (row) => row && !row.deletedAt && !row.trashedAt && !row.permanentlyPurgedAt;
const rawOf = (row) => String(row.rawContent ?? row.content ?? '');
const targets = (state) => (state.captures || []).filter(live).flatMap((capture) =>
  (capture.annotations || []).filter(live).filter((row) => row.organizationRequested).map((row) => ({ capture, row })));

export function createAnnotationWorker({ db, owner, read, commit, organize }) {
  let active, timer;
  const retries = new Set();
  const keyOf = ({ capture, row }) => JSON.stringify([capture.id, row.id]);
  async function step({ capture, row }, snapshot, retry, generate) {
    const raw = rawOf(row), before = signature([raw, row.content]);
    const provider = snapshot.settings.aiMode;
    let job, content, organizedBy;
    try {
      if (row.content !== raw) throw Object.assign(new Error('笔记正文已有修改，请先核对原文，旧整理结果不会覆盖'), { code: 'BODY_CHANGED' });
      const parts = segments.splitText(raw);
      const result = await organizationJobs.createOrganizationJobs({ db,
        leaseMs: Math.max(150000, Number(snapshot.settings.timeoutSeconds || 120) * 1000 + 30000) }).run({
        owner, targetId: keyOf({ capture, row }), kind: 'journal_annotation', parts, retry, maxParts: 1,
        promptVersion: signature(['annotation-v2-full-markdown', fidelity.POLICY, segments.POLICY, provider, snapshot.settings.aiModel,
          snapshot.settings.deepseekModel, snapshot.settings.providerApiBase, snapshot.settings.maxTokens,
          String(capture.content || '').slice(0, 300)]),
        generate: async (part) => {
          if (part.literal) return { content: part.content, organizedBy: 'rules' };
          const output = await generate(capture, part.content, snapshot);
          if (output.error) throw new Error(output.error);
          if (typeof output.content !== 'string' || !output.content.trim()) throw new Error('AI 未返回完整正文，原文已保留');
          fidelity.assertFidelity(part.content, output.content);
          return { content: output.content, organizedBy: output.organizedBy || provider };
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
        retryable: !['BODY_CHANGED', 'AI_OUTPUT_CAPACITY', 'JOB_RECEIPT_MISSING'].includes(error.code) };
    }
    const event = { type: 'annotation-organization', contentChanged: false };
    await commit((state) => {
      const parent = state.captures.find((entry) => entry.id === capture.id);
      const current = parent?.annotations?.find((entry) => entry.id === row.id);
      if (!live(parent) || !live(current) || signature([rawOf(current), current.content]) !== before) return;
      const status = content !== undefined ? organizedBy === 'rules' ? 'fallback' : 'organized' : job.status === 'failed' ? 'failed' : 'pending';
      const patch = { organizationJob: job, organizationRequested: content === undefined, organizationStatus: status,
        aiError: job.error || '', ...(content !== undefined ? { content, organizedBy } : {}) };
      const next = { ...parent, annotations: parent.annotations.map((entry) => entry.id === row.id ? { ...entry, ...patch } : entry) };
      if (Buffer.byteLength(JSON.stringify(next), 'utf8') > 800000) {
        delete patch.content; delete patch.organizedBy;
        patch.organizationRequested = true; patch.organizationStatus = 'failed'; patch.aiError = '整理稿超过单条记录容量，原文已保留';
        patch.organizationJob = { ...job, status: 'failed', error: patch.aiError, retryable: false };
      }
      event.contentChanged = patch.content !== undefined || current.organizationStatus !== patch.organizationStatus;
      Object.assign(current, patch);
      if (event.contentChanged) {
        parent.updatedAt = new Date().toISOString(); parent.version = Number(parent.version || 1) + 1;
        current.updatedAt = parent.updatedAt; current.version = Number(current.version || 1) + 1;
      }
    }, event);
  }
  async function drain(generate) {
    const seen = new Set();
    while (true) {
      const state = await read(), candidates = targets(state);
      const checkpoint = (target) => signature([keyOf(target), rawOf(target.row), target.row.content, target.row.organizationJob]);
      const target = candidates.find((candidate) => !seen.has(checkpoint(candidate)) &&
        (retries.has(keyOf(candidate)) || candidate.row.organizationJob?.retryable !== false && candidate.row.organizationJob?.automaticRetry !== false &&
          Number(candidate.row.organizationJob?.retryAfter || 0) <= Date.now()));
      if (!target) {
        const deadlines = candidates.filter(({ row }) => row.organizationJob?.status === 'running' && row.organizationJob.retryAfter > Date.now())
          .map(({ row }) => row.organizationJob.retryAfter);
        if (deadlines.length) {
          timer = setTimeout(() => { timer = null; void resume({ organize: generate }).catch(() => {}); }, Math.min(2147483647, Math.max(10, Math.min(...deadlines) - Date.now() + 10)));
          timer.unref?.();
        }
        break;
      }
      seen.add(checkpoint(target));
      await step(target, structuredClone(state), retries.delete(keyOf(target)), generate);
    }
  }
  function resume(options = {}) {
    if (options.retry && options.captureId && options.annotationId) retries.add(JSON.stringify([options.captureId, options.annotationId]));
    if (active) return active;
    if (timer) { clearTimeout(timer); timer = null; }
    active = Promise.resolve().then(() => drain(options.organize || organize)).finally(() => { active = null; });
    return active;
  }
  return { resume };
}
