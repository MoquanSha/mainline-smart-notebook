export type Owner = "me" | "ai" | "both";
export type Priority = "high" | "normal" | "low";
export type TaskStatus =
  | "planned"
  | "active"
  | "blocked"
  | "waiting"
  | "verifying"
  | "done"
  | "archived";
export type CaptureSource = "manual" | "codex" | "import" | "wechat_official" | "wecom";
export type TaskStepStatus = "pending" | "current" | "done";
export type ProgressType = "percentage" | "stage" | "checklist";
export type TaskStage = "planning" | "preparing" | "executing" | "verifying" | "stable";
export type TimelineKind =
  | "capture"
  | "plan"
  | "progress"
  | "result"
  | "decision"
  | "blocker"
  | "note";

export interface Task {
  id: string;
  deletedAt?: string;
  title: string;
  project: string;
  owner: Owner;
  priority: Priority;
  status: TaskStatus;
  progress: number;
  startDate: string;
  dueDate: string;
  estimatedMinutes: number;
  nextAction: string;
  steps: TaskStep[];
  currentStepId: string;
  why: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  sourceCaptureIds: string[];
  description?: string;
  progressType?: ProgressType;
  currentStage?: TaskStage;
  importance?: "important" | "not_important";
  urgency?: "urgent" | "not_urgent";
  lastActivityAt?: string;
  completionCriteria?: string;
  version?: number;
}

export interface TaskStep {
  id: string;
  title: string;
  owner: Owner;
  status: TaskStepStatus;
  order: number;
  startDate: string;
  dueDate: string;
  estimatedMinutes: number;
  completedAt: string;
}

export interface Capture {
  id: string;
  deletedAt?: string;
  source: CaptureSource;
  kind:
    | "user_prompt"
    | "assistant_commentary"
    | "assistant_result"
    | "task_started"
    | "task_complete"
    | "note"
    | "import";
  content: string;
  occurredAt: string;
  /** The local calendar day chosen for a journal entry, which may differ from occurredAt. */
  journalDate?: string;
  sessionId: string;
  turnId: string;
  cwd: string;
  status: "unprocessed" | "processed" | "ignored";
  messageId?: string;
  contentHash?: string;
  actionable?: boolean;
  /** A lightly formatted reading copy. `content` always remains the untouched source. */
  organizedContent?: string;
  rawContent?: string;
  organizationStatus?: "original" | "lightly_organized" | "ai_organized" | "organized" | "fallback" | "pending" | "failed";
  organizationRequested?: boolean;
  organizationHost?: 'desktop';
  organizationJob?: DayRecord['organizationJob'];
  aiError?: string;
  organizationSummary?: string;
  /** A concise, searchable title generated from the source record and its notes. */
  journalTitle?: string;
  journalTitleUpdatedAt?: string;
  journalTitleSource?: "codex" | "deepseek" | "rules";
  updatedAt?: string;
  version?: number;
  checklistItems?: Array<{
    id: string;
    text: string;
    checked: boolean;
  }>;
  annotations?: JournalAnnotation[];
  /** Kept in the journal's prominent favourites shelf until explicitly removed. */
  favoritedAt?: string;
  /** Hidden from the journal timeline without deleting the source record. */
  hiddenAt?: string;
  trashedAt?: string;
  purgeAt?: string;
  trashOrigin?: string;
}

export interface JournalAnnotation {
  id: string;
  kind: "evaluation" | "note";
  content: string;
  /** Untouched input retained for recovery; the UI displays `content`. */
  rawContent?: string;
  organizedBy?: "codex" | "deepseek" | "rules";
  organizationStatus?: "organized" | "fallback" | "pending" | "failed";
  organizationRequested?: boolean;
  organizationJob?: DayRecord['organizationJob'];
  aiError?: string;
  deletedAt?: string;
  trashedAt?: string;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  title: string;
  detail: string;
  occurredAt: string;
  source: CaptureSource | "ai";
  taskId: string;
  captureId: string;
  supersededBy?: string;
}

export interface SessionBlock {
  id: string;
  taskId: string;
  title: string;
  startMinutes: number;
  durationMinutes: number;
  owner: Owner;
  status: "planned" | "done" | "skipped" | "postponed" | "removed";
  fixed?: boolean;
  scheduleType?: "flexible" | "preparation" | "travel" | "event";
  sourceCaptureIds?: string[];
  originalSuggestion?: {
    startMinutes: number;
    durationMinutes: number;
    title: string;
  };
  planningTrackId?: string;
  planRationale?: string;
}

export interface TodoComment {
  id: string;
  content: string;
  createdAt: string;
  rawContent?: string;
  organizedBy?: "codex" | "deepseek" | "rules";
  organizationStatus?: "organized" | "fallback";
  attachments?: TodoCommentAttachment[];
}

export interface TodoCommentAttachment {
  id: string;
  fileName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  size: number;
  relativePath?: string;
  fileID?: string;
  cloudPath?: string;
  previewUrl?: string;
  deletedAt?: string;
  createdAt: string;
}

export interface DailyTask {
  id: string;
  deletedAt?: string;
  entryKind?: "today_todo";
  date: string;
  title: string;
  description: string;
  source: "long_term" | "conversation" | "manual" | "scheduled" | "carry_over" | "verification" | "profile";
  relatedTaskId: string;
  estimatedMinutes: number;
  tier: "core" | "normal" | "optional";
  priority: Priority;
  status: "planned" | "done" | "skipped" | "postponed";
  completionCriteria: string;
  suggestedStartTime: string;
  requiresConfirmation: boolean;
  sourceCaptureIds: string[];
  fixedStartTime?: string;
  scheduleType?: "flexible" | "preparation" | "travel" | "event";
  planningTrackId?: string;
  planRationale?: string;
  completedAt?: string;
  proposedAt?: string;
  scheduledFor?: string;
  carriedFromId?: string;
  deferredTo?: "tomorrow";
  rawInput?: string;
  sourceCaptureId?: string;
  sourceSuggestionId?: string;
  comments?: TodoComment[];
  pinned?: boolean;
  priorityPinned?: boolean;
  pinnedAt?: string;
  sortRank?: number;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  trashedAt?: string;
  purgeAt?: string;
  trashOrigin?: string;
}

export interface TodayTodoSuggestion {
  id: string;
  captureId: string;
  title: string;
  evidence: string;
  occurredAt: string;
  reason: string;
}

export interface PlanningTrack {
  id: string;
  title: string;
  goal: string;
  milestone: string;
  nextAction: string;
  weeklyCadence: string;
  active: boolean;
  priority: number;
  keywords: string[];
  sourceLabel: string;
  rationale: string;
  aiPreparation: string;
}

export interface PlanningProfile {
  summary: string;
  updatedAt: string;
  tracks: PlanningTrack[];
}

export type DailyPeriodStatus = "completed" | "in_progress" | "blocked";

export interface DailyPeriodSummary {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  title: string;
  summary: string;
  status: DailyPeriodStatus;
  outcomes: string[];
  remaining: string[];
  sourceEventIds: string[];
  sourceCaptureIds: string[];
}

export interface DayRecord {
  organizationRequested?: boolean;
  organizationJob?: { id?: string; status: "pending" | "running" | "failed" | "complete"; reviewId?: string; reviewHost?: 'desktop' | 'cloud'; generation?: number; completed?: number; total?: number; error?: string; errorCode?: string; retryable?: boolean; automaticRetry?: boolean; retryAfter?: number };
  aiError?: string;
  organizationStatus?: "pending" | "organized" | "fallback" | "failed";
  inputRevision?: string;
  organizationRevision?: string;
  date: string;
  deletedAt?: string;
  headline: string;
  summary: string;
  planReason: string;
  taskIds: string[];
  sessions: SessionBlock[];
  eventIds: string[];
  reflection: string;
  tomorrowNote: string;
  isClosed: boolean;
  periods?: DailyPeriodSummary[];
  synthesisSource?: "rules" | "llm";
  synthesisUpdatedAt?: string;
  manualInputs?: Array<{
    id: string;
    content: string;
    createdAt: string;
    source: "desktop" | "wechat" | "mobile";
  }>;
}

export interface Proposal {
  id: string;
  version?: number;
  taskBaseVersion?: number;
  deletedAt?: string;
  type:
    | "task_create"
    | "task_update"
    | "decision"
    | "achievement"
    | "blocker"
    | "note"
    | "calendar_event";
  title: string;
  detail: string;
  taskId: string;
  project: string;
  owner: Owner;
  priority: Priority;
  importance?: "important" | "not_important";
  urgency?: "urgent" | "not_urgent";
  progress: number;
  dueDate: string;
  startDate: string;
  nextAction: string;
  steps: Array<{
    title: string;
    owner: Owner;
    startDate: string;
    dueDate: string;
    estimatedMinutes: number;
  }>;
  why: string;
  confidence: number;
  status: "pending" | "applied" | "rejected" | "deferred" | "filtered";
  captureIds: string[];
  createdAt: string;
  uncertaintyReason?: string;
  requiresConfirmation?: boolean;
  userIntent?:
    | "explicit_action"
    | "explicit_update"
    | "fixed_event"
    | "completed_result"
    | "decision"
    | "blocker"
    | "background"
    | "question"
    | "product_instruction"
    | "cancelled";
  suggestedHandling?: "ask_user" | "auto_apply" | "record_only" | "ignore";
  usefulness?: number;
  confirmationQuestion?: string;
  filterReason?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  model?: string;
  promptVersion?: string;
  eventDate?: string;
  eventTime?: string;
  eventEndTime?: string;
  departureTime?: string;
  preparationMinutes?: number;
  eventDurationMinutes?: number;
  supersededBy?: string;
}

export interface PlanPreview {
  id: string;
  createdAt: string;
  reason: string;
  taskIds: string[];
  sessions: SessionBlock[];
  dailyTasks?: DailyTask[];
}

export interface NotebookSettings {
  aiMode: "codex" | "deepseek" | "rules";
  aiModel: string;
  deepseekModel: string;
  autoOrganize: boolean;
  autoPinHighPriorityTodos: boolean;
  autoPlanOnFirstOpen: boolean;
  autoScanCodexHistory: boolean;
  codexHistoryLookbackDays: number;
  captureCodex: boolean;
  redactSecrets: boolean;
  workdayStart: number;
  workdayEnd: number;
  dailyCapacityMinutes: number;
  codexSessionsDir: string;
  autoUpdateEnabled: boolean;
  dailyRunTime: string;
  providerApiBase: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
  retryCount: number;
}

export interface NotebookStatus {
  dataScope?: string;
  serverOnline: boolean;
  hookInstalled: boolean;
  hookTrusted: boolean | null;
  codexCliAvailable: boolean;
  aiAvailable: boolean;
  deepseekConfigured: boolean;
  codexHistoryAvailable: boolean;
  lastHistoryScanAt: string;
  recentHistoryImported: number;
  queuedHookEvents: number;
  lastCaptureAt: string;
  dataPath: string;
  cleanTranscriptPath: string;
  cleanTranscriptFiles: number;
  scannedFileCount: number;
  importErrorCount: number;
  lastAiRunAt: string;
  lastAiProcessedCount: number;
  nextRunAt: string;
  lastError: string;
  lastSyncAt: string;
}

export interface SourceLink {
  id: string;
  entityType: "task" | "daily_note" | "daily_task" | "timeline" | "proposal";
  entityId: string;
  captureId: string;
  createdAt: string;
}

export interface SourceFileState {
  path: string;
  modifiedAt: number;
  size: number;
  fileHash: string;
  lastScannedAt: string;
  importedCount: number;
  error: string;
}

export interface SyncRun {
  id: string;
  trigger: "startup" | "manual" | "scheduled" | "backfill";
  startedAt: string;
  finishedAt: string;
  status: "running" | "success" | "failed";
  scannedFiles: number;
  importedMessages: number;
  processedMessages: number;
  error: string;
}

export interface AiRun {
  id: string;
  taskType: string;
  provider: string;
  model: string;
  promptVersion: string;
  startedAt: string;
  finishedAt: string;
  status: "running" | "success" | "failed" | "fallback";
  inputCount: number;
  outputCount: number;
  retryCount: number;
  error: string;
}

export interface AppError {
  id: string;
  type: "scan" | "jsonl" | "llm" | "storage" | "scheduler" | "source";
  message: string;
  occurredAt: string;
  resolved: boolean;
}

export interface NotebookState {
  meta: {
    lastProposalDecision?: ProposalDecision;
    localRevision?: number;
    schemaVersion: number;
    createdAt: string;
    updatedAt: string;
    lastOpenedDate: string;
    dismissedTodayTodoSuggestionIds?: string[];
  };
  tasks: Task[];
  captures: Capture[];
  timeline: TimelineEvent[];
  days: DayRecord[];
  proposals: Proposal[];
  dailyTasks: DailyTask[];
  todoSuggestions?: TodayTodoSuggestion[];
  sourceLinks: SourceLink[];
  sourceFileStates: SourceFileState[];
  syncRuns: SyncRun[];
  aiRuns: AiRun[];
  errors: AppError[];
  pendingPlan: PlanPreview | null;
  planningProfile: PlanningProfile;
  settings: NotebookSettings;
  processedHookEventIds: string[];
  processedCodexMessageIds: string[];
  actionHistory: Array<{
    id: string;
    label: string;
    at: string;
  }>;
  status: NotebookStatus;
}

export interface ProposalDecision {
  requestId: string;
  applied: number;
  failed: number;
  results: Array<{ id: string; ok: boolean; error?: { code: string; message: string } }>;
}

export type ViewName = "journal" | "todos" | "tasks" | "inbox" | "records" | "settings";
