import {
  ArchiveBoxIcon as ArchiveBox,
  ArrowCounterClockwise,
  ArrowRight,
  BookOpenText,
  CalendarBlank,
  CaretDown,
  CaretRight,
  Check,
  CheckCircle,
  CircleNotch,
  Clock,
  CloudArrowDown,
  Cpu,
  DotsSixVertical,
  FileText,
  GearSix,
  Eye,
  EyeSlash,
  ImageSquare,
  Tray as Inbox,
  ListChecks,
  MagicWand,
  NotePencil,
  PushPin,
  Robot,
  ShieldCheck,
  Sparkle,
  Star,
  TextAlignLeft,
  UploadSimple,
  User,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { describeDesktopCloudSync } from "./sync-status.mjs";
import {
  ApiError,
  downloadExport,
  getLocalRecovery,
  localRecoveryDownloadUrl,
  getState,
  importData,
  organizeCaptures,
  performAction,
  uploadTodoCommentImage,
} from "./api";
import type { RecoveryFile } from "./api";
import { clearAccessToken, cloudAuthEnabled, completeAuthRedirect, getAccessToken, loadCloudAuthConfig, sendMagicLink } from "./auth";
import { MarkdownContent } from "./MarkdownContent";
import { OrganizationReview } from "./OrganizationReview";
import { ProposalBatch } from './ProposalBatch';
import { journalBody } from "../shared/markdown-web.js";
import { selectNewerState } from "./state-order";
import packageMetadata from "../package.json";
import type {
  Capture,
  DailyTask,
  DailyPeriodSummary,
  DayRecord,
  NotebookState,
  Owner,
  PlanningTrack,
  PlanPreview,
  Proposal,
  SessionBlock,
  Task,
  TimelineEvent,
  TodoCommentAttachment,
  ViewName,
} from "./types";

const weekNames = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const sidebarWidthStorageKey = "mainline-notebook.sidebar-width";
const completedHistoryOrderStorageKey = "mainline-notebook.completed-history-order";
// The timeline-based plan preview is kept for a possible later return, but is
// intentionally hidden while Today Todos are the product's primary workflow.
const planPreviewUiEnabled = false;
const cloudSyncUiEnabled = true;
const defaultSidebarWidth = 248;
const minSidebarWidth = 200;
const maxSidebarWidth = 420;

function proposalNeedsReview(proposal: Proposal) {
  if (!["pending", "deferred"].includes(proposal.status)) return false;
  if (proposal.suggestedHandling) return proposal.suggestedHandling === "ask_user";
  return ["task_create", "task_update", "calendar_event"].includes(proposal.type);
}

function clampSidebarWidth(value: number): number {
  return Math.min(maxSidebarWidth, Math.max(minSidebarWidth, value));
}

function loadSidebarWidth(): number {
  const savedWidth = Number(window.localStorage.getItem(sidebarWidthStorageKey));
  return Number.isFinite(savedWidth) ? clampSidebarWidth(savedWidth) : defaultSidebarWidth;
}

type CompletedHistoryOrder = "newest" | "oldest";

function loadCompletedHistoryOrder(): CompletedHistoryOrder {
  return window.localStorage.getItem(completedHistoryOrderStorageKey) === "oldest" ? "oldest" : "newest";
}

function taskCompletionTimestamp(task: Task): number {
  for (const value of [task.completedAt, task.updatedAt, task.createdAt]) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

const ownerLabels: Record<Owner, string> = {
  me: "我来完成",
  ai: "AI 准备",
  both: "共同完成",
};
type ActionHandler = (
  action: string,
  payload?: Record<string, unknown>,
) => Promise<NotebookState>;

function dayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timestampFallsOnDate(value: string | undefined, date: string): boolean {
  if (!value) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && dayKey(parsed) === date;
}

function compactExcerpt(value: string | undefined, max = 110): string {
  const normalized = (value || "").replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max).trim()}…` : normalized;
}

function captureResultHeadline(capture: Capture): string {
  const value = capture.journalTitle || capture.organizationSummary || capture.content;
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#>\s]+/, "").trim())
    .find(Boolean) || "";
  return compactExcerpt(firstLine, 82);
}

function dateFromKey(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function formatDay(value: string): { monthDay: string; week: string; full: string } {
  const date = dateFromKey(value);
  return {
    monthDay: `${date.getMonth() + 1}月${date.getDate()}日`,
    week: weekNames[date.getDay()],
    full: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`,
  };
}

function isMeaningfulTimelineEvent(event: TimelineEvent, state: NotebookState): boolean {
  if (event.supersededBy) return false;
  if (!event.captureId) return true;
  const capture = state.captures.find((item) => item.id === event.captureId);
  return !capture || capture.actionable !== false;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${formatTime(value)}`;
}

function formatShortDate(value: string): string {
  if (!value) return "";
  const date = dateFromKey(value);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatUpdatedLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const updatedDay = dateFromKey(dayKey(date));
  const today = dateFromKey(dayKey());
  const days = Math.round((today.getTime() - updatedDay.getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "今天更新";
  if (days === 1) return "昨天更新";
  if (days < 7) return `${days} 天前更新`;
  return `${formatShortDate(dayKey(date))}更新`;
}

function formatDuration(minutes: number): string {
  if (minutes <= 0) return "";
  return minutes >= 60
    ? `${Math.round((minutes / 60) * 10) / 10} 小时`
    : `${minutes} 分钟`;
}

function minutesToTime(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function taskDisplaySort(left: Task, right: Task): number {
  const currentOwner = (task: Task) =>
    task.steps.find((step) => step.id === task.currentStepId)?.owner || task.owner;
  const ownerRank = (task: Task) => {
    const owner = currentOwner(task);
    return owner === "me" ? 0 : owner === "both" ? 1 : 2;
  };
  const quadrant = (task: Task) => {
    const important = task.importance !== "not_important";
    const urgent = task.urgency === "urgent";
    return important && urgent ? 0 : important ? 1 : urgent ? 2 : 3;
  };
  const priorityRank = { high: 0, normal: 1, low: 2 } as const;
  return (
    ownerRank(left) - ownerRank(right) ||
    quadrant(left) - quadrant(right) ||
    priorityRank[left.priority] - priorityRank[right.priority] ||
    new Date(right.lastActivityAt || right.updatedAt).getTime() -
      new Date(left.lastActivityAt || left.updatedAt).getTime()
  );
}

function sourceLabel(source: string): string {
  if (source === "codex") return "Codex";
  if (source === "manual") return "手动记录";
  if (source === "import") return "聊天导入";
  if (source === "wechat_official") return "微信公众号";
  if (source === "wecom") return "企业微信";
  return "AI 整理";
}

function ownerIcon(owner: Owner) {
  if (owner === "ai") return <Robot weight="duotone" aria-hidden />;
  if (owner === "both") return <UsersThree weight="duotone" aria-hidden />;
  return <User weight="duotone" aria-hidden />;
}

function emptyState(title: string, detail: string) {
  return (
    <div className="empty-state">
      <FileText size={28} weight="duotone" aria-hidden />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

interface SidebarProps {
  state: NotebookState;
  view: ViewName;
  setView: (view: ViewName) => void;
  collapsed: boolean;
  setCollapsed: (value: boolean) => void;
}

function Sidebar({ state, view, setView, collapsed, setCollapsed }: SidebarProps) {
  const pending = state.proposals.filter((proposal) => proposal.status === "pending" && proposalNeedsReview(proposal)).length;
  const todayTodos = state.dailyTasks.filter(
    (task) =>
      task.entryKind === "today_todo" &&
      task.date === dayKey() &&
      task.status === "planned",
  ).length;
  const navigation: Array<{
    id: ViewName;
    label: string;
    helper: string;
    purpose: string;
    icon: typeof BookOpenText;
    count?: number;
  }> = [
    { id: "todos", label: "今日待办", helper: "今天要完成", purpose: "查看、完成和调整今天真正要做的事情。", icon: CheckCircle, count: todayTodos },
    { id: "journal", label: "灵光一现", helper: "记录与确认", purpose: "想到什么就记下来；需要你决定的 AI 建议会在右侧集中确认。", icon: BookOpenText, count: pending },
    { id: "tasks", label: "今日小记", helper: "回想今天做了什么", purpose: "汇总今天和 Codex 的对话、实际结果，以及待办与笔记的变化。", icon: NotePencil },
    { id: "records", label: "数据档案", helper: "查找原始来源", purpose: "查找系统保留的原始输入和 Codex 记录，用于核对来源或重新分析。", icon: ArchiveBox },
  ];

  return (
    <aside className={`sidebar ${collapsed ? "is-collapsed" : ""}`}>
      <div className="brand-row">
        <button
          className="brand-mark"
          onClick={() => setView("todos")}
          aria-label="返回今日待办"
        >
          <BookOpenText size={23} weight="duotone" />
        </button>
        {!collapsed && (
          <div className="brand-copy">
            <strong>主线笔记</strong>
          <span>v{packageMetadata.version}</span>
          </div>
        )}
        <button
          className="icon-button collapse-button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          {collapsed ? <CaretRight /> : <CaretDown />}
        </button>
      </div>

      <nav className="primary-nav" aria-label="主要导航">
        {navigation.map(({ id, label, helper, purpose, icon: Icon, count }) => (
          <button
            key={id}
            className={`nav-item ${view === id ? "is-active" : ""} ${id === "records" ? "is-utility" : ""}`}
            onClick={() => setView(id)}
            aria-label={label}
            title={purpose}
          >
            <Icon size={20} weight={view === id ? "fill" : "regular"} aria-hidden />
            {!collapsed && (
              <span className="nav-copy">
                <strong>{label}</strong>
                <small>{helper}</small>
              </span>
            )}
            {!collapsed && count !== undefined && count > 0 && (
              <span className={`nav-count ${id === "journal" && pending > 0 ? "is-warm" : ""}`}>{count}</span>
            )}
          </button>
        ))}
      </nav>

      {!collapsed && (
        <>
          <div className="sidebar-section-title">记录来源</div>
          <div className="source-status-list">
            <div className="source-status">
              <span className={`status-dot ${state.status.hookInstalled || state.status.codexHistoryAvailable ? "is-online" : ""}`} />
              <div>
                <strong>Codex 对话</strong>
                <span>
                  {state.status.hookInstalled
                    ? "实时记录已接入"
                    : state.status.codexHistoryAvailable
                      ? state.status.lastHistoryScanAt
                        ? "可读取 · 最近扫描成功"
                        : "可读取 · 等待首次扫描"
                      : "未找到 Codex 记录"}
                </span>
              </div>
            </div>
            <div className="source-status">
              <span className="status-dot is-online" />
              <div>
                <strong>本地数据</strong>
                <span>只保存在这台电脑</span>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="sidebar-spacer" />
      <button
        className={`nav-item settings-nav ${view === "settings" ? "is-active" : ""}`}
        onClick={() => setView("settings")}
        title={collapsed ? "设置与连接" : undefined}
      >
        <GearSix size={20} weight={view === "settings" ? "fill" : "regular"} />
        {!collapsed && <span>设置与连接</span>}
      </button>
      {!collapsed && (
        <div className="privacy-note">
          <ShieldCheck size={18} weight="duotone" />
          <span>原始记录保留，AI 修改可撤销</span>
        </div>
      )}
    </aside>
  );
}

interface TopbarProps {
  state: NotebookState;
  view: ViewName;
  busy: string;
  onUndo: () => void;
  onCloudRefresh: () => Promise<void>;
  cloudRefreshBusy: boolean;
  desktopBridgeAvailable: boolean;
}

function Topbar({
  state,
  view,
  busy,
  onUndo,
  onCloudRefresh,
  cloudRefreshBusy,
  desktopBridgeAvailable,
}: TopbarProps) {
  const pending = state.proposals.filter((proposal) => proposal.status === "pending" && proposalNeedsReview(proposal)).length;
  const pageLabel: Record<ViewName, string> = {
    todos: `今天 · ${formatDay(dayKey()).full}`,
    journal: "灵光一现",
    tasks: "今日小记",
    inbox: "AI 建议",
    records: "数据档案",
    settings: "设置与连接",
  };
  return (
    <header className="topbar">
      <div className="breadcrumbs">
        <span>主线笔记</span>
        <CaretRight size={14} />
        <strong>{pageLabel[view]}</strong>
      </div>
      <div className="topbar-actions">
        {busy && (
          <span className="working-status" role="status">
            <CircleNotch className="spin" size={16} />
            {busy}
          </span>
        )}
        {pending > 0 && <span className="pending-pill">{pending} 条 AI 建议</span>}
        <button
          className="quiet-button topbar-sync-button"
          type="button"
          onClick={() => void onCloudRefresh()}
          disabled={Boolean(busy) || cloudRefreshBusy}
          aria-label={cloudRefreshBusy ? "正在同步刷新" : "同步刷新"}
          title={desktopBridgeAvailable
            ? "立即从云端拉取手机最新数据，并刷新当前页面"
            : "重新读取电脑本地数据；手机通过 HTTPS 写入后也会在这里出现"}
        >
          {cloudRefreshBusy
            ? <CircleNotch className="spin" size={17} />
            : <ArrowCounterClockwise size={17} />}
          <span>{cloudRefreshBusy ? "同步中" : "同步刷新"}</span>
        </button>
        <button
          className="quiet-button"
          onClick={onUndo}
          disabled={!state.actionHistory.length || Boolean(busy)}
        >
          <ArrowCounterClockwise size={17} />
          撤销
        </button>
        <span className="save-indicator">
          <Check size={14} weight="bold" />
          已保存
        </span>
      </div>
    </header>
  );
}

interface ComposerProps {
  busy: string;
  tasks: Task[];
  onSave: (
    text: string,
    intent: "organize" | "note" | "favorite" | "today" | "long_term" | "update" | "defer",
    taskId?: string,
    identity?: { id: string; date: string; scope: string },
  ) => Promise<void>;
  onImport: (file: File) => Promise<void>;
}

function CaptureComposer({ busy, tasks, onSave, onImport }: ComposerProps) {
  type Input = { id: string; content: string; revision: number; date: string; intent: Parameters<ComposerProps['onSave']>[1]; taskId: string; error?: string; blocked?: boolean };
  type Draft = { input: Input; submissions: Input[]; readError: string };
  const scope = useContext(JournalScopeContext);
  const key = `mainline.journalDraft.v1.${scope}`;
  const fresh = (): Input => ({ id: crypto.randomUUID(), content: '', revision: 0,
    date: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10), intent: 'organize', taskId: '' });
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const saved = localStorage.getItem(key), value = saved ? JSON.parse(saved) : { input: fresh(), submissions: [] };
      const valid = (row: Input) => row && typeof row.id === 'string' && typeof row.content === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date)
        && ['organize', 'note', 'favorite', 'today', 'long_term', 'update', 'defer'].includes(row.intent);
      if (!valid(value.input) || !Array.isArray(value.submissions) || !value.submissions.every(valid)) throw new Error('unreadable draft');
      return { ...value, readError: '' };
    } catch { return { input: fresh(), submissions: [], readError: '旧草稿暂时无法读取，已停止覆盖，请保留本机数据后重试。' }; }
  });
  const current = useRef(draft), mounted = useRef(true), active = useRef(false), save = useRef(onSave);
  useEffect(() => { save.current = onSave; }, [onSave]);
  const [draftError, setDraftError] = useState(draft.readError), [saving, setSaving] = useState(false);
  const { content: text, intent, taskId } = draft.input;
  const persist = (next: Draft) => {
    if (next.readError) return false;
    if (scope === 'unbound') { setDraftError('账号空间尚未准备好，请保留输入，稍后再提交。'); return false; }
    try { localStorage.setItem(key, JSON.stringify(next)); setDraftError(''); return true; }
    catch { setDraftError('草稿还未写入本机，请保留输入内容并检查存储空间。'); return false; }
  };
  const change = (patch: Partial<Input>) => {
    const previous = current.current;
    const input = { ...previous.input, ...patch, id: crypto.randomUUID(), revision: previous.input.revision + 1,
      date: previous.input.content ? previous.input.date : fresh().date };
    const next = { ...previous, input };
    current.current = next; setDraft(next); persist(next);
  };
  const drain = async (retryBlocked = false) => {
    if (active.current || !mounted.current) return;
    active.current = true; setSaving(true);
    const visited = new Set<string>();
    let failure = '';
    try {
      while (mounted.current) {
        const submitted = current.current.submissions.find((item) => !visited.has(item.id) && (!item.blocked || retryBlocked));
        if (!submitted || !persist(current.current)) break;
        visited.add(submitted.id);
        try {
          await save.current(submitted.content, submitted.intent, submitted.taskId || undefined, { id: submitted.id, date: submitted.date, scope });
          if (!mounted.current) return;
          const previous = current.current;
          const next = { ...previous, submissions: previous.submissions.filter((item) => item.id !== submitted.id),
            input: previous.input.id === submitted.id && previous.input.revision === submitted.revision ? fresh() : previous.input };
          // If the acknowledgement cannot be persisted, keep the submission
          // for an idempotent replay after storage is available again.
          if (!persist(next)) break;
          current.current = next; setDraft(next);
        } catch (error) {
          if (!mounted.current) return;
          failure = error instanceof Error ? error.message : '提交尚未确认，原文留在待提交记录中';
          const next = { ...current.current, submissions: current.current.submissions.map((item) => item.id === submitted.id
            ? { ...item, error: failure, blocked: error instanceof ApiError && [400, 401, 403, 409, 413].includes(error.status) } : item) };
          if (persist(next)) { current.current = next; setDraft(next); }
        }
      }
    } finally {
      active.current = false;
      if (mounted.current) { setSaving(false); if (failure) setDraftError(failure); }
    }
  };
  const drainRef = useRef(drain);
  useEffect(() => { drainRef.current = drain; });
  useEffect(() => {
    mounted.current = true;
    const resume = () => { void drainRef.current(); };
    resume(); window.addEventListener('online', resume);
    return () => { mounted.current = false; window.removeEventListener('online', resume); };
  }, []);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent, requestedIntent = intent) => {
    event.preventDefault();
    let input = current.current.input;
    if (!input.content.trim()) return;
    if (input.intent !== requestedIntent) input = { ...input, intent: requestedIntent, id: crypto.randomUUID(), revision: input.revision + 1 };
    const previous = { ...current.current, input };
    const next = previous.submissions.some((item) => item.id === input.id) ? previous : { ...previous, submissions: [...previous.submissions, input] };
    if (!persist(next)) return;
    current.current = next; setDraft(next);
    await drain();
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await onImport(file);
    event.target.value = "";
  };

  return (
    <form className="capture-composer" onSubmit={(event) => submit(event, intent)}>
      <div className="composer-leading">
        <NotePencil size={22} weight="duotone" />
      </div>
      <textarea
        value={text}
        onChange={(event) => change({ content: event.target.value })}
        placeholder="把刚刚出现的新计划、变化、进展或想法写在这里，不用整理格式……"
        rows={3}
        aria-label="新增记录"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            void submit(event, intent);
          }
        }}
      />
      {draftError && <p role="alert" className="journal-draft-error">{draftError}</p>}
      {draft.submissions.length > 0 && <div className="journal-pending-inputs">
        <span>{saving ? '正在保存原文' : `${draft.submissions.length} 条提交尚未确认，内容已保留在本机`}</span>
        {!saving && <button type="button" className="quiet-button" onClick={() => void drain(true)}>重试待提交记录</button>}
        <details><summary>查看待提交原文</summary>{draft.submissions.map((item) => <div key={item.id}>
          {item.error && <p>{item.blocked ? '已暂停自动重试 · ' : ''}{item.error}</p>}
          <pre>{item.content}</pre>
        </div>)}</details>
      </div>}
      <div className="composer-footer">
        <div className="composer-hint">
          <span>支持零散输入</span>
          <button
            type="button"
            className="text-button"
            onClick={() => fileRef.current?.click()}
          >
            <UploadSimple size={16} />
            导入文件
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            accept=".json,.txt,.md"
            onChange={handleFile}
          />
        </div>
        <div className="composer-actions">
          <label className="composer-intent">
            <span className="sr-only">这段文字要怎么处理</span>
            <select value={intent} onChange={(event) => change({ intent: event.target.value as typeof intent })}>
              <option value="organize">交给 AI 整理</option>
              <option value="note">仅保存为笔记</option>
              <option value="favorite">保存到收藏</option>
              <option value="today">添加到今日待办</option>
              <option value="long_term">添加到长期计划</option>
              <option value="update">更新已有计划</option>
              <option value="defer">稍后再整理</option>
            </select>
          </label>
          {intent === "update" && (
            <select
              className="composer-task-select"
              aria-label="选择要更新的任务"
              value={taskId}
              onChange={(event) => change({ taskId: event.target.value })}
            >
              <option value="">选择任务</option>
              {tasks.filter((task) => !["done", "archived"].includes(task.status)).map((task) => (
                <option key={task.id} value={task.id}>{task.title}</option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={!text.trim() || Boolean(busy)}
            onClick={(event) => void submit(event, "note")}
          >
            只记下来
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={!text.trim() || Boolean(busy)}
          >
            <MagicWand size={17} weight="fill" />
            {intent === "organize" ? "记下并整理" : "保存这条内容"}
          </button>
        </div>
      </div>
    </form>
  );
}

interface TaskRowProps {
  task: Task;
  captures?: Capture[];
  suggested?: boolean;
  workbench?: boolean;
  onAction: ActionHandler;
}

function TaskRow({ task, captures = [], suggested = false, workbench = false, onAction }: TaskRowProps) {
  const [progress, setProgress] = useState(task.progress);
  const [showSteps, setShowSteps] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const taskSources = captures.filter((capture) => task.sourceCaptureIds.includes(capture.id));
  useEffect(() => setProgress(task.progress), [task.progress]);
  const steps = task.steps ?? [];
  const currentStep = steps.find((step) => step.id === task.currentStepId);
  const completedSteps = steps.filter((step) => step.status === "done").length;

  const handleMainCheck = () => {
    if (task.status === "done") {
      return onAction("task.toggleDone", { taskId: task.id, done: false });
    }
    if (currentStep) {
      return onAction("task.stepComplete", { taskId: task.id, stepId: currentStep.id });
    }
    return onAction("task.toggleDone", { taskId: task.id, done: true });
  };

  const dueSoon =
    task.dueDate &&
    dateFromKey(task.dueDate).getTime() - dateFromKey(dayKey()).getTime() <=
      3 * 24 * 60 * 60 * 1000;

  return (
    <article className={`task-row ${workbench ? "is-workbench" : ""} ${task.status === "done" ? "is-done" : ""}`}>
      <button
        className={`task-check ${task.status === "done" ? "is-checked" : ""}`}
        onClick={() => void handleMainCheck()}
        aria-label={
          task.status === "done"
            ? `重新打开${task.title}`
            : currentStep
              ? `完成当前步骤${currentStep.title}`
              : `完成${task.title}`
        }
      >
        {task.status === "done" && <Check size={15} weight="bold" />}
      </button>
      <div className="task-row-body">
        <div className="task-title-line">
          <strong>{task.title}</strong>
          {suggested && <span className="ai-label">AI 建议</span>}
          {workbench && (
            <div className="task-primary-meta">
              <span className={`owner-chip owner-${task.owner}`}>
                {ownerIcon(task.owner)}
                {ownerLabels[task.owner]}
              </span>
              {task.dueDate && (
                <span className={`meta-chip ${dueSoon ? "is-warning" : ""}`}>
                  <CalendarBlank size={14} />
                  {formatShortDate(task.dueDate)}
                </span>
              )}
            </div>
          )}
        </div>
        <p className="task-why">{task.why || "继续推进这项长期计划，避免重新切换上下文。"}</p>
        {workbench && task.status !== "done" && currentStep ? (
          <div className="task-step-focus">
            <div className="task-next">
              <ArrowRight size={14} />
              <span className="task-next-label">当前步骤</span>
              {steps.length > 1 && <span className="step-position">{completedSteps + 1}/{steps.length}</span>}
              <span className="current-step-title">{currentStep.title}</span>
              {currentStep.dueDate && <span className="step-date">截止 {formatShortDate(currentStep.dueDate)}</span>}
            </div>
            <button
              className="complete-step-button"
              onClick={() =>
                onAction("task.stepComplete", { taskId: task.id, stepId: currentStep.id })
              }
            >
              <CheckCircle size={16} weight="bold" />
              完成这一步
            </button>
          </div>
        ) : (
          <div className="task-next">
            <ArrowRight size={14} />
            {workbench && <span className="task-next-label">下一步</span>}
            <span>{task.nextAction || (task.status === "done" ? "所有步骤已经完成" : "先确定下一步可以直接开始的动作")}</span>
          </div>
        )}
        {workbench && steps.length > 1 && (
          <div className="task-steps-wrap">
            <button className="steps-toggle" onClick={() => setShowSteps((value) => !value)}>
              {showSteps ? <CaretDown size={14} /> : <CaretRight size={14} />}
              {showSteps ? "收起步骤" : `查看全部 ${steps.length} 步`}
            </button>
            {showSteps && (
              <ol className="task-steps-list">
                {steps.map((step) => (
                  <li
                    key={step.id}
                    className={`step-${step.status}`}
                    aria-current={step.status === "current" ? "step" : undefined}
                  >
                    <span className="step-index">
                      {step.status === "done" ? <Check size={12} weight="bold" /> : step.order + 1}
                    </span>
                    <span className="step-copy">
                      <strong>{step.title}</strong>
                      <small>
                        {ownerLabels[step.owner]}
                        {step.startDate ? ` · ${formatShortDate(step.startDate)} 开始` : ""}
                        {step.dueDate ? ` · ${formatShortDate(step.dueDate)} 截止` : ""}
                      </small>
                    </span>
                    <span className="step-state">
                      {step.status === "done" ? "已完成" : step.status === "current" ? "正在进行" : "稍后"}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        <div className="task-card-footer">
          {task.status !== "done" && steps.length > 1 ? (
            <div className="step-progress" aria-label={`${completedSteps} / ${steps.length} 步已完成`}>
              <span className="step-progress-track">
                <i style={{ width: `${task.progress}%` }} />
              </span>
              <span>{completedSteps}/{steps.length} 步</span>
            </div>
          ) : task.status !== "done" ? (
            <label className="progress-control">
              <span className="sr-only">调整 {task.title} 的进度</span>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={progress}
                style={{ "--progress": `${progress}%` } as React.CSSProperties}
                onChange={(event) => setProgress(Number(event.target.value))}
                onPointerUp={() =>
                  onAction("task.update", {
                    taskId: task.id,
                    patch: { progress },
                    logProgress: true,
                  })
                }
                onKeyUp={(event) => {
                  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                    void onAction("task.update", {
                      taskId: task.id,
                      patch: { progress },
                      logProgress: true,
                    });
                  }
                }}
              />
              <span>{progress}%</span>
            </label>
          ) : null}
          {workbench && (
            <div className="task-secondary-meta">
              {task.estimatedMinutes > 0 && <span>预计 {formatDuration(task.estimatedMinutes)}</span>}
              {task.project && <span>{task.project}</span>}
              <span>{formatUpdatedLabel(task.updatedAt)}</span>
              <span>{task.currentStage === "verifying" ? "验证中" : task.currentStage === "executing" ? "执行中" : task.currentStage === "preparing" ? "准备中" : task.currentStage === "stable" ? "已稳定" : "规划中"}</span>
              {taskSources.length > 0 && (
                <button type="button" className="inline-source-button" onClick={() => setShowSources((value) => !value)}>
                  查看来源 {taskSources.length}
                </button>
              )}
              <button type="button" className="inline-source-button" onClick={() => void onAction("task.reanalyze", { taskId: task.id })}>
                重新分析
              </button>
            </div>
          )}
        </div>
      </div>
      {!workbench && <div className="task-meta">
        <span className={`owner-chip owner-${task.owner}`}>
          {ownerIcon(task.owner)}
          {ownerLabels[task.owner]}
        </span>
        {task.estimatedMinutes > 0 && (
          <span className="meta-chip">
            <Clock size={14} />
            {formatDuration(task.estimatedMinutes)}
          </span>
        )}
        {task.dueDate && (
          <span className={`meta-chip ${dueSoon ? "is-warning" : ""}`}>
            <CalendarBlank size={14} />
            {formatShortDate(task.dueDate)}
          </span>
        )}
        {task.project && <span className="project-chip">{task.project}</span>}
      </div>}
      {showSources && taskSources.length > 0 && (
        <div className="task-source-panel">
          {taskSources.map((capture) => (
            <div key={capture.id}>
              <span>{sourceLabel(capture.source)} · {formatTime(capture.occurredAt)}</span>
              <p>{capture.content}</p>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

interface TodayPlanProps {
  state: NotebookState;
  day: DayRecord;
  onAction: ActionHandler;
}

function _TodayPlan({ state, day, onAction }: TodayPlanProps) {
  const tasks = day.taskIds
    .map((taskId) => state.tasks.find((task) => task.id === taskId))
    .filter((task): task is Task => Boolean(task && !["done", "archived"].includes(task.status)))
    .sort(taskDisplaySort);

  return (
    <section className="document-section" aria-labelledby="today-plan-title">
      <div className="section-heading-row">
        <div>
          <div className="eyebrow">
            <Sparkle size={16} weight="fill" />
            根据长期计划与最近变化生成
          </div>
          <h2 id="today-plan-title">今天建议推进</h2>
          <p>{day.planReason}</p>
        </div>
        <button className="quiet-button" onClick={() => onAction("plan.preview")}>
          <MagicWand size={17} />
          预览重排
        </button>
      </div>
      <div className="task-list">
        {tasks.length
          ? tasks.map((task) => (
              <TaskRow key={task.id} task={task} captures={state.captures} suggested onAction={onAction} />
            ))
          : emptyState("今天还没有建议待办", "添加一条计划变化，或从长期计划中重新生成今天的安排。")}
      </div>
    </section>
  );
}

const maxCommentImages = 6;
const maxCommentImageBytes = 10 * 1024 * 1024;
const compressCommentImageAboveBytes = 3 * 1024 * 1024;

interface PendingCommentImage {
  id: string;
  file: File;
  previewUrl: string;
}

async function compressCommentImage(file: File): Promise<File> {
  if (!(["image/jpeg", "image/png", "image/webp"] as string[]).includes(file.type)) {
    throw new Error("只支持 JPG、PNG 或 WebP 图片");
  }
  const bitmap = await createImageBitmap(file);
  try {
    const maxDimension = 2200;
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const shouldCompress = file.size > compressCommentImageAboveBytes || scale < 1;
    if (!shouldCompress && file.size <= maxCommentImageBytes) return file;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法处理这张图片");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolveBlob) => canvas.toBlob(resolveBlob, "image/webp", 0.82));
    if (!blob) throw new Error("图片压缩失败");
    if (blob.size > maxCommentImageBytes) throw new Error("压缩后仍超过 10 MB，请换一张更小的图片");
    const baseName = file.name.replace(/\.[^.]+$/, "") || "笔记图片";
    return new File([blob], `${baseName}.webp`, { type: "image/webp", lastModified: Date.now() });
  } finally {
    bitmap.close();
  }
}

function commentImageSources(attachment: TodoCommentAttachment): string[] {
  const sources: string[] = [];
  if (attachment.relativePath) {
    sources.push(`/api/comment-images/${encodeURIComponent(attachment.relativePath)}`);
  }
  if (attachment.previewUrl && !sources.includes(attachment.previewUrl)) {
    sources.push(attachment.previewUrl);
  }
  return sources;
}

function TodoCommentImage({ attachment, onOpen }: { attachment: TodoCommentAttachment; onOpen: (url: string) => void }) {
  const sources = commentImageSources(attachment);
  const sourceKey = sources.join("|");
  const [sourceIndex, setSourceIndex] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSourceIndex(0);
    setFailed(false);
  }, [sourceKey]);

  const url = sources[sourceIndex] || "";
  if (!url || failed) {
    return <div className="todo-comment-image-unavailable">图片暂时无法加载，请同步后重试</div>;
  }
  return (
    <button type="button" onClick={() => onOpen(url)} aria-label={`查看图片：${attachment.fileName}`}>
      <img
        src={url}
        alt={attachment.fileName}
        loading="lazy"
        onError={() => {
          if (sourceIndex + 1 < sources.length) setSourceIndex(sourceIndex + 1);
          else setFailed(true);
        }}
      />
    </button>
  );
}

function TodoCommentSection({ todo, onAction, readonly = false, defaultOpen = false }: { todo: DailyTask; onAction: ActionHandler; readonly?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingCommentImage[]>([]);
  const [imageError, setImageError] = useState("");
  const [lightboxUrl, setLightboxUrl] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingImagesRef = useRef<PendingCommentImage[]>([]);
  const comments = todo.comments || [];

  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  useEffect(() => () => {
    pendingImagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
  }, []);

  const addImages = async (selectedFiles: File[]) => {
    if (!selectedFiles.length) return;
    const remaining = maxCommentImages - pendingImages.length;
    if (remaining <= 0) {
      setImageError(`每条笔记最多添加 ${maxCommentImages} 张图片`);
      return;
    }
    setImageError("");
    const prepared: PendingCommentImage[] = [];
    try {
      for (const file of selectedFiles.slice(0, remaining)) {
        const readyFile = await compressCommentImage(file);
        if (readyFile.size > maxCommentImageBytes) throw new Error("单张图片不能超过 10 MB");
        prepared.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file: readyFile,
          previewUrl: URL.createObjectURL(readyFile),
        });
      }
      setPendingImages((current) => [...current, ...prepared]);
      if (selectedFiles.length > remaining) setImageError(`已保留前 ${remaining} 张；每条笔记最多 ${maxCommentImages} 张`);
    } catch (error) {
      prepared.forEach((image) => URL.revokeObjectURL(image.previewUrl));
      setImageError(error instanceof Error ? error.message : "图片处理失败");
    }
  };

  const chooseImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    event.target.value = "";
    await addImages(selectedFiles);
  };

  const pasteImages = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && ["image/jpeg", "image/png", "image/webp"].includes(item.type))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
      .map((file, index) => file.name ? file : new File([file], `粘贴图片-${Date.now()}-${index + 1}.png`, { type: file.type, lastModified: Date.now() }));
    if (!images.length) return;
    event.preventDefault();
    void addImages(images);
  };

  const removePendingImage = (id: string) => {
    setPendingImages((current) => {
      const target = current.find((image) => image.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((image) => image.id !== id);
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if ((!draft.trim() && !pendingImages.length) || saving) return;
    setSaving(true);
    setImageError("");
    try {
      const attachments: TodoCommentAttachment[] = [];
      for (const image of pendingImages) attachments.push(await uploadTodoCommentImage(image.file));
      await onAction("todayTodo.commentAdd", {
        todoId: todo.id,
        content: draft,
        attachmentIds: attachments.map((attachment) => attachment.id),
      });
      setDraft("");
      pendingImages.forEach((image) => URL.revokeObjectURL(image.previewUrl));
      setPendingImages([]);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "笔记保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  if (readonly && !comments.length) return null;
  return (
    <div className={`todo-comment-section ${open ? "is-open" : ""}`}>
      <button className="todo-comment-toggle" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <NotePencil size={15} />
        {comments.length ? `笔记 ${comments.length}` : "笔记"}
        <CaretDown size={13} />
      </button>
      {open && (
        <div className="todo-comment-panel">
          {!!comments.length && (
            <div className="todo-comment-list">
              {comments.map((comment) => (
                <article className="todo-comment" key={comment.id}>
                  <div className="todo-comment-heading">
                    <div>
                      <time>{formatDateTime(comment.createdAt)}</time>
                      <span className={`todo-comment-ai-state ${comment.organizationStatus === "organized" ? "is-organized" : ""}`}>
                        {comment.organizationStatus === "organized" ? "AI 已整理" : "原文保留"}
                      </span>
                    </div>
                    {!readonly && (
                      <button type="button" title="删除笔记" aria-label="删除笔记" onClick={() => void onAction("todayTodo.commentDelete", { todoId: todo.id, commentId: comment.id })}>
                        <X size={13} />
                      </button>
                    )}
                  </div>
                  {comment.content && <MarkdownContent content={comment.content} />}
                  {!!comment.attachments?.some((attachment) => !attachment.deletedAt && commentImageSources(attachment).length) && (
                    <div className="todo-comment-gallery" aria-label="笔记图片">
                      {comment.attachments.filter((attachment) => !attachment.deletedAt).map((attachment) => {
                        if (!commentImageSources(attachment).length) return null;
                        return <TodoCommentImage key={attachment.id} attachment={attachment} onOpen={setLightboxUrl} />;
                      })}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
          {!readonly && (
            <form className="todo-comment-composer" onSubmit={(event) => void submit(event)}>
              <textarea aria-label={`笔记：${todo.title}`} placeholder="记录进展、问题或下一步；也可以直接粘贴截图……" rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={pasteImages} />
              {!!pendingImages.length && (
                <div className="todo-comment-pending-images">
                  {pendingImages.map((image) => (
                    <div key={image.id}>
                      <img src={image.previewUrl} alt={image.file.name} />
                      <button type="button" onClick={() => removePendingImage(image.id)} aria-label={`移除图片：${image.file.name}`}><X size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
              {imageError && <p className="todo-comment-image-error" role="alert">{imageError}</p>}
              <div className="todo-comment-composer-footer">
                <span>可粘贴截图；文字由 AI 整理，图片保持原样</span>
                <div>
                  <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(event) => void chooseImages(event)} />
                  <button className="todo-comment-image-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={saving || pendingImages.length >= maxCommentImages}>
                    <ImageSquare size={15} />图片{pendingImages.length ? ` ${pendingImages.length}/${maxCommentImages}` : ""}
                  </button>
                  <button className="primary-button" type="submit" disabled={(!draft.trim() && !pendingImages.length) || saving}>{saving ? "保存中" : "发送"}</button>
                </div>
              </div>
            </form>
          )}
        </div>
      )}
      {lightboxUrl && (
        <button className="todo-comment-lightbox" type="button" onClick={() => setLightboxUrl("")} aria-label="关闭图片预览">
          <img src={lightboxUrl} alt="笔记图片大图" />
          <span><X size={18} />关闭</span>
        </button>
      )}
    </div>
  );
}

function todayTodoSortValue(todo: DailyTask): number {
  const explicit = Number(todo.sortRank);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const created = Date.parse(todo.createdAt || "");
  return Number.isFinite(created) ? created : 0;
}

function todayTodoPinTier(todo: DailyTask): number {
  if (todo.pinned && todo.priorityPinned) return 0;
  if (todo.pinned) return 1;
  return 2;
}

function compareTodayTodoOrder(left: DailyTask, right: DailyTask): number {
  if (left.status === "planned" && right.status !== "planned") return -1;
  if (right.status === "planned" && left.status !== "planned") return 1;
  const pinTierDelta = todayTodoPinTier(left) - todayTodoPinTier(right);
  if (pinTierDelta) return pinTierDelta;
  return todayTodoSortValue(right) - todayTodoSortValue(left)
    || String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
    || left.id.localeCompare(right.id);
}

function todayTodoCarryLabel(todo: DailyTask, allTodos: DailyTask[], today: string): string {
  const todoById = new Map(allTodos.map((item) => [item.id, item]));
  const seen = new Set<string>();
  let current = todo;
  let originDate = todo.date;

  while (current.carriedFromId && !seen.has(current.carriedFromId)) {
    seen.add(current.carriedFromId);
    const previous = todoById.get(current.carriedFromId);
    if (!previous) break;
    originDate = previous.date || originDate;
    current = previous;
  }

  if (originDate === todo.date) {
    originDate = todo.planRationale?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || originDate;
  }

  const todayDate = dateFromKey(today);
  const origin = dateFromKey(originDate);
  if (Number.isNaN(todayDate.getTime()) || Number.isNaN(origin.getTime())) return "顺延任务";
  const days = Math.round((todayDate.getTime() - origin.getTime()) / (24 * 60 * 60 * 1000));
  if (days === 1) return "从昨天顺延";
  if (days === 2) return "从前天顺延";
  if (days > 2) {
    return origin.getFullYear() === todayDate.getFullYear()
      ? `从${origin.getMonth() + 1}月${origin.getDate()}日顺延`
      : `从${origin.getFullYear()}年${origin.getMonth() + 1}月${origin.getDate()}日顺延`;
  }
  return "顺延任务";
}

function todoRecordDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dayKey(date);
}

function todoProposedDate(todo: DailyTask, todoById: Map<string, DailyTask>): string {
  const dates = new Set<string>();
  const addDate = (value?: string) => {
    if (!value) return;
    const plainDate = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : todoRecordDate(value);
    if (plainDate) dates.add(plainDate);
  };
  const seen = new Set<string>();
  let current: DailyTask | undefined = todo;

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    addDate(current.proposedAt);
    addDate(current.createdAt);
    addDate(current.date);
    addDate(current.planRationale?.match(/\d{4}-\d{2}-\d{2}/)?.[0]);
    current = current.carriedFromId ? todoById.get(current.carriedFromId) : undefined;
  }

  return [...dates].sort()[0] || todo.date;
}

function todoDateMeta(todo: DailyTask, todoById: Map<string, DailyTask>): string {
  const proposed = todoProposedDate(todo, todoById);
  const completed = todoRecordDate(todo.completedAt);
  return [proposed ? `提出 ${formatShortDate(proposed)}` : "", completed ? `完成 ${formatShortDate(completed)}` : ""]
    .filter(Boolean)
    .join(" · ");
}

type CompletionCalendarDay = {
  key: string;
  date: string;
  day: number;
  empty: boolean;
  enabled: boolean;
};

function shiftMonthKey(monthKey: string, offset: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return dayKey().slice(0, 7);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function completionMonthLabel(monthKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  return match ? `${Number(match[1])}年${Number(match[2])}月` : monthKey;
}

function completionCalendarDays(monthKey: string, availableDates: Set<string>): CompletionCalendarDay[] {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return [];
  const year = Number(match[1]);
  const month = Number(match[2]);
  const leading = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [
    ...Array.from({ length: leading }, (_, index) => ({
      key: `empty-${monthKey}-${index}`, date: "", day: 0, empty: true, enabled: false,
    })),
    ...Array.from({ length: daysInMonth }, (_, index) => {
      const day = index + 1;
      const date = `${monthKey}-${String(day).padStart(2, "0")}`;
      return { key: date, date, day, empty: false, enabled: availableDates.has(date) };
    }),
  ];
}

type TodoDragSession = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  initialOrder: string[];
  currentOrder: string[];
  pinTier: number;
  timer: number;
  handle: HTMLButtonElement;
  cleanup: () => void;
};

function TodayTodoView({ state, onAction }: { state: NotebookState; onAction: ActionHandler }) {
  const [draft, setDraft] = useState("");
  const [targetDate, setTargetDate] = useState(dayKey());
  const initialCompletionMonth = [...state.dailyTasks]
    .filter((task) => task.entryKind === "today_todo" && task.status === "done" && !task.trashedAt && !task.deletedAt && todoRecordDate(task.completedAt))
    .sort((left, right) => String(right.completedAt || "").localeCompare(String(left.completedAt || "")))[0];
  const [completionDate, setCompletionDate] = useState("");
  const [completionMonth, setCompletionMonth] = useState(
    todoRecordDate(initialCompletionMonth?.completedAt).slice(0, 7) || dayKey().slice(0, 7),
  );
  const [completionCalendarOpen, setCompletionCalendarOpen] = useState(false);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState("");
  const [dragTargetId, setDragTargetId] = useState("");
  const dragSessionRef = useRef<TodoDragSession | null>(null);
  const today = dayKey();
  const todoById = new Map(state.dailyTasks.map((task) => [task.id, task]));
  const isTodayTodo = (task: (typeof state.dailyTasks)[number]) =>
    task.entryKind === "today_todo";
  const todayTodos = state.dailyTasks
    .filter((task) => task.date === today && isTodayTodo(task) && !task.trashedAt && !task.deletedAt)
    .sort(compareTodayTodoOrder);
  const sourceOpenTodos = todayTodos.filter((task) => task.status === "planned");
  const openTodoMap = new Map(sourceOpenTodos.map((todo) => [todo.id, todo]));
  const openTodos = (dragOrder || sourceOpenTodos.map((todo) => todo.id))
    .map((id) => openTodoMap.get(id))
    .filter((todo): todo is DailyTask => Boolean(todo));
  const completedTodos = todayTodos.filter((task) => task.status === "done");
  const scheduledTodos = state.dailyTasks
    .filter((task) => task.date > today && task.status === "planned" && isTodayTodo(task) && !task.trashedAt && !task.deletedAt)
    .sort((left, right) => left.date.localeCompare(right.date) || compareTodayTodoOrder(left, right));
  const allCompletedTodos = state.dailyTasks
    .filter((task) => isTodayTodo(task) && !task.trashedAt && !task.deletedAt && task.status === "done" && todoRecordDate(task.completedAt))
    .sort((left, right) => String(right.completedAt || "").localeCompare(String(left.completedAt || "")));
  const completionDates = [...new Set(allCompletedTodos.map((task) => todoRecordDate(task.completedAt)).filter(Boolean))].sort();
  const completionDateSet = new Set(completionDates);
  const activeCompletionDate = completionDateSet.has(completionDate) ? completionDate : "";
  const completionResults = activeCompletionDate
    ? allCompletedTodos.filter((task) => todoRecordDate(task.completedAt) === activeCompletionDate)
    : allCompletedTodos;
  const completionDays = completionCalendarDays(completionMonth, completionDateSet);
  const firstCompletionMonth = completionDates[0]?.slice(0, 7) || "";
  const lastCompletionMonth = completionDates.at(-1)?.slice(0, 7) || "";
  const canViewPreviousCompletionMonth = Boolean(firstCompletionMonth && completionMonth > firstCompletionMonth);
  const canViewNextCompletionMonth = Boolean(lastCompletionMonth && completionMonth < lastCompletionMonth);
  const suggestions = state.todoSuggestions || [];
  const history = state.dailyTasks
    .filter((task) => task.date < today && isTodayTodo(task) && !task.trashedAt && !task.deletedAt)
    .sort((left, right) => right.date.localeCompare(left.date));
  const days = [...new Set(history.map((task) => task.date))].slice(0, 14);

  const addTodo = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    await onAction("todayTodo.add", { content: draft, date: targetDate });
    setDraft("");
  };

  const cancelTodoDrag = useCallback(() => {
    const session = dragSessionRef.current;
    if (session?.timer) window.clearTimeout(session.timer);
    session?.cleanup();
    if (session?.handle.hasPointerCapture(session.pointerId)) {
      session.handle.releasePointerCapture(session.pointerId);
    }
    dragSessionRef.current = null;
    setDraggingId("");
    setDragTargetId("");
    setDragOrder(null);
  }, []);

  const startTodoDrag = (event: ReactPointerEvent<HTMLButtonElement>, todo: DailyTask) => {
    if (event.button !== 0 || !event.isPrimary || sourceOpenTodos.length < 2) return;
    cancelTodoDrag();
    event.preventDefault();
    const initialOrder = sourceOpenTodos.map((item) => item.id);
    const handle = event.currentTarget;
    const session: TodoDragSession = {
      id: todo.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      initialOrder,
      currentOrder: [...initialOrder],
      pinTier: todayTodoPinTier(todo),
      timer: 0,
      handle,
      cleanup: () => undefined,
    };

    const activate = () => {
      if (dragSessionRef.current !== session) return;
      if (session.active) return;
      session.active = true;
      setDragOrder([...session.currentOrder]);
      setDraggingId(todo.id);
      navigator.vibrate?.(12);
    };

    const move = (pointerEvent: PointerEvent) => {
      if (dragSessionRef.current !== session || session.pointerId !== pointerEvent.pointerId) return;
      const distance = Math.hypot(pointerEvent.clientX - session.startX, pointerEvent.clientY - session.startY);
      if (!session.active && distance >= 6) activate();
      if (!session.active) return;
      pointerEvent.preventDefault();

      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-todo-row-id]"))
        .filter((row) => row.dataset.todoPinTier === String(session.pinTier) && row.dataset.todoRowId !== session.id)
        .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
      if (!rows.length) return;

      let insertionIndex = rows.length;
      for (let index = 0; index < rows.length; index += 1) {
        const rect = rows[index].getBoundingClientRect();
        if (pointerEvent.clientY < rect.top + rect.height / 2) {
          insertionIndex = index;
          break;
        }
      }

      const nextGroup = rows.map((row) => row.dataset.todoRowId).filter((id): id is string => Boolean(id));
      nextGroup.splice(insertionIndex, 0, session.id);
      let groupCursor = 0;
      const nextOrder = session.currentOrder.map((id) => {
        const currentTodo = openTodoMap.get(id);
        if (!currentTodo || todayTodoPinTier(currentTodo) !== session.pinTier) return id;
        const nextId = nextGroup[groupCursor];
        groupCursor += 1;
        return nextId;
      });
      if (nextOrder.join("|") === session.currentOrder.join("|")) return;
      session.currentOrder = nextOrder;
      const adjacentRow = rows[Math.min(insertionIndex, rows.length - 1)];
      setDragTargetId(adjacentRow?.dataset.todoRowId || "");
      setDragOrder(nextOrder);
    };

    const finish = (pointerEvent: PointerEvent) => {
      if (dragSessionRef.current !== session || session.pointerId !== pointerEvent.pointerId) return;
      window.clearTimeout(session.timer);
      session.cleanup();
      dragSessionRef.current = null;
      if (handle.hasPointerCapture(session.pointerId)) handle.releasePointerCapture(session.pointerId);
      if (!session.active) return;
      pointerEvent.preventDefault();
      setDraggingId("");
      setDragTargetId("");
      if (session.currentOrder.join("|") === session.initialOrder.join("|")) {
        setDragOrder(null);
        return;
      }
      void onAction("todayTodo.reorder", { orderedIds: session.currentOrder })
        .catch(() => undefined)
        .finally(() => setDragOrder(null));
    };

    const cancel = (pointerEvent: PointerEvent) => {
      if (dragSessionRef.current !== session || session.pointerId !== pointerEvent.pointerId) return;
      cancelTodoDrag();
    };

    session.cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
    dragSessionRef.current = session;
    handle.setPointerCapture(event.pointerId);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish, { passive: false });
    window.addEventListener("pointercancel", cancel);
    session.timer = window.setTimeout(activate, 240);
  };

  useEffect(() => () => cancelTodoDrag(), [cancelTodoDrag]);

  return (
    <main className="wide-view today-todo-view">
      <header className="view-header todo-view-header">
        <div>
          <div className="eyebrow muted"><CheckCircle size={16} />今日待办</div>
          <h1>今天要完成什么</h1>
        </div>
        <span className="todo-total">{openTodos.length} 项待完成</span>
      </header>

      <form className="todo-capture" onSubmit={(event) => void addTodo(event)}>
        <textarea
          aria-label="添加今日待办"
          placeholder="把今天要做的事情都写进来，可以是一大段，也可以分行写……"
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="todo-capture-actions">
          <label>
            <span>{targetDate === today ? "加入今天" : "预约日期"}</span>
            <input type="date" min={today} value={targetDate} onChange={(event) => setTargetDate(event.target.value || today)} />
          </label>
          <button className="primary-button" type="submit" disabled={!draft.trim()}>
            {targetDate === today ? "整理并加入" : "预约待办"}
          </button>
        </div>
      </form>
      <p className="todo-capture-note">一段话会拆成多项待办。预约项会提前同步，到指定日期自动出现在今日待办。</p>

      <section className="today-todo-list" aria-label="今天的待办">
        {openTodos.length ? openTodos.map((todo) => (
          <article
            className={`today-todo-card ${todo.priority === "high" ? "is-urgent" : ""} ${todo.pinned ? "is-pinned" : ""} ${draggingId === todo.id ? "is-dragging" : ""} ${dragTargetId === todo.id ? "is-drag-target" : ""}`}
            data-todo-row-id={todo.id}
            data-todo-pin-tier={String(todayTodoPinTier(todo))}
            key={todo.id}
          >
            <button
              type="button"
              className="today-todo-drag-handle"
              aria-label={`按住拖动排序：${todo.title}`}
              title="按住后拖动排序"
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={(event) => startTodoDrag(event, todo)}
            >
              <DotsSixVertical size={18} weight="bold" />
            </button>
            <button
              className="today-todo-check"
              aria-label={`完成：${todo.title}`}
              title="完成"
              onClick={() => void onAction("todayTodo.complete", { todoId: todo.id })}
            >
              <Check size={15} weight="bold" />
            </button>
            <div className="today-todo-copy">
              <div className="today-todo-meta">
                <span>{todo.priority === "high" ? "优先处理" : "今日"}</span>
                {todo.source === "carry_over" && <em>{todayTodoCarryLabel(todo, state.dailyTasks, today)}</em>}
                {todo.source === "conversation" && <em>来自 Codex</em>}
              </div>
              <strong>{todo.title}</strong>
              {todo.description && todo.description !== todo.title && <p>{todo.description}</p>}
            </div>
            <div className="today-todo-actions">
              <button
                className={`today-todo-pin ${todo.pinned ? "is-pinned" : ""}`}
                title={todo.pinned ? "取消置顶" : "置顶到今日最前"}
                aria-label={todo.pinned ? `取消置顶：${todo.title}` : `置顶：${todo.title}`}
                onClick={() => void onAction("todayTodo.togglePin", { todoId: todo.id })}
              >
                <PushPin size={14} weight={todo.pinned ? "fill" : "regular"} />
                {todo.pinned ? "已置顶" : "置顶"}
              </button>
              <button className="quiet-button" onClick={() => void onAction("todayTodo.defer", { todoId: todo.id })}>明天</button>
              <button className="text-button" onClick={() => void onAction("todayTodo.delete", { todoId: todo.id })}>移除</button>
            </div>
            <TodoCommentSection todo={todo} onAction={onAction} />
          </article>
        )) : emptyState("今天的待办已经清空", "可以从上面加一件新的事情，或回到长期计划继续推进主线。")}
      </section>

      {!!scheduledTodos.length && (
        <details className="todo-scheduled" open>
          <summary>已预约 {scheduledTodos.length} 项</summary>
          <div className="todo-scheduled-list">
            {scheduledTodos.map((todo) => (
              <div className="todo-scheduled-item" key={todo.id}>
                <time>{formatShortDate(todo.date)}</time>
                <div><strong>{todo.title}</strong><small>{todoDateMeta(todo, todoById)}</small></div>
                <button className="text-button" type="button" onClick={() => void onAction("todayTodo.delete", { todoId: todo.id })}>取消</button>
              </div>
            ))}
          </div>
        </details>
      )}

      {!!completedTodos.length && (
        <details className="todo-completed">
          <summary>今天已完成 {completedTodos.length} 项</summary>
          {completedTodos.map((todo) => (
            <div className="todo-completed-item" key={todo.id}>
              <div className="todo-completed-title">
                <Check size={14} weight="bold" />
                <span>{todo.title}<small>{todoDateMeta(todo, todoById)}</small></span>
                <button type="button" onClick={() => void onAction("todayTodo.reopen", { todoId: todo.id })}>撤回完成</button>
              </div>
              <TodoCommentSection todo={todo} onAction={onAction} />
            </div>
          ))}
        </details>
      )}

      <section className="todo-completion-history" aria-labelledby="todo-completion-title">
        <div className="todo-completion-heading">
          <div><strong id="todo-completion-title">完成记录</strong><span>默认显示全部，只有存在完成记录的日期可以选择</span></div>
          <button
            className={`completion-all-button ${activeCompletionDate ? "" : "is-active"}`}
            type="button"
            onClick={() => {
              setCompletionDate("");
              setCompletionCalendarOpen(false);
            }}
          >
            查看全部 {allCompletedTodos.length} 项
          </button>
        </div>
        <button
          className={`completion-calendar-toggle ${completionCalendarOpen ? "is-open" : ""}`}
          type="button"
          aria-expanded={completionCalendarOpen}
          aria-controls="completion-calendar-panel"
          onClick={() => setCompletionCalendarOpen((open) => !open)}
        >
          <span><CalendarBlank size={15} />{activeCompletionDate ? `已选择 ${formatShortDate(activeCompletionDate)}` : "按完成日期筛选"}</span>
          <span>{completionCalendarOpen ? "收起日期" : "展开选择"}<CaretDown size={14} /></span>
        </button>
        {completionCalendarOpen && <div id="completion-calendar-panel" className="completion-calendar" aria-label="按完成日期筛选">
          <div className="completion-calendar-nav">
            <button
              type="button"
              aria-label="上一个有完成记录的月份范围"
              disabled={!canViewPreviousCompletionMonth}
              onClick={() => setCompletionMonth((current) => shiftMonthKey(current, -1))}
            >‹</button>
            <strong>{completionMonthLabel(completionMonth)}</strong>
            <button
              type="button"
              aria-label="下一个有完成记录的月份范围"
              disabled={!canViewNextCompletionMonth}
              onClick={() => setCompletionMonth((current) => shiftMonthKey(current, 1))}
            >›</button>
          </div>
          <div className="completion-calendar-weekdays" aria-hidden="true">
            {['一', '二', '三', '四', '五', '六', '日'].map((label) => <span key={label}>{label}</span>)}
          </div>
          <div className="completion-calendar-grid">
            {completionDays.map((item) => item.empty ? <span key={item.key} /> : (
              <button
                className={activeCompletionDate === item.date ? "is-selected" : ""}
                type="button"
                key={item.key}
                disabled={!item.enabled}
                aria-label={item.enabled ? `筛选 ${item.date} 的完成记录` : `${item.date} 没有完成记录`}
                onClick={() => {
                  setCompletionDate(item.date);
                  setCompletionCalendarOpen(false);
                }}
              >{item.day}</button>
            ))}
          </div>
        </div>}
        <div className="todo-completion-results">
          {!!activeCompletionDate && <p className="completion-filter-label">当前只看 {formatShortDate(activeCompletionDate)}，共 {completionResults.length} 项</p>}
          {completionResults.length ? completionResults.map((todo) => (
            <div className="todo-completion-row" key={todo.id}>
              <Check size={14} weight="bold" />
              <div>
                <strong>{todo.title}</strong>
                <small>{todoDateMeta(todo, todoById)}</small>
                <TodoCommentSection todo={todo} onAction={onAction} readonly />
              </div>
            </div>
          )) : <p>还没有已完成的待办。</p>}
        </div>
      </section>

      {!!suggestions.length && (
        <section className="todo-suggestions" aria-labelledby="todo-suggestions-title">
          <div className="todo-suggestions-heading">
            <div><Robot size={17} /><strong id="todo-suggestions-title">Codex 里可能要做</strong></div>
            <span>筛选后最多 3 条，由你确认</span>
          </div>
          <div className="todo-suggestion-list">
            {suggestions.map((suggestion) => (
              <article className="todo-suggestion-card" key={suggestion.id}>
                <div>
                  <strong>{suggestion.title}</strong>
                  <p>{suggestion.reason}</p>
                </div>
                <div>
                  <button className="quiet-button" onClick={() => void onAction("todayTodo.dismissSuggestion", { suggestionId: suggestion.id })}>忽略</button>
                  <button className="primary-button" onClick={() => void onAction("todayTodo.adoptSuggestion", { suggestionId: suggestion.id })}>加入今日</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="todo-history" aria-labelledby="todo-history-title">
        <div className="history-divider"><span id="todo-history-title">过去的待办</span></div>
        {days.length ? days.map((date) => {
          const items = history.filter((todo) => todo.date === date);
          const done = items.filter((todo) => todo.status === "done").length;
          return (
            <details className="todo-history-day" key={date}>
              <summary><strong>{formatDay(date).monthDay}</strong><span>完成 {done}/{items.length}</span><CaretDown size={16} /></summary>
              <div>
                {items.map((todo) => (
                  <div className="todo-history-item" key={todo.id}>
                    <p className={todo.status === "done" ? "is-done" : ""}>
                      <span>{todo.status === "done" ? "已完成" : todo.status === "postponed" ? "已顺延" : "未完成"}</span>
                      {todo.title}
                    </p>
                    <TodoCommentSection todo={todo} onAction={onAction} readonly />
                  </div>
                ))}
              </div>
            </details>
          );
        }) : <p className="todo-history-empty">完成或顺延的待办会按日期保留在这里。</p>}
      </section>
    </main>
  );
}

function _NoTimelineFocus({ state }: { state: NotebookState }) {
  const today = dayKey();
  const planned = state.dailyTasks
    .filter((task) => task.date === today && task.status === "planned")
    .sort((left, right) => (left.tier === "core" ? -1 : 0) - (right.tier === "core" ? -1 : 0))
    .slice(0, 4);
  const fallback = state.tasks
    .filter((task) => !["done", "archived"].includes(task.status))
    .sort(taskDisplaySort)
    .slice(0, 3);
  const entries = planned.length
    ? planned.map((task) => {
        const related = state.tasks.find((item) => item.id === task.relatedTaskId);
        return {
          id: task.id,
          title: task.title,
          detail: task.description || task.completionCriteria || related?.nextAction || "完成这一件事后，再决定下一步。",
          label: task.tier === "core" ? "主线" : "今日待办",
          owner: related?.owner,
        };
      })
    : fallback.map((task) => ({
        id: task.id,
        title: task.nextAction || task.title,
        detail: task.description || task.why || "把这一项推进到可以判断结果的程度。",
        label: "长期主线",
        owner: task.owner,
      }));

  return (
    <section className="no-timeline-focus" aria-labelledby="no-timeline-focus-title">
      <div className="no-timeline-focus-heading">
        <div>
          <div className="eyebrow"><Sparkle size={16} weight="fill" />今日主线</div>
          <h2 id="no-timeline-focus-title">今天先做什么</h2>
        </div>
        <span className="no-timeline-count">{entries.length} 项</span>
      </div>
      <div className="no-timeline-task-list">
        {entries.length ? entries.map((entry) => (
          <article className="no-timeline-task" key={entry.id}>
            <span className="no-timeline-task-marker" aria-hidden />
            <div className="no-timeline-task-copy">
              <div><span>{entry.label}</span>{entry.owner && <em>{ownerLabels[entry.owner]}</em>}</div>
              <strong>{entry.title}</strong>
              <p>{entry.detail}</p>
            </div>
          </article>
        )) : emptyState("今天还没有待推进的主线", "写下一件新事情，系统会先把它整理成任务。")}
      </div>
    </section>
  );
}

interface TodayMapProps {
  state: NotebookState;
  day: DayRecord;
  onAction: ActionHandler;
}

function _TodayMap({ state, day, onAction }: TodayMapProps) {
  const pendingPlan = state.pendingPlan;
  const scheduledSessions = (day.sessions.length ? day.sessions : pendingPlan?.sessions || [])
    .filter((session) => !["skipped", "postponed"].includes(session.status))
    .sort((left, right) => left.startMinutes - right.startMinutes);
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nextSession =
    scheduledSessions.find((session) => session.status === "planned" && session.startMinutes <= nowMinutes && nowMinutes < session.startMinutes + session.durationMinutes) ||
    scheduledSessions.find((session) => session.status === "planned" && session.startMinutes >= nowMinutes) ||
    scheduledSessions.find((session) => session.status === "planned");
  const activeTracks = state.planningProfile.tracks
    .filter((track) => track.active)
    .sort((left, right) => left.priority - right.priority);
  const meaningfulEvents = day.eventIds
    .map((eventId) => state.timeline.find((event) => event.id === eventId))
    .filter((event): event is TimelineEvent => Boolean(event && isMeaningfulTimelineEvent(event, state)));
  const blocker = meaningfulEvents.find((event) => event.kind === "blocker");
  const completed = meaningfulEvents.filter((event) => event.kind === "result").at(-1);
  const pendingCount = state.proposals.filter((proposal) => proposal.status === "pending").length;
  const fixedSources = scheduledSessions.filter((session) => session.fixed).map((session) => session.title);
  const scheduledTrackIds = [...new Set(scheduledSessions.map((session) => session.planningTrackId).filter(Boolean))];
  const scheduledTracks = activeTracks.filter((track) => scheduledTrackIds.includes(track.id)).map((track) => track.title);
  const todayCaptureCount = state.captures.filter(
    (capture) => capture.actionable !== false && dayKey(new Date(capture.occurredAt)) === day.date,
  ).length;
  const sourceItems = [
    fixedSources.length ? `固定安排 · ${fixedSources.slice(0, 2).join("、")}` : "",
    scheduledTracks.length ? `长期主线 · ${scheduledTracks.slice(0, 2).join("、")}` : "",
    todayCaptureCount ? `今日输入 · ${todayCaptureCount} 条` : "",
  ].filter(Boolean);
  const displaySessions = scheduledSessions.slice(0, 4);

  return (
    <section className="today-map" aria-labelledby="today-map-title">
      <div className="today-map-heading">
        <div>
          <div className="eyebrow"><Sparkle size={16} weight="fill" />今日地图</div>
          <h2 id="today-map-title" title="先看下一步和关键时段，其他信息留在后面。">今日安排</h2>
        </div>
        <button className="quiet-button today-map-adjust" onClick={() => onAction("plan.preview")}>
          <MagicWand size={17} />{pendingPlan ? "查看 AI 建议" : "重新规划今天"}
        </button>
      </div>

      <div className="today-map-primary">
        <div className="today-now-card">
          <span className="map-label">{nextSession && nextSession.startMinutes <= nowMinutes && nowMinutes < nextSession.startMinutes + nextSession.durationMinutes ? "现在进行" : "接下来"}</span>
          <div className="today-now-time"><Clock size={19} /><strong>{nextSession ? `${minutesToTime(nextSession.startMinutes)}–${minutesToTime(nextSession.startMinutes + nextSession.durationMinutes)}` : "先留出一段专注时间"}</strong></div>
          <h3>{nextSession?.title || activeTracks[0]?.nextAction || "记录一条新的计划变化，让系统生成可确认方案"}</h3>
          <p>{nextSession?.planRationale || activeTracks[0]?.rationale || "还没有足够可靠的安排时，系统不会用旧聊天记录硬塞满你的日程。"}</p>
        </div>
        <div className="today-map-reason">
          <span className="map-label">排程依据</span>
          <ul className="today-map-sources">
            {sourceItems.length ? sourceItems.map((item) => <li key={item}>{item}</li>) : <li>尚无足够依据，等待新的确认信息</li>}
          </ul>
          <div className="today-map-evidence"><ShieldCheck size={16} /><span>{pendingPlan ? "待你确认后写入日程" : "已采用当前计划"}</span></div>
        </div>
      </div>

      <div className="today-map-schedule">
        <div className="today-map-section-head"><strong>今日关键安排</strong><span>{displaySessions.length ? `${displaySessions.length} 个时段` : "尚未锁定时段"}</span></div>
        {displaySessions.length ? (
          <ol>
            {displaySessions.map((session) => (
              <li key={session.id} className={session.fixed ? "is-fixed" : ""}>
                <time>{minutesToTime(session.startMinutes)}–{minutesToTime(session.startMinutes + session.durationMinutes)}</time>
                <div><strong>{session.title}</strong><span>{session.fixed ? "固定活动" : session.planningTrackId ? "个人主线推进" : ownerLabels[session.owner]}</span></div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="today-map-empty">还没有可确认的关键时段。写下固定活动或新的计划变化，系统会先生成预览。</p>
        )}
      </div>

      <div className="today-map-signals">
        <div><span>需要留意</span><strong>{blocker?.title || (pendingCount ? `${pendingCount} 条 AI 建议待处理` : "目前没有新增阻塞")}</strong></div>
        <div><span>已经形成</span><strong>{completed?.title || "今天的结果会在完成后沉淀在这里"}</strong></div>
        <div><span>预留空间</span><strong>不把每段空白排满，留给沟通、切换与突发变化</strong></div>
      </div>
    </section>
  );
}

const periodStatusLabels: Record<DailyPeriodSummary["status"], string> = {
  completed: "已完成",
  in_progress: "推进中",
  blocked: "有阻塞",
};

function periodTimeLabel(period: DailyPeriodSummary): string {
  return period.startTime === period.endTime
    ? period.startTime
    : `${period.startTime}–${period.endTime}`;
}

function DailyPeriodList({ periods, showTime = true }: { periods: DailyPeriodSummary[]; showTime?: boolean }) {
  if (!periods.length) {
    return emptyState("还没有形成可总结的工作阶段", "原始对话仍会保留；只有出现明确进展、结果、决定或阻塞后，才会进入这里。");
  }
  return (
    <div className={`period-summary-list ${showTime ? "with-time" : "without-time"}`}>
      {periods.map((period) => (
        <article className={`period-summary period-${period.status}`} key={period.id}>
          {showTime && <time>{periodTimeLabel(period)}</time>}
          <div className="period-rail"><span /></div>
          <div className="period-body">
            <div className="period-heading">
              <strong>{period.title}</strong>
              <span>{periodStatusLabels[period.status]}</span>
            </div>
            <p>{period.summary}</p>
            {!!period.outcomes.length && (
              <div className="period-points period-outcomes">
                <span>形成结果</span>
                <ul>{period.outcomes.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
            )}
            {!!period.remaining.length && (
              <div className="period-points period-remaining">
                <span>还要继续</span>
                <ul>{period.remaining.slice(0, 2).map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function DailyNoteDigest({ day }: { day: DayRecord }) {
  const periods = day.periods || [];
  const outcomes = periods
    .flatMap((period) => period.outcomes)
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .slice(0, 3);
  const remaining = periods
    .flatMap((period) => period.remaining)
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .slice(0, 2);
  return (
    <div className="daily-note-digest">
      <p className="daily-note-lead">{day.summary}</p>
      {!!outcomes.length && (
        <div>
          <span>当天形成的结果</span>
          <ul>{outcomes.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      )}
      {!!remaining.length && (
        <div>
          <span>之后继续</span>
          <ul>{remaining.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

interface DayScheduleProps {
  state: NotebookState;
  day: DayRecord;
  onAction: ActionHandler;
}

function DaySchedule({ state, day, onAction }: DayScheduleProps) {
  const visibleSessions = day.sessions.filter((session) => !["skipped", "postponed"].includes(session.status));
  const earliestSession = visibleSessions.length
    ? Math.min(...visibleSessions.map((session) => session.startMinutes))
    : state.settings.workdayStart * 60;
  const latestSession = visibleSessions.length
    ? Math.max(...visibleSessions.map((session) => session.startMinutes + session.durationMinutes))
    : state.settings.workdayEnd * 60;
  const startHour = Math.max(0, Math.min(state.settings.workdayStart, Math.floor(earliestSession / 60)));
  const endHour = Math.min(24, Math.max(state.settings.workdayEnd, Math.ceil(latestSession / 60)));
  const totalMinutes = (endHour - startHour) * 60;
  const [dragging, setDragging] = useState<string>("");
  const [dragPreviewMinutes, setDragPreviewMinutes] = useState<number | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [deferMenuFor, setDeferMenuFor] = useState<string>("");
  const gridRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{
    session: SessionBlock;
    startY: number;
    initialDuration: number;
  } | null>(null);

  const snappedMinutesFromPointer = (clientY: number) => {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const relative = clamp(clientY - rect.top, 0, rect.height);
    return clamp(
      startHour * 60 + Math.round((relative / rect.height) * totalMinutes / 30) * 30,
      startHour * 60,
      endHour * 60,
    );
  };

  const moveFromPointer = (sessionId: string, clientY: number) => {
    const session = visibleSessions.find((item) => item.id === sessionId);
    const minutes = snappedMinutesFromPointer(clientY);
    if (!session || minutes === null) return;
    void onAction("schedule.move", {
      sessionId,
      startMinutes: clamp(
        minutes,
        startHour * 60,
        endHour * 60 - session.durationMinutes,
      ),
    });
  };

  const beginResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    session: SessionBlock,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      session,
      startY: event.clientY,
      initialDuration: session.durationMinutes,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const finishResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = resizeRef.current;
    const grid = gridRef.current;
    if (!current || !grid) return;
    const deltaPixels = event.clientY - current.startY;
    const deltaMinutes = Math.round((deltaPixels / grid.clientHeight) * totalMinutes / 15) * 15;
    const durationMinutes = clamp(current.initialDuration + deltaMinutes, 30, 240);
    resizeRef.current = null;
    void onAction("schedule.resize", {
      sessionId: current.session.id,
      durationMinutes,
    });
  };

  const hours = Array.from({ length: endHour - startHour + 1 }, (_, index) => startHour + index);
  const plannedMinutes = visibleSessions.reduce((sum, session) => sum + session.durationMinutes, 0);
  const sortedSessions = [...visibleSessions].sort(
    (left, right) => left.startMinutes - right.startMinutes || left.durationMinutes - right.durationMinutes,
  );
  const selectedSession = sortedSessions.find((session) => session.id === selectedSessionId);
  const laneBySession = new Map<string, { lane: number; lanes: number }>();
  let cluster: SessionBlock[] = [];
  let clusterEnd = 0;
  const flushCluster = () => {
    if (!cluster.length) return;
    const laneEnds: number[] = [];
    const assigned = new Map<string, number>();
    for (const session of cluster) {
      const visualEnd = Math.max(session.startMinutes + session.durationMinutes, session.startMinutes + 42);
      const lane = laneEnds.findIndex((end) => session.startMinutes >= end + 4);
      const nextLane = lane === -1 ? laneEnds.length : lane;
      laneEnds[nextLane] = visualEnd;
      assigned.set(session.id, nextLane);
    }
    const lanes = Math.min(Math.max(laneEnds.length, 1), 3);
    for (const session of cluster) {
      laneBySession.set(session.id, { lane: (assigned.get(session.id) || 0) % lanes, lanes });
    }
    cluster = [];
    clusterEnd = 0;
  };
  for (const session of sortedSessions) {
    if (!cluster.length || session.startMinutes <= clusterEnd + 18) {
      cluster.push(session);
      clusterEnd = Math.max(clusterEnd, session.startMinutes + session.durationMinutes);
    } else {
      flushCluster();
      cluster.push(session);
      clusterEnd = session.startMinutes + session.durationMinutes;
    }
  }
  flushCluster();

  return (
    <aside className="schedule-panel" aria-label="今天的时间安排">
      <div className="schedule-header">
        <div>
          <span className="panel-label" title="拖动时间块改变开始时间，拖动底边调整时长。">今天的时间</span>
          <strong>
            {Math.round((plannedMinutes / 60) * 10) / 10} /{" "}
            {Math.round((state.settings.dailyCapacityMinutes / 60) * 10) / 10} 小时
          </strong>
        </div>
        <button
          className="icon-button"
          onClick={() => onAction("plan.preview")}
          aria-label="预览重新安排"
          title="预览重新安排"
        >
          <MagicWand size={18} />
        </button>
      </div>
      {selectedSession && (
        <div className="schedule-selection-menu">
          <div className="schedule-selection-copy">
            <span>{minutesToTime(selectedSession.startMinutes)}–{minutesToTime(selectedSession.startMinutes + selectedSession.durationMinutes)}</span>
            <strong>{selectedSession.title}</strong>
          </div>
          <div className="schedule-selection-actions">
            <button
              className="session-action-complete"
              onClick={() => {
                setSelectedSessionId("");
                void onAction("schedule.complete", { sessionId: selectedSession.id });
              }}
            ><Check size={13} />完成</button>
            <button
              onClick={() => {
                setSelectedSessionId("");
                void onAction("schedule.removeToday", { sessionId: selectedSession.id });
              }}
            ><ArchiveBox size={13} />移出今天</button>
            <div className="defer-action">
              <button onClick={() => setDeferMenuFor((current) => current === selectedSession.id ? "" : selectedSession.id)}>
                <ArrowRight size={13} />延后<CaretDown size={11} />
              </button>
              {deferMenuFor === selectedSession.id && (
                <div className="defer-options">
                  <button onClick={() => {
                    setSelectedSessionId("");
                    setDeferMenuFor("");
                    void onAction("schedule.postpone", { sessionId: selectedSession.id, to: "later_today" });
                  }}>今天稍后</button>
                  <button onClick={() => {
                    setSelectedSessionId("");
                    setDeferMenuFor("");
                    void onAction("schedule.postpone", { sessionId: selectedSession.id, to: "tomorrow" });
                  }}>明天</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="schedule-agenda" aria-label="今日安排清单">
        {sortedSessions.map((session) => (
          <article className={`agenda-session session-owner-${session.owner} session-type-${session.scheduleType || "flexible"}`} key={session.id}>
            <time>{minutesToTime(session.startMinutes)}-{minutesToTime(session.startMinutes + session.durationMinutes)}</time>
            <div>
              <strong>{session.title}</strong>
              <span>{session.fixed ? "固定时间" : ownerLabels[session.owner]}</span>
            </div>
          </article>
        ))}
      </div>
      <div
        className={`time-grid ${dragging ? "is-dragging" : ""}`}
        ref={gridRef}
        onDragOver={(event) => {
          event.preventDefault();
          setDragPreviewMinutes(snappedMinutesFromPointer(event.clientY));
        }}
        onDrop={(event) => {
          event.preventDefault();
          const sessionId = event.dataTransfer.getData("text/session-id");
          moveFromPointer(sessionId, event.clientY);
          setDragging("");
          setDragPreviewMinutes(null);
        }}
      >
        {hours.map((hour, index) => (
          <div
            className="hour-line"
            key={hour}
            style={{ top: `${(index / (hours.length - 1)) * 100}%` }}
          >
            <span>{String(hour).padStart(2, "0")}:00</span>
          </div>
        ))}
        {dragPreviewMinutes !== null && (
          <div
            className="drag-snap-line"
            style={{ top: `${((dragPreviewMinutes - startHour * 60) / totalMinutes) * 100}%` }}
          >
            <span>{minutesToTime(dragPreviewMinutes)}</span>
          </div>
        )}
        {sortedSessions.map((session) => {
          const top =
            ((session.startMinutes - startHour * 60) / totalMinutes) * 100;
          const height = (session.durationMinutes / totalMinutes) * 100;
          const lane = laneBySession.get(session.id) || { lane: 0, lanes: 1 };
          const blockStyle = {
            top: `${top}%`,
            height: `${height}%`,
            left: `calc(${lane.lane * (100 / lane.lanes)}% + 10px)`,
            right: "auto",
            width: `calc(${100 / lane.lanes}% - 14px)`,
            "--session-lane": lane.lane,
            "--session-lanes": lane.lanes,
          } as CSSProperties;
          const task = state.tasks.find((item) => item.id === session.taskId);
          const currentStep = task?.steps?.find((step) => step.id === task.currentStepId);
          const nextAction = currentStep?.title || task?.nextAction || session.planRationale || "按此时间完成这一步";
          const isSelected = selectedSessionId === session.id;
          const canEdit = session.status === "planned" && !session.fixed;
          return (
            <article
              className={`session-block session-owner-${session.owner} session-type-${session.scheduleType || "flexible"} ${session.fixed ? "is-fixed" : ""} ${session.durationMinutes <= 30 ? "is-tight" : ""} ${
                dragging === session.id ? "is-moving" : ""
              } ${isSelected ? "is-selected" : ""} ${session.status === "done" ? "is-completed" : ""} ${!canEdit ? "is-readonly" : ""}`}
              key={session.id}
              style={blockStyle}
              draggable={canEdit}
              tabIndex={0}
              role="button"
              aria-label={`${session.title}，${minutesToTime(session.startMinutes)} 至 ${minutesToTime(session.startMinutes + session.durationMinutes)}`}
              onClick={() => {
                if (!canEdit) return;
                setSelectedSessionId((current) => current === session.id ? "" : session.id);
                setDeferMenuFor("");
              }}
              onKeyDown={(event) => {
                if (!canEdit || (event.key !== "Enter" && event.key !== " ")) return;
                event.preventDefault();
                setSelectedSessionId((current) => current === session.id ? "" : session.id);
              }}
              onDragStart={(event: DragEvent<HTMLElement>) => {
                event.dataTransfer.setData("text/session-id", session.id);
                event.dataTransfer.effectAllowed = "move";
                setDragging(session.id);
                setSelectedSessionId("");
              }}
              onDragEnd={() => {
                setDragging("");
                setDragPreviewMinutes(null);
              }}
            >
              <div className="session-time">
                {minutesToTime(session.startMinutes)}–{minutesToTime(session.startMinutes + session.durationMinutes)}
              </div>
              <strong>{session.title}</strong>
              <span>{session.fixed ? "固定时间" : ownerLabels[session.owner]}</span>
              {session.durationMinutes >= 60 && (
                <div className="session-detail">
                  <span>{session.fixed ? "固定活动" : ownerLabels[session.owner]}</span>
                  <span className="session-next">下一步：{nextAction}</span>
                </div>
              )}
              {session.status === "done" && <span className="session-state">已完成</span>}
              {isSelected && (
                <div
                  className="session-action-menu"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    className="session-action-complete"
                    onClick={() => {
                      setSelectedSessionId("");
                      void onAction("schedule.complete", { sessionId: session.id });
                    }}
                  ><Check size={13} />完成</button>
                  <button
                    onClick={() => {
                      setSelectedSessionId("");
                      void onAction("schedule.removeToday", { sessionId: session.id });
                    }}
                  ><ArchiveBox size={13} />移出今天</button>
                  <div className="defer-action">
                    <button onClick={() => setDeferMenuFor((current) => current === session.id ? "" : session.id)}>
                      <ArrowRight size={13} />延后<CaretDown size={11} />
                    </button>
                    {deferMenuFor === session.id && (
                      <div className="defer-options">
                        <button onClick={() => {
                          setSelectedSessionId("");
                          setDeferMenuFor("");
                          void onAction("schedule.postpone", { sessionId: session.id, to: "later_today" });
                        }}>今天稍后</button>
                        <button onClick={() => {
                          setSelectedSessionId("");
                          setDeferMenuFor("");
                          void onAction("schedule.postpone", { sessionId: session.id, to: "tomorrow" });
                        }}>明天</button>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="session-actions" aria-hidden="true" onPointerDown={(event) => event.stopPropagation()}>
                <button
                  title="标记完成"
                  aria-label={`完成${session.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onAction("schedule.complete", { sessionId: session.id });
                  }}
                ><Check size={13} /></button>
                <button
                  title="跳过今天"
                  aria-label={`跳过${session.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onAction("schedule.skip", { sessionId: session.id });
                  }}
                ><X size={13} /></button>
                <button
                  title="顺延到明天"
                  aria-label={`顺延${session.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onAction("schedule.postpone", { sessionId: session.id });
                  }}
                ><ArrowRight size={13} /></button>
                {!session.taskId && (
                  <button
                    title="转为长期计划"
                    aria-label={`将${session.title}转为长期计划`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void onAction("schedule.convert", { sessionId: session.id });
                    }}
                  ><ListChecks size={13} /></button>
                )}
                <button
                  title="删除时间块"
                  aria-label={`删除${session.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onAction("schedule.delete", { sessionId: session.id });
                  }}
                ><ArchiveBox size={13} /></button>
              </div>
              <button
                className="resize-handle"
                aria-label={`调整${session.title}的时长`}
                onPointerDown={(event) => beginResize(event, session)}
                onPointerUp={finishResize}
              />
            </article>
          );
        })}
      </div>
      <div className="schedule-legend">
        <span><i className="legend-dot is-me" />我来做</span>
        <span><i className="legend-dot is-ai" />AI 准备</span>
        <span><i className="legend-dot is-both" />共同完成</span>
      </div>
    </aside>
  );
}

function captureKindLabel(capture: Capture): string {
  if (capture.source === "codex" && capture.organizationSummary) return "重点摘要";
  if (capture.kind === "user_prompt") return "我说";
  if (capture.kind === "assistant_result") return "Codex 结果";
  if (capture.kind === "task_complete") return "完成结果";
  if (capture.kind === "task_started") return "开始记录";
  if (capture.kind === "assistant_commentary") return "过程记录";
  if (capture.kind === "import") return "导入内容";
  if ((capture.checklistItems || []).length > 0) return "清单";

  const content = (capture.organizedContent || capture.content || "").trim();
  if (content.length > 180 || content.split("\n").length > 4) return "长笔记";
  if (/[？?]\s*$/u.test(content)) return "问题";
  if (capture.organizationStatus === "ai_organized") return "整理记录";
  return "随手记";
}

function normalizeJournalComparisonText(value: string): string {
  return value
    .replace(/^#{1,6}\s*/gmu, "")
    .replace(/[\s，,。！？!?；;：:“”'"「」『』（）()、`*_>#-]/gu, "")
    .replace(/\[|\]/gu, "")
    .toLocaleLowerCase("zh-CN");
}

function journalContentRepeatsTitle(title: string, content: string): boolean {
  const normalizedTitle = normalizeJournalComparisonText(title);
  const normalizedContent = normalizeJournalComparisonText(content);
  return Boolean(normalizedTitle && normalizedTitle === normalizedContent);
}

function captureStatusLabel(capture: Capture): string {
  if (capture.source === "codex") return "后台原文已归档";
  if (capture.organizationStatus === 'failed') return '整理暂停 · 原文已保存';
  if (capture.organizationStatus === 'pending') return `原文已保存 · 整理中${capture.organizationJob?.total ? ` ${capture.organizationJob.completed || 0}/${capture.organizationJob.total}` : ''}`;
  if (capture.organizationStatus === 'organized') return 'AI 轻量整理';
  if (capture.organizationStatus === "ai_organized") return "AI 轻量整理";
  if (capture.organizationStatus === "lightly_organized") return "已轻量排版";
  if (capture.status === "unprocessed") return "原文已保存 · 待整理";
  return "原文已保存";
}

function isJournalVisibleCapture(capture: Capture): boolean {
  if (capture.source !== "codex") return true;
  return Boolean(capture.organizationSummary?.trim());
}

function journalCaptureDay(capture: Capture): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(capture.journalDate || "")) return capture.journalDate!;
  const occurredAt = new Date(capture.occurredAt);
  return Number.isNaN(occurredAt.getTime()) ? "" : dayKey(occurredAt);
}

interface JournalEntryCardProps {
  capture: Capture;
  readOnly?: boolean;
  showDate?: boolean;
  onAction?: ActionHandler;
}

const JournalScopeContext = createContext('unbound');

function JournalAnnotationSection({ capture, onAction }: { capture: Capture; onAction?: ActionHandler }) {
  const scope = useContext(JournalScopeContext);
  const draftKey = `mainline.annotationDraft.v1.${scope}.${capture.id}`;
  const [draftState, setDraftState] = useState(() => {
    try {
      const saved = localStorage.getItem(draftKey);
      const value = saved ? JSON.parse(saved) : { id: crypto.randomUUID(), content: '', revision: 0 };
      if (typeof value.content !== 'string' || typeof value.id !== 'string') throw new Error('草稿格式无法识别');
      return { id: value.id, content: value.content, revision: Number(value.revision || 0), readError: '' };
    } catch {
      return { id: crypto.randomUUID(), content: '', revision: 0, readError: '旧草稿暂时无法读取，已停止覆盖；请保留浏览器数据后再重试。' };
    }
  });
  const draftRef = useRef(draftState);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [open, setOpen] = useState(false);
  const draft = draftState.content;
  const [draftError, setDraftError] = useState(draftState.readError);
  const [saving, setSaving] = useState(false);
  const annotations = [...(capture.annotations || [])]
    .filter((item) => !item.deletedAt && !item.trashedAt)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  const persistDraft = (next: typeof draftState) => {
    if (draftState.readError) return false;
    try { localStorage.setItem(draftKey, JSON.stringify(next)); setDraftError(''); return true; }
    catch { setDraftError('草稿还未写入本机，请保留输入内容并检查存储空间。'); return false; }
  };
  const changeDraft = (content: string) => {
    const next = { id: crypto.randomUUID(), content, revision: draftRef.current.revision + 1, readError: draftState.readError };
    draftRef.current = next; setDraftState(next); persistDraft(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || saving || !onAction || !persistDraft(draftRef.current)) return;
    const submitted = draftRef.current;
    setSaving(true);
    try {
      await onAction("capture.annotationAdd", {
        captureId: capture.id,
        annotationId: submitted.id,
        kind: "note",
        content: submitted.content,
      });
      if (mounted.current && draftRef.current.id === submitted.id && draftRef.current.revision === submitted.revision) changeDraft('');
    } catch (error) {
      if (mounted.current) setDraftError(error instanceof Error ? error.message : '提交没有确认，草稿仍保留，可以重试。');
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <div className={`journal-annotation-section ${open ? "is-open" : ""}`}>
      <button
        className="journal-annotation-toggle"
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <NotePencil size={15} />
        {annotations.length ? `笔记 ${annotations.length}` : "笔记"}
        <CaretDown size={13} />
      </button>

      {open && (
        <div className="journal-annotation-panel">
          {!!annotations.length && (
            <div className="journal-annotation-list">
              {annotations.map((annotation) => (
                <article className="journal-annotation is-note" key={annotation.id}>
                  <div className="journal-annotation-heading">
                    <div>
                      <span>笔记</span>
                      <em className={`journal-annotation-ai-state ${annotation.organizationStatus === "organized" ? "is-organized" : ""}`}>
                        {annotation.organizationStatus === "organized" ? "AI 已排版"
                          : annotation.organizationStatus === 'failed' ? '整理暂停 · 原文已保留'
                            : annotation.organizationStatus === 'pending' ? `原文已保存 · 整理中${annotation.organizationJob?.total ? ` ${annotation.organizationJob.completed || 0}/${annotation.organizationJob.total}` : ''}` : "原话保留"}
                      </em>
                      <time>{formatTime(annotation.createdAt)}</time>
                    </div>
                    {onAction && (
                      <button
                        type="button"
                        title="删除笔记"
                        aria-label="删除笔记"
                        onClick={() => void onAction("capture.annotationDelete", {
                          captureId: capture.id,
                          annotationId: annotation.id,
                        })}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                  <MarkdownContent content={annotation.content} />
                  {annotation.aiError && <p role="status">{annotation.aiError}</p>}
                  <OrganizationReview job={annotation.organizationJob} scope={scope} target={{ kind: 'journal_annotation', captureId: capture.id, annotationId: annotation.id }} />
                  {annotation.organizationStatus === 'failed' && annotation.organizationJob?.retryable !== false && onAction && <button type="button" className="quiet-button"
                    onClick={() => void onAction('capture.annotationRetry', { captureId: capture.id, annotationId: annotation.id })}>重试整理</button>}
                  <details><summary>查看原文</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{annotation.rawContent ?? annotation.content}</pre></details>
                </article>
              ))}
            </div>
          )}

          {onAction && (
            <form className="journal-annotation-composer" onSubmit={(event) => void submit(event)}>
              <textarea
                aria-label={`笔记：${capture.content.slice(0, 40)}`}
                placeholder="随手写下细节、资料、判断或想法，AI 会替你重新排版……"
                rows={3}
                value={draft}
                onChange={(event) => changeDraft(event.target.value)}
              />
              {draftError && <p role="alert">{draftError}</p>}
              <div className="journal-annotation-composer-footer">
                <span>保留原意，由 AI 重新排版为 Markdown</span>
                <button className="primary-button" type="submit" disabled={!draft.trim() || saving}>
                  {saving ? "保存原文中" : "保存笔记"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function JournalEntryCard({ capture, readOnly = false, showDate = false, onAction }: JournalEntryCardProps) {
  const reviewScope = useContext(JournalScopeContext);
  const displayContent = journalBody(capture);
  const displayTitle = capture.journalTitle || "未命名灵光";
  const contentRepeatsTitle = journalContentRepeatsTitle(displayTitle, displayContent);
  const showDisplayContent = Boolean(
    displayContent.trim()
    && (!contentRepeatsTitle || displayContent.trim().length > 60),
  );
  const hasSeparateOriginal = Boolean(
    capture.source !== "codex"
    && String(capture.rawContent ?? capture.content ?? '').length,
  );
  const isLong = showDisplayContent
    && (displayContent.length > 420 || displayContent.split("\n").length > 8);
  const [expanded, setExpanded] = useState(!isLong);
  const checklist = capture.checklistItems || [];

  return (
    <article className={`journal-entry-card ${capture.hiddenAt ? "is-hidden-record" : ""} ${capture.favoritedAt ? "is-favorite-record" : ""}`}>
      <div className="journal-entry-meta">
        <div>
          <time>
            {showDate
              ? new Date(capture.occurredAt).toLocaleString("zh-CN", {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })
              : formatTime(capture.occurredAt)}
          </time>
          <span className={`journal-source source-${capture.source}`}>{sourceLabel(capture.source)}</span>
          <span>{captureKindLabel(capture)}</span>
        </div>
        <div className="journal-entry-meta-actions">
          <span>{capture.hiddenAt ? "已隐藏 · 内容仍保留" : capture.favoritedAt ? "已收藏 · 长期保留" : captureStatusLabel(capture)}</span>
          {onAction && !capture.trashedAt && !capture.deletedAt && (
            <>
              {!capture.hiddenAt && (
                <button
                  className={`journal-visibility-button journal-favorite-button ${capture.favoritedAt ? "is-active" : ""}`}
                  type="button"
                  title={capture.favoritedAt ? "取消收藏" : "长期收藏这条记录"}
                  onClick={() => void onAction("capture.setFavorite", {
                    captureId: capture.id,
                    favorited: !capture.favoritedAt,
                  })}
                >
                  <Star size={14} weight={capture.favoritedAt ? "fill" : "regular"} />
                  {capture.favoritedAt ? "已收藏" : "收藏"}
                </button>
              )}
              {!capture.favoritedAt && (
                <button
                  className="journal-visibility-button"
                  type="button"
                  title={capture.hiddenAt ? "恢复到灵光一现" : "隐藏这条记录，内容不会删除"}
                  onClick={() => void onAction(
                    capture.hiddenAt ? "capture.restoreHidden" : "capture.hide",
                    { captureId: capture.id },
                  )}
                >
                  {capture.hiddenAt ? <Eye size={14} /> : <EyeSlash size={14} />}
                  {capture.hiddenAt ? "恢复" : "隐藏"}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="journal-entry-title-row">
        <h3>{displayTitle}</h3>
        {onAction && !capture.trashedAt && !capture.deletedAt && (
          <button
            className="journal-title-refresh"
            type="button"
            title="根据原记录和补充笔记重新生成一个便于搜索的标题；原标题合适时会保持不变"
            aria-label={`更新标题：${displayTitle}`}
            onClick={() => void onAction("capture.refreshTitle", { captureId: capture.id })}
          >
            <MagicWand size={15} />
            更新标题
          </button>
        )}
      </div>

      {showDisplayContent && (
        <div className={`journal-entry-content ${expanded ? "is-expanded" : ""}`}>
          <MarkdownContent content={displayContent} />
        </div>
      )}
      {isLong && (
        <button className="journal-entry-expand" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : "展开全文"}
          {expanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
        </button>
      )}

      {checklist.length > 0 && (
        <div className="journal-checklist" aria-label="可勾选清单">
          {checklist.map((item) => (
            <label key={item.id} className={item.checked ? "is-checked" : ""}>
              <input
                type="checkbox"
                checked={item.checked}
                disabled={readOnly || !onAction}
                onChange={(event) => {
                  if (!onAction) return;
                  void onAction("capture.toggleChecklistItem", {
                    captureId: capture.id,
                    itemId: item.id,
                    checked: event.target.checked,
                  });
                }}
              />
              <span>{item.text}</span>
            </label>
          ))}
        </div>
      )}

      {capture.organizationSummary && capture.source !== "codex" && (
        <p className="journal-entry-summary">AI 识别：{capture.organizationSummary}</p>
      )}
      {capture.aiError && <p role="status">{capture.aiError}</p>}
      <OrganizationReview job={capture.organizationJob} scope={reviewScope} target={{ kind: 'journal_entry', captureId: capture.id }} />
      {capture.organizationStatus === 'failed' && capture.organizationHost === 'desktop' && capture.organizationJob?.retryable !== false && onAction && !readOnly &&
        <button type="button" className="quiet-button" onClick={() => void onAction('capture.organizationRetry', { captureId: capture.id })}>重试整理这条记录</button>}
      {capture.organizationStatus === 'original' && capture.organizationHost === 'desktop' && onAction && !readOnly &&
        <button type="button" className="quiet-button" onClick={() => void onAction('capture.organizationRetry', { captureId: capture.id })}>整理这条记录</button>}
      {hasSeparateOriginal && (
        <details className="journal-original-copy">
          <summary>查看保存的原文</summary>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{capture.rawContent ?? capture.content}</pre>
        </details>
      )}
      <JournalAnnotationSection capture={capture} onAction={onAction} />
    </article>
  );
}

interface JournalEntryListProps {
  captures: Capture[];
  emptyText?: string;
  readOnly?: boolean;
  showDate?: boolean;
  onAction?: ActionHandler;
}

function JournalEntryList({ captures, emptyText = "还没有记录。", readOnly = false, showDate = false, onAction }: JournalEntryListProps) {
  if (!captures.length) return <div className="journal-entry-empty">{emptyText}</div>;
  return (
    <div className="journal-entry-list">
      {captures.map((capture) => (
        <JournalEntryCard
          key={capture.id}
          capture={capture}
          readOnly={readOnly}
          showDate={showDate}
          onAction={onAction}
        />
      ))}
    </div>
  );
}

interface JournalHistoryDayProps {
  day: { date: string };
  captures: Capture[];
  onAction: ActionHandler;
}

function JournalHistoryDay({ day, captures, onAction }: JournalHistoryDayProps) {
  const date = formatDay(day.date);
  const favoriteCount = captures.filter((capture) => Boolean(capture.favoritedAt)).length;

  return (
    <section id={`journal-history-day-${day.date}`} className="journal-history-day">
      <header className="journal-history-day-divider">
        <div className="journal-history-date">
          <strong>{date.monthDay}</strong>
          <span>{date.week}</span>
        </div>
        <span className="journal-history-divider-line" aria-hidden="true" />
        <div className="journal-history-counts">
          <span>{captures.length} 条记录</span>
          {favoriteCount > 0 && (
            <span className="journal-history-favorite-count" title={`${favoriteCount} 条收藏`}>
              <Star size={12} weight="fill" />
              {favoriteCount}
            </span>
          )}
        </div>
      </header>
      <div className="journal-history-day-body">
        {captures.length > 0 && (
          <>
            <div className="past-record-heading">
              <strong>当天全部记录</strong>
              <span>按发生时间保留，回顾不会覆盖原文</span>
            </div>
            <JournalEntryList captures={captures} readOnly onAction={onAction} />
          </>
        )}
      </div>
    </section>
  );
}

interface JournalReviewDayProps {
  day: DayRecord;
  tasks: Task[];
}

function JournalReviewDay({ day, tasks }: JournalReviewDayProps) {
  const date = formatDay(day.date);
  const headline = day.headline === "新的工作记录" ? "当天回顾" : day.headline;
  const completed = tasks.filter(
    (task) => task.completedAt && dayKey(new Date(task.completedAt)) === day.date,
  );

  return (
    <section id={`journal-review-day-${day.date}`} className="journal-history-day journal-review-day">
      <header className="journal-history-day-divider">
        <div className="journal-history-date">
          <strong>{date.monthDay}</strong>
          <span>{date.week}</span>
        </div>
        <span className="journal-history-divider-line" aria-hidden="true" />
        <div className="journal-history-counts">
          <span>{completed.length} 项完成</span>
        </div>
      </header>
      <div className="journal-history-day-body">
        <div className="journal-history-day-title">{headline}</div>
        <DailyNoteDigest day={day} />
        {day.reflection && (
          <div className="day-reflection">
            <TextAlignLeft size={18} />
            <div>
              <span>当天小结</span>
              <p>{day.reflection}</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

interface JournalViewProps {
  state: NotebookState;
  busy: string;
  onAction: ActionHandler;
  onOrganize: (captureIds?: string[]) => Promise<void>;
  onImport: (file: File) => Promise<void>;
}

function JournalView({ state, busy, onAction, onOrganize, onImport }: JournalViewProps) {
  const today = dayKey();
  const date = formatDay(today);
  const capturesByDay = (dateKey: string, newestFirst = false) => state.captures
    .filter((capture) => (
      journalCaptureDay(capture) === dateKey
      && !capture.hiddenAt
      && !capture.trashedAt && !capture.deletedAt
      && isJournalVisibleCapture(capture)
    ))
    .sort((left, right) => {
      const delta = new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime();
      return newestFirst ? -delta : delta;
    });
  const todayCaptures = capturesByDay(today, true);
  const todayCaptureCount = todayCaptures.length;
  const pendingProposals = state.proposals.filter(proposalNeedsReview);
  const pendingProposalCount = pendingProposals.filter((proposal) => proposal.status === "pending").length;
  const unprocessed = state.captures.filter((capture) => capture.status === "unprocessed");
  const pastDaysByDate = state.days
    .filter((day) => day.date < today)
    .reduce((days, day) => {
      if (!days.has(day.date)) days.set(day.date, day);
      return days;
    }, new Map<string, (typeof state.days)[number]>());
  const pastDays = [...pastDaysByDate.values()]
    .sort((left, right) => right.date.localeCompare(left.date));
  const [proposalRailExpanded, setProposalRailExpanded] = useState(false);
  const [favoriteRecordsExpanded, setFavoriteRecordsExpanded] = useState(false);
  const [hiddenRecordsExpanded, setHiddenRecordsExpanded] = useState(false);
  const [dailyReviewsExpanded, setDailyReviewsExpanded] = useState(false);
  const [historyRecordsExpanded, setHistoryRecordsExpanded] = useState(false);
  const hiddenCaptures = [...state.captures]
    .filter((capture) => Boolean(capture.hiddenAt) && !capture.trashedAt && !capture.deletedAt && isJournalVisibleCapture(capture))
    .sort((left, right) => new Date(right.hiddenAt || 0).getTime() - new Date(left.hiddenAt || 0).getTime());
  const favoriteCaptures = [...state.captures]
    .filter((capture) => Boolean(capture.favoritedAt) && !capture.trashedAt && !capture.deletedAt && !capture.hiddenAt && isJournalVisibleCapture(capture))
    .sort((left, right) => new Date(right.favoritedAt || 0).getTime() - new Date(left.favoritedAt || 0).getTime());
  const historyDates = [...new Set(state.captures
    .filter((capture) => !capture.hiddenAt && !capture.trashedAt && !capture.deletedAt && isJournalVisibleCapture(capture))
    .map(journalCaptureDay)
    .filter((dateKey) => dateKey && dateKey < today))]
    .sort((left, right) => right.localeCompare(left));
  const historyDays = historyDates.map((date) => ({
    day: { date },
    captures: capturesByDay(date),
  }));
  const historyCaptureCount = historyDays.reduce((total, item) => total + item.captures.length, 0);

  const scrollToJournalDate = (section: "review" | "history", dateKey: string) => {
    document.getElementById(`journal-${section}-day-${dateKey}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const addCapture = async (
    text: string,
    intent: "organize" | "note" | "favorite" | "today" | "long_term" | "update" | "defer",
    taskId?: string,
    identity?: { id: string; date: string; scope: string },
  ) => {
    await onAction("capture.add", {
      id: identity?.id, journalDate: identity?.date, expectedDataScope: identity?.scope,
      content: text,
      source: "manual",
      intent,
      taskId,
    });
  };

  return (
    <div className={`journal-layout no-timeline-test ${proposalRailExpanded ? "is-proposal-expanded" : "is-proposal-collapsed"}`}>
      <main className="journal-document">
        <header className="view-header worklog-header">
          <div>
            <div className="eyebrow muted"><BookOpenText size={16} />{date.monthDay} · {date.week}</div>
            <h1 title="想到什么就记下来；原文完整保留，系统只做轻量整理，第二天再回顾。">灵光一现</h1>
          </div>
          <span className="worklog-count">今天 {todayCaptureCount} 条记录</span>
        </header>

        <section className="quick-capture-section" aria-labelledby="quick-capture-title">
          <div className="quick-capture-heading">
            <div><span>随手记录</span><h2 id="quick-capture-title" title="写下刚刚发生的进展、结果、问题或新想法。">记一笔</h2></div>
          </div>
          <CaptureComposer busy={busy} tasks={state.tasks} onSave={addCapture} onImport={onImport} />
        </section>

        <section className={`journal-favorites-section ${favoriteRecordsExpanded ? "is-expanded" : ""}`}>
          <button
            className="journal-favorites-toggle"
            type="button"
            aria-expanded={favoriteRecordsExpanded}
            title="长期保存重要偏好、珍贵话语和值得反复查看的想法"
            onClick={() => setFavoriteRecordsExpanded((current) => !current)}
          >
            <span>
              <Star size={18} weight="fill" />
              <strong>收藏</strong>
              <em>{favoriteCaptures.length}</em>
            </span>
            <span className="journal-favorites-note">重要内容长期留在这里</span>
            {favoriteRecordsExpanded ? <CaretDown size={17} /> : <CaretRight size={17} />}
          </button>
          {favoriteRecordsExpanded && (
            <div className="journal-favorites-body">
              <JournalEntryList
                captures={favoriteCaptures}
                emptyText="还没有收藏。喜欢的事物、重要的话和有意思的想法都可以放在这里。"
                showDate
                onAction={onAction}
              />
            </div>
          )}
        </section>

        <section className="document-section actual-section journal-today-section" aria-labelledby="actual-title">
          <div className="section-heading-row">
            <div>
              <div className="eyebrow muted">
                <TextAlignLeft size={16} />
                完整保留
              </div>
              <h2 id="actual-title" title="每一次输入都按时间和来源保存在这里；长内容只折叠显示，不会被总结覆盖。">今天记下的</h2>
            </div>
          </div>
          <JournalEntryList
            captures={todayCaptures}
            emptyText="今天还没有记录。想到什么，直接在上面写下来。"
            onAction={onAction}
          />
        </section>

        <div className="journal-record-groups">
          <section className={`journal-hidden-section ${hiddenRecordsExpanded ? "is-expanded" : ""}`}>
            <button
              className="journal-hidden-toggle"
              type="button"
              aria-expanded={hiddenRecordsExpanded}
              onClick={() => setHiddenRecordsExpanded((current) => !current)}
            >
              <span>
                <EyeSlash size={17} />
                <strong>隐藏记录</strong>
                <em>{hiddenCaptures.length}</em>
              </span>
              <span className="journal-hidden-toggle-note">不会删除，可以随时恢复</span>
              {hiddenRecordsExpanded ? <CaretDown size={17} /> : <CaretRight size={17} />}
            </button>
            {hiddenRecordsExpanded && (
              <div className="journal-hidden-body">
                <JournalEntryList
                  captures={hiddenCaptures}
                  emptyText="还没有隐藏记录。"
                  readOnly
                  showDate
                  onAction={onAction}
                />
              </div>
            )}
          </section>

          <section className={`journal-review-section ${dailyReviewsExpanded ? "is-expanded" : ""}`} aria-labelledby="journal-review-title">
            <button
              className="journal-history-toggle journal-review-toggle"
              type="button"
              aria-expanded={dailyReviewsExpanded}
              onClick={() => setDailyReviewsExpanded((current) => !current)}
            >
              <span>
                <TextAlignLeft size={17} />
                <strong id="journal-review-title">当天回顾</strong>
                <em>{pastDays.length} 天</em>
              </span>
              <span className="journal-history-toggle-note">每天的摘要单独保留</span>
              {dailyReviewsExpanded ? <CaretDown size={17} /> : <CaretRight size={17} />}
            </button>
            {dailyReviewsExpanded && (
              <div className="journal-review-body">
                {pastDays.length > 0 ? (
                  <>
                    <label className="journal-history-mobile-jump journal-history-body-jump">
                      <span>跳转日期</span>
                      <select
                        defaultValue=""
                        onChange={(event) => {
                          if (event.target.value) scrollToJournalDate("review", event.target.value);
                          event.target.value = "";
                        }}
                      >
                        <option value="" disabled>选择日期</option>
                        {pastDays.map((day) => {
                          const dayDate = formatDay(day.date);
                          return <option key={day.date} value={day.date}>{dayDate.monthDay} · {dayDate.week}</option>;
                        })}
                      </select>
                    </label>
                    <div className="journal-history-layout">
                      <div className="journal-history-stream">
                        {pastDays.map((day) => (
                          <JournalReviewDay
                            key={day.date}
                            day={day}
                            tasks={state.tasks}
                          />
                        ))}
                      </div>
                      <nav className="journal-history-date-nav" aria-label="当天回顾日期导航">
                        <span>跳转日期</span>
                        <div>
                          {pastDays.map((day) => {
                            const dayDate = formatDay(day.date);
                            return (
                              <button key={day.date} type="button" onClick={() => scrollToJournalDate("review", day.date)}>
                                <strong>{dayDate.monthDay}</strong>
                                <small>{dayDate.week}</small>
                              </button>
                            );
                          })}
                        </div>
                      </nav>
                    </div>
                  </>
                ) : (
                  <div className="journal-entry-empty">还没有当天回顾。</div>
                )}
              </div>
            )}
          </section>

          <section className={`journal-history-section ${historyRecordsExpanded ? "is-expanded" : ""}`} aria-labelledby="journal-history-title">
            <button
              className="journal-history-toggle"
              type="button"
              aria-expanded={historyRecordsExpanded}
              onClick={() => setHistoryRecordsExpanded((current) => !current)}
            >
              <span>
                <ArchiveBox size={17} />
                <strong id="journal-history-title">历史记录</strong>
                <em>{historyCaptureCount}</em>
              </span>
              <span className="journal-history-toggle-note">按日期保留的全部原始记录</span>
              {historyRecordsExpanded ? <CaretDown size={17} /> : <CaretRight size={17} />}
            </button>
            {historyRecordsExpanded && (
              <div className="journal-history-body">
                {historyDays.length > 0 ? (
                  <>
                    <label className="journal-history-mobile-jump journal-history-body-jump">
                      <span>跳转日期</span>
                      <select
                        defaultValue=""
                        onChange={(event) => {
                          if (event.target.value) scrollToJournalDate("history", event.target.value);
                          event.target.value = "";
                        }}
                      >
                        <option value="" disabled>选择日期</option>
                        {historyDays.map(({ day, captures }) => {
                          const dayDate = formatDay(day.date);
                          const favoriteMark = captures.some((capture) => Boolean(capture.favoritedAt)) ? " ★" : "";
                          return (
                            <option key={day.date} value={day.date}>
                              {dayDate.monthDay} · {dayDate.week} · {captures.length} 条{favoriteMark}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                    <div className="journal-history-layout">
                      <div className="journal-history-stream">
                        {historyDays.map(({ day, captures }) => (
                          <JournalHistoryDay
                            key={day.date}
                            day={day}
                            captures={captures}
                            onAction={onAction}
                          />
                        ))}
                      </div>
                      <nav className="journal-history-date-nav" aria-label="历史记录日期导航">
                        <span>跳转日期</span>
                        <div>
                          {historyDays.map(({ day, captures }) => {
                            const dayDate = formatDay(day.date);
                            const hasFavorite = captures.some((capture) => Boolean(capture.favoritedAt));
                            return (
                              <button key={day.date} type="button" onClick={() => scrollToJournalDate("history", day.date)}>
                                <span className="journal-history-nav-date">
                                  <strong>{dayDate.monthDay}</strong>
                                  {hasFavorite && <Star size={11} weight="fill" aria-label="当天有收藏" />}
                                </span>
                                <small>{dayDate.week}<b>{captures.length} 条</b></small>
                              </button>
                            );
                          })}
                        </div>
                      </nav>
                    </div>
                  </>
                ) : (
                  <div className="journal-entry-empty">还没有历记录。</div>
                )}
              </div>
            )}
          </section>
        </div>
      </main>
      <aside
        className={`journal-proposal-rail ${proposalRailExpanded ? "is-expanded" : "is-collapsed"}`}
        aria-label="待确认"
      >
        <button
          className="journal-proposal-toggle"
          type="button"
          aria-expanded={proposalRailExpanded}
          title={proposalRailExpanded ? "收起待确认" : "展开待确认"}
          onClick={() => setProposalRailExpanded((current) => !current)}
        >
          <span className="journal-proposal-toggle-copy">
            <Inbox size={18} />
            <span>
              <small>AI 建议</small>
              <strong title="只有 AI 无法安全替你决定、并且可能改变任务或关键时间的内容才会出现在这里。">待确认</strong>
            </span>
          </span>
          <span className="journal-proposal-toggle-status">
            {pendingProposalCount > 0 && <span>{pendingProposalCount}</span>}
            <CaretRight size={17} className={proposalRailExpanded ? "is-expanded" : ""} />
          </span>
        </button>

        {proposalRailExpanded && (
          <div className="journal-proposal-content">
            {unprocessed.length > 0 && (
              <button
                className="journal-organize-button"
                disabled={Boolean(busy)}
                onClick={() => onOrganize(unprocessed.map((capture) => capture.id))}
              >
                <MagicWand size={16} weight="fill" />
                整理新记录 · {unprocessed.length}
              </button>
            )}

            <ProposalBatch key={state.status.dataScope || 'unbound'} scope={state.status.dataScope || 'unbound'}
              proposals={pendingProposals} disabled={Boolean(busy)} onAction={onAction} />

            <div className="proposal-list journal-proposal-list">
              {pendingProposals.length
                ? pendingProposals.map((proposal) => (
                    <ProposalCard key={proposal.id} proposal={proposal} captures={state.captures} onAction={onAction} />
                  ))
                : emptyState("没有待确认内容", "明确的记录已经自动保存；只有重要歧义才会来到这里。")}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

interface TimelineViewProps {
  state: NotebookState;
  onAction: ActionHandler;
}

function taskMatchesPlanningTrack(task: Task, track: PlanningTrack): boolean {
  const content = [task.title, task.project, task.nextAction, task.why, task.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return track.keywords.some((keyword) => content.includes(keyword.toLowerCase()));
}

function _TimelineView({ state, onAction }: TimelineViewProps) {
  const days = [...state.days].sort((left, right) => right.date.localeCompare(left.date));
  const today = dayKey();
  const todayRecord = state.days.find((day) => day.date === today) || {
    date: today, headline: "今天", summary: "新的记录会从这里开始。", planReason: "", taskIds: [], sessions: [], eventIds: [], reflection: "", tomorrowNote: "", isClosed: false,
  };
  const activeTracks = state.planningProfile.tracks
    .filter((track) => track.active)
    .sort((left, right) => left.priority - right.priority);
  const trackById = new Map(activeTracks.map((track) => [track.id, track]));
  const sessions = [...todayRecord.sessions]
    .filter((session) => session.status !== "skipped" && session.status !== "postponed")
    .sort((left, right) => left.startMinutes - right.startMinutes);
  const dailyTasks = state.dailyTasks
    .filter((task) => task.date === today && task.status === "planned")
    .sort((left, right) => (left.tier === "core" ? -1 : 0) - (right.tier === "core" ? -1 : 0));
  const scheduleRows = sessions
    .slice(0, 4)
    .map((session, index) => {
      const relatedTask = state.tasks.find((task) => task.id === session.taskId);
      const track = trackById.get(session.planningTrackId || "") ||
        (relatedTask ? activeTracks.find((item) => taskMatchesPlanningTrack(relatedTask, item)) : undefined);
      return {
        ...session,
        relatedTask,
        track,
        kind: session.fixed ? "fixed" : index === 0 ? "focus" : "secondary",
        rationale: session.planRationale || (track
          ? `${track.sourceLabel} · ${track.rationale}`
          : "来自已确认的长期计划与最近进展。"),
      };
    });
  const focusedRow = scheduleRows.find((row) => row.kind === "focus") || scheduleRows[0];
  const flexibleMinutes = scheduleRows
    .filter((session) => !session.fixed)
    .reduce((sum, session) => sum + session.durationMinutes, 0);
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const planningEndMinutes = state.settings.workdayEnd * 60;
  const hasRemainingPlanningTime = currentMinutes < planningEndMinutes;
  const remainingWindowMinutes = Math.max(0, planningEndMinutes - currentMinutes);
  const bufferHours = Math.max(
    0,
    Math.round((Math.min(state.settings.dailyCapacityMinutes - flexibleMinutes, remainingWindowMinutes) / 60) * 10) / 10,
  );
  const nonTimeTasks = dailyTasks
    .filter((task) => !sessions.some((session) => session.title === task.title))
    .slice(0, 2);
  const date = formatDay(today);
  return (
    <main className="wide-view timeline-view timeline-focus-view">
      <header className="timeline-focus-header">
        <div className="timeline-date-line"><strong>{date.full}</strong><span>{date.week}</span></div>
        <div className="timeline-focus-title-row">
          <div>
            <h1 title={focusedRow?.rationale || state.planningProfile.summary}>今日聚焦</h1>
          </div>
          <div className="timeline-header-actions">
            <button className="quiet-button" onClick={() => onAction("timeline.rebuild", { date: today })}><MagicWand size={17} />更新今日总结</button>
            <button className="primary-button small" onClick={() => onAction("daily.replan")}><MagicWand size={17} />重新理解并规划今天</button>
          </div>
        </div>
      </header>

      <section className="focus-planning-layout" aria-label="今日计划与长期主线">
        <div className="focus-day-column">
          <section className="focus-nontime-tasks" aria-labelledby="today-priorities-title">
            <div><strong id="today-priorities-title" title="这里显示从长期计划中选出的、今天不必锁定具体时间但需要推进的下一步。">今日主线</strong><span>{nonTimeTasks.length}</span></div>
            {nonTimeTasks.length ? <ul>{nonTimeTasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul> : <p>没有额外主线事项。</p>}
          </section>

          <div className="focus-section-heading"><span title="按时间排好的行动会显示在这里；可以在完整日程中调整。">今日安排</span></div>
          <div className="focus-schedule-list">
            {scheduleRows.length ? scheduleRows.map((row) => (
              <article className={`focus-schedule-row is-${row.kind}`} key={row.id}>
                <div className="focus-time"><strong>{row.startMinutes > 0 && row.durationMinutes > 0 ? `${minutesToTime(row.startMinutes)}–${minutesToTime(row.startMinutes + row.durationMinutes)}` : "待确定时段"}</strong><span title={row.fixed ? "这个时间已固定。" : "这是系统为这项行动预留的时间，可在完整日程中调整。"}>{row.fixed ? "固定时间" : row.startMinutes > 0 ? "计划时间" : row.kind === "focus" ? "今日聚焦" : "待安排"}</span></div>
                <div className="focus-schedule-card">
                  <div className="focus-schedule-topline"><strong>{row.title}</strong>{row.fixed && <span className="focus-fixed-badge">固定安排</span>}</div>
                  <p>{row.relatedTask?.why || row.relatedTask?.description || row.track?.goal || "完成后再判断是否需要进入下一步。"}</p>
                  <div className="focus-evidence-row"><FileText size={15} /><span>证据</span><em>{row.track?.title || row.relatedTask?.project || "已确认的今日安排"}</em></div>
                </div>
              </article>
            )) : emptyState(
              hasRemainingPlanningTime ? "还没有排定时间" : "今日没有可用时段",
              hasRemainingPlanningTime
                ? "可以重新规划今天，为当前之后的时间添加具体安排。"
                : `已过 ${String(state.settings.workdayEnd).padStart(2, "0")}:00 的规划边界；未排定主线会在下一次可用时段再进入日程。`,
            )}
            {bufferHours > 0 && <div className="focus-buffer-row"><div className="focus-time"><strong>留白</strong><span>不预先占满</span></div><div><strong>缓冲 / 突发事项</strong><span>约 {bufferHours} 小时，用来处理临时沟通、思考和时长误差。</span></div></div>}
          </div>
        </div>

        <aside className="focus-track-panel">
          <div className="focus-track-panel-heading"><div><h2 title="这里维护你的长期方向。系统会从开启的主线中选择可验证的下一步进入今日安排。">长期主线</h2></div><ShieldCheck size={19} /></div>
          <div className="focus-track-list">
            {[...state.planningProfile.tracks].sort((left, right) => left.priority - right.priority).map((track) => {
              const isScheduled = scheduleRows.some((row) => row.track?.id === track.id);
              const linkedTask = state.tasks.filter((task) => !["done", "archived"].includes(task.status)).find((task) => taskMatchesPlanningTrack(task, track));
              return <article className={`focus-track ${isScheduled ? "is-scheduled" : ""} ${!track.active ? "is-paused" : ""}`} key={track.id}>
                <div className="focus-track-head"><div><i className={`track-dot track-dot-${track.id}`} /><strong>{track.title}</strong><span>（本周节律：{track.weeklyCadence}）</span></div><label className="track-switch"><span className="sr-only">{track.active ? `暂停${track.title}` : `恢复${track.title}`}</span><input className="switch" type="checkbox" checked={track.active} onChange={(event) => onAction("planning-profile.toggle", { trackId: track.id, active: event.target.checked })} /></label></div>
                <div className="focus-track-meta"><span>目标</span><p>{track.goal}</p><span>当前里程碑</span><p>{linkedTask?.nextAction || track.milestone}</p></div>
                <div className="focus-track-why"><strong>{isScheduled ? "为什么今天这样安排" : track.active ? "今天暂不占用时间" : "本周已暂停"}</strong><span>{isScheduled ? `${track.title} 已有一个可验证的下一步进入今天。` : track.active ? "没有经过确认的即时行动，因此先保留为主线，不强行塞进日程。" : "恢复后，日计划会再次参考这条主线。"}</span></div>
                <div className="focus-evidence-row"><FileText size={15} /><span>证据</span><em>{linkedTask ? `长期计划 · ${linkedTask.project || track.sourceLabel}` : track.sourceLabel}</em></div>
              </article>;
            })}
          </div>
        </aside>
      </section>

      <section className="focus-ai-queue" aria-label="AI 准备队列">
        <div className="focus-ai-heading"><Robot size={22} weight="duotone" /><div><strong title="为你提前准备，不占用你的日程。">AI 准备队列</strong></div></div>
        <div className="focus-ai-items">{activeTracks.map((track) => <div key={track.id}><strong>{track.title}</strong><span>{track.aiPreparation}</span><small>等待触发</small></div>)}</div>
      </section>

      <details className="timeline-calendar-details">
        <summary><CalendarBlank size={18} /><span><strong title="拖动、调整时长或查看全天空档。">展开完整日程</strong></span><CaretDown size={17} /></summary>
        <DaySchedule state={state} day={todayRecord} onAction={onAction} />
      </details>

      <div className="history-divider"><span>过去每天的阶段总结</span></div>
      <div className="vertical-days">
        {days.filter((day) => day.date < today).map((day) => {
          const historyDate = formatDay(day.date);
          return <section className="timeline-day" key={day.date}><div className="timeline-day-date"><strong>{historyDate.monthDay}</strong><span>{historyDate.week}</span></div><div className="timeline-day-document"><h2>{day.headline}</h2><p>{day.summary}</p><DailyPeriodList periods={day.periods || []} /></div></section>;
        })}
      </div>
    </main>
  );
}

interface DailyDiaryViewProps {
  state: NotebookState;
  onAction: ActionHandler;
  onGoJournal: () => void;
}

function DailyDiaryView({ state, onAction, onGoJournal }: DailyDiaryViewProps) {
  const [query, setQuery] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [owner, setOwner] = useState<Owner | "all">("all");
  const [completedHistoryOrder, setCompletedHistoryOrder] = useState<CompletedHistoryOrder>(loadCompletedHistoryOrder);
  const draftKey = `mainline.dailyDiaryDraft.v3.${state.status.dataScope || "unbound"}`;
  type DiaryDraft = { content: string; inputId: string; date: string; revision: number };
  const emptyDiaryDraft = (): DiaryDraft => ({ content: "", inputId: crypto.randomUUID(), date: dayKey(), revision: 0 });
  const loadDiaryDraft = (): DiaryDraft => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(draftKey) || "null");
      if (saved && typeof saved.content === "string" && typeof saved.inputId === "string" && /^\d{4}-\d{2}-\d{2}$/.test(saved.date)) return saved as { content: string; inputId: string; date: string; revision: number };
    } catch { /* Keep malformed or unscoped legacy storage for explicit recovery. */ }
    return emptyDiaryDraft();
  };
  const [diaryDraft, setDiaryDraft] = useState<DiaryDraft>(loadDiaryDraft);
  const draftScopeRef = useRef(draftKey);
  // During the render in which the account/workspace changes, do not expose
  // the previous scope's text while the effect below loads the new draft.
  const activeDiaryDraft = draftScopeRef.current === draftKey ? diaryDraft : emptyDiaryDraft();
  const manualDiaryText = activeDiaryDraft.content;
  const draftRef = useRef(diaryDraft);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const [diaryDraftError, setDiaryDraftError] = useState("");
  // dataScope is allowed to change after login or workspace switching. Reload
  // the newly scoped draft before rendering, otherwise the previous space's
  // unsent diary text can remain in the editor for one or more renders.
  useEffect(() => {
    const next = loadDiaryDraft();
    draftScopeRef.current = draftKey;
    draftRef.current = next;
    setDiaryDraft(next);
    setDiaryDraftError("");
  }, [draftKey]);
  const [organizingManualDiary, setOrganizingManualDiary] = useState(false);
  const today = dayKey();
  const todayLabel = formatDay(today);
  const day = state.days.find((item) => item.date === today);
  const visibleTodos = state.dailyTasks.filter(
    (task) => task.entryKind === "today_todo" && !task.trashedAt && !task.deletedAt,
  );
  const newTodos = visibleTodos
    .filter((task) => task.source !== "carry_over"
      && !task.carriedFromId
      && (timestampFallsOnDate(task.proposedAt, today) || timestampFallsOnDate(task.createdAt, today)))
    .sort((left, right) => Date.parse(right.proposedAt || right.createdAt || "") - Date.parse(left.proposedAt || left.createdAt || ""));
  const completedTodos = visibleTodos
    .filter((task) => timestampFallsOnDate(task.completedAt, today))
    .sort((left, right) => Date.parse(right.completedAt || "") - Date.parse(left.completedAt || ""));
  const todoNotes = visibleTodos
    .flatMap((todo) => (todo.comments || [])
      .filter((comment) => timestampFallsOnDate(comment.createdAt, today))
      .map((comment) => ({ todo, comment })))
    .sort((left, right) => Date.parse(right.comment.createdAt) - Date.parse(left.comment.createdAt));
  const todayCodexCaptures = state.captures
    .filter((capture) => capture.source === "codex" && !capture.hiddenAt && timestampFallsOnDate(capture.occurredAt, today));
  const codexSessionCount = new Set(
    todayCodexCaptures.map((capture) => capture.sessionId || capture.turnId).filter(Boolean),
  ).size;
  const codexResults = [...new Set(todayCodexCaptures
    .filter((capture) => ["assistant_result", "task_complete"].includes(capture.kind))
    .map(captureResultHeadline)
    .filter((value) => value && value !== "Codex 任务完成"))]
    .slice(-5)
    .reverse();
  const diarySupplementLines = [
    completedTodos.length ? `- 今日待办完成：${completedTodos.slice(0, 3).map((task) => task.title).join("、")}` : "",
    newTodos.length ? `- 新增待办：${newTodos.slice(0, 3).map((task) => task.title).join("、")}` : "",
    todoNotes.length ? `- 待办补充：${todoNotes.length} 条笔记` : "",
    codexResults.length ? `- 电脑端工作结果：${codexResults.slice(0, 3).join("、")}` : "",
  ].filter(Boolean);
  const legacyManualText = (day?.manualInputs || []).map((item) => String(item.content || "")).filter((content) => content.trim());
  const fallbackDiarySummary = [
    `## 今日记录\n\n${legacyManualText.length ? legacyManualText.join("\n\n") : "今天暂未手动补写日记或感悟。"}`,
    `## 今日补充\n\n${diarySupplementLines.length ? diarySupplementLines.join("\n") : "今天没有可补充的待办变化。"}`,
  ].join("\n\n");
  const displayDiarySummary = String(day?.summary || "").trim().startsWith("## 今日记录")
    ? String(day?.summary || "")
    : fallbackDiarySummary;
  const pastDiaryDays = state.days
    .filter((item) => item.date < today && item.summary?.trim())
    .sort((left, right) => right.date.localeCompare(left.date));
  const active = state.tasks
    .filter((task) => !["done", "archived"].includes(task.status))
    .filter((task) => owner === "all" || task.owner === owner)
    .filter((task) =>
      `${task.title} ${task.project} ${task.steps.map((step) => step.title).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort(taskDisplaySort);
  const done = state.tasks
    .filter((task) => task.status === "done")
    .filter((task) =>
      `${task.title} ${task.project} ${task.steps.map((step) => step.title).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort((left, right) => {
      const difference = taskCompletionTimestamp(right) - taskCompletionTimestamp(left);
      return completedHistoryOrder === "newest" ? difference : -difference;
    });

  const updateCompletedHistoryOrder = (order: CompletedHistoryOrder) => {
    setCompletedHistoryOrder(order);
    window.localStorage.setItem(completedHistoryOrderStorageKey, order);
  };

  const persistDiaryDraft = (next: DiaryDraft) => {
    try {
      window.localStorage.setItem(draftKey, JSON.stringify(next));
      setDiaryDraftError("");
      return true;
    } catch {
      setDiaryDraftError("草稿还未写入本机，请保留输入内容并检查存储空间。视图中的文字仍会保留，但关闭页面前请先处理存储问题。");
      return false;
    }
  };
  const updateManualDiaryText = (value: string, options: { clearOnlyAfterPersist?: boolean } = {}) => {
    const previous = draftRef.current;
    const next = { content: value, inputId: crypto.randomUUID(), date: previous.content ? previous.date : dayKey(), revision: previous.revision + 1 };
    // Typing remains visible even when local persistence fails. Clearing after
    // a cloud acknowledgement is stricter: keep the submitted text visible if
    // the cleared draft cannot itself be persisted.
    if (options.clearOnlyAfterPersist && !persistDiaryDraft(next)) return false;
    persistDiaryDraft(next);
    draftRef.current = next;
    setDiaryDraft(next);
    return true;
  };

  const organizeManualDiary = async () => {
    const submitted = draftRef.current;
    const content = submitted.content;
    if (!content.trim() || organizingManualDiary) return;
    setOrganizingManualDiary(true);
    try {
      await onAction("diary.appendInput", {
        date: submitted.date,
        content,
        inputId: submitted.inputId,
      });
      if (!mountedRef.current) return;
      if (draftRef.current.inputId === submitted.inputId && draftRef.current.revision === submitted.revision) {
        updateManualDiaryText("", { clearOnlyAfterPersist: true });
      }
    } catch {
      // onAction displays the error. An already saved original remains in the
      // day; an unacknowledged submission keeps its stable draft identifier.
    } finally {
      if (mountedRef.current) setOrganizingManualDiary(false);
    }
  };

  return (
    <main className="wide-view tasks-view daily-diary-view">
      <header className="view-header with-actions diary-view-header">
        <div>
          <div className="eyebrow muted"><NotePencil size={16} />{todayLabel.full} · {todayLabel.week}</div>
          <h1>今日小记</h1>
          <p>写下今天的经历、感悟和想法。原文会保留，AI 只整理表达与排版，待办作为补充。</p>
        </div>
        <button className="primary-button" onClick={() => void onAction("diary.refresh", { date: today })}>
          <MagicWand size={17} weight="bold" />
          AI 更新小记
        </button>
      </header>

      <section className="diary-input-card" aria-labelledby="diary-input-title">
        <div className="diary-input-heading">
          <div>
            <strong id="diary-input-title">今天的日记与感悟</strong>
            <span>原文完整保留，AI 整理稿以这里的内容为主，待办只作补充。</span>
          </div>
          {!!day?.manualInputs?.length && <small>今天已保存 {day.manualInputs.length} 条</small>}
        </div>
        <div className="diary-input-composer">
          {!!manualDiaryText && activeDiaryDraft.date !== today && <small>这份草稿会保存到 {activeDiaryDraft.date}，保留开始记录时的日期。</small>}
          {diaryDraftError && <p role="alert" className="journal-draft-error">{diaryDraftError}</p>}
          <textarea
            value={manualDiaryText}
            placeholder="例如，今天把小程序同步问题查清了，也决定以后桌面端小更新直接使用固定本地入口……"
            onChange={(event) => updateManualDiaryText(event.target.value)}
          />
          <button
            className="primary-button"
            type="button"
            disabled={!manualDiaryText.trim() || organizingManualDiary}
            onClick={() => void organizeManualDiary()}
          >
            {organizingManualDiary ? <CircleNotch className="spin" size={17} /> : <MagicWand size={17} weight="bold" />}
            {organizingManualDiary ? "正在保存原文并整理" : "保存原文并整理"}
          </button>
        </div>
        {!!day?.manualInputs?.length && (
          <div className="diary-manual-history">
            <strong>已保存的原文</strong>
            <div>
              {[...day.manualInputs].reverse().map((item) => (
                <article key={item.id}>
                  <p>{item.content}</p>
                  <small>{formatDateTime(item.createdAt)} · 原文保持不变</small>
                </article>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="diary-lead-card" aria-labelledby="diary-summary-title">
        <OrganizationReview job={day?.organizationJob} scope={state.status.dataScope || 'unbound'} target={{ kind: 'daily_diary', date: today }} />
        <p className="diary-organization-state" role="status">
          {day?.organizationStatus === "failed"
            ? `原文已保留，AI 整理暂停。${day.aiError || day.organizationJob?.error || "请稍后点击 AI 更新小记重试。"}`
            : day?.organizationRequested || day?.organizationStatus === "pending"
              ? `原文已保存，基础整理已完成，后台 AI 整理中${day.organizationJob?.total ? `（已完成 ${day.organizationJob.completed || 0}/${day.organizationJob.total} 段）` : ""}，可以继续记录。`
              : day?.organizationStatus === "organized" ? "AI 整理稿已保存，可与上方原文对照。"
                : day?.manualInputs?.length ? "原文已保存，当前显示基础整理。" : "写下原文后即可整理。"}
        </p>
        <div className="diary-lead-heading">
          <span id="diary-summary-title">一眼看完今天</span>
          <small>
            {day?.synthesisUpdatedAt
              ? `${formatTime(day.synthesisUpdatedAt)} 更新 · ${day.synthesisSource === "llm" ? "AI 整理" : "基础整理"} · 已自动保存`
              : "等待第一次整理"}
          </small>
        </div>
        <MarkdownContent content={displayDiarySummary} />
        <div className="diary-stats" aria-label="今日变化统计">
          <div><strong>{codexSessionCount}</strong><span>段 Codex 对话</span></div>
          <div><strong>{newTodos.length}</strong><span>条新待办</span></div>
          <div><strong>{completedTodos.length}</strong><span>条实际完成</span></div>
          <div><strong>{todoNotes.length}</strong><span>条待办笔记</span></div>
        </div>
      </section>

      <div className="diary-main-grid">
        <section className="diary-card" aria-labelledby="diary-work-title">
          <div className="diary-card-heading">
            <div><Sparkle size={17} weight="fill" /><h2 id="diary-work-title">今天主要做了这些</h2></div>
            <span>{day?.periods?.length || codexResults.length} 项</span>
          </div>
          <div className="diary-card-scroll">
            {day?.periods?.length
              ? <DailyPeriodList periods={day.periods} showTime={false} />
              : codexResults.length
                ? <ul className="diary-plain-list">{codexResults.map((result) => <li key={result}>{result}</li>)}</ul>
                : emptyState("今天还没有形成工作小结", "更新小记后，今天和 Codex 的主要工作会显示在这里。")}
            {!!day?.periods?.length && !!codexResults.length && (
              <details className="diary-evidence">
                <summary>查看 Codex 的实际结果线索 · {codexResults.length}</summary>
                <ul>{codexResults.map((result) => <li key={result}>{result}</li>)}</ul>
              </details>
            )}
          </div>
        </section>

        <section className="diary-card" aria-labelledby="diary-todo-title">
          <div className="diary-card-heading">
            <div><CheckCircle size={17} weight="fill" /><h2 id="diary-todo-title">待办发生了什么</h2></div>
            <span>{newTodos.length + completedTodos.length + todoNotes.length} 条变化</span>
          </div>
          <div className="diary-card-scroll diary-change-list">
            <div className="diary-change-group">
              <strong>今天新记下</strong>
              {newTodos.length
                ? <ul>{newTodos.slice(0, 5).map((todo) => <li key={todo.id}><span>{todo.title}</span>{todo.date !== today && <small>计划 {formatShortDate(todo.date)}</small>}</li>)}</ul>
                : <p>没有新增待办。</p>}
            </div>
            <div className="diary-change-group is-completed">
              <strong>今天实际完成</strong>
              {completedTodos.length
                ? <ul>{completedTodos.slice(0, 5).map((todo) => <li key={todo.id}><span>{todo.title}</span><small>{formatTime(todo.completedAt || "")}</small></li>)}</ul>
                : <p>今天还没有待办被标记为完成。</p>}
            </div>
            <details className="diary-notes" open={false}>
              <summary>今天补充的待办笔记 · {todoNotes.length}</summary>
              {todoNotes.length
                ? <ul>{todoNotes.map(({ todo, comment }) => <li key={comment.id}><strong>{todo.title}</strong><span>{compactExcerpt(comment.content, 120)}</span><small>{formatDateTime(comment.createdAt)}</small></li>)}</ul>
                : <p>今天还没有给待办补充笔记。</p>}
            </details>
          </div>
        </section>
      </div>

      <details className="diary-saved-history">
        <summary>
          <span><ArchiveBox size={18} /><strong>往日小记</strong><small>{pastDiaryDays.length} 天 · 只保留“一眼看完”正文</small></span>
          <CaretDown size={17} />
        </summary>
        <div className="diary-history-scroll">
          {pastDiaryDays.length
            ? pastDiaryDays.map((savedDay) => {
                const savedDate = formatDay(savedDay.date);
                return (
                  <article className="diary-history-item" key={savedDay.date}>
                    <div>
                      <strong>{savedDate.monthDay}</strong>
                      <span>{savedDate.week}</span>
                    </div>
                    <p>{savedDay.summary}</p>
                    <small>{savedDay.synthesisSource === "llm" ? "AI 整理" : "基础整理"}</small>
                  </article>
                );
              })
            : emptyState("还没有往日小记", "今天的内容已经自动保存，明天会出现在这里。")}
        </div>
      </details>

      <details className="diary-legacy-plans">
        <summary>
          <span><ListChecks size={18} /><strong>旧的长期计划</strong><small>{active.length} 项正在推进，默认收起</small></span>
          <CaretDown size={17} />
        </summary>
        <div className="diary-legacy-body">
          <div className="diary-legacy-heading">
            <p>这里保留原来的长期计划，数据不会删除。需要时再展开维护。</p>
            <button className="quiet-button" onClick={onGoJournal}><NotePencil size={16} />记录新的长期计划</button>
          </div>
          <div className="task-toolbar">
            <label className="search-field">
              <span className="sr-only">搜索长期计划</span>
              <TextAlignLeft size={17} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务或项目" />
            </label>
            <div className="segmented-control" aria-label="按负责人筛选">
              {([ ["all", "全部"], ["me", "我来做"], ["ai", "AI 准备"], ["both", "共同"] ] as const).map(([value, label]) => (
                <button key={value} className={owner === value ? "is-active" : ""} onClick={() => setOwner(value)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="task-list large">
            {active.length
              ? active.map((task) => <TaskRow key={task.id} task={task} captures={state.captures} workbench onAction={onAction} />)
              : emptyState("没有符合条件的长期计划", "换一个筛选条件，或记录新的计划。")}
          </div>
          <section className="completed-section">
            <div className="completed-section-header">
              <button className="completed-toggle" onClick={() => setShowDone(!showDone)}>
                {showDone ? <CaretDown /> : <CaretRight />}已完成任务<span>{done.length}</span>
              </button>
              {showDone && done.length > 1 && (
                <label className="completed-history-sort">
                  <span>排序</span>
                  <select aria-label="已完成历史排序" value={completedHistoryOrder} onChange={(event) => updateCompletedHistoryOrder(event.target.value as CompletedHistoryOrder)}>
                    <option value="newest">最新完成优先</option>
                    <option value="oldest">最早完成优先</option>
                  </select>
                </label>
              )}
            </div>
            {showDone && <div className="task-list large">{done.map((task) => <TaskRow key={task.id} task={task} captures={state.captures} workbench onAction={onAction} />)}</div>}
          </section>
        </div>
      </details>
    </main>
  );
}

interface ProposalCardProps {
  proposal: Proposal;
  captures: Capture[];
  onAction: ActionHandler;
}

function ProposalCard({ proposal, captures, onAction }: ProposalCardProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(proposal.title);
  const [detail, setDetail] = useState(proposal.detail || "");
  const citedCaptures = captures.filter((capture) => proposal.captureIds.includes(capture.id));
  const summarizeValue = (value: unknown) => {
    if (value === null || value === undefined || value === "") return "未设置";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };

  return (
    <article className={`proposal-card ${proposal.status === "deferred" ? "is-deferred" : ""}`}>
      <div className="proposal-icon">
        {proposal.type === "task_create" ? (
          <ListChecks weight="duotone" />
        ) : proposal.type === "blocker" ? (
          <WarningCircle weight="duotone" />
        ) : (
          <Sparkle weight="duotone" />
        )}
      </div>
      <div className="proposal-body">
        <div className="proposal-kicker">
          <span>{proposal.type === "task_create" ? "建议创建任务" : proposal.type === "calendar_event" ? "建议安排固定活动" : "建议更新记录"}</span>
          <span>{Math.round(proposal.confidence * 100)}% 把握</span>
        </div>
        {editing ? (
          <div className="proposal-edit-form">
            <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="建议标题" />
            <textarea value={detail} onChange={(event) => setDetail(event.target.value)} aria-label="建议内容" rows={3} />
          </div>
        ) : (
          <>
            <strong>{proposal.title}</strong>
            <p>{proposal.detail || proposal.why}</p>
          </>
        )}
        {!editing && proposal.type === "task_create" && proposal.steps?.length > 0 && (
          <div className="proposal-steps" aria-label="AI 拆分的任务步骤">
            <span>拆分后的步骤</span>
            <ol>
              {proposal.steps.slice(0, 5).map((step, index) => (
                <li key={`${proposal.id}-step-${index}`}>{step.title}</li>
              ))}
            </ol>
          </div>
        )}
        {!editing && proposal.nextAction && (
          <div className="proposal-next-action">
            <span>下一步</span>
            <strong>{proposal.nextAction}</strong>
          </div>
        )}
        {(proposal.confirmationQuestion || proposal.uncertaintyReason) && (
          <p className="proposal-uncertainty">需要你决定：{proposal.confirmationQuestion || proposal.uncertaintyReason}</p>
        )}
        {(proposal.before !== undefined || proposal.after !== undefined) && (
          <div className="proposal-compare">
            {proposal.before !== undefined && <span>原来：{summarizeValue(proposal.before)}</span>}
            {proposal.after !== undefined && <span>改为：{summarizeValue(proposal.after)}</span>}
          </div>
        )}
        <div className="proposal-meta">
          <span>{ownerLabels[proposal.owner]}</span>
          {proposal.project && <span>{proposal.project}</span>}
          {proposal.dueDate && <span>截止 {formatShortDate(proposal.dueDate)}</span>}
          {proposal.status === "deferred" && <span>已暂缓</span>}
        </div>
        {citedCaptures.length > 0 && (
          <details className="proposal-sources">
            <summary>查看依据 · {citedCaptures.length} 条原文</summary>
            {citedCaptures.slice(0, 4).map((capture) => (
              <p key={capture.id}><time>{formatTime(capture.occurredAt)}</time>{capture.content}</p>
            ))}
          </details>
        )}
      </div>
      <div className="proposal-actions">
        {editing ? (
          <>
            <button
              className="primary-button small"
              disabled={!title.trim()}
              onClick={() => onAction("proposal.editApply", {
                proposalId: proposal.id,
                patch: { title: title.trim(), detail: detail.trim() },
              })}
            >
              <Check size={16} weight="bold" />修改后采用
            </button>
            <button className="quiet-button" onClick={() => setEditing(false)}>取消</button>
          </>
        ) : (
          <>
            <button
              className="primary-button small"
              onClick={() => proposal.status === "deferred"
                ? onAction("proposal.editApply", { proposalId: proposal.id, patch: {} })
                : onAction("proposal.apply", { proposalId: proposal.id })}
            >
              <Check size={16} weight="bold" />采用
            </button>
            <button className="quiet-button" onClick={() => setEditing(true)}>修改</button>
            {proposal.status === "pending" && (
              <button className="quiet-button" onClick={() => onAction("proposal.defer", { proposalId: proposal.id })}>暂缓</button>
            )}
            <button
              className="quiet-button"
              onClick={() => onAction("proposal.reject", { proposalId: proposal.id })}
            >
              <X size={16} />忽略
            </button>
          </>
        )}
      </div>
    </article>
  );
}

interface RecordsViewProps {
  state: NotebookState;
  onAction: ActionHandler;
}

function RecordsView({ state, onAction }: RecordsViewProps) {
  const [activeSection, setActiveSection] = useState<"archive" | "trash">("archive");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [kind, setKind] = useState("all");
  const [period, setPeriod] = useState("7");
  const [visibleCount, setVisibleCount] = useState(60);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const cutoff = period === "all" ? 0 : Date.now() - Number(period) * 86400000;
  const captures = [...state.captures]
    .filter((capture) => !capture.trashedAt && !capture.deletedAt)
    .filter((capture) => source === "all" || capture.source === source)
    .filter((capture) => {
      if (kind === "all") return true;
      if (kind === "user") return ["user_prompt", "note", "import"].includes(capture.kind);
      if (kind === "assistant") return capture.kind.startsWith("assistant_");
      return capture.kind === kind;
    })
    .filter((capture) => !cutoff || new Date(capture.occurredAt).getTime() >= cutoff)
    .filter((capture) => `${capture.content} ${capture.sessionId} ${capture.cwd}`.toLowerCase().includes(query.toLowerCase()))
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());
  const trashItems = [
    ...state.captures.filter((capture) => capture.trashedAt && !capture.deletedAt).map((capture) => ({
      id: capture.id,
      entityType: "capture" as const,
      title: capture.organizedContent || capture.content,
      trashedAt: capture.trashedAt || "",
      purgeAt: capture.purgeAt || "",
      source: sourceLabel(capture.source),
    })),
    ...state.dailyTasks.filter((todo) => todo.trashedAt && !todo.deletedAt).map((todo) => ({
      id: todo.id,
      entityType: "today_todo" as const,
      title: todo.title,
      trashedAt: todo.trashedAt || "",
      purgeAt: todo.purgeAt || "",
      source: "今日待办",
    })),
  ].sort((left, right) => Date.parse(right.trashedAt) - Date.parse(left.trashedAt));
  const remainingDays = (purgeAt: string) => Math.max(0, Math.ceil((Date.parse(purgeAt) - Date.now()) / 86400000));
  useEffect(() => setVisibleCount(60), [query, source, kind, period]);

  return (
    <main className="wide-view records-view">
      <header className="view-header">
        <div className="eyebrow muted"><ArchiveBox size={16} />{captures.length} 条可追溯记录</div>
        <h1 title="查找系统保存的原始输入和 Codex 记录，核对 AI 结果的来源，或重新分析旧内容。">数据档案</h1>
      </header>
      <div className="records-tabs" role="tablist" aria-label="数据档案分类">
        <button className={activeSection === "archive" ? "is-active" : ""} onClick={() => setActiveSection("archive")}>已归档 · {captures.length}</button>
        <button className={activeSection === "trash" ? "is-active" : ""} onClick={() => setActiveSection("trash")}>垃圾箱 · {trashItems.length}</button>
      </div>
      {activeSection === "archive" ? <>
      <div className="records-toolbar">
        <label className="search-field">
          <TextAlignLeft size={17} />
          <input aria-label="搜索原始记录" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索原文、会话或项目路径" />
        </label>
        <select aria-label="来源筛选" value={source} onChange={(event) => setSource(event.target.value)}>
          <option value="all">全部来源</option>
          <option value="codex">Codex</option>
          <option value="manual">手动输入</option>
          <option value="import">文件导入</option>
        </select>
        <select aria-label="消息类型筛选" value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="all">全部类型</option>
          <option value="user">用户输入</option>
          <option value="assistant">AI 可见输出</option>
          <option value="task_started">任务开始</option>
          <option value="task_complete">任务结束</option>
        </select>
        <select aria-label="日期筛选" value={period} onChange={(event) => setPeriod(event.target.value)}>
          <option value="1">最近 1 天</option>
          <option value="7">最近 7 天</option>
          <option value="14">最近 14 天</option>
          <option value="all">全部时间</option>
        </select>
      </div>
      <div className="records-summary">当前筛选 {captures.length} 条 · 原始内容与 AI 整理结果分开保存</div>
      <div className="records-list">
        {captures.slice(0, visibleCount).map((capture) => {
          const links = state.sourceLinks.filter((link) => link.captureId === capture.id);
          const isExpanded = expanded.has(capture.id);
          return (
            <article className="record-row" key={capture.id}>
              <div className="record-row-head">
                <div>
                  <span className={`source-chip source-${capture.source}`}>{sourceLabel(capture.source)}</span>
                  <span className="record-kind">{capture.kind === "assistant_commentary" ? "AI 可见进度" : capture.kind === "assistant_result" ? "AI 最终回答" : capture.kind === "user_prompt" ? "用户输入" : capture.kind}</span>
                  <time>{new Date(capture.occurredAt).toLocaleString("zh-CN", { hour12: false })}</time>
                </div>
                <div className="record-actions">
                  {capture.actionable && (
                    <button className="text-button" onClick={() => void onAction("capture.reanalyze", { captureId: capture.id })}>重新分析</button>
                  )}
                  <button
                    className="text-button danger-text-button"
                    onClick={() => {
                      if (window.confirm("把这条记录移到垃圾箱？15 天内可以恢复。")) void onAction("capture.delete", { captureId: capture.id });
                    }}
                  >
                    移到垃圾箱
                  </button>
                  <button className="text-button" onClick={() => setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(capture.id)) next.delete(capture.id); else next.add(capture.id);
                    return next;
                  })}>{isExpanded ? "收起" : "展开原文"}</button>
                </div>
              </div>
              <p className={isExpanded ? "is-expanded" : ""}>{capture.content}</p>
              <div className="record-trace">
                <span>{capture.sessionId ? `会话 ${capture.sessionId.slice(0, 12)}` : "手动记录"}</span>
                {links.length > 0 ? <span>已关联 {links.length} 个任务或笔记</span> : <span>尚无派生内容</span>}
              </div>
            </article>
          );
        })}
        {!captures.length && emptyState("没有符合条件的记录", "可以调整搜索或筛选条件。")}
        {captures.length > visibleCount && (
          <button className="secondary-button records-more" onClick={() => setVisibleCount((count) => count + 60)}>
            再显示 {Math.min(60, captures.length - visibleCount)} 条
          </button>
        )}
      </div>
      </> : <div className="records-list trash-list">
        <p className="records-summary">垃圾箱内容保留 15 天，到期后自动清除。</p>
        {trashItems.map((item) => (
          <article className="record-row trash-row" key={`${item.entityType}-${item.id}`}>
            <div>
              <span className="record-kind">{item.source}</span>
              <strong>{item.title}</strong>
              <small>{remainingDays(item.purgeAt)} 天后清除</small>
            </div>
            <button className="secondary-button" onClick={() => void onAction("trash.restore", { entityType: item.entityType, entityId: item.id, expectedPurgeAt: item.purgeAt })}>
              <ArrowCounterClockwise size={16} />恢复
            </button>
          </article>
        ))}
        {!trashItems.length && emptyState("垃圾箱是空的", "移除的今日待办和数据档案会在这里保留 15 天。")}
      </div>}
    </main>
  );
}

interface SettingsViewProps {
  state: NotebookState;
  onAction: ActionHandler;
  onImport: (file: File) => Promise<void>;
  onCloudRefresh: () => Promise<DesktopCloudSyncResult | null>;
}

interface DesktopCloudSyncResult {
  connected: boolean;
  pulled: number;
  pushed: number;
  conflicts: number;
  lastSyncAt: string;
  uploadPending?: boolean;
  receivePending?: boolean;
}

interface DesktopCloudStatus {
  connected: boolean;
  endpoint?: string;
  pairedAt?: string;
  lastSyncAt?: string;
  disabled?: boolean;
  localOnly?: boolean;
  error?: string;
}

const backgroundCloudSyncDelayMs = 700;
const backgroundCloudFocusThrottleMs = 3000;

function actionChangesSyncedUserContent(actionName: string): boolean {
  return (actionName.startsWith("todayTodo.") && actionName !== "todayTodo.dismissSuggestion")
    || actionName.startsWith("capture.")
    || actionName.startsWith("task.")
    || [
      "proposal.apply",
      "proposal.editApply",
      "proposal.applyAll",
      "trash.restore",
      "undo",
      "data.import",
      "diary.organizeInput",
      "diary.appendInput",
      "timeline.rebuild",
    ].includes(actionName);
}

interface DesktopHomeStatus {
  enabled: boolean;
  port: number;
  localUrl: string;
  publicUrl?: string;
  token?: string;
  tunnel: {
    configured: boolean;
    connected: boolean;
    state: string;
    lastError?: string;
    lastConnectedAt?: string;
    publicEndpoint?: string;
    relayBaseUrl?: string;
    homeId?: string;
  };
}

function SettingsView({ state, onAction, onImport, onCloudRefresh }: SettingsViewProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [cloudEndpoint, setCloudEndpoint] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [cloudStatus, setCloudStatus] = useState<DesktopCloudStatus>({ connected: false });
  const [cloudStatusLoaded, setCloudStatusLoaded] = useState(false);
  const [cloudMessage, setCloudMessage] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const [homeStatus, setHomeStatus] = useState<DesktopHomeStatus | null>(null);
  const [homeRelayBaseUrl, setHomeRelayBaseUrl] = useState("");
  const [homeId, setHomeId] = useState("");
  const [homeTunnelToken, setHomeTunnelToken] = useState("");
  const [homeMessage, setHomeMessage] = useState("");
  const [homeBusy, setHomeBusy] = useState(false);
  const desktopBridgeAvailable = cloudSyncUiEnabled && Boolean(window.mainlineCloud);
  const desktopHomeAvailable = Boolean(window.mainlineHome);
  const codexReadable = state.status.codexHistoryAvailable;
  const codexConnectionLabel = state.status.hookInstalled
    ? "实时记录"
    : codexReadable
      ? "可读取"
      : "未找到";
  const codexConnectionTitle = state.status.hookInstalled
    ? "新的 Codex 对话会自动进入灵光一现"
    : codexReadable
      ? "已找到本机 Codex 对话"
      : "尚未找到本机 Codex 对话";
  const homeRemoteConnected = Boolean(homeStatus?.tunnel.connected || homeStatus?.publicUrl);
  const syncConnectionLabel = cloudStatus.connected
    ? "云端已连接"
    : homeRemoteConnected
      ? "手机直连已就绪"
      : cloudStatusLoaded
        ? "尚未连接"
        : "正在读取";
  const updateSetting = (patch: Record<string, unknown>) =>
    onAction("settings.update", { patch });

  const readCloudStatus = async () => {
    if (!cloudSyncUiEnabled) return { connected: false } as DesktopCloudStatus;
    let status: DesktopCloudStatus;
    if (window.mainlineCloud) {
      status = await window.mainlineCloud.status();
    } else {
      const response = await fetch("/api/runtime-status", { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取桌面同步状态");
      const runtime = await response.json() as { cloudSync?: DesktopCloudStatus };
      status = runtime.cloudSync || { connected: false };
    }
    setCloudStatus(status);
    setCloudStatusLoaded(true);
    if (status.endpoint) setCloudEndpoint(status.endpoint);
    return status;
  };

  useEffect(() => {
    void readCloudStatus().catch(() => setCloudStatusLoaded(true));
  }, []);

  useEffect(() => {
    if (!window.mainlineHome) return;
    window.mainlineHome.status().then((status) => {
      setHomeStatus(status);
      setHomeRelayBaseUrl(status.tunnel.relayBaseUrl || "");
      setHomeId(status.tunnel.homeId || "");
    }).catch(() => {});
  }, []);

  const refreshHomeStatus = async () => {
    if (!window.mainlineHome) return null;
    const status = await window.mainlineHome.status();
    setHomeStatus(status);
    setHomeRelayBaseUrl(status.tunnel.relayBaseUrl || "");
    setHomeId(status.tunnel.homeId || "");
    return status;
  };

  const refreshConnectionStatus = async () => {
    setHomeBusy(true);
    setHomeMessage("");
    try {
      await Promise.all([
        readCloudStatus(),
        window.mainlineHome ? refreshHomeStatus() : Promise.resolve(null),
      ]);
      setHomeMessage("连接状态已更新。");
    } catch (error) {
      setHomeMessage(error instanceof Error ? error.message : "连接状态读取失败");
    } finally {
      setHomeBusy(false);
    }
  };

  const configureHomeTunnel = async () => {
    if (!window.mainlineHome) return;
    setHomeBusy(true);
    setHomeMessage("");
    try {
      const status = await window.mainlineHome.configureTunnel({
        relayBaseUrl: homeRelayBaseUrl,
        homeId,
        tunnelToken: homeTunnelToken,
      });
      setHomeStatus(status);
      setHomeTunnelToken("");
      setHomeMessage(status.tunnel.connected ? "手机直连入口已连接。" : "连接信息已保存，正在建立手机直连。" );
    } catch (error) {
      setHomeMessage(error instanceof Error ? error.message : "远程入口连接失败");
    } finally {
      setHomeBusy(false);
    }
  };

  const restartHomeTunnel = async () => {
    if (!window.mainlineHome) return;
    setHomeBusy(true);
    setHomeMessage("");
    try {
      const status = await window.mainlineHome.restartTunnel();
      setHomeStatus(status);
      setHomeMessage(status.tunnel.connected ? "家庭同步已恢复。" : "正在重新连接家庭同步。" );
    } catch (error) {
      setHomeMessage(error instanceof Error ? error.message : "重新连接失败");
    } finally {
      setHomeBusy(false);
    }
  };

  const copyHomeConnection = async () => {
    if (!homeStatus?.publicUrl || !homeStatus.token) return;
    await navigator.clipboard.writeText(`家庭同步地址：${homeStatus.publicUrl}\n设备连接凭证：${homeStatus.token}`);
    setHomeMessage("手机连接信息已复制。只发送给你自己的设备。" );
  };

  const pairCloud = async () => {
    if (!window.mainlineCloud) {
      setCloudMessage("请使用桌面版主线笔记完成配对。");
      return;
    }
    setCloudBusy(true);
    setCloudMessage("");
    try {
      const status = await window.mainlineCloud.pair({ endpoint: cloudEndpoint, pairCode });
      setCloudStatus(status);
      setPairCode("");
      const result = await onCloudRefresh();
      if (result) {
        setCloudStatus((current) => ({ ...current, connected: true, lastSyncAt: result.lastSyncAt }));
        setCloudMessage(describeDesktopCloudSync(result, { initial: true }));
      }
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : "配对失败");
    } finally {
      setCloudBusy(false);
    }
  };

  const syncCloud = async () => {
    if (!window.mainlineCloud) return;
    setCloudBusy(true);
    setCloudMessage("");
    try {
      const result = await onCloudRefresh();
      if (result) {
        setCloudStatus((current) => ({ ...current, connected: true, lastSyncAt: result.lastSyncAt }));
        setCloudMessage(describeDesktopCloudSync(result));
      }
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : "同步失败");
    } finally {
      setCloudBusy(false);
    }
  };

  return (
    <main className="wide-view settings-view">
      <header className="view-header">
        <div className="eyebrow muted"><GearSix size={16} />连接、自动化与隐私</div>
        <h1 title="默认选择少打扰、可撤销。自动化只在新内容出现时工作。">设置与连接</h1>
      </header>

      <section className="settings-card settings-focus-card">
        <div className="settings-card-heading">
          <div className="settings-icon data-icon"><User size={22} weight="duotone" /></div>
          <div className="settings-card-heading-copy">
            <h2>微信账号与电脑登录</h2>
            <p>当前笔记继续保存在本机。需要更换账号时，再打开扫码登录窗口。</p>
          </div>
        </div>
        <div className="connection-overview">
          <div className="connection-overview-copy">
            <strong>扫码登录不会打断当前使用</strong>
            <p>只有你点击下面按钮后，才会打开独立的微信扫码窗口；当前“今日小记”和“灵光一现”数据不会自动改变。</p>
          </div>
          <div className="settings-button-row">
            <button
              className="primary-button"
              disabled={!window.mainlineAccounts}
              onClick={() => void window.mainlineAccounts?.switchAccount()}
            >
              <User size={17} />打开微信扫码登录
            </button>
          </div>
        </div>
      </section>

      <section className="settings-card settings-focus-card codex-connection-card">
        <div className="settings-card-heading">
          <div className="settings-icon codex-icon"><Cpu size={22} weight="duotone" /></div>
          <div className="settings-card-heading-copy">
            <h2 title="每次发送内容和一次回答结束时，自动写入本地收件箱。">Codex 对话接入</h2>
            <p>把本机对话变成可搜索、可整理的灵光一现</p>
          </div>
          <span className={`connection-pill ${state.status.hookInstalled || codexReadable ? "is-connected" : ""}`}>
            {codexConnectionLabel}
          </span>
        </div>
        <div className="connection-overview codex-overview">
          <div className="connection-overview-copy">
            <strong>{codexConnectionTitle}</strong>
            <p>只保留你的提问和 Codex 最终回答，不保存推理过程、工具输出和密钥。</p>
          </div>
          <div className="connection-metrics" aria-label="Codex 接入状态">
            <div><strong>{state.status.cleanTranscriptFiles}</strong><span>个会话</span></div>
            <div><strong>{state.status.queuedHookEvents}</strong><span>条待导入</span></div>
            <div>
              <strong>{state.status.lastHistoryScanAt ? formatUpdatedLabel(state.status.lastHistoryScanAt) : "尚未"}</strong>
              <span>最近读取</span>
            </div>
          </div>
        </div>
        <div className="settings-command-bar codex-command-bar">
          <label className="settings-compact-switch">
            <span>
              <strong title="打开工作笔记时只补录新增的可见消息，并自动去重。">自动读取新对话</strong>
              <small>打开工作笔记时检查新增内容</small>
            </span>
            <input
              className="switch"
              type="checkbox"
              checked={state.settings.autoScanCodexHistory}
              onChange={(event) => updateSetting({ autoScanCodexHistory: event.target.checked })}
            />
          </label>
          <label className="settings-compact-field">
            <span>回看范围</span>
            <select
              aria-label="Codex 回看范围"
              value={state.settings.codexHistoryLookbackDays}
              onChange={(event) => updateSetting({ codexHistoryLookbackDays: Number(event.target.value) })}
            >
              <option value={1}>最近 1 天</option>
              <option value={3}>最近 3 天</option>
              <option value={7}>最近 7 天</option>
              <option value={14}>最近 14 天</option>
            </select>
          </label>
          <button
            className="secondary-button"
            disabled={!state.status.codexHistoryAvailable}
            onClick={() => onAction("codex.scanRecent")}
          >
            <ArrowCounterClockwise size={17} />
            立即读取新增对话
          </button>
        </div>
        <details className="settings-advanced">
          <summary><CaretRight className="settings-advanced-caret" size={16} />路径与保存范围</summary>
          <div className="settings-advanced-content">
            <label className="settings-row settings-row-wide settings-path-row">
              <span>
                <strong title="只读取 JSONL，不修改原始 sessions。">Codex 日志目录</strong>
                <small>只读取这个目录，不会修改原始会话文件</small>
              </span>
              <input
                className="path-input"
                aria-label="Codex 日志目录"
                defaultValue={state.settings.codexSessionsDir}
                onBlur={(event) => updateSetting({ codexSessionsDir: event.target.value })}
              />
            </label>
            <div className="settings-detail-grid settings-compact-grid">
              <div><span>实时钩子</span><strong>{state.status.hookInstalled ? "已安装" : "未安装，使用历史读取"}</strong></div>
              <div><span>保存内容</span><strong>提问与最终回答</strong></div>
              <div><span>纯净副本</span><strong>{state.status.cleanTranscriptFiles} 个会话文件</strong></div>
            </div>
            <div className="safety-message">
              <ShieldCheck size={18} weight="duotone" />
              原始 sessions 保持不动。纯净副本保存在 {state.status.cleanTranscriptPath}。
            </div>
          </div>
        </details>
      </section>

      <section className="settings-card settings-focus-card device-sync-card">
        <div className="settings-card-heading">
          <div className="settings-icon data-icon"><ArrowCounterClockwise size={22} weight="duotone" /></div>
          <div className="settings-card-heading-copy">
            <h2 title="打开手机或电脑时同步一次，也可以随时手动同步刷新。">手机与电脑同步</h2>
            <p>{cloudStatus.connected
              ? "CloudBase 已连接，传输精简后的跨端数据"
              : "电脑本地数据正常保存，连接云端后可与小程序同步"}</p>
          </div>
          <span className={`connection-pill ${cloudStatus.connected || homeRemoteConnected ? "is-connected" : ""}`}>
            {syncConnectionLabel}
          </span>
        </div>
        <div className="connection-overview sync-overview">
          <div className="connection-overview-copy">
            <strong>
              {cloudStatus.connected
                  ? "手机与电脑已连接到同一个 CloudBase 工作区"
                  : homeRemoteConnected
                  ? "手机通过 HTTPS 连接这台电脑"
                  : desktopHomeAvailable
                    ? `电脑端 ${homeStatus?.port || 4430} 已就绪`
                    : "同步由桌面程序自动管理"}
            </strong>
            <p>
              {cloudStatus.connected
                ? `${cloudStatus.lastSyncAt ? `最近同步 ${formatUpdatedLabel(cloudStatus.lastSyncAt)}。` : "云端连接已经配置。"}修改后会合并同步，重新回到窗口时会轻量检查，也可以随时手动刷新。`
                : homeRemoteConnected
                ? "修改会通知另一端；断网时先保存在本机，恢复连接后自动补齐。"
                : desktopHomeAvailable
                  ? "本机记录已经可以正常使用。手机直连尚未配置时，不会影响电脑端保存。"
                  : "浏览器只负责显示。保持“主线笔记”桌面程序运行，连接和数据恢复由桌面程序处理。"}
            </p>
          </div>
          <div className="connection-metrics sync-metrics sync-status-metrics">
            <div><strong>{cloudStatus.connected ? "已连接" : "未连接"}</strong><span>CloudBase</span></div>
            <div><strong>{cloudStatus.lastSyncAt ? formatUpdatedLabel(cloudStatus.lastSyncAt) : "尚未"}</strong><span>最近同步</span></div>
            <div><strong>{homeStatus?.port || 4430}</strong><span>电脑端口</span></div>
          </div>
        </div>

        {(desktopHomeAvailable || cloudStatusLoaded) && (
          <div className="settings-button-row sync-action-row">
            {cloudStatus.connected && Boolean(window.mainlineCloud) && (
              <button className="secondary-button" disabled={cloudBusy} onClick={syncCloud}>
                <ArrowCounterClockwise size={17} />同步刷新
              </button>
            )}
            {desktopHomeAvailable && homeStatus?.tunnel.configured && (
              <button className="secondary-button" disabled={homeBusy} onClick={restartHomeTunnel}>
                <ArrowCounterClockwise size={17} />重新连接家庭同步
              </button>
            )}
            {desktopHomeAvailable && homeStatus?.publicUrl && homeStatus?.token && (
              <button className="secondary-button" disabled={homeBusy} onClick={copyHomeConnection}>
                复制手机连接信息
              </button>
            )}
            <button className="quiet-button" disabled={homeBusy} onClick={() => void refreshConnectionStatus()}>
              检查连接状态
            </button>
          </div>
        )}

        <details className="settings-advanced sync-setup">
          <summary><CaretRight className="settings-advanced-caret" size={16} />连接方式与高级设置</summary>
          <div className="settings-advanced-content sync-advanced-content">
            {desktopHomeAvailable && (
              <section className="sync-method-block">
                <div className="sync-method-heading">
                  <div><strong>手机直连</strong><span>通过 HTTPS 访问当前电脑的 4430 服务</span></div>
                  <span className={`connection-pill ${homeRemoteConnected ? "is-connected" : ""}`}>
                    {homeRemoteConnected ? "远程已连接" : "仅本机"}
                  </span>
                </div>
                <div className="settings-detail-grid settings-compact-grid home-status-grid">
                  <div><span>本机地址</span><strong>{homeStatus?.localUrl || "http://127.0.0.1:4430"}</strong></div>
                  <div><span>手机地址</span><strong>{homeStatus?.publicUrl || "尚未配置"}</strong></div>
                  <div><span>连接状态</span><strong>{homeStatus?.tunnel.connected ? "在线" : homeStatus?.tunnel.configured ? "等待连接" : "未配置"}</strong></div>
                </div>
                <div className="settings-row-stack home-tunnel-fields">
                  <label>
                    <span>固定中继地址</span>
                    <input value={homeRelayBaseUrl} onChange={(event) => setHomeRelayBaseUrl(event.target.value)} placeholder="https://你的中继服务" />
                  </label>
                  <label>
                    <span>这台电脑的 ID</span>
                    <input value={homeId} onChange={(event) => setHomeId(event.target.value)} placeholder="例如 mainline-home" />
                  </label>
                  <label>
                    <span>中继连接凭证</span>
                    <input type="password" value={homeTunnelToken} onChange={(event) => setHomeTunnelToken(event.target.value)} placeholder={homeStatus?.tunnel.configured ? "已安全保存，留空即可沿用" : "至少 32 个字符"} />
                  </label>
                </div>
                <div className="settings-button-row">
                  <button className="secondary-button" disabled={homeBusy || !homeRelayBaseUrl || !homeId} onClick={configureHomeTunnel}>
                    保存并连接
                  </button>
                  <button className="quiet-button" disabled={!homeStatus?.publicUrl || !homeStatus?.token} onClick={copyHomeConnection}>
                    复制手机连接信息
                  </button>
                </div>
                {homeStatus?.tunnel.lastError && <div className="runtime-message">{homeStatus.tunnel.lastError}</div>}
              </section>
            )}

            {desktopBridgeAvailable && (
              <section className="sync-method-block">
                <div className="sync-method-heading">
                  <div><strong>CloudBase 云端同步</strong><span>适合长期在线和多设备使用</span></div>
                  <span className={`connection-pill ${cloudStatus.connected ? "is-connected" : ""}`}>
                    {cloudStatus.connected ? "已连接" : "未连接"}
                  </span>
                </div>
                {!cloudStatus.connected ? (
                  <>
                    <label className="settings-row settings-row-wide settings-path-row">
                      <span><strong>CloudBase 同步地址</strong></span>
                      <input className="path-input" value={cloudEndpoint} onChange={(event) => setCloudEndpoint(event.target.value)} placeholder="https://.../desktopSync" />
                    </label>
                    <label className="settings-row settings-pair-row">
                      <span><strong>六位配对码</strong><small>仅首次连接云端时使用</small></span>
                      <input aria-label="六位配对码" value={pairCode} onChange={(event) => setPairCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="000000" />
                    </label>
                    <div className="settings-button-row">
                      <button className="primary-button" disabled={cloudBusy || pairCode.length !== 6 || !cloudEndpoint} onClick={pairCloud}>连接云端</button>
                    </div>
                  </>
                ) : (
                  <div className="settings-button-row">
                    <button
                      className="quiet-button"
                      disabled={cloudBusy}
                      onClick={async () => {
                        await window.mainlineCloud?.disconnect();
                        setCloudStatus({ connected: false });
                        setCloudMessage("已断开此电脑，云端数据没有删除。");
                      }}
                    >
                      断开云端同步
                    </button>
                  </div>
                )}
              </section>
            )}
          </div>
        </details>
        <div className="safety-message sync-safety-message">
          <ShieldCheck size={18} weight="duotone" />
          启动、重新回到窗口以及成功修改内容后按需增量同步，不会在后台持续轮询消耗额度。
        </div>
        {homeMessage && <div className="runtime-message">{homeMessage}</div>}
        {cloudMessage && <div className="runtime-message">{cloudMessage}</div>}
      </section>

      <section className="settings-card">
        <div className="settings-card-heading">
          <div className="settings-icon ai-icon"><Sparkle size={22} weight="duotone" /></div>
          <div>
            <h2 title="可使用本机 Codex 或 DeepSeek API；不可用时自动退回本地规则。">AI 整理方式</h2>
          </div>
          <span className={`connection-pill ${state.status.aiAvailable ? "is-connected" : ""}`}>
            {state.status.aiAvailable ? "可用" : "规则模式"}
          </span>
        </div>
        <div className="settings-rows">
          <label className="settings-row">
            <span>
              <strong title="先提取事实与任务，再按完整当天证据生成阶段总结；不会直接删除现有任务。">整理引擎</strong>
            </span>
            <select
              value={state.settings.aiMode}
              onChange={(event) => updateSetting({ aiMode: event.target.value })}
            >
              <option value="codex">Codex AI</option>
              <option value="deepseek" disabled={!state.status.deepseekConfigured}>
                DeepSeek API{state.status.deepseekConfigured ? "" : "（尚未配置密钥）"}
              </option>
              <option value="rules">仅本地规则</option>
            </select>
          </label>
          {state.settings.aiMode === "deepseek" && (
            <label className="settings-row">
              <span>
                <strong title="密钥只从本地服务环境读取，不保存在网页数据中。">DeepSeek 模型</strong>
              </span>
              <select
                value={state.settings.deepseekModel}
                onChange={(event) => updateSetting({ deepseekModel: event.target.value })}
              >
                <option value="deepseek-v4-flash">V4 Flash</option>
                <option value="deepseek-v4-pro">V4 Pro</option>
              </select>
            </label>
          )}
          {state.settings.aiMode === "deepseek" && (
            <label className="settings-row settings-row-wide">
              <span><strong title="密钥仍只从环境变量读取。">兼容 API 地址</strong></span>
              <input className="path-input" defaultValue={state.settings.providerApiBase} onBlur={(event) => updateSetting({ providerApiBase: event.target.value })} />
            </label>
          )}
          <label className="settings-row">
            <span><strong title="结构错误或超时时会自动重试。">失败重试次数</strong></span>
            <select value={state.settings.retryCount} onChange={(event) => updateSetting({ retryCount: Number(event.target.value) })}>
              <option value={0}>不重试</option><option value={1}>重试 1 次</option><option value={2}>重试 2 次</option>
            </select>
          </label>
          {state.settings.aiMode === "deepseek" && (
            <div className="safety-message external-ai-notice">
              <WarningCircle size={18} weight="duotone" />
              选择 DeepSeek 后，本次新输入、当天已确认事件、任务状态和日程会发送到 DeepSeek API，用于分别生成任务更新与每日阶段总结。
            </div>
          )}
          <label className="settings-row">
            <span>
              <strong title="没有新内容时不会重复运行，也不会产生无意义的自动任务。">打开网页时自动整理新内容</strong>
            </span>
            <input
              className="switch"
              type="checkbox"
              checked={state.settings.autoOrganize}
              onChange={(event) => updateSetting({ autoOrganize: event.target.checked })}
            />
          </label>
          <label className="settings-row">
            <span>
              <strong title="AI 或整理规则判断为高优先级的新待办，会进入最高级置顶，普通置顶不会超过它。">优先待办自动置顶</strong>
              <small>始终排在普通置顶之前；关闭后新待办仍显示“优先处理”，但不再自动置顶。</small>
            </span>
            <input
              className="switch"
              type="checkbox"
              checked={state.settings.autoPinHighPriorityTodos}
              onChange={(event) => updateSetting({ autoPinHighPriorityTodos: event.target.checked })}
            />
          </label>
          {planPreviewUiEnabled && (
            <label className="settings-row">
              <span>
                <strong title="首次打开当天页面时，根据剩余任务生成一次，可预览后调整。">自动生成今日建议</strong>
              </span>
              <input
                className="switch"
                type="checkbox"
                checked={state.settings.autoPlanOnFirstOpen}
                onChange={(event) =>
                  updateSetting({ autoPlanOnFirstOpen: event.target.checked })
                }
              />
            </label>
          )}
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-card-heading">
          <div className="settings-icon data-icon"><Clock size={22} weight="duotone" /></div>
          <div><h2 title="运行中的服务会按时处理；错过的日期在下次打开时补跑。">每日自动更新</h2></div>
          <span className={`connection-pill ${state.settings.autoUpdateEnabled ? "is-connected" : ""}`}>{state.settings.autoUpdateEnabled ? "运行中" : "已暂停"}</span>
        </div>
        <div className="settings-detail-grid runtime-grid">
          <div><span>最近同步</span><strong>{state.status.lastSyncAt ? formatUpdatedLabel(state.status.lastSyncAt) : "尚未运行"}</strong></div>
          <div><span>最近 AI</span><strong>{state.status.lastAiRunAt ? formatUpdatedLabel(state.status.lastAiRunAt) : "尚未运行"}</strong></div>
          <div><span>最近处理</span><strong>{state.status.lastAiProcessedCount} 条</strong></div>
          <div><span>当前模型</span><strong>{state.settings.aiMode === "deepseek" ? state.settings.deepseekModel : state.settings.aiMode === "codex" ? "Codex" : "本地规则"}</strong></div>
          <div><span>下次执行</span><strong>{state.status.nextRunAt ? new Date(state.status.nextRunAt).toLocaleString("zh-CN", { hour12: false }) : "已暂停"}</strong></div>
        </div>
        <div className="settings-rows">
          <label className="settings-row">
            <span><strong title="自动扫描、整理、延续任务并生成计划预览。">启用每日自动更新</strong></span>
            <input className="switch" type="checkbox" checked={state.settings.autoUpdateEnabled} onChange={(event) => updateSetting({ autoUpdateEnabled: event.target.checked })} />
          </label>
          <label className="settings-row">
            <span><strong title="默认凌晨 00:00。">每天运行时间</strong></span>
            <input type="time" value={state.settings.dailyRunTime} onChange={(event) => updateSetting({ dailyRunTime: event.target.value })} />
          </label>
        </div>
        <div className="settings-button-row">
          <button className="primary-button" onClick={() => onAction("daily.runNow")}><ArrowCounterClockwise size={17} />立即同步并整理今天</button>
        </div>
        <div className={`runtime-message ${state.status.lastError ? "has-error" : ""}`}>
          {state.status.lastError ? `最近错误：${state.status.lastError}` : `最近扫描 ${state.status.scannedFileCount} 个文件，导入错误 ${state.status.importErrorCount} 个。`}
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-card-heading">
          <div className="settings-icon data-icon"><ArchiveBox size={22} weight="duotone" /></div>
          <div>
            <h2 title="导出完整备份，或导入旧版工作台与聊天记录。">本地数据</h2>
          </div>
        </div>
        <div className="data-path">
          <span>数据位置</span>
          <code>{state.status.dataPath}</code>
        </div>
        <div className="settings-button-row">
          <button className="secondary-button" onClick={downloadExport}>
            <CloudArrowDown size={17} />
            导出完整备份
          </button>
          <button className="secondary-button" onClick={() => fileRef.current?.click()}>
            <UploadSimple size={17} />
            导入数据或聊天
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            accept=".json,.txt,.md"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onImport(file);
              event.target.value = "";
            }}
          />
        </div>
      </section>
    </main>
  );
}

interface PlanPreviewDrawerProps {
  preview: PlanPreview;
  tasks: Task[];
  onAction: ActionHandler;
}

function PlanPreviewDrawer({ preview, tasks, onAction }: PlanPreviewDrawerProps) {
  return (
    <div className="drawer-backdrop" role="presentation">
      <aside className="plan-drawer" role="dialog" aria-modal="true" aria-labelledby="preview-title">
        <div className="drawer-header">
          <div>
            <div className="eyebrow"><MagicWand size={16} weight="fill" />AI 计划预览</div>
            <h2 id="preview-title">先看方案，再决定是否采用</h2>
            <p>{preview.reason}</p>
          </div>
          <button
            className="icon-button"
            onClick={() => onAction("plan.cancel")}
            aria-label="关闭计划预览"
          >
            <X size={20} />
          </button>
        </div>
        <div className="preview-sessions">
          {preview.sessions.map((session) => {
            const task = tasks.find((item) => item.id === session.taskId);
            return (
              <div className="preview-session" key={session.id}>
                <span className="preview-time">
                  {minutesToTime(session.startMinutes)}
                  <ArrowRight size={14} />
                  {minutesToTime(session.startMinutes + session.durationMinutes)}
                </span>
                <div>
                  <strong>{session.title}</strong>
                  <span>{task?.why || "安排一段完整时间推进下一步"}</span>
                </div>
                <span className={`owner-chip owner-${session.owner}`}>
                  {ownerIcon(session.owner)}
                  {ownerLabels[session.owner]}
                </span>
              </div>
            );
          })}
        </div>
        <div className="drawer-note">
          <ShieldCheck size={18} weight="duotone" />
          采用后仍可直接拖动时间块，或使用顶部“撤销”恢复。
        </div>
        <div className="drawer-actions">
          <button className="secondary-button" onClick={() => onAction("plan.cancel")}>
            保留原计划
          </button>
          <button className="primary-button" onClick={() => onAction("plan.confirm")}>
            <Check size={17} weight="bold" />
            采用这个安排
          </button>
        </div>
      </aside>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="loading-screen" role="status">
      <BookOpenText size={31} weight="duotone" />
      <CircleNotch className="spin" size={22} />
      <strong>正在打开你的工作笔记</strong>
      <span>同步本地记录与新的 Codex 对话</span>
    </div>
  );
}

function LocalDataRecovery({ error, onRetry }: { error: Error; onRetry: () => Promise<void> }) {
  const [files, setFiles] = useState<RecoveryFile[]>([]);
  const [directory, setDirectory] = useState("");
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [message, setMessage] = useState("");
  const loadFiles = useCallback(async () => {
    setLoading(true); setMessage("");
    try {
      const manifest = await getLocalRecovery();
      setFiles(manifest.files || []); setDirectory(manifest.directory || "");
    } catch (loadError) {
      setMessage(loadError instanceof Error ? loadError.message : "暂时无法读取恢复文件列表。");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void loadFiles(); }, [loadFiles]);
  const retry = async () => {
    setRetrying(true); setMessage("");
    try { await onRetry(); }
    catch (retryError) { setMessage(retryError instanceof Error ? retryError.message : "数据仍无法读取，请先导出原文件。"); }
    finally { setRetrying(false); }
  };
  return (
    <main className="loading-screen local-recovery-screen" role="alert">
      <WarningCircle size={34} weight="duotone" />
      <strong>暂时无法打开这份笔记</strong>
      <span>{error.message}</span>
      <p>原始文件没有被自动清空。先导出当前文件或备份，再恢复；测试版不会拿空白数据覆盖它。</p>
      {directory && <small className="recovery-directory">数据目录：{directory}</small>}
      <div className="recovery-actions">
        <button className="primary-button" type="button" onClick={() => void retry()} disabled={retrying}>
          {retrying ? "正在重新读取…" : "重新读取"}
        </button>
        <button className="secondary-button" type="button" onClick={() => void loadFiles()} disabled={loading}>
          {loading ? "正在检查文件…" : "刷新文件列表"}
        </button>
      </div>
      {loading ? <span>正在检查可导出的原始文件…</span> : files.length ? (
        <div className="recovery-file-list">
          {files.map((file) => (
            <a key={file.name} className="recovery-file" href={localRecoveryDownloadUrl(file.name)} download={file.name}>
              <span>{file.name}{file.current ? "（当前文件）" : "（备份候选）"}</span>
              <small>{file.bytes.toLocaleString()} 字节 · 下载原始文件</small>
            </a>
          ))}
        </div>
      ) : <span>当前目录没有可识别的 notebook 文件，请保留整个目录后再处理。</span>}
      {message && <p className="cloud-auth-message" role="status">{message}</p>}
    </main>
  );
}

function CloudSignIn({ onReady }: { onReady: () => void }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setMessage("");
    try {
      await sendMagicLink(email);
      setMessage("登录链接已发送。请在邮箱中打开它，随后会回到这个工作台。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录邮件暂时无法发送。");
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (completeAuthRedirect() || getAccessToken()) onReady();
  }, [onReady]);

  return (
    <main className="cloud-auth-shell">
      <section className="cloud-auth-card">
        <div className="cloud-auth-mark"><BookOpenText size={28} weight="duotone" /></div>
        <p className="eyebrow">PRIVATE BETA</p>
        <h1 title="这是你的私有智能工作笔记本。登录后，每个账号只会看到自己的记录。">主线笔记</h1>
        <form onSubmit={submit} className="cloud-auth-form">
          <label htmlFor="cloud-email">受邀请的邮箱</label>
          <input
            id="cloud-email"
            type="email"
            autoComplete="email"
            placeholder="name@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <button className="primary-button" type="submit" disabled={sending}>
            {sending ? "正在发送…" : "发送登录链接"}
          </button>
        </form>
        <p className="cloud-auth-note">云端不会扫描你的本机 Codex 聊天记录；只有你主动输入或导入的内容会进入这个工作区。</p>
        {message && <p className="cloud-auth-message" role="status">{message}</p>}
      </section>
    </main>
  );
}

export function App() {
  const [state, setState] = useState<NotebookState | null>(null);
  const [dataError, setDataError] = useState<Error | null>(null);
  const activeDataScope = useRef<string | undefined>(undefined);
  const activeAction = useRef('');
  useEffect(() => { activeDataScope.current = state?.status.dataScope; }, [state?.status.dataScope]);
  const applyState = useCallback((next: NotebookState) => setState((current) => selectNewerState(current, next)), []);
  const [authChecked, setAuthChecked] = useState(false);
  const [cloudReady, setCloudReady] = useState(true);
  const [view, setView] = useState<ViewName>("todos");
  const [busy, setBusy] = useState("");
  useEffect(() => { activeAction.current = ''; setBusy(''); }, [state?.status.dataScope]);
  const [toast, setToastText] = useState("");
  const [toastError, setToastError] = useState(false);
  const setToast = useCallback((message: string, kind: 'ok' | 'error' = 'ok') => {
    setToastText(message); setToastError(kind === 'error');
  }, []);
  const [cloudRefreshBusy, setCloudRefreshBusy] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [sidebarDrag, setSidebarDrag] = useState<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const autoOrganizeBatch = useRef("");
  const backgroundCloudSyncTimer = useRef<number | null>(null);
  const lastBackgroundCloudSyncAt = useRef(Date.now());

  useEffect(() => {
    window.localStorage.setItem(sidebarWidthStorageKey, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    if (!sidebarDrag) return;

    const updateSidebarWidth = (event: PointerEvent) => {
      if (event.pointerId !== sidebarDrag.pointerId) return;
      setSidebarWidth(clampSidebarWidth(sidebarDrag.startWidth + event.clientX - sidebarDrag.startX));
    };
    const finishSidebarDrag = (event: PointerEvent) => {
      if (event.pointerId === sidebarDrag.pointerId) setSidebarDrag(null);
    };

    window.addEventListener("pointermove", updateSidebarWidth);
    window.addEventListener("pointerup", finishSidebarDrag);
    window.addEventListener("pointercancel", finishSidebarDrag);
    return () => {
      window.removeEventListener("pointermove", updateSidebarWidth);
      window.removeEventListener("pointerup", finishSidebarDrag);
      window.removeEventListener("pointercancel", finishSidebarDrag);
    };
  }, [sidebarDrag]);

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarCollapsed || window.innerWidth <= 900) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSidebarDrag({ pointerId: event.pointerId, startX: event.clientX, startWidth: sidebarWidth });
  }, [sidebarCollapsed, sidebarWidth]);

  const refresh = useCallback(async () => {
    const next = await getState();
    applyState(next);
    return next;
  }, [applyState]);

  const syncCloudSilently = useCallback(async (throttle = false) => {
    if (!cloudSyncUiEnabled || !window.mainlineCloud) return;
    const startedAt = Date.now();
    if (throttle && startedAt - lastBackgroundCloudSyncAt.current < backgroundCloudFocusThrottleMs) return;
    lastBackgroundCloudSyncAt.current = startedAt;
    try {
      const status = await window.mainlineCloud.status();
      if (!status.connected) return;
      await window.mainlineCloud.sync();
      await refresh();
    } catch {
      // Background sync is best-effort. Local writes are already durable and a
      // later focus, manual refresh or startup sync will retry without a toast.
    }
  }, [refresh]);

  const scheduleBackgroundCloudSync = useCallback(() => {
    if (backgroundCloudSyncTimer.current !== null) {
      window.clearTimeout(backgroundCloudSyncTimer.current);
    }
    backgroundCloudSyncTimer.current = window.setTimeout(() => {
      backgroundCloudSyncTimer.current = null;
      void syncCloudSilently();
    }, backgroundCloudSyncDelayMs);
  }, [syncCloudSilently]);

  const dataScope = state?.status.dataScope;
  useEffect(() => {
    if (!authChecked || !cloudReady || !dataScope || cloudAuthEnabled()) return;
    let disposed = false;
    let refreshing = false;
    let dirty = false;
    const refreshLocal = async () => {
      dirty = true;
      if (refreshing) return;
      refreshing = true;
      try {
        while (dirty && !disposed) {
          dirty = false;
          const next = await getState();
          if (!disposed && next.status.dataScope === dataScope) applyState(next);
        }
      } catch { /* A reconnect or the next local change retries this local read. */ }
      finally { refreshing = false; }
    };
    // This stream is local-only. Progress wakes the page, not CloudBase.
    const stream = new EventSource('/api/events');
    stream.onmessage = (message) => {
      if (disposed) return;
      try {
        const event = JSON.parse(message.data);
        void refreshLocal();
        if (['diary-organization', 'annotation-organization', 'journal-organization'].includes(event.type) && event.contentChanged) scheduleBackgroundCloudSync();
      } catch { /* Ignore incomplete event frames. */ }
    };
    return () => { disposed = true; stream.close(); };
  }, [authChecked, cloudReady, dataScope, applyState, scheduleBackgroundCloudSync]);

  useEffect(() => {
    const syncWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (backgroundCloudSyncTimer.current !== null) {
        window.clearTimeout(backgroundCloudSyncTimer.current);
        backgroundCloudSyncTimer.current = null;
      }
      void syncCloudSilently(true);
    };
    window.addEventListener("focus", syncWhenVisible);
    document.addEventListener("visibilitychange", syncWhenVisible);
    return () => {
      window.removeEventListener("focus", syncWhenVisible);
      document.removeEventListener("visibilitychange", syncWhenVisible);
      if (backgroundCloudSyncTimer.current !== null) {
        window.clearTimeout(backgroundCloudSyncTimer.current);
        backgroundCloudSyncTimer.current = null;
      }
    };
  }, [syncCloudSilently]);

  useEffect(() => {
    if (!cloudSyncUiEnabled || !window.mainlineCloud?.onRemoteApplied) return;
    return window.mainlineCloud.onRemoteApplied(() => {
      // The main process has already pulled and merged the remote mutation.
      // This refresh reads only the local notebook server, without CloudBase use.
      void refresh();
    });
  }, [refresh]);

  const syncCloudNow = useCallback(async (): Promise<DesktopCloudSyncResult | null> => {
    if (cloudRefreshBusy) return null;
    setCloudRefreshBusy(true);
    try {
      if (!cloudSyncUiEnabled || !window.mainlineCloud) {
        await refresh();
        setToast("已从电脑本地数据刷新。");
        return null;
      }
      const status = await window.mainlineCloud.status();
      if (!status.connected) {
        await refresh();
        throw new Error("这台电脑尚未连接手机，请先在“设置与连接”中完成连接。");
      }
      const result = await window.mainlineCloud.sync();
      await refresh();
      const conflictNote = result.conflicts ? `，${result.conflicts} 项需要稍后重试` : "";
      setToast(`本次同步收到 ${result.pulled} 项，上传 ${result.pushed} 项${conflictNote}。`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "同步刷新没有完成";
      setToast(message);
      return null;
    } finally {
      setCloudRefreshBusy(false);
    }
  }, [cloudRefreshBusy, refresh]);

  useEffect(() => {
    void loadCloudAuthConfig()
      .then((cloudEnabled) => {
        setCloudReady(!cloudEnabled || completeAuthRedirect() || Boolean(getAccessToken()));
      })
      .catch((error: Error) => setToast(error.message))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!authChecked || !cloudReady) return;
    void refresh().catch((error: Error) => {
      if (cloudAuthEnabled() && "status" in error && (error as { status?: number }).status === 401) {
        clearAccessToken();
        setCloudReady(false);
        return;
      }
      setDataError(error);
    });
  }, [authChecked, cloudReady, refresh]);

  useEffect(() => {
    if (!state || !state.settings.autoOrganize) return;
    const expectedDataScope = activeDataScope.current;
    const unprocessed = state.captures.filter((capture) => capture.status === "unprocessed");
    if (!unprocessed.length) return;
    const batchKey = unprocessed.map((capture) => capture.id).sort().join("|");
    if (autoOrganizeBatch.current === batchKey) return;
    autoOrganizeBatch.current = batchKey;
    setBusy("正在整理新出现的内容");
    void organizeCaptures(unprocessed.map((capture) => capture.id))
      .then((next) => {
        if (activeDataScope.current !== expectedDataScope || next.status.dataScope !== expectedDataScope) return;
        applyState(next);
        scheduleBackgroundCloudSync();
        setToast(`已整理 ${unprocessed.length} 条新内容`);
      })
      .catch((error: Error) => {
        if (activeDataScope.current === expectedDataScope) setToast(`自动整理暂时没有完成：${error.message}`);
      })
      .finally(() => {
        if (activeDataScope.current === expectedDataScope) setBusy("");
      });
  }, [applyState, scheduleBackgroundCloudSync, state]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const action = useCallback(
    async (actionName: string, payload: Record<string, unknown> = {}) => {
      const expectedDataScope = typeof payload.expectedDataScope === 'string' ? payload.expectedDataScope : activeDataScope.current;
      const isCurrent = () => !expectedDataScope || activeDataScope.current === expectedDataScope;
      const actionId = crypto.randomUUID();
      activeAction.current = actionId;
      const labels: Record<string, string> = {
        "plan.preview": "正在生成可调整的计划",
        "plan.confirm": "正在采用新的安排",
        "daily.replan": "正在重新理解今天的变化并安排后续时间",
        "timeline.rebuild": "正在读取今天的 Codex 对话并整理小记",
        "diary.organizeInput": "正在保存并整理今日小记",
        "diary.appendInput": "正在保存原文",
        "diary.refresh": "原文已保存，AI 正在整理",
        "todayTodo.add": "正在加入今日待办",
        "todayTodo.adoptSuggestion": "正在采用 Codex 候选",
        "todayTodo.dismissSuggestion": "正在忽略这条候选",
        "todayTodo.commentAdd": "AI 正在整理并保存笔记",
        "todayTodo.commentDelete": "正在删除笔记",
        "todayTodo.togglePin": "正在更新置顶",
        "todayTodo.complete": "正在标记完成",
        "todayTodo.defer": "正在顺延到明天",
        "todayTodo.delete": "正在移到垃圾箱",
        "trash.restore": "正在恢复",
        "capture.add": "正在保存",
        "capture.setFavorite": "正在更新收藏",
        "capture.refreshTitle": "AI 正在根据原记录和笔记检查标题",
        "capture.annotationAdd": "正在保存笔记",
        "capture.annotationDelete": "正在删除笔记",
        "codex.scanRecent": "正在扫描本机最近的 Codex 对话",
        "data.import": "正在导入",
        "proposal.applyAll": "正在采用全部 AI 建议",
      };
      setBusy(labels[actionName] ?? "");
      try {
        const next = await performAction(actionName, { ...payload, ...(expectedDataScope ? { expectedDataScope } : {}) });
        if (!isCurrent() || expectedDataScope && next.status.dataScope !== expectedDataScope) {
          throw new ApiError('数据空间已切换，旧请求的结果已隔离', 409);
        }
        setState((current) => typeof payload.expectedDataScope === 'string' && current?.status.dataScope !== payload.expectedDataScope
          ? current : selectNewerState(current, next));
        if (actionChangesSyncedUserContent(actionName)) scheduleBackgroundCloudSync();
        const messages: Record<string, string> = {
          "capture.add": cloudAuthEnabled() ? "原文已保存到当前账号" : "原文已保存到本机，等待同步",
          "capture.setFavorite": "收藏状态已更新",
          "capture.refreshTitle": "标题已重新检查",
          "capture.annotationAdd": "笔记已保存",
          "capture.annotationDelete": "笔记已删除",
          "task.toggleDone": "任务状态已更新",
          "task.update": "进度已保存",
          "todayTodo.add": "已加入今日待办",
          "todayTodo.adoptSuggestion": "已加入今日待办",
          "todayTodo.dismissSuggestion": "已忽略这条候选",
          "todayTodo.commentAdd": "笔记已保存",
          "todayTodo.commentDelete": "笔记已删除",
          "todayTodo.togglePin": "今日待办置顶状态已更新",
          "todayTodo.complete": "这件事已完成",
          "todayTodo.defer": "已顺延到明天的待办",
          "todayTodo.delete": "已移到垃圾箱，15 天内可恢复",
          "plan.confirm": "今天的安排已更新",
          "daily.replan": "已生成新的今日安排，请先确认再采用",
          "timeline.rebuild": "今日小记已更新",
          "diary.organizeInput": "原文已保存，基础整理已完成，后台 AI 整理已安排",
          "diary.appendInput": "原文已保存到本机，基础整理已完成",
          "diary.refresh": "原文已保留，后台整理已安排",
          "proposal.apply": "建议已经写入主线",
          "proposal.applyAll": "已收到采用结果",
          "proposal.reject": "这条建议已忽略，原文仍然保留",
          "capture.delete": "记录已移到垃圾箱，15 天内可恢复",
          "trash.restore": "已恢复",
          undo: "已经撤销上一步修改",
          "data.import": "内容已安全导入",
        };
        if (actionName === "codex.scanRecent") {
          setToast(
            next.status.recentHistoryImported
              ? `已补录 ${next.status.recentHistoryImported} 条内容，并更新纯净对话副本`
              : "已经检查并更新纯净对话副本，没有发现尚未补录的新内容",
          );
        } else if (actionName === 'proposal.applyAll') {
          const result = next.meta.lastProposalDecision;
          setToast(result && result.requestId === payload.requestId
            ? `已采用 ${result.applied} 条${result.failed ? `，${result.failed} 条待处理` : '，已保存到本机'}`
            : '采用结果尚未确认，请保留原选择后重试', result?.failed || result?.requestId !== payload.requestId ? 'error' : 'ok');
        } else if (messages[actionName]) setToast(messages[actionName]);
        return next;
      } catch (error) {
        if (isCurrent()) setToast(error instanceof Error ? error.message : "操作没有完成", 'error');
        throw error;
      } finally {
        if (isCurrent() && activeAction.current === actionId) setBusy("");
      }
    },
    [applyState, scheduleBackgroundCloudSync],
  );

  const organize = useCallback(async (captureIds?: string[]) => {
    const expectedDataScope = activeDataScope.current;
    setBusy("Codex 正在理解上下文");
    try {
      const next = await organizeCaptures(captureIds);
      if (activeDataScope.current !== expectedDataScope || next.status.dataScope !== expectedDataScope) return;
      applyState(next);
      scheduleBackgroundCloudSync();
      const pending = next.proposals.filter((proposal) => proposal.status === "pending" && proposalNeedsReview(proposal)).length;
      setToast(pending ? `整理完成，有 ${pending} 条重要变化需要你确认` : "整理完成，有用信息已自动归档");
    } catch (error) {
      if (activeDataScope.current === expectedDataScope) setToast(error instanceof Error ? error.message : "AI 整理没有完成");
    } finally {
      if (activeDataScope.current === expectedDataScope) setBusy("");
    }
  }, [applyState, scheduleBackgroundCloudSync]);

  const handleImport = useCallback(async (file: File) => {
    const expectedDataScope = activeDataScope.current;
    setBusy("正在读取并导入");
    try {
      const next = await importData(file);
      if (activeDataScope.current !== expectedDataScope || next.status.dataScope !== expectedDataScope) return;
      applyState(next);
      scheduleBackgroundCloudSync();
      setToast(`${file.name} 已导入，原始内容已保留`);
    } catch (error) {
      if (activeDataScope.current === expectedDataScope) setToast(error instanceof Error ? error.message : "文件没有成功导入");
    } finally {
      if (activeDataScope.current === expectedDataScope) setBusy("");
    }
  }, [applyState, scheduleBackgroundCloudSync]);

  const content = useMemo(() => {
    if (!state) return null;
    if (view === "todos") return <TodayTodoView state={state} onAction={action} />;
    if (view === "tasks") {
      return (
        <DailyDiaryView
          key={state.status.dataScope || "unbound"}
          state={state}
          onAction={action}
          onGoJournal={() => setView("journal")}
        />
      );
    }
    if (view === "inbox") {
      return (
        <JournalView
          state={state}
          busy={busy}
          onAction={action}
          onOrganize={organize}
          onImport={handleImport}
        />
      );
    }
    if (view === "records") {
      return <RecordsView state={state} onAction={action} />;
    }
    if (view === "settings") {
      return (
        <SettingsView
          state={state}
          onAction={action}
          onImport={handleImport}
          onCloudRefresh={syncCloudNow}
        />
      );
    }
    return (
      <JournalView
        state={state}
        busy={busy}
        onAction={action}
        onOrganize={organize}
        onImport={handleImport}
      />
    );
  }, [action, busy, handleImport, organize, state, syncCloudNow, view]);

  if (!authChecked) return <LoadingScreen />;
  if (!cloudReady) return <CloudSignIn onReady={() => setCloudReady(true)} />;
  if (!state) return dataError
    ? <LocalDataRecovery error={dataError} onRetry={async () => { const next = await refresh(); setDataError(null); applyState(next); }} />
    : <LoadingScreen />;

  return (
    <div
      className={`app-shell${sidebarDrag ? " is-resizing" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <Sidebar
        state={state}
        view={view}
        setView={setView}
        collapsed={sidebarCollapsed}
        setCollapsed={setSidebarCollapsed}
      />
      {!sidebarCollapsed && (
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左侧导航栏宽度"
          title="拖动以调整左侧导航栏宽度"
          onPointerDown={startSidebarResize}
        />
      )}
      <div className="app-main">
        <Topbar
          state={state}
          view={view}
          busy={busy}
          onUndo={() => void action("undo")}
          onCloudRefresh={async () => { await syncCloudNow(); }}
          cloudRefreshBusy={cloudRefreshBusy}
          desktopBridgeAvailable={cloudSyncUiEnabled && Boolean(window.mainlineCloud)}
        />
        <div className="view-scroll"><JournalScopeContext.Provider key={dataScope || 'unbound'} value={dataScope || 'unbound'}>{content}</JournalScopeContext.Provider></div>
      </div>
      {planPreviewUiEnabled && state.pendingPlan && (
        <PlanPreviewDrawer
          preview={state.pendingPlan}
          tasks={state.tasks}
          onAction={action}
        />
      )}
      {toast && (
        <div className={`toast ${toastError ? 'is-error' : ''}`} role="status">
          {toastError ? <WarningCircle size={19} weight="fill" /> : <CheckCircle size={19} weight="fill" />}
          {toast}
        </div>
      )}
    </div>
  );
}
