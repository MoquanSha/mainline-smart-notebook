import { createHash } from 'node:crypto';
import organizationJobs from './organization-job.cjs';
import fidelity from './fidelity.cjs';
import segments from '../shared/text-segments.js';

export function diarySegments(context, size = 3000) {
  const originals = segments.splitInputs(context.manualInputs, size);
  const batches = originals.length ? originals : [null];
  if (originals.at(-1)?.literal && segments.hasSupplements(context)) batches.push(null);
  return batches.map((input, index) => {
    const last = index === batches.length - 1;
    // The current clock and a previous generated summary are not new source
    // material. Including them would invalidate every restart/retry signature.
    const { now, existingPeriods, ...source } = context;
    return { ...source, manualInputs: input ? [input] : [],
      dailyFacts: last ? context.dailyFacts : { todayNewTodos: [], todayCompletedTodos: [], todayTodoNotes: [] },
      captures: last ? context.captures : [], timelineEvents: last ? context.timelineEvents : [],
      sessions: last ? context.sessions : [], dailyTasks: last ? context.dailyTasks : [], activeTasks: last ? context.activeTasks : [],
      segment: { index, total: batches.length, includeSupplements: last, supplementsOnly: !input && originals.length > 0 } };
  });
}

export async function organizeDiary({ db, owner, date, input, providerKey, generate, validate, retry = false,
  maxParts = 1, leaseMs = 150000, onProgress = () => {} }) {
  const jobs = organizationJobs.createOrganizationJobs({ db, leaseMs });
  const promptVersion = createHash('sha256').update(JSON.stringify({ template: input.promptTemplate, schema: input.outputSchema,
    providerKey, protocol: segments.POLICY, fidelity: fidelity.POLICY })).digest('hex');
  const parts = diarySegments(input.context);
  const result = await jobs.run({ owner, targetId: `day:${date}`, kind: 'daily_diary', promptVersion,
    parts, retry, maxParts,
    countsAsAiCall: (context) => !context.manualInputs[0]?.literal,
    validateOutput: (outputs) => fidelity.assertDiaryFidelity(input.context.manualInputs,
      segments.joinDiary(parts, outputs.map((output) => output.daySummary)),
      { aggregate: true, candidateForReview: outputs.at(-1).daySummary }),
    generate: async (context) => {
      if (context.manualInputs[0]?.literal) return { daySummary: '## 今日记录\n\n' + context.manualInputs[0].content, periods: [] };
      const output = validate(await generate({ ...input, context,
        promptTemplate: input.promptTemplate + '\n当前只整理 manualInputs 所含的一段原文，保留本段全部意思。segment.includeSupplements 为 false 时不要添加补充或时间段，periods 返回空数组；为 true 时才整理补充信息。' }));
      fidelity.assertDiaryFidelity(context.manualInputs, output.daySummary);
      return output;
    } });
  const job = { id: result.job.id, status: result.job.status, completed: result.job.completed, total: result.job.partCount,
    reviewId: result.job.reviewId || '', reviewHost: 'desktop',
    generation: Number(result.job.outputGeneration || 0),
    automaticRetry: result.job.automaticRetry !== false, errorCode: result.job.errorCode || '',
    retryAfter: result.job.status === 'running' ? result.job.leaseUntil : result.job.retryAfter || 0,
    error: result.job.error || '', retryable: result.job.errorCode !== 'AI_OUTPUT_CAPACITY' };
  await onProgress(job);
  if (result.job.status !== 'complete' || result.stale) return { job, pending: true, aiCalls: result.aiCalls };
  return { job, aiCalls: result.aiCalls, value: {
    daySummary: segments.joinDiary(parts, result.outputs.map((output) => output.daySummary)),
    periods: result.outputs.at(-1)?.periods || [],
  } };
}
