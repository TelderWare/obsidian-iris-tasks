import type { Task } from "./task-parser";
import type { RawMailTodo } from "./mail-source";

const MAX_PER_EMAIL = 200;

export interface ComposedTask {
  title: string;
  sourceIds: string[];
  /** Per-email derived deadline. ISO date "YYYY-MM-DD", or one of "Immediately" | "ASAP" | "Eventually". */
  dueDate?: string;
  /** Per-email derived priority. */
  priority?: "high" | "medium" | "low";
}

/**
 * Cache slot for one email's per-email compose output. `tasks` is 0 or 1
 * entry; an empty array distinguishes "AI saw this and decided it isn't
 * actionable" from "we haven't asked yet" (a missing entry).
 */
export interface PerEmailCacheEntry {
  hash: string;
  emailId: string;
  contentDigest: string;
  tasks: ComposedTask[];
  promptVersion: number;
  storedAt: number;
}

/**
 * A user-facing task group. Persists across runs; new per-email candidates
 * either join an existing group (via the AI merge pass) or start a new one.
 * Title is set when the group is created and never rewritten — the merge
 * pass can only attach members, not rename.
 */
export interface Group {
  id: string;
  title: string;
  sourceIds: string[];
  createdAt: number;
}

export interface TaskCache {
  version: 3;
  perEmail: PerEmailCacheEntry[];
  groups: Group[];
  /** Monotonic counter for stable group ids. */
  nextGroupId: number;
}

export function emptyCache(): TaskCache {
  return { version: 3, perEmail: [], groups: [], nextGroupId: 1 };
}

/**
 * Drop a persisted cache that doesn't match the current shape. Older v1/v2
 * caches (pre-incremental-merge) are wiped wholesale — one fresh compose
 * after upgrade is acceptable.
 */
export function migrateCache(raw: unknown): TaskCache {
  if (!raw || typeof raw !== "object") return emptyCache();
  const r = raw as {
    version?: unknown;
    perEmail?: unknown;
    groups?: unknown;
    nextGroupId?: unknown;
  };
  if (r.version !== 3) return emptyCache();
  const perEmail = Array.isArray(r.perEmail) ? r.perEmail : null;
  const groups = Array.isArray(r.groups) ? r.groups : null;
  if (!perEmail || !groups) return emptyCache();
  const okPerEmail = perEmail.every((e) => {
    if (!e || typeof e !== "object") return false;
    const x = e as Record<string, unknown>;
    return (
      typeof x.hash === "string" &&
      typeof x.emailId === "string" &&
      typeof x.contentDigest === "string" &&
      Array.isArray(x.tasks) &&
      typeof x.promptVersion === "number" &&
      typeof x.storedAt === "number"
    );
  });
  const okGroups = groups.every((g) => {
    if (!g || typeof g !== "object") return false;
    const x = g as Record<string, unknown>;
    return (
      typeof x.id === "string" &&
      typeof x.title === "string" &&
      Array.isArray(x.sourceIds) &&
      (x.sourceIds as unknown[]).every((s) => typeof s === "string") &&
      typeof x.createdAt === "number"
    );
  });
  if (!okPerEmail || !okGroups) return emptyCache();
  const nextGroupId =
    typeof r.nextGroupId === "number" && r.nextGroupId >= 1
      ? Math.trunc(r.nextGroupId)
      : 1;
  return {
    version: 3,
    perEmail: perEmail as PerEmailCacheEntry[],
    groups: groups as Group[],
    nextGroupId,
  };
}

/**
 * Hash of an arbitrary token list, optionally salted. Stable across runs
 * and Node/browser. Used for the per-email content digest.
 */
export function hashIdSet(ids: string[], salt = ""): string {
  const sorted = [...ids].sort();
  let h = 5381;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) {
      h = ((h << 5) + h + id.charCodeAt(i)) | 0;
    }
    h = ((h << 5) + h + 124) | 0;
  }
  for (let i = 0; i < salt.length; i++) {
    h = ((h << 5) + h + salt.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/** Deterministic id for a composed task — derived from its sourceIds. */
export function composedTaskId(sourceIds: string[]): string {
  return "c-" + hashIdSet(sourceIds);
}

/**
 * Per-email cache key: combines email id + content digest + compose prompt
 * version. Email id is included so the key is human-debuggable and protects
 * against content collisions; content digest makes the key self-invalidating
 * when the email body or subject changes.
 */
export function hashEmailContent(
  email: Pick<RawMailTodo, "id" | "subject">,
  body: string,
  promptVersion: number,
): { hash: string; contentDigest: string } {
  const contentDigest = hashIdSet([email.subject ?? "", body ?? ""], "");
  const hash = hashIdSet([email.id, contentDigest], "pe" + promptVersion);
  return { hash, contentDigest };
}

/** Stable fingerprint of an array of per-email hashes. Order-independent. */
export function aggregateHash(perEmailHashes: string[]): string {
  return hashIdSet(perEmailHashes, "agg");
}

export function lookupPerEmail(
  cache: TaskCache,
  hash: string,
): PerEmailCacheEntry | null {
  return cache.perEmail.find((e) => e.hash === hash) ?? null;
}

export function storePerEmail(
  cache: TaskCache,
  entry: PerEmailCacheEntry,
): TaskCache {
  const filtered = cache.perEmail.filter((e) => e.hash !== entry.hash);
  filtered.unshift(entry);
  return { ...cache, perEmail: filtered.slice(0, MAX_PER_EMAIL) };
}

/**
 * Drop per-email entries for emails no longer present in the inbox, then
 * LRU-cap. Called once per pipeline run after composes settle.
 */
export function gcPerEmail(
  cache: TaskCache,
  currentEmailIds: Set<string>,
): TaskCache {
  const kept = cache.perEmail.filter((e) => currentEmailIds.has(e.emailId));
  return { ...cache, perEmail: kept.slice(0, MAX_PER_EMAIL) };
}

/**
 * Email ids that have a per-email cache entry but aren't yet attached to
 * any group. These are the candidates the merge pass needs to triage.
 */
export function ungroupedEmailIds(cache: TaskCache, emailIds: string[]): string[] {
  const claimed = new Set<string>();
  for (const g of cache.groups) for (const id of g.sourceIds) claimed.add(id);
  return emailIds.filter((id) => !claimed.has(id));
}

/**
 * Apply merge assignments produced by the AI: each candidate either joins
 * an existing group (by id) or contributes to a new group keyed by an
 * arbitrary token (so multiple candidates with the same token form one
 * new group). Returns the updated cache.
 *
 * Caller is responsible for filtering out emailIds whose per-email pass
 * produced no task — those should never reach this function.
 */
export interface Assignment {
  emailId: string;
  /** Per-email task title; used as the new group's title when `newToken` is set. */
  title: string;
  joinId?: string;
  newToken?: string;
}

export function applyAssignments(
  cache: TaskCache,
  assignments: Assignment[],
): TaskCache {
  const groups = cache.groups.map((g) => ({ ...g, sourceIds: [...g.sourceIds] }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const newByToken = new Map<string, Group>();
  let nextId = cache.nextGroupId;

  for (const a of assignments) {
    if (a.joinId) {
      const g = byId.get(a.joinId);
      if (g) {
        if (!g.sourceIds.includes(a.emailId)) g.sourceIds.push(a.emailId);
        continue;
      }
      // joinId didn't resolve (group GC'd between merge call and apply) —
      // fall through to a new group keyed by emailId so the candidate isn't lost.
    }
    const token = a.newToken ?? `__solo_${a.emailId}`;
    let g = newByToken.get(token);
    if (!g) {
      g = {
        id: `g${nextId++}`,
        title: a.title,
        sourceIds: [],
        createdAt: Date.now(),
      };
      newByToken.set(token, g);
      groups.push(g);
      byId.set(g.id, g);
    }
    if (!g.sourceIds.includes(a.emailId)) g.sourceIds.push(a.emailId);
  }

  return { ...cache, groups, nextGroupId: nextId };
}

/**
 * Drop sourceIds and groups that no longer correspond to a flagged email.
 * Called after each pipeline run.
 */
export function gcGroups(cache: TaskCache, currentEmailIds: Set<string>): TaskCache {
  const groups: Group[] = [];
  for (const g of cache.groups) {
    const surviving = g.sourceIds.filter((id) => currentEmailIds.has(id));
    if (surviving.length === 0) continue;
    groups.push({ ...g, sourceIds: surviving });
  }
  return { ...cache, groups };
}

/**
 * When a group's sourceIds change (merge adds an email, GC removes one),
 * the composed task ID — hash(sourceIds) — changes too. Remap all settings
 * entries that were keyed by the old ID so dependencies, title overrides,
 * ordering, and archive state follow the task across the rename.
 */
export function migrateSettingsForIdChanges(
  oldGroups: Group[],
  newGroups: Group[],
  settings: {
    manualDependencies: { [taskId: string]: string[] };
    taskTitleOverrides: { [taskId: string]: string };
    taskOrder: string[];
    archivedTaskIds: string[];
  },
): void {
  const oldById = new Map(oldGroups.map((g) => [g.id, g]));
  const remap = new Map<string, string>();

  for (const ng of newGroups) {
    const og = oldById.get(ng.id);
    if (!og) continue;
    const oldTid = composedTaskId(og.sourceIds);
    const newTid = composedTaskId(ng.sourceIds);
    if (oldTid !== newTid) remap.set(oldTid, newTid);
  }

  if (remap.size === 0) return;

  const md = settings.manualDependencies;
  for (const oldKey of Object.keys(md)) {
    const newKey = remap.get(oldKey);
    if (!newKey) continue;
    const merged = [...(md[newKey] ?? []), ...md[oldKey]];
    delete md[oldKey];
    md[newKey] = [...new Set(merged)];
  }
  for (const key of Object.keys(md)) {
    let changed = false;
    const arr = md[key].map((dep) => {
      const r = remap.get(dep);
      if (r) { changed = true; return r; }
      return dep;
    });
    if (changed) md[key] = [...new Set(arr)];
  }

  const tto = settings.taskTitleOverrides;
  for (const oldKey of Object.keys(tto)) {
    const newKey = remap.get(oldKey);
    if (!newKey) continue;
    if (!(newKey in tto)) tto[newKey] = tto[oldKey];
    delete tto[oldKey];
  }

  const seen = new Set<string>();
  settings.taskOrder = settings.taskOrder
    .map((id) => remap.get(id) ?? id)
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

  settings.archivedTaskIds = [...new Set(
    settings.archivedTaskIds.map((id) => remap.get(id) ?? id),
  )];
}

interface RawTodoLite {
  id: string;
  subject: string;
  from: string;
  fromAddress: string;
  receivedDateTime: string;
}

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function pickPriority(
  acc: "high" | "medium" | "low" | undefined,
  next: "high" | "medium" | "low" | undefined,
): "high" | "medium" | "low" | undefined {
  if (!next) return acc;
  if (!acc) return next;
  return PRIORITY_RANK[next] < PRIORITY_RANK[acc] ? next : acc;
}

/**
 * Earliest-equivalent dueDate wins. Ordering: "Immediately" < any explicit
 * date < "ASAP" < "Eventually" < undefined. ASAP outranks Eventually but
 * loses to a concrete date because a known date is more actionable.
 */
function dueDateRank(d: string | undefined): number {
  if (d === "Immediately") return 0;
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return 1;
  if (d === "ASAP") return 2;
  if (d === "Eventually") return 3;
  return 4;
}

function pickDueDate(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  const ra = dueDateRank(a);
  const rb = dueDateRank(b);
  if (ra !== rb) return ra < rb ? a : b;
  // Both concrete dates: earlier wins.
  if (ra === 1) return a < b ? a : b;
  return a;
}

/**
 * Build renderable Task[] from cached groups plus per-email cache entries
 * (which carry each member's individual dueDate/priority).
 *
 * Ranking is computed deterministically: tasks sorted by (priority,
 * dueDate, then group creation order) get aiRank = 1, 2, 3, …
 */
export function materialiseGroups(
  raw: RawTodoLite[],
  groups: Group[],
  perEmail: PerEmailCacheEntry[],
): Task[] {
  const byId = new Map(raw.map((r) => [r.id, r]));
  const taskBySource = new Map<string, ComposedTask>();
  for (const e of perEmail) {
    for (const t of e.tasks) {
      for (const sid of t.sourceIds) taskBySource.set(sid, t);
    }
  }

  type Built = { task: Task; createdAt: number };
  const built: Built[] = [];
  for (const g of groups) {
    const present = g.sourceIds.filter((id) => byId.has(id));
    if (present.length === 0) continue;

    let dueDate: string | undefined;
    let priority: "high" | "medium" | "low" | undefined;
    let earliest: string | null = null;
    for (const id of present) {
      const r = byId.get(id);
      const recv = r?.receivedDateTime || null;
      if (recv && (!earliest || recv < earliest)) earliest = recv;
      const t = taskBySource.get(id);
      if (!t) continue;
      dueDate = pickDueDate(dueDate, t.dueDate);
      priority = pickPriority(priority, t.priority);
    }

    built.push({
      task: {
        id: composedTaskId(present),
        title: g.title,
        status: "incomplete",
        priority: priority ?? null,
        dueDate: dueDate ?? null,
        dueTime: null,
        created: earliest,
        source: "mail",
        sourceIds: present,
        composedId: g.id,
        dependsOn: [],
        aiRank: null,
      },
      createdAt: g.createdAt,
    });
  }

  built.sort((a, b) => {
    const pa = a.task.priority ? PRIORITY_RANK[a.task.priority] : 3;
    const pb = b.task.priority ? PRIORITY_RANK[b.task.priority] : 3;
    if (pa !== pb) return pa - pb;
    const da = dueDateRank(a.task.dueDate ?? undefined);
    const db = dueDateRank(b.task.dueDate ?? undefined);
    if (da !== db) return da - db;
    if (da === 1 && a.task.dueDate && b.task.dueDate) {
      const cmp = a.task.dueDate.localeCompare(b.task.dueDate);
      if (cmp !== 0) return cmp;
    }
    return a.createdAt - b.createdAt;
  });

  for (let i = 0; i < built.length; i++) built[i].task.aiRank = i + 1;
  return built.map((b) => b.task);
}
