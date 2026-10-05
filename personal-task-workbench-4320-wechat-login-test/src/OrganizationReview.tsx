import { useEffect, useRef, useState } from 'react';
import { getOrganizationReview, type OrganizationReviewPage } from './api';
import type { DayRecord } from './types';

type Props = { job?: DayRecord['organizationJob']; scope: string; target: Record<string, string> };
export function OrganizationReview({ job, scope, target }: Props) {
  if (!job?.reviewId || job.status !== 'failed') return null;
  if (job.reviewHost !== 'desktop') return <p className="organization-review-hint">这次整理的疑点稿保留在手机端，可在手机查看。</p>;
  return <ReviewPanel key={`${scope}:${job.reviewId}`} scope={scope} target={target} reviewId={job.reviewId} />;
}

function ReviewPanel({ scope, target, reviewId }: Omit<Props, 'job'> & { reviewId: string }) {
  const [opened, setOpened] = useState(false), [busy, setBusy] = useState(false);
  const [page, setPage] = useState<OrganizationReviewPage | null>(null), [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function load(index: number) {
    const current = ++generation.current;
    setBusy(true); setError('');
    try {
      const result = await getOrganizationReview({ ...target, index, expectedDataScope: scope, expectedReviewId: reviewId });
      if (generation.current === current) setPage(result);
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : '暂时无法读取检查记录');
    } finally { if (generation.current === current) setBusy(false); }
  }
  return <div className="organization-review">
    <button type="button" className="quiet-button" aria-expanded={opened} onClick={() => {
      if (opened) { generation.current++; setBusy(false); } else if (!page) void load(0);
      setOpened(!opened);
    }}>{opened ? '收起整理疑点' : '查看整理疑点'}</button>
    {opened && <section aria-label="整理疑点对照" className="organization-review-panel">
      <p>候选稿尚未采用，原文保持不变。可对照后使用原页面的重试整理按钮。</p>
      {busy && <p role="status">正在读取检查记录…</p>}
      {error && <p role="alert">{error}<button type="button" className="quiet-button" disabled={busy} onClick={() => void load(page?.index || 0)}>重新读取</button></p>}
      {page && <>
        <p>{page.checkedScope.startsWith('assembled') ? '整篇拼接检查发现疑点，以下按段展示当时的候选稿。' : `第 ${page.failedPartIndex + 1} 段检查发现疑点，以下可翻阅本次保存的候选稿。`}标记检查仅供辅助核对。</p>
        <ul>{page.findings.map((finding) => <li key={finding.kind}>{finding.label}{finding.changes
          ? `涉及 ${finding.changes.slice(0, 12).map((change) => `${change.value}（原文 ${change.originalCount} 次，候选稿 ${change.candidateCount} 次）`).join('、')}`
          : `出现次数从 ${finding.originalCount} 变为 ${finding.candidateCount}`}</li>)}</ul>
        <div className="organization-review-columns">
          <div><strong>本次整理时的原文</strong><pre>{page.originalAvailable ? page.original : '旧检查记录未保留分段原文，请查看笔记中的原文。'}</pre></div>
          <div><strong>未采用的候选稿</strong><pre>{page.candidate}</pre></div>
        </div>
        <div className="organization-review-pages">
          <button type="button" className="quiet-button" disabled={busy || page.index === 0} onClick={() => void load(page.index - 1)}>上一段</button>
          <span>第 {page.index + 1} 段 · 可查看 {page.availableParts} / 共 {page.totalParts} 段</span>
          <button type="button" className="quiet-button" disabled={busy || page.index + 1 >= page.availableParts} onClick={() => void load(page.index + 1)}>下一段</button>
        </div>
      </>}
    </section>}
  </div>;
}
