import type { App } from "obsidian";
import type { Task } from "./task-parser";

const IRIS_MAIL_PLUGIN_ID = "iris-mail";

export interface RawMailTodo {
  id: string;
  subject: string;
  from: string;
  fromAddress: string;
  receivedDateTime: string;
  todoAt: number;
  accountLabel?: string;
}

interface IrisMailApi {
  getTodos(): RawMailTodo[];
  getTodoBody(messageId: string): string;
  onTodosChanged(cb: () => void): () => void;
  clearTodo(messageId: string): void;
}

function getMailApi(app: App): IrisMailApi | null {
  const plugins = (app as unknown as {
    plugins?: { plugins?: Record<string, unknown> };
  }).plugins?.plugins;
  const plugin = plugins?.[IRIS_MAIL_PLUGIN_ID] as IrisMailApi | undefined;
  if (!plugin) return null;
  if (typeof plugin.getTodos !== "function") return null;
  return plugin;
}

/**
 * Run `cb` once Iris Mail's plugin API is reachable. Fires synchronously if
 * Mail is already loaded; otherwise defers to `onLayoutReady`, which runs
 * after every enabled plugin's `onload` has completed. Resolves the load-
 * order race when Iris Tasks loads before Iris Mail.
 */
export function whenMailReady(app: App, cb: () => void): void {
  if (getMailApi(app)) {
    cb();
    return;
  }
  app.workspace.onLayoutReady(() => cb());
}

export function getRawMailTodos(app: App): RawMailTodo[] {
  const api = getMailApi(app);
  if (!api) return [];
  return api.getTodos();
}

/**
 * Fallback view: 1:1 mirror of the inbox with a light cleanup of the title.
 * Used when the AI composer hasn't run, isn't available, or has failed.
 */
export function getMailTasks(app: App): Task[] {
  return getRawMailTodos(app).map(toTask);
}

export function subscribeMailTodos(app: App, cb: () => void): () => void {
  const api = getMailApi(app);
  if (!api) return () => {};
  return api.onTodosChanged(cb);
}

export function clearMailTodo(app: App, messageId: string): void {
  const api = getMailApi(app);
  if (!api) return;
  api.clearTodo(messageId);
}

export function getMailTodoBody(app: App, messageId: string): string {
  const api = getMailApi(app);
  if (!api) return "";
  return api.getTodoBody(messageId);
}

const PREFIX_NOISE = /^(?:\s*(?:fw|fwd|re)\s*:\s*)+/i;

function cleanSubject(subject: string): string {
  return subject.replace(PREFIX_NOISE, "").trim() || subject;
}

function toTask(todo: RawMailTodo): Task {
  const subject = cleanSubject(todo.subject || "(no subject)");
  const fromLabel = todo.from || todo.fromAddress;
  const title = fromLabel ? `${fromLabel} — ${subject}` : subject;
  return {
    id: todo.id,
    title,
    status: "incomplete",
    priority: null,
    dueDate: null,
    dueTime: null,
    created: todo.receivedDateTime || null,
    source: "mail",
    sourceIds: [todo.id],
    dependsOn: [],
    aiRank: null,
  };
}
