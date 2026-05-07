/**
 * Single source of truth for "what edits are allowed on a given task right now."
 *
 * Today the only thing constraining edits is TaskRatchet — once a task has a
 * `pending` link, TR owns the title/due/cents and we can't reverse a complete.
 * Other plugins (iris-student, iris-course, iris-calendar) still need to
 * update fields TR doesn't know about (durationMin, onClickCommand,
 * autoComplete rules), so the policy is field-level, not task-level.
 *
 * UI mutation sites read `editCapabilities` to gate user-driven actions
 * (rename/archive/delete/uncheck) and to disable the corresponding menu items.
 * The external API in main.ts (upsertExternalTask) reads `fieldUpdatePolicy`
 * to decide per-field what to do on a staked task — apply, drop silently, or
 * round-trip through TR.
 */

import type IrisTasksPlugin from "./main";

/** High-level capability flags for user-driven mutations. */
export interface EditCaps {
  canRename: boolean;
  canArchive: boolean;
  canDelete: boolean;
  canUncheck: boolean;
  /**
   * - "any": no constraint on the new deadline.
   * - "earlier-only": TR rule, must be strictly earlier than current.
   * - "blocked": deadline is fixed (e.g. task is already settled on TR).
   */
  canSetDue: "any" | "earlier-only" | "blocked";
  /** Reason a capability is restricted, for tooltips/notices. */
  lockedBy: "taskratchet-pending" | "taskratchet-complete" | null;
}

const ALL_ALLOWED: EditCaps = {
  canRename: true,
  canArchive: true,
  canDelete: true,
  canUncheck: true,
  canSetDue: "any",
  lockedBy: null,
};

export function editCapabilities(
  plugin: IrisTasksPlugin,
  taskId: string,
): EditCaps {
  const link = plugin.taskRatchetLinkForTask(taskId);
  // No stake, or stake already expired (money's lost; TR is no longer the
  // arbiter): everything is fair game.
  if (!link || link.status === "expired") return ALL_ALLOWED;

  if (link.status === "complete") {
    // TR has settled — uncheck is forbidden (TR's complete is one-way).
    // Archive/delete are also blocked: TR is the source of truth for a
    // settled stake, and removing the local row would orphan that record
    // (the user can no longer see "I staked $X on this and won/lost").
    // Title and due date remain editable as local-only labels.
    return {
      canRename: true,
      canArchive: false,
      canDelete: false,
      canUncheck: false,
      canSetDue: "any",
      lockedBy: "taskratchet-complete",
    };
  }

  // status === "pending": TR owns the task. Title is immutable and the
  // deadline can only move earlier (TR's rule). Archive/delete are blocked
  // because TR is the source of truth on a live stake — hiding or removing
  // the local row would silently diverge from money the user has on the
  // line. Uncheck is moot since the task isn't complete on TR yet.
  return {
    canRename: false,
    canArchive: false,
    canDelete: false,
    canUncheck: true,
    canSetDue: "earlier-only",
    lockedBy: "taskratchet-pending",
  };
}

/** Human-readable explanation for a `lockedBy` value. */
export function lockReason(caps: EditCaps): string {
  switch (caps.lockedBy) {
    case "taskratchet-pending":
      return "TaskRatchet doesn't allow this change on an active stake.";
    case "taskratchet-complete":
      return "TaskRatchet has already settled this task.";
    case null:
      return "";
  }
}

/**
 * Field-level policy for `upsertExternalTask`. Each field has one of three
 * outcomes when TR has a non-expired link on the task:
 *
 * - "allow": TR doesn't care about this field; apply locally as normal.
 * - "drop": TR rejects changes (or the field is meaningless after settle);
 *   silently no-op so the calling plugin's other field updates still go
 *   through.
 * - "tr-mediated": the change must round-trip through TR's API; only
 *   relevant for `dueDate` / `dueTime` (TR's "earlier-only" rule).
 */
export type ExternalTaskField =
  | "title"
  | "dueDate"
  | "dueTime"
  | "durationMin"
  | "onClickCommand"
  | "autoCompleteWhen"
  | "autoCompleteWhenWordCount"
  | "autoCompletes"
  /** Pseudo-field for the auto-reopen on completedAt that upsert performs. */
  | "reopen";

export function fieldUpdatePolicy(
  plugin: IrisTasksPlugin,
  taskId: string,
  field: ExternalTaskField,
): "allow" | "drop" | "tr-mediated" {
  const link = plugin.taskRatchetLinkForTask(taskId);
  if (!link || link.status === "expired") return "allow";
  switch (field) {
    case "title":
      // Title is immutable on a pending TR task. Once settled, the local
      // title is just a label and editing it doesn't affect TR.
      return link.status === "pending" ? "drop" : "allow";
    case "reopen":
      // TR's complete is one-way; reopening a settled link would diverge.
      return link.status === "complete" ? "drop" : "allow";
    case "dueDate":
    case "dueTime":
      // Pending: round-trip through TR (earlier-only rule). Settled: local
      // edit only, TR's record is frozen.
      return link.status === "pending" ? "tr-mediated" : "allow";
    case "durationMin":
    case "onClickCommand":
    case "autoCompleteWhen":
    case "autoCompleteWhenWordCount":
    case "autoCompletes":
      // Pure local metadata — TR doesn't know about these fields.
      return "allow";
  }
}

/**
 * Split a list of items by a per-item permission predicate. Used by bulk
 * mutation handlers that want to apply the operation to allowed items and
 * surface a "Skipped N…" notice for the rest.
 */
export function partitionByPolicy<T>(
  items: T[],
  isAllowed: (item: T) => boolean,
): { allowed: T[]; blocked: T[] } {
  const allowed: T[] = [];
  const blocked: T[] = [];
  for (const item of items) {
    (isAllowed(item) ? allowed : blocked).push(item);
  }
  return { allowed, blocked };
}
