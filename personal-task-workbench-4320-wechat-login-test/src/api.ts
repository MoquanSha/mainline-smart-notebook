import type { NotebookState, TodoCommentAttachment } from "./types";
import { getAccessToken } from "./auth";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code = "",
    public retryable = false,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getAccessToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  }).catch(() => { throw new ApiError('连接暂时中断，请稍后重试', 0); });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(
      payload?.error ?? `请求失败（${response.status}）`,
      response.status,
      String(payload?.code || ""),
      Boolean(payload?.retryable),
    );
  }

  return response.json() as Promise<T>;
}

export type RecoveryFile = { name: string; bytes: number; modifiedAt: string; current: boolean };
export type RecoveryManifest = { directory: string; files: RecoveryFile[]; build?: { version?: string; releaseSet?: string } };

export async function getLocalRecovery(): Promise<RecoveryManifest> {
  return request<RecoveryManifest>("/api/local-recovery");
}

export function localRecoveryDownloadUrl(name: string): string {
  return `/api/local-recovery/file?name=${encodeURIComponent(name)}`;
}

function visibleState(state: NotebookState): NotebookState {
  return {
    ...state,
    tasks: state.tasks.filter((item) => !item.deletedAt),
    captures: state.captures.filter((item) => !item.deletedAt),
    proposals: state.proposals.filter((item) => !item.deletedAt),
    dailyTasks: state.dailyTasks.filter((item) => !item.deletedAt),
    days: state.days.filter((item) => !item.deletedAt),
  };
}

export async function getState(): Promise<NotebookState> {
  return visibleState(await request<NotebookState>("/api/state"));
}

export type OrganizationReviewPage = {
  reviewId: string; index: number; availableParts: number; totalParts: number; checkedScope: string;
  original: string; originalAvailable: boolean; candidate: string; failedPartIndex: number;
  findings: { kind: string; label: string; originalCount?: number; candidateCount?: number;
    changes?: { value: string; originalCount: number; candidateCount: number }[] }[];
};
export function getOrganizationReview(payload: Record<string, unknown>): Promise<OrganizationReviewPage> {
  return request('/api/organization-review', { method: 'POST', body: JSON.stringify(payload) });
}

export async function performAction(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<NotebookState> {
  return visibleState(await request<NotebookState>("/api/action", {
    method: "POST",
    body: JSON.stringify({ action, ...payload }),
  }));
}

export async function organizeCaptures(
  captureIds?: string[],
): Promise<NotebookState> {
  return visibleState(await request<NotebookState>("/api/organize", {
    method: "POST",
    body: JSON.stringify({ captureIds }),
  }));
}

export async function importData(file: File): Promise<NotebookState> {
  const text = await file.text();
  return performAction("data.import", { text, filename: file.name });
}

export async function uploadTodoCommentImage(file: File): Promise<TodoCommentAttachment> {
  const payload = await request<{ attachment: TodoCommentAttachment }>("/api/todo-comment-image", {
    method: "POST",
    headers: {
      "Content-Type": file.type,
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
  return payload.attachment;
}

export function downloadExport(): void {
  window.location.href = "/api/export";
}
