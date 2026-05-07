import { requestUrl } from "obsidian";

const API_BASE = "https://api.taskratchet.com/api2";
const REQUEST_TIMEOUT_MS = 15_000;

export type TaskRatchetStatus = "pending" | "complete" | "expired";

export interface TaskRatchetProfile {
  id: string;
  name?: string;
  email?: string;
  timezone?: string;
}

export interface TaskRatchetTask {
  id: string;
  task: string;
  due: number;
  cents: number;
  complete: boolean;
  status: TaskRatchetStatus;
  chargeStatus?: string;
  contested?: boolean;
}

export interface TaskRatchetLink {
  /** Internal Iris task id (manual or composed). */
  taskId: string;
  /** TaskRatchet's id for the corresponding task. */
  trTaskId: string;
  cents: number;
  /** Unix seconds. */
  due: number;
  linkedAt: string;
  status: TaskRatchetStatus;
  /** Set when local task is complete but TR push hasn't yet succeeded. */
  pendingComplete?: boolean;
}

export class TaskRatchetError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
}

async function request<T>(
  path: string,
  apiKey: string,
  opts: RequestOptions = { method: "GET" },
): Promise<T> {
  if (!apiKey) throw new TaskRatchetError("No TaskRatchet API key configured");
  const init: Parameters<typeof requestUrl>[0] = {
    url: API_BASE + path,
    method: opts.method,
    headers: {
      Authorization: `ApiKey-v2 ${apiKey}`,
      "Content-Type": "application/json",
    },
    throw: false,
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const response = await Promise.race([
    requestUrl(init),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new TaskRatchetError("TaskRatchet request timed out")),
        REQUEST_TIMEOUT_MS,
      ),
    ),
  ]);
  if (response.status < 200 || response.status >= 300) {
    throw new TaskRatchetError(
      `TaskRatchet API error: HTTP ${response.status}`,
      response.status,
    );
  }
  // Some endpoints (uncle) return a non-JSON "ok"; tolerate that.
  try {
    return response.json as T;
  } catch {
    return undefined as T;
  }
}

export async function fetchProfile(apiKey: string): Promise<TaskRatchetProfile> {
  return request<TaskRatchetProfile>("/me", apiKey);
}

export async function createTask(
  apiKey: string,
  input: { task: string; dueUnixSec: number; cents: number },
): Promise<TaskRatchetTask> {
  return request<TaskRatchetTask>("/me/tasks", apiKey, {
    method: "POST",
    body: { task: input.task, due: input.dueUnixSec, cents: input.cents },
  });
}

export async function fetchTask(
  apiKey: string,
  trTaskId: string,
): Promise<TaskRatchetTask> {
  return request<TaskRatchetTask>(`/me/tasks/${encodeURIComponent(trTaskId)}`, apiKey);
}

export async function markComplete(
  apiKey: string,
  trTaskId: string,
): Promise<TaskRatchetTask> {
  return request<TaskRatchetTask>(`/me/tasks/${encodeURIComponent(trTaskId)}`, apiKey, {
    method: "PUT",
    body: { complete: true },
  });
}

/**
 * General PUT for an existing task. Per the TR API v2 spec, only `complete`,
 * `cents`, and `due` are mutable — and TR enforces "harder-only" rules:
 * stakes can only increase, deadlines can only move earlier. Title is
 * immutable. We don't pre-validate here; let TR be the authority and
 * surface its error to the caller.
 */
export async function updateTask(
  apiKey: string,
  trTaskId: string,
  patch: { complete?: boolean; cents?: number; due?: number },
): Promise<TaskRatchetTask> {
  return request<TaskRatchetTask>(`/me/tasks/${encodeURIComponent(trTaskId)}`, apiKey, {
    method: "PUT",
    body: patch,
  });
}

export async function uncleTask(apiKey: string, trTaskId: string): Promise<void> {
  await request<unknown>(`/me/tasks/${encodeURIComponent(trTaskId)}/uncle`, apiKey, {
    method: "POST",
  });
}

/**
 * Convert an iris due date/time to a TaskRatchet Unix-seconds deadline.
 * If `time` is missing, default to local 23:59:59. Returns null if `date`
 * is empty or one of the special tokens ("Immediately"/"ASAP"/"Eventually").
 */
export function toTaskRatchetDeadline(
  date: string | null | undefined,
  time: string | null | undefined,
): number | null {
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split("-").map(Number);
  let hh = 23;
  let mm = 59;
  let ss = 59;
  if (time && /^\d{2}:\d{2}$/.test(time)) {
    const [h, mi] = time.split(":").map(Number);
    hh = h;
    mm = mi;
    ss = 0;
  }
  const dt = new Date(y, m - 1, d, hh, mm, ss);
  return Math.floor(dt.getTime() / 1000);
}

export function formatStake(cents: number): string {
  if (cents % 100 === 0) return `$${cents / 100}`;
  return `$${(cents / 100).toFixed(2)}`;
}
