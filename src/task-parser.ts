import { App, TFile, TFolder } from "obsidian";

export interface Task {
  file: TFile;
  title: string;
  status: string;
  priority: string | null;
  dueDate: string | null;
  dueTime: string | null;
  created: string | null;
  module: string | null;
  from: string | null;
  tags: string[];
  source: "task" | "assignment";
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

export type SortKey = "dueDate" | "priority" | "created" | "title";

export function parseTasks(app: App, folders: string[]): Task[] {
  const tasks: Task[] = [];

  for (const folderPath of folders) {
    const abstract = app.vault.getAbstractFileByPath(folderPath);
    if (!abstract || !(abstract instanceof TFolder)) continue;

    const source: "task" | "assignment" = folderPath.includes("Assignment")
      ? "assignment"
      : "task";

    collectFiles(abstract).forEach((file) => {
      const task = parseFile(app, file, source);
      if (task) tasks.push(task);
    });
  }

  return tasks;
}

function collectFiles(folder: TFolder): TFile[] {
  const files: TFile[] = [];
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === "md") {
      files.push(child);
    } else if (child instanceof TFolder) {
      files.push(...collectFiles(child));
    }
  }
  return files;
}

function parseFile(app: App, file: TFile, source: "task" | "assignment"): Task | null {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!fm) {
    return {
      file,
      title: file.basename,
      status: "",
      priority: null,
      dueDate: null,
      dueTime: null,
      created: null,
      module: null,
      from: null,
      tags: [],
      source,
    };
  }

  const title = fm.displayTitle ?? fm.title ?? file.basename;
  const status = normalizeStatus(fm.status);
  const priority = fm.priority ?? null;
  const dueDate = fm.closes ?? fm.closeDate ?? null;
  const dueTime = fm.closeTime ?? null;
  const created = fm.created ?? null;
  const module = fm.module ?? null;
  const from = fm.from ?? null;
  const tags = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [];

  return { file, title, status, priority, dueDate, dueTime, created, module, from, tags, source };
}

function normalizeStatus(raw: unknown): string {
  if (!raw || typeof raw !== "string") return "incomplete";
  const lower = raw.toLowerCase().trim();
  if (lower === "archived") return "archived";
  if (lower === "completed" || lower === "done" || lower === "submitted") return "completed";
  if (lower === "in-progress" || lower === "in progress" || lower === "working") return "in-progress";
  return "incomplete";
}

function dueDateOrder(d: string | null): number {
  if (!d) return 3; // no date — sort last
  if (d === "Immediately" || d === "ASAP") return 0;
  if (d === "Eventually") return 2;
  return 1; // regular date
}

export function sortTasks(tasks: Task[], key: SortKey): Task[] {
  return [...tasks].sort((a, b) => {
    switch (key) {
      case "dueDate": {
        const oa = dueDateOrder(a.dueDate);
        const ob = dueDateOrder(b.dueDate);
        if (oa !== ob) return oa - ob;
        // Both are real dates — compare lexicographically
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        return 0;
      }
      case "priority": {
        const pa = a.priority ? (PRIORITY_ORDER[a.priority] ?? 3) : 3;
        const pb = b.priority ? (PRIORITY_ORDER[b.priority] ?? 3) : 3;
        return pa - pb;
      }
      case "created": {
        if (a.created && b.created) return b.created.localeCompare(a.created);
        if (a.created) return -1;
        if (b.created) return 1;
        return 0;
      }
      case "title":
        return a.title.localeCompare(b.title);
      default:
        return 0;
    }
  });
}

const SPECIAL_DUE = new Set(["Immediately", "ASAP", "Eventually"]);

export function isSpecialDueDate(d: string | null): boolean {
  return d !== null && SPECIAL_DUE.has(d);
}

export function isOverdue(task: Task): boolean {
  if (!task.dueDate || task.status === "completed") return false;
  if (isSpecialDueDate(task.dueDate)) return task.dueDate === "Immediately" || task.dueDate === "ASAP";
  const today = new Date().toISOString().slice(0, 10);
  return task.dueDate < today;
}
