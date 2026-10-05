import { useEffect, useRef, useState } from 'react';
import type { NotebookState, Proposal, ProposalDecision } from './types';

type Pending = { requestId: string; scope: string; selections: Array<{ id: string; baseVersion: number; taskBaseVersion?: number }>; labels: Record<string, string> };
type Stored = { pending: Pending | null; result: (ProposalDecision & { labels: Record<string, string> }) | null };
type Props = { scope: string; proposals: Proposal[]; disabled: boolean; onAction: (action: string, payload: Record<string, unknown>) => Promise<NotebookState> };
export function ProposalBatch({ scope, proposals, disabled, onAction }: Props) {
  const key = `mainline.proposalDecision.v1.${scope}`;
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(key), value: Stored = raw ? JSON.parse(raw) : { pending: null, result: null };
      if (!value || (value.pending && (value.pending.scope !== scope || !value.pending.requestId || !Array.isArray(value.pending.selections)
        || !value.pending.selections.length || !value.pending.labels || value.pending.selections.some(row => !row.id || !Number.isSafeInteger(row.baseVersion))))
        || (value.result && (!Array.isArray(value.result.results) || !value.result.labels))) throw new Error('invalid');
      return { value, error: '' };
    } catch { return { value: { pending: null, result: null } as Stored, error: '上次采用记录暂时无法读取，已停止覆盖，请保留本机数据后重试。' }; }
  });
  const [stored, setStored] = useState(initial.value), [error, setError] = useState(initial.error), [working, setWorking] = useState(false);
  const current = useRef(stored), mounted = useRef(true), running = useRef(false), action = useRef(onAction);
  useEffect(() => { action.current = onAction; }, [onAction]);
  const persist = (value: Stored) => {
    if (initial.error || scope === 'unbound') throw new Error(initial.error || '账号空间尚未准备好');
    localStorage.setItem(key, JSON.stringify(value)); current.current = value; setStored(value);
  };
  const submit = async (resumeOnly = false) => {
    if (!mounted.current || running.current) return;
    running.current = true; setWorking(true); setError('');
    try {
      let pending = current.current.pending;
      if (!pending) {
        if (resumeOnly) return;
        const rows = proposals.filter(row => row.status === 'pending');
        if (!rows.length) return;
        pending = { requestId: crypto.randomUUID(), scope, labels: Object.fromEntries(rows.map(row => [row.id, row.title])),
          selections: rows.map(row => ({ id: row.id, baseVersion: Number(row.version || 1), ...(row.taskBaseVersion !== undefined ? { taskBaseVersion: row.taskBaseVersion } : {}) })) };
      }
      // The durable request is written before sending, including on a retry.
      persist({ ...current.current, pending });
      const next = await action.current('proposal.applyAll', { requestId: pending.requestId, expectedDataScope: pending.scope, selections: pending.selections });
      if (!mounted.current) return;
      const receipt = next.meta.lastProposalDecision;
      if (next.status.dataScope !== scope || receipt?.requestId !== pending.requestId) throw new Error('尚未收到本次采用的确认，已保留原选择，请重试确认');
      const result = { requestId: receipt.requestId, applied: receipt.applied, failed: receipt.failed, labels: pending.labels,
        results: receipt.results.map(row => ({ id: row.id, ok: row.ok, ...(row.error ? { error: { code: row.error.code, message: row.error.message } } : {}) })) };
      // If this storage write fails the pending request stays durable for replay.
      persist({ pending: null, result });
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '采用结果尚未确认，原选择已保留'); }
    finally { running.current = false; if (mounted.current) setWorking(false); }
  };
  const resume = useRef(submit);
  useEffect(() => { resume.current = submit; });
  useEffect(() => {
    mounted.current = true;
    const retry = () => { void resume.current(true); };
    retry(); window.addEventListener('online', retry);
    return () => { mounted.current = false; window.removeEventListener('online', retry); };
  }, []);
  const count = proposals.filter(row => row.status === 'pending').length;
  if (!count && !stored.pending && !stored.result && !error) return null;
  return <section className="proposal-batch" aria-label="批量采用结果">
    {(count > 0 || stored.pending) && <button className="journal-apply-all" disabled={disabled || working || Boolean(initial.error)} onClick={() => { void submit(); }}>
      {working ? '正在确认采用结果' : stored.pending ? '重试上次采用' : `采用当前 ${count} 条建议`}
    </button>}
    {stored.pending && <p>已保留本次 {stored.pending.selections.length} 条选择，等待保存确认。</p>}
    {error && <p role="alert" className="proposal-batch-error">{error}</p>}
    {stored.result && <div role="status">
      <p>已采用 {stored.result.applied} 条{stored.result.failed ? `，${stored.result.failed} 条待处理` : '，已保存到本机'}。</p>
      {stored.result.failed > 0 && <ul>{stored.result.results.filter(row => !row.ok).map(row => <li key={row.id}>
        <strong>{stored.result!.labels[row.id] || '建议'}</strong> — {row.error?.message || '尚未采用，请查看最新内容后重新确认'}
      </li>)}</ul>}
    </div>}
  </section>;
}
