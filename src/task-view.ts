import {
  App,
  ItemView,
  Menu,
  Modal,
  Notice,
  SuggestModal,
  TFile,
  TFolder,
  Vault,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type IrisTasksPlugin from "./main";
import type { ManualTask, TaskSeries } from "./settings";
import { parseDueDate } from "./date-parse";
import { Task } from "./task-parser";
import {
  getMailTasks,
  getMailTodoBody,
  getRawMailTodos,
  subscribeMailTodos,
  clearMailTodo,
  whenMailReady,
} from "./mail-source";
import { formatStake, toTaskRatchetDeadline } from "./taskratchet";
import type { TaskRatchetLink } from "./taskratchet";
import {
  editCapabilities,
  lockReason,
  partitionByPolicy,
} from "./task-edit-policy";
import {
  aiComposeEmail,
  aiAssignToGroups,
  hasAiAccess,
  hasIrisRelay,
  AIError,
  COMPOSE_PROMPT_VERSION,
} from "./ai-compose";
import {
  aggregateHash,
  applyAssignments,
  gcGroups,
  gcPerEmail,
  hashEmailContent,
  hashIdSet,
  lookupPerEmail,
  materialiseGroups,
  migrateSettingsForIdChanges,
  storePerEmail,
  ungroupedEmailIds,
  type Assignment,
  type ComposedTask,
  type Group,
} from "./task-cache";
import { MailMessageModal } from "./mail-modal";

export const VIEW_TYPE_TASKS = "iris-tasks-view";

const AI_DEBOUNCE_MS = 10_000;

type AiPhase =
  | "idle"
  | "pending"
  | "composing"
  | "merging"
  | "unavailable"
  | "compose-failed"
  | "merge-failed";

interface DeleteSnapshot {
  manualTasks: ManualTask[];
  taskSeries: TaskSeries[];
  manualDependencies: Record<string, string[]>;
  taskTitleOverrides: Record<string, string>;
  taskDueDateOverrides: Record<string, { date: string; time: string | null }>;
  taskOrder: string[];
  archivedTaskIds: string[];
  taskratchetTaskLinks: TaskRatchetLink[];
  currentTaskId: string | null;
  currentTaskTitle: string | null;
}

function snapshotDeletableState(plugin: IrisTasksPlugin): DeleteSnapshot {
  const s = plugin.settings;
  return {
    manualTasks: s.manualTasks.map((m) => ({ ...m })),
    taskSeries: s.taskSeries.map((ts) => ({ id: ts.id, memberIds: [...ts.memberIds] })),
    manualDependencies: Object.fromEntries(
      Object.entries(s.manualDependencies).map(([k, v]) => [k, [...v]]),
    ),
    taskTitleOverrides: { ...s.taskTitleOverrides },
    taskDueDateOverrides: { ...s.taskDueDateOverrides },
    taskOrder: [...s.taskOrder],
    archivedTaskIds: [...s.archivedTaskIds],
    taskratchetTaskLinks: s.taskratchetTaskLinks.map((l) => ({ ...l })),
    currentTaskId: s.currentTaskId,
    currentTaskTitle: s.currentTaskTitle,
  };
}

/**
 * Apply the standard "delete these manual task ids" mutation, returning a list
 * of series ids that got destroyed in the process (so a SeriesModal showing
 * one of them can decide to close).
 */
function applyDeleteMutation(plugin: IrisTasksPlugin, idSet: Set<string>): string[] {
  const s = plugin.settings;
  const destroyedSeries: string[] = [];
  s.manualTasks = s.manualTasks.filter((m) => !idSet.has(m.id));
  for (let i = s.taskSeries.length - 1; i >= 0; i--) {
    const series = s.taskSeries[i];
    series.memberIds = series.memberIds.filter((mid) => !idSet.has(mid));
    if (series.memberIds.length <= 1) {
      destroyedSeries.push(series.id);
      s.taskSeries.splice(i, 1);
    }
  }
  for (const id of idSet) delete s.manualDependencies[id];
  for (const k of Object.keys(s.manualDependencies)) {
    const filtered = s.manualDependencies[k].filter((d) => !idSet.has(d));
    if (filtered.length === 0) delete s.manualDependencies[k];
    else s.manualDependencies[k] = filtered;
  }
  for (const id of idSet) delete s.taskTitleOverrides[id];
  for (const id of idSet) delete s.taskDueDateOverrides[id];
  s.taskOrder = s.taskOrder.filter((tid) => !idSet.has(tid));
  s.archivedTaskIds = s.archivedTaskIds.filter((tid) => !idSet.has(tid));
  s.taskratchetTaskLinks = s.taskratchetTaskLinks.filter((l) => !idSet.has(l.taskId));
  if (s.currentTaskId && idSet.has(s.currentTaskId)) {
    s.currentTaskId = null;
    s.currentTaskTitle = null;
  }
  return destroyedSeries;
}

function restoreSnapshot(plugin: IrisTasksPlugin, snapshot: DeleteSnapshot): void {
  const s = plugin.settings;
  s.manualTasks = snapshot.manualTasks;
  s.taskSeries = snapshot.taskSeries;
  s.manualDependencies = snapshot.manualDependencies;
  s.taskTitleOverrides = snapshot.taskTitleOverrides;
  s.taskDueDateOverrides = snapshot.taskDueDateOverrides;
  s.taskOrder = snapshot.taskOrder;
  s.archivedTaskIds = snapshot.archivedTaskIds;
  s.taskratchetTaskLinks = snapshot.taskratchetTaskLinks;
  s.currentTaskId = snapshot.currentTaskId;
  s.currentTaskTitle = snapshot.currentTaskTitle;
}

/**
 * Show a deletion Notice with an Undo button. Returns the destroyed series ids
 * so the caller can react (e.g. close a SeriesModal whose series got removed).
 */
function showDeleteNoticeWithUndo(
  plugin: IrisTasksPlugin,
  snapshot: DeleteSnapshot,
  label: string,
): Notice {
  const notice = new Notice("", 6000);
  notice.noticeEl.empty();
  notice.noticeEl.createSpan({ text: `${label} deleted. ` });
  const btn = notice.noticeEl.createEl("button", {
    text: "Undo",
    cls: "iris-tasks-notice-undo",
  });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    restoreSnapshot(plugin, snapshot);
    await plugin.saveSettings();
    TaskView.refreshAll();
    plugin.updateCurrentTaskBar();
    notice.hide();
  });
  return notice;
}

function showTaskRatchetGearMenu(
  plugin: IrisTasksPlugin,
  taskId: string,
  trLink: TaskRatchetLink,
  evt: MouseEvent,
): void {
  if (trLink.status !== "pending") return;
  const menu = new Menu();
  menu.addItem((i) =>
    i
      .setTitle(`Staked ${formatStake(trLink.cents)} (${trLink.status})`)
      .setDisabled(true),
  );
  menu.addItem((i) =>
    i
      .setTitle("Forfeit stake (uncle)")
      .setIcon("flag")
      .onClick(() => {
        if (
          confirm(
            `Forfeit ${formatStake(trLink.cents)}? Your card will be charged immediately.`,
          )
        ) {
          void plugin.uncleTaskRatchet(taskId);
        }
      }),
  );
  menu.showAtMouseEvent(evt);
}

export class TaskView extends ItemView {
  /** Open instances, used by sibling widgets to trigger a re-render after they mutate settings. */
  private static instances = new Set<TaskView>();
  static refreshAll(): void {
    for (const v of TaskView.instances) v.renderBody();
  }

  private plugin: IrisTasksPlugin;
  private bodyEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private layoutReady = false;
  private mailUnsubscribe: (() => void) | null = null;
  private isOpen = false;

  private aiPhase: AiPhase = "idle";
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  /** Polls until iris-router (relay) finishes loading after a cold start. */
  private aiAccessRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Hash the pipeline is currently working on (per-email aggregate). */
  private inflightHash: string | null = null;
  /** Per-email content hashes whose compose has failed permanently this session — don't retry. */
  private perEmailFailedHashes = new Set<string>();
  /** Attempt counts for transient per-email failures, keyed by content hash. */
  private perEmailAttempts = new Map<string, number>();
  /**
   * Fingerprint of the last failed merge call (ungrouped ids + existing
   * group ids). When the current merge would have the same fingerprint
   * we skip until cleared by a manual retry or the scheduled timer.
   */
  private mergeFailedKey: string | null = null;
  /** Attempt counts for transient merge failures, keyed by mergeKey. */
  private mergeAttempts = new Map<string, number>();
  /** Last per-email compose error message, surfaced in the status tooltip. */
  private lastComposeError: string | null = null;
  /** Last merge error message, surfaced in the status tooltip. */
  private lastMergeError: string | null = null;

  private isWidget: boolean;

  /** Inline create-entry row when `widgetShowCreateTaskEntry` is on (widget only). */
  private createEntryEl: HTMLElement | null = null;
  /** Header "+" button (widget only). */
  private addBtn: HTMLButtonElement | null = null;

  /** Module code → Lucide icon id (or null). Built lazily per render. */
  private moduleIconCache: Map<string, string | null> | null = null;

  /** Row ids the user has multi-selected via ctrl/shift-click. */
  private selectedIds = new Set<string>();
  /** Anchor for shift-range selection — last id the user explicitly toggled. */
  private selectionAnchorId: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    plugin: IrisTasksPlugin,
    opts?: { isWidget?: boolean },
  ) {
    super(leaf);
    this.plugin = plugin;
    this.isWidget = opts?.isWidget ?? false;
  }

  getViewType(): string { return VIEW_TYPE_TASKS; }
  getDisplayText(): string { return "Tasks"; }
  getIcon(): string { return "list-todo"; }

  async onOpen(): Promise<void> {
    this.isOpen = true;
    TaskView.instances.add(this);
    if (this.isWidget) {
      // Embedded widget: no view-tab action button. Right-click anywhere in
      // the widget body opens the same options menu, and the choices flip
      // widget-specific settings (independent of the standalone view).
      this.contentEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.openOptionsMenu(e);
      });
    } else {
      this.addAction("sliders-horizontal", "View options", (e) =>
        this.openOptionsMenu(e),
      );
    }
    this.render();
    whenMailReady(this.app, () => {
      if (!this.isOpen) return;
      this.mailUnsubscribe = subscribeMailTodos(this.app, () => this.onTodosChanged());
      this.onTodosChanged();
    });
  }

  private getShowCompleted(): boolean {
    return this.isWidget
      ? this.plugin.settings.widgetShowCompleted
      : this.plugin.settings.showCompleted;
  }

  private setShowCompleted(v: boolean): void {
    if (this.isWidget) this.plugin.settings.widgetShowCompleted = v;
    else this.plugin.settings.showCompleted = v;
  }

  private getActionableOnly(): boolean {
    // The widget is always actionable-only — surfacing blocked tasks in a
    // glanceable list is just noise.
    return this.isWidget || this.plugin.settings.actionableOnly;
  }

  private setActionableOnly(v: boolean): void {
    this.plugin.settings.actionableOnly = v;
  }

  private getShowArchived(): boolean {
    // The widget stays glanceable — archived tasks never surface there.
    return !this.isWidget && this.plugin.settings.showArchived;
  }

  private setShowArchived(v: boolean): void {
    this.plugin.settings.showArchived = v;
  }

  private getShowCreateTaskEntry(): boolean {
    return this.isWidget;
  }

  async onClose(): Promise<void> {
    this.isOpen = false;
    TaskView.instances.delete(this);
    if (this.mailUnsubscribe) {
      this.mailUnsubscribe();
      this.mailUnsubscribe = null;
    }
    if (this.aiTimer) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
    if (this.aiAccessRetryTimer) {
      clearTimeout(this.aiAccessRetryTimer);
      this.aiAccessRetryTimer = null;
    }
  }

  private ensureLayout(): void {
    if (this.layoutReady) return;
    this.layoutReady = true;

    const container = this.contentEl;
    container.empty();
    container.addClass("iris-tasks");

    const header = container.createDiv({ cls: "iris-tasks-header" });
    header.createEl("h6", { text: "Tasks", cls: "iris-hp-widget-title" });

    this.statusEl = header.createEl("span", { cls: "iris-tasks-status" });
    this.statusEl.addEventListener("click", () => this.handleStatusClick());

    if (this.getShowCreateTaskEntry()) {
      this.addBtn = header.createEl("button", {
        cls: "iris-hp-widget-add clickable-icon",
        attr: { "aria-label": "New task" },
      });
      setIcon(this.addBtn, "plus");
      this.addBtn.addEventListener("click", () => this.activateCreateEntry());
    }

    this.bodyEl = container.createDiv({ cls: "iris-hp-list-container" });
    this.bodyEl.tabIndex = -1;
    this.bodyEl.addEventListener("keydown", (e) => this.handleKeydown(e));
    this.bodyEl.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      this.bodyEl.focus({ preventScroll: true });
    });
  }

  private handleKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target.matches("input, textarea")) return;
    if (e.key === "Escape" && this.selectedIds.size > 0) {
      e.preventDefault();
      this.clearSelection();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      e.preventDefault();
      const ids = this.orderedHeadIdsFromDom();
      this.selectedIds = new Set(ids);
      this.selectionAnchorId = ids[0] ?? null;
      this.refreshSelectionClasses();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.selectedIds.size > 1) {
      e.preventDefault();
      const ids = [...this.selectedIds];
      const tasks = (this.getCurrentTasks() ?? []).filter((t) => ids.includes(t.id) && t.source === "manual");
      if (tasks.length > 0) void this.applyBulkDelete(tasks);
    }
  }

  private handleStatusClick(): void {
    switch (this.aiPhase) {
      case "compose-failed":
        this.lastComposeError = null;
        this.perEmailFailedHashes.clear();
        this.aiPhase = "pending";
        this.renderStatus();
        this.scheduleAiPipeline();
        break;
      case "merge-failed":
        this.lastMergeError = null;
        this.mergeFailedKey = null;
        this.aiPhase = "pending";
        this.renderStatus();
        this.scheduleAiPipeline();
        break;
      case "unavailable":
        this.aiPhase = "pending";
        this.renderStatus();
        this.scheduleAiPipeline();
        break;
      default:
        break;
    }
  }

  private render(): void {
    this.ensureLayout();
    this.renderBody();
    this.renderStatus();
  }

  private openOptionsMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Show completed")
        .setChecked(this.getShowCompleted())
        .onClick(async () => {
          this.setShowCompleted(!this.getShowCompleted());
          await this.plugin.saveSettings();
          this.renderBody();
        }),
    );
    if (!this.isWidget) {
      menu.addItem((item) =>
        item
          .setTitle("Actionable only")
          .setChecked(this.getActionableOnly())
          .onClick(async () => {
            this.setActionableOnly(!this.getActionableOnly());
            await this.plugin.saveSettings();
            this.renderBody();
          }),
      );
      menu.addItem((item) =>
        item
          .setTitle("Show archived")
          .setChecked(this.getShowArchived())
          .onClick(async () => {
            this.setShowArchived(!this.getShowArchived());
            await this.plugin.saveSettings();
            this.renderBody();
          }),
      );
    }
    menu.showAtMouseEvent(e);
  }

  private renderStatus(): void {
    if (!this.statusEl) return;
    this.statusEl.empty();
    this.statusEl.removeClass(
      "iris-tasks-status-busy",
      "iris-tasks-status-warn",
      "iris-tasks-status-clickable",
    );

    let icon: string | null = null;
    let title = "";
    let kind: "busy" | "warn" | null = null;
    let clickable = false;
    switch (this.aiPhase) {
      case "composing":
        icon = "loader-2";
        title = "Composing tasks per email with Claude";
        kind = "busy";
        break;
      case "merging":
        icon = "loader-2";
        title = "Grouping new tasks with Claude";
        kind = "busy";
        break;
      case "unavailable":
        icon = "circle-alert";
        title = "No relay or API key configured — showing raw inbox.\nClick to retry.";
        kind = "warn";
        clickable = true;
        break;
      case "compose-failed":
        icon = "circle-alert";
        title = this.lastComposeError
          ? `Per-email compose failed: ${this.lastComposeError}\nClick to retry.`
          : "Per-email compose failed — showing raw inbox.\nClick to retry.";
        kind = "warn";
        clickable = true;
        break;
      case "merge-failed":
        icon = "circle-alert";
        title = this.lastMergeError
          ? `Grouping failed: ${this.lastMergeError}\nClick to retry.`
          : "Grouping failed — new tasks shown ungrouped.\nClick to retry.";
        kind = "warn";
        clickable = true;
        break;
      case "pending":
      case "idle":
      default:
        break;
    }

    if (!icon) {
      this.statusEl.setAttr("aria-hidden", "true");
      this.statusEl.removeAttribute("title");
      return;
    }
    this.statusEl.removeAttribute("aria-hidden");
    if (kind === "busy") this.statusEl.addClass("iris-tasks-status-busy");
    if (kind === "warn") this.statusEl.addClass("iris-tasks-status-warn");
    if (clickable) this.statusEl.addClass("iris-tasks-status-clickable");
    setIcon(this.statusEl, icon);
    this.statusEl.setAttr("aria-label", title);
    this.statusEl.setAttr("title", title);
  }

  /**
   * Render order:
   * - Empty inbox -> empty list.
   * - Any per-email cache hits -> render persisted groups plus a synthetic
   *   "solo" group for any cached candidate not yet attached to a group
   *   (covers in-flight and merge-failed states).
   * - Zero cache hits + small inbox -> raw 1:1 fallback so something
   *   renders before the first compose.
   * - Zero cache hits + bigger inbox -> null placeholder while compose runs.
   */
  private getCurrentTasks(): Task[] | null {
    const raw = getRawMailTodos(this.app);
    let tasks: Task[];
    if (raw.length === 0) {
      tasks = [];
    } else {
      const cache = this.plugin.settings.taskCache;
      const claimed = new Set<string>();
      for (const g of cache.groups) for (const id of g.sourceIds) claimed.add(id);

      const effective: Group[] = cache.groups.map((g) => ({ ...g }));
      let anyHit = false;
      for (const e of raw) {
        const body = getMailTodoBody(this.app, e.id);
        const { hash } = hashEmailContent(e, body, COMPOSE_PROMPT_VERSION);
        const hit = lookupPerEmail(cache, hash);
        if (!hit) continue;
        anyHit = true;
        if (claimed.has(e.id)) continue;
        if (hit.tasks.length === 0) continue;
        const t = hit.tasks[0];
        const received = Date.parse(e.receivedDateTime);
        effective.push({
          id: `solo-${e.id}`,
          title: t.title,
          sourceIds: [e.id],
          createdAt: Number.isFinite(received) ? received : Date.now(),
        });
      }

      if (anyHit) {
        tasks = materialiseGroups(raw, effective, cache.perEmail);
      } else if (this.shouldShowFallback(raw.length)) {
        tasks = getMailTasks(this.app);
      } else {
        return null;
      }
    }
    tasks = [...tasks, ...this.materialiseManualTasks()];
    // Apply manual deps before filtering so blocked-status sees the full graph.
    this.applyManualDependencies(tasks);
    this.sweepOrphanWaits(tasks);
    const cid = this.plugin.settings.currentTaskId;
    if (cid && !tasks.some((t) => t.id === cid)) {
      this.plugin.settings.currentTaskId = null;
      this.plugin.settings.currentTaskTitle = null;
      void this.plugin.saveSettings();
      this.plugin.updateCurrentTaskBar();
    }
    const completedIds = new Set(
      tasks.filter((t) => t.status === "completed").map((t) => t.id),
    );
    const archived = new Set(this.plugin.settings.archivedTaskIds);
    let visible = tasks;
    if (!this.getShowCompleted()) {
      visible = visible.filter((t) => t.status !== "completed");
    }
    if (this.getActionableOnly()) {
      visible = visible.filter(
        (t) => !t.isWait && t.dependsOn.every((d) => completedIds.has(d)),
      );
    }
    if (archived.size > 0 && !this.getShowArchived()) {
      visible = visible.filter((t) => !archived.has(t.id));
    }
    const overrides = this.plugin.settings.taskTitleOverrides;
    const dueOverrides = this.plugin.settings.taskDueDateOverrides;
    visible = visible.map((t) => {
      let patched = t;
      if (overrides[t.id]) patched = { ...patched, title: overrides[t.id] };
      const dueOv = dueOverrides[t.id];
      if (dueOv) patched = { ...patched, dueDate: dueOv.date, dueTime: dueOv.time };
      return patched;
    });
    return visible;
  }

  private materialiseManualTasks(): Task[] {
    const now = Date.now();
    const archived = new Set(this.plugin.settings.archivedTaskIds);
    const manualById = new Map(
      this.plugin.settings.manualTasks.map((m) => [m.id, m]),
    );

    const seriesByMember = new Map<string, TaskSeries>();
    for (const s of this.plugin.settings.taskSeries) {
      for (const mid of s.memberIds) seriesByMember.set(mid, s);
    }

    // Archived members are kept in `memberIds` so unarchive restores them, but
    // they're treated as ineligible to be "current" — like completed members.
    // Non-archived non-current members are hidden as usual; archived members
    // pass through as their own rows so the user can find and unarchive them.
    const hiddenIds = new Set<string>();
    const currentForSeries = new Map<string, { index: number }>();
    for (const series of this.plugin.settings.taskSeries) {
      let currentIdx = -1;
      for (let i = 0; i < series.memberIds.length; i++) {
        const memberId = series.memberIds[i];
        if (archived.has(memberId)) continue;
        const m = manualById.get(memberId);
        if (!m) continue;
        const isWait = m.kind === "wait";
        const elapsed = isWait && this.isWaitElapsed(m, now);
        if (!m.completedAt && !elapsed && currentIdx === -1) currentIdx = i;
      }
      if (currentIdx === -1) {
        for (let i = series.memberIds.length - 1; i >= 0; i--) {
          if (!archived.has(series.memberIds[i])) {
            currentIdx = i;
            break;
          }
        }
        if (currentIdx === -1) currentIdx = series.memberIds.length - 1;
      }
      for (let i = 0; i < series.memberIds.length; i++) {
        const memberId = series.memberIds[i];
        if (i !== currentIdx && !archived.has(memberId)) {
          hiddenIds.add(memberId);
        }
      }
      currentForSeries.set(series.id, { index: currentIdx });
    }

    return this.plugin.settings.manualTasks
      .filter((m) => !hiddenIds.has(m.id))
      .map((m) => {
        const isWait = m.kind === "wait";
        const elapsed = isWait && this.isWaitElapsed(m, now);
        const series = seriesByMember.get(m.id);
        const task: Task = {
          id: m.id,
          title: m.title,
          status: m.completedAt || elapsed ? "completed" : "incomplete",
          priority: null,
          dueDate: m.dueDate,
          dueTime: m.dueTime,
          created: m.createdAt,
          source: "manual",
          sourceIds: [],
          dependsOn: [],
          aiRank: null,
          isWait,
        };
        if (m.autoCompleteWhen) {
          task.autoCompletes = true;
          if (m.autoCompleteWhen.filePath) {
            task.linkedFilePath = m.autoCompleteWhen.filePath;
          }
        } else if (m.autoCompleteWhenWordCount) {
          task.autoCompletes = true;
          task.wordCountTarget = m.autoCompleteWhenWordCount.minWords;
          task.wordCountFilePath = m.autoCompleteWhenWordCount.filePath;
          if (m.autoCompleteWhenWordCount.filePath) {
            task.linkedFilePath = m.autoCompleteWhenWordCount.filePath;
          }
        } else if (m.autoCompletes) {
          task.autoCompletes = true;
        }
        if (m.onClickCommand) {
          task.onClickCommand = m.onClickCommand;
        }
        if (series) {
          const cur = currentForSeries.get(series.id);
          const ownIdx = series.memberIds.indexOf(m.id);
          task.seriesId = series.id;
          // Archived members surface as their own rows — show their actual
          // position, not the current member's.
          task.seriesIndex =
            (archived.has(m.id) ? ownIdx : (cur?.index ?? 0)) + 1;
          task.seriesTotal = series.memberIds.length;
        }
        return task;
      });
  }

  private buildModuleIconCache(): Map<string, string | null> {
    const cache = new Map<string, string | null>();
    const folder = this.app.vault.getFolderByPath("Modules");
    if (!folder || !(folder instanceof TFolder)) return cache;
    Vault.recurseChildren(folder, (child) => {
      if (!(child instanceof TFile) || child.extension !== "md") return;
      const fm = this.app.metadataCache.getFileCache(child)?.frontmatter;
      if (!fm) return;
      const code = fm["module"];
      if (typeof code !== "string" || !code.trim()) return;
      const icon = fm["icon"];
      cache.set(code.trim(), typeof icon === "string" && icon.trim() ? icon.trim() : null);
    });
    return cache;
  }

  private resolveModuleIcon(task: Task): string | null {
    if (!task.linkedFilePath) return null;
    const match = task.linkedFilePath.match(/^Lectures\/([A-Za-z]+\d+)\s/);
    if (!match) return null;
    if (!this.moduleIconCache) this.moduleIconCache = this.buildModuleIconCache();
    return this.moduleIconCache.get(match[1]) ?? null;
  }

  /** A wait task is "elapsed" once we're past its dueDate (start-of-day if no time). */
  private isWaitElapsed(m: ManualTask, now: number): boolean {
    if (!m.dueDate) return false;
    const iso = m.dueTime ? `${m.dueDate}T${m.dueTime}` : `${m.dueDate}T00:00:00`;
    const due = Date.parse(iso);
    if (isNaN(due)) return false;
    return now >= due;
  }

  /**
   * Merge user-declared prerequisites into each task's `dependsOn`. Read-only
   * with respect to settings — never prunes the map, since a task's absence
   * here can be transient (filter toggles, completion + showCompleted=off,
   * mid-AI-recompose). Stale entries simply get ignored on render and persist
   * silently for when the task reappears.
   */
  private applyManualDependencies(tasks: Task[]): void {
    const map = this.plugin.settings.manualDependencies;
    if (Object.keys(map).length === 0) return;
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    for (const [taskId, deps] of Object.entries(map)) {
      const t = taskById.get(taskId);
      if (!t) continue;
      for (const dep of deps) {
        if (dep === taskId || !taskById.has(dep)) continue;
        if (!t.dependsOn.includes(dep)) t.dependsOn.push(dep);
      }
    }
  }

  /**
   * Wait pseudo-tasks exist only to gate something else. Once nothing
   * (visible or hidden-by-completion, but not archived/cleared) references
   * a wait task in its `dependsOn`, the wait has no purpose — drop it from
   * settings and the in-flight task list.
   */
  private sweepOrphanWaits(tasks: Task[]): void {
    const archived = new Set(this.plugin.settings.archivedTaskIds);
    const referenced = new Set<string>();
    for (const t of tasks) {
      if (archived.has(t.id)) continue;
      for (const dep of t.dependsOn) referenced.add(dep);
    }
    for (const deps of Object.values(this.plugin.settings.manualDependencies)) {
      for (const dep of deps) referenced.add(dep);
    }
    const orphanIds = new Set(
      tasks.filter((t) => t.isWait && !referenced.has(t.id)).map((t) => t.id),
    );
    if (orphanIds.size === 0) return;

    this.plugin.settings.manualTasks = this.plugin.settings.manualTasks.filter(
      (m) => !orphanIds.has(m.id),
    );
    const map = this.plugin.settings.manualDependencies;
    for (const k of Object.keys(map)) {
      const filtered = map[k].filter((d) => !orphanIds.has(d));
      if (filtered.length !== map[k].length) {
        if (filtered.length === 0) delete map[k];
        else map[k] = filtered;
      }
    }
    void this.plugin.saveSettings();
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (orphanIds.has(tasks[i].id)) tasks.splice(i, 1);
    }
  }

  private shouldShowFallback(rawCount: number): boolean {
    if (rawCount < 2) return true;
    return false;
  }

  private placeholderText(): string {
    switch (this.aiPhase) {
      case "unavailable":
        return "Waiting for AI…";
      case "compose-failed":
        return "Compose failed — retrying…";
      case "merging":
      case "composing":
      case "pending":
      case "idle":
      case "merge-failed":
      default:
        return "Composing…";
    }
  }

  /** DOM nodes for rows currently in the list, keyed by row signature. */
  private renderedRows = new Map<string, HTMLElement>();

  /** Task id currently being dragged (set on dragstart, cleared on dragend). */
  private draggingTaskId: string | null = null;
  /** Set during a multi-selection drag — head ids in display order. Empty for single-drag. */
  private draggingGroupHeadIds: string[] = [];
  /**
   * Resolved drop position during a drag. `beforeTaskId` means insert source
   * just above that row; `atEnd: true` means append at the end of the list.
   * Lower-halves of rows resolve to the next row's "above" so the gap between
   * any two consecutive rows is one snap location, not two.
   */
  private dropBeforeId: string | null = null;
  /** Head id of the drop target row — used by group drag where head ids drive the reorder. */
  private dropBeforeHeadId: string | null = null;
  private dropAtEnd = false;

  /**
   * Sort by `plugin.settings.taskOrder` first; tasks not in that list fall to
   * the bottom in their original order. Stale ids in `taskOrder` (no matching
   * task) are skipped here — they get pruned the next time the user drops a row.
   */
  private applyUserOrder(tasks: Task[]): Task[] {
    const orderList = this.plugin.settings.taskOrder ?? [];
    const orderIndex = new Map<string, number>();
    for (let i = 0; i < orderList.length; i++) orderIndex.set(orderList[i], i);
    const placed: Task[] = [];
    const unplaced: Task[] = [];
    for (const t of tasks) {
      if (orderIndex.has(t.id)) placed.push(t);
      else unplaced.push(t);
    }
    placed.sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));
    return [...placed, ...unplaced];
  }

  private rowKey(row: Row): string {
    // extendDown is part of the key so a row is rebuilt when its siblings
    // appear/disappear and its connector shape needs to change.
    return (
      row.lineage
        .map((n) => n.task.id + (n.extendDown ? "+" : ""))
        .join(">") +
      ":" +
      row.branchAt
    );
  }

  private renderBody(): void {
    this.moduleIconCache = null;
    // Detach the create entry around reconcile — the patch loop trims
    // children, which would otherwise wipe it out.
    if (this.createEntryEl?.parentElement === this.bodyEl) {
      this.bodyEl.removeChild(this.createEntryEl);
    }
    this.renderBodyImpl();
    this.ensureCreateEntry();
  }

  private renderBodyImpl(): void {
    const tasks = this.getCurrentTasks();

    if (tasks === null) {
      this.plugin.topTaskTitle = null;
      this.bodyEl.empty();
      this.renderedRows.clear();
      const placeholder = this.bodyEl.createDiv({ cls: "iris-hp-empty" });
      placeholder.setText(this.placeholderText());
      return;
    }
    if (tasks.length === 0) {
      this.plugin.topTaskTitle = null;
      this.bodyEl.empty();
      this.renderedRows.clear();
      const empty = this.bodyEl.createDiv({ cls: "iris-hp-empty" });
      empty.setText("No tasks found");
      return;
    }

    const ordered = this.applyUserOrder(tasks);
    this.plugin.topTaskTitle = ordered[0]?.title ?? null;
    console.debug(
      "[iris-tasks] order:",
      ordered.map((t) => `${t.composedId ?? t.id}:r${t.aiRank}:${t.priority ?? "-"}:${t.dueDate ?? "-"}`).join(" | "),
    );
    const chains = buildChains(ordered);
    const rows = flattenForest(buildForest(chains));

    // If the body is showing the placeholder/empty div, swap to a fresh list.
    const first = this.bodyEl.firstElementChild;
    const showingList = first != null && !first.classList.contains("iris-hp-empty");
    if (!showingList) {
      this.bodyEl.empty();
      this.renderedRows.clear();
      for (const row of rows) {
        const el = this.buildRowElement(row);
        this.bodyEl.appendChild(el);
        this.renderedRows.set(this.rowKey(row), el);
      }
      return;
    }

    // Reconcile: keep matching row elements in place; insert, move, or remove
    // only what changed. Preserves DOM identity (and listeners) for unchanged
    // rows so a single-task add doesn't tear the list down.
    let cursor: ChildNode | null = this.bodyEl.firstChild;
    const newKeys = new Set<string>();
    for (const row of rows) {
      const key = this.rowKey(row);
      newKeys.add(key);
      const existing = this.renderedRows.get(key);
      if (existing) {
        this.patchRowElement(existing, row);
        if (existing === cursor) {
          cursor = cursor.nextSibling;
        } else {
          this.bodyEl.insertBefore(existing, cursor);
        }
      } else {
        const fresh = this.buildRowElement(row);
        this.bodyEl.insertBefore(fresh, cursor);
        this.renderedRows.set(key, fresh);
        fresh.addClass("iris-hp-enter");
        fresh.addEventListener(
          "animationend",
          () => fresh.removeClass("iris-hp-enter"),
          { once: true },
        );
      }
    }
    while (cursor) {
      const next: ChildNode | null = cursor.nextSibling;
      this.bodyEl.removeChild(cursor);
      cursor = next;
    }
    for (const k of [...this.renderedRows.keys()]) {
      if (!newKeys.has(k)) this.renderedRows.delete(k);
    }
  }

  private ensureCreateEntry(): void {
    if (!this.getShowCreateTaskEntry()) {
      this.createEntryEl = null;
      return;
    }
    if (this.createEntryEl?.parentElement === this.bodyEl) {
      this.bodyEl.prepend(this.createEntryEl);
    }
  }

  private activateCreateEntry(): void {
    if (!this.createEntryEl) {
      this.createEntryEl = document.createElement("div");
      this.createEntryEl.addClass("iris-hp-list-item");
      this.createEntryEl.addClass("iris-tasks-create-entry");
    }
    this.bodyEl.prepend(this.createEntryEl);
    this.renderCreateEntryEditing(this.createEntryEl);
  }

  private removeCreateEntry(): void {
    if (this.createEntryEl?.parentElement) {
      this.createEntryEl.remove();
    }
  }

  private renderCreateEntryEditing(el: HTMLElement): void {
    el.empty();
    el.addClass("is-editing");
    el.onclick = null;
    const self = el.createDiv({ cls: "iris-hp-list-item-self iris-tasks-create-entry-self" });
    self.createSpan({ cls: "iris-tasks-drag-handle iris-tasks-ghost" });
    const input = self.createEl("input", {
      type: "text",
      cls: "iris-tasks-create-entry-input",
    });
    input.placeholder = "Task name…";

    const submit = async (): Promise<void> => {
      const title = input.value.trim();
      if (!title) {
        this.removeCreateEntry();
        return;
      }
      input.disabled = true;
      const id =
        "m-" +
        Math.random().toString(36).slice(2, 10) +
        Date.now().toString(36);
      this.plugin.settings.manualTasks.push({
        id,
        title,
        dueDate: null,
        dueTime: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      await this.plugin.saveSettings();
      this.removeCreateEntry();
      TaskView.refreshAll();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.removeCreateEntry();
      }
    });
    input.addEventListener("blur", () => {
      if (input.disabled) return;
      if (!input.value.trim()) this.removeCreateEntry();
    });
    input.focus();
  }

  /** Build (but don't attach) the DOM for one row. */
  private buildRowElement(row: Row): HTMLElement {
    const head = row.lineage[0].task;
    const leaf = row.lineage[row.lineage.length - 1].task;
    const displayed = row.lineage.slice(row.branchAt);
    const hidden = row.lineage.slice(0, row.branchAt);
    const item = document.createElement("div");
    item.addClass("iris-hp-list-item");
    item.dataset.taskId = leaf.id;
    item.dataset.headId = head.id;
    // Make the whole row draggable so users can grab anywhere on it. When
    // embedded as a homepage widget, the wrapper is also draggable=true; the
    // browser picks the closest ancestor, so the row wins over the wrapper.
    item.setAttribute("draggable", "true");
    this.attachItemDragHandlers(item, leaf.id, head.id);
    const isBranch = !row.isFirstRow;
    const headIsWait = !!head.isWait;
    const showCheckbox = row.isFirstRow && !headIsWait && !head.autoCompletes;
    const selfClasses = ["iris-hp-list-item-self", "is-clickable"];
    if (head.status === "completed") selfClasses.push("is-completed");
    if (isBranch) selfClasses.push("is-branch-row");
    if (this.plugin.settings.enableCurrentTask && this.plugin.settings.currentTaskId === head.id) selfClasses.push("is-current-task");
    if (this.plugin.settings.archivedTaskIds.includes(head.id)) {
      selfClasses.push("is-archived");
    }
    if (this.selectedIds.has(head.id)) selfClasses.push("is-selected");
    const self = item.createDiv({ cls: selfClasses.join(" ") });

    self.addEventListener("click", (e) => {
      if (e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        this.extendSelectionTo(head.id);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleSelection(head.id);
        return;
      }
      if (this.selectedIds.size > 0) this.clearSelection();
      // Plain clicks no longer set the current task — that's a deliberate
      // action via the row's context menu. This keeps incidental clicks
      // (e.g. while reading the list) from changing app state.
    });

    this.attachDragHandle(self, leaf.id, head.id);
    this.attachDropTarget(item, leaf.id);

    if (showCheckbox) {
      const checkbox = self.createEl("input", { cls: "task-list-item-checkbox", type: "checkbox" });
      checkbox.checked = head.status === "completed";
      checkbox.addEventListener("click", (e) => {
        e.stopPropagation();
        this.handleComplete(head);
      });
    } else if (row.isFirstRow && head.autoCompletes) {
      // Auto-completing tasks can't be manually checked off — show a uniform
      // muted indicator in place of a checkbox. The destination-specific
      // glyph (lecture / mail / iris-cards / file / command) lives in the
      // trailing nav icon next to the title.
      const iconEl = self.createDiv({ cls: "iris-tasks-auto-icon" });
      setIcon(iconEl, "circle-dashed");
    } else {
      self.createEl("input", {
        cls: "task-list-item-checkbox iris-tasks-ghost",
        type: "checkbox",
      });
    }

    const inner = self.createDiv({ cls: "iris-hp-list-item-inner" });
    // Hidden prefix: ghost segments + ghost connectors between them, matching
    // the trunk row's layout above so visible content lines up exactly.
    for (let i = 0; i < hidden.length; i++) {
      if (i > 0) inner.appendChild(this.buildGhostConnector());
      inner.createSpan({
        cls: "iris-tasks-title-link iris-tasks-ghost",
        text: hidden[i].task.title,
      });
    }
    // Visible content: leading top-entering connector for branch rows, then
    // each displayed segment with a left-entering connector before it.
    for (let i = 0; i < displayed.length; i++) {
      const node = displayed[i];
      const isLeading = i === 0;
      if (isLeading && isBranch) {
        inner.appendChild(this.buildConnector("top", node.extendDown));
      } else if (!isLeading) {
        inner.appendChild(this.buildConnector("left", node.extendDown));
      }
      if (i === displayed.length - 1) {
        const trLink = this.plugin.taskRatchetLinkForTask(node.task.id);
        if (trLink) {
          const gear = inner.createSpan({ cls: `iris-tasks-tr-lock iris-tasks-tr-lock-${trLink.status}` });
          gear.setAttribute("aria-label", `TaskRatchet: ${formatStake(trLink.cents)} (${trLink.status})`);
          setIcon(gear, "lock");
          if (trLink.status === "pending") {
            gear.addEventListener("click", (e) => {
              e.stopPropagation();
              showTaskRatchetGearMenu(this.plugin, node.task.id, trLink, e);
            });
          }
        }
      }
      this.appendNavIcon(inner, node.task);
      this.appendTitleSegment(inner, node.task);
      if (i === displayed.length - 1 && node.task.seriesId) {
        inner.createSpan({
          cls: "iris-tasks-series-badge",
          text: `${node.task.seriesIndex}/${node.task.seriesTotal}`,
        });
      }
      if (i === displayed.length - 1 && node.task.wordCountTarget && node.task.wordCountFilePath) {
        const current = this.plugin.wordCountCache.get(node.task.wordCountFilePath) ?? 0;
        const target = node.task.wordCountTarget;
        const badge = inner.createSpan({
          cls: "iris-tasks-wc-badge" + (current >= target ? " iris-tasks-wc-done" : ""),
          text: `${current}/${target}`,
        });
        if (current === 0) {
          const fp = node.task.wordCountFilePath;
          const file = this.app.vault.getAbstractFileByPath(fp);
          if (file instanceof TFile) {
            this.app.vault.cachedRead(file).then((content) => {
              const count = this.plugin.countWords(content);
              this.plugin.wordCountCache.set(fp, count);
              badge.textContent = `${count}/${target}`;
              if (count >= target) badge.addClass("iris-tasks-wc-done");
            });
          }
        }
      }
    }
    return item;
  }

  /**
   * Insert a small grip handle at the start of the row's self container.
   * The handle is the only draggable element — clicks on the checkbox or
   * title links are unaffected.
   */
  private attachDragHandle(self: HTMLElement, _taskId: string, _headId: string): void {
    // The whole row is the draggable element (see buildRowElement). The handle
    // here is a visual cue only — its grip dots show on hover so users know
    // where to grab. All dragstart/dragend wiring lives in attachItemDragHandlers.
    const handle = document.createElement("span");
    handle.addClass("iris-tasks-drag-handle");
    handle.setAttribute("aria-label", "Drag to reorder");

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 10 16");
    svg.setAttribute("aria-hidden", "true");
    for (const [cx, cy] of [[3, 3], [7, 3], [3, 8], [7, 8], [3, 13], [7, 13]]) {
      const c = document.createElementNS(svgNS, "circle");
      c.setAttribute("cx", String(cx));
      c.setAttribute("cy", String(cy));
      c.setAttribute("r", "1.2");
      svg.appendChild(c);
    }
    handle.appendChild(svg);

    self.insertBefore(handle, self.firstChild);
  }

  /**
   * Wire dragstart/dragend on the row item. The whole row is draggable so the
   * user can grab anywhere on it (hovering the small grip-handle is too fiddly,
   * especially inside the iris-homepage widget where the host wrapper is also
   * draggable=true and would otherwise intercept the drag).
   */
  private attachItemDragHandlers(item: HTMLElement, taskId: string, headId: string): void {
    item.addEventListener("dragstart", (e) => {
      // Don't initiate a row drag from inputs (e.g. the inline-rename field).
      if ((e.target as HTMLElement).closest("input, textarea")) {
        e.preventDefault();
        return;
      }
      // Stop the host's grid-level dragstart (iris-homepage widget reorder).
      e.stopPropagation();
      this.draggingTaskId = taskId;
      this.dropBeforeId = null;
      this.dropAtEnd = false;
      if (this.selectedIds.has(headId) && this.selectedIds.size > 1) {
        this.draggingGroupHeadIds = this.orderedHeadIdsFromDom().filter((id) => this.selectedIds.has(id));
        for (const hid of this.draggingGroupHeadIds) {
          const row = this.bodyEl.querySelector<HTMLElement>(
            `.iris-hp-list-item[data-head-id="${CSS.escape(hid)}"]`,
          );
          row?.classList.add("is-dragging");
        }
      } else {
        this.draggingGroupHeadIds = [];
        item.classList.add("is-dragging");
      }
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", taskId);
        // Cross-plugin payload: lets iris-calendar (or any drop target) pick
        // up enough metadata to reschedule via upsertExternalTask. Set for
        // all draggable rows — manual, mail-derived, or otherwise.
        const tasks = this.getCurrentTasks();
        const task = tasks?.find((t) => t.id === taskId);
        const manual = this.plugin.settings.manualTasks.find((m) => m.id === taskId);
        const title = manual?.title ?? task?.title ?? "";
        const durationMin = manual?.durationMin ?? null;
        if (title) {
          e.dataTransfer.setData(
            "application/x-iris-task",
            JSON.stringify({ id: taskId, title, durationMin }),
          );
        }
      }
    });
    item.addEventListener("dragend", () => {
      this.draggingTaskId = null;
      this.draggingGroupHeadIds = [];
      this.dropBeforeId = null;
      this.dropBeforeHeadId = null;
      this.dropAtEnd = false;
      this.clearDropIndicators();
      this.bodyEl.querySelectorAll(".is-dragging").forEach((el) => {
        el.classList.remove("is-dragging");
      });
    });
  }

  /** Remove every drop indicator class from the list. */
  private clearDropIndicators(): void {
    this.bodyEl.querySelectorAll(".is-drop-above, .is-drop-below").forEach((el) => {
      el.classList.remove("is-drop-above", "is-drop-below");
    });
  }

  /**
   * Wire the row as a drop target. Cursor in upper half → drop above this
   * row; cursor in lower half → drop above the *next* row (or append if
   * this row is last). Collapsing those to a single gap position prevents
   * the "two snaps between rows" effect.
   */
  private attachDropTarget(item: HTMLElement, taskId: string): void {
    const isInDraggedSet = (el: HTMLElement | null): boolean => {
      if (!el) return false;
      if (this.draggingGroupHeadIds.length > 0) {
        const hid = el.dataset.headId;
        return !!hid && this.draggingGroupHeadIds.includes(hid);
      }
      return el.dataset.taskId === this.draggingTaskId;
    };

    item.addEventListener("dragover", (e) => {
      if (!this.draggingTaskId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = item.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      this.clearDropIndicators();
      if (above) {
        if (isInDraggedSet(item)) {
          this.dropBeforeId = null;
          this.dropBeforeHeadId = null;
          this.dropAtEnd = false;
          return;
        }
        item.classList.add("is-drop-above");
        this.dropBeforeId = taskId;
        this.dropBeforeHeadId = item.dataset.headId ?? null;
        this.dropAtEnd = false;
      } else {
        const next = item.nextElementSibling as HTMLElement | null;
        const nextIsRow = !!next && next.classList.contains("iris-hp-list-item");
        if (nextIsRow && next) {
          if (isInDraggedSet(next) || isInDraggedSet(item)) {
            this.dropBeforeId = null;
            this.dropBeforeHeadId = null;
            this.dropAtEnd = false;
            return;
          }
          next.classList.add("is-drop-above");
          this.dropBeforeId = next.dataset.taskId ?? "";
          this.dropBeforeHeadId = next.dataset.headId ?? null;
          this.dropAtEnd = false;
        } else {
          if (isInDraggedSet(item)) {
            this.dropBeforeId = null;
            this.dropBeforeHeadId = null;
            this.dropAtEnd = false;
            return;
          }
          item.classList.add("is-drop-below");
          this.dropBeforeId = null;
          this.dropBeforeHeadId = null;
          this.dropAtEnd = true;
        }
      }
    });
    item.addEventListener("drop", (e) => {
      const sourceId = this.draggingTaskId;
      if (!sourceId) return;
      e.preventDefault();
      const before = this.dropBeforeId;
      const beforeHead = this.dropBeforeHeadId;
      const atEnd = this.dropAtEnd;
      const groupIds = [...this.draggingGroupHeadIds];
      this.clearDropIndicators();
      this.dropBeforeId = null;
      this.dropBeforeHeadId = null;
      this.dropAtEnd = false;
      if (!atEnd && !before) return;
      if (groupIds.length > 0) {
        void this.reorderTasksBulk(groupIds, beforeHead, atEnd);
      } else {
        void this.reorderTasks(sourceId, before, atEnd);
      }
    });
  }

  /**
   * Move a group of head ids (a multi-selection) together. They keep their
   * current relative order and land just above `beforeHeadId`, or appended
   * if `atEnd`.
   */
  private async reorderTasksBulk(
    headIds: string[],
    beforeHeadId: string | null,
    atEnd: boolean,
  ): Promise<void> {
    if (headIds.length === 0) return;
    const tasks = this.getCurrentTasks();
    if (!tasks) return;
    const ordered = this.applyUserOrder(tasks);
    const ids = ordered.map((t) => t.id);
    const movingSet = new Set(headIds);
    // Preserve current relative order of moved items.
    const moving = ids.filter((id) => movingSet.has(id));
    if (moving.length === 0) return;
    const remaining = ids.filter((id) => !movingSet.has(id));
    let dstIdx: number;
    if (atEnd) {
      dstIdx = remaining.length;
    } else {
      if (!beforeHeadId) return;
      dstIdx = remaining.indexOf(beforeHeadId);
      if (dstIdx === -1) return;
    }
    remaining.splice(dstIdx, 0, ...moving);
    this.plugin.settings.taskOrder = remaining;
    await this.plugin.saveSettings();
    this.renderBody();
  }

  /**
   * Move `sourceId` to land just above `beforeId`, or append if `atEnd`.
   *
   * Algorithm: take the currently-displayed task ordering as the basis (so
   * dragging one task doesn't reshuffle anything else), splice the source
   * into its new spot, and write that out as the new `taskOrder`.
   */
  private async reorderTasks(
    sourceId: string,
    beforeId: string | null,
    atEnd: boolean,
  ): Promise<void> {
    const tasks = this.getCurrentTasks();
    if (!tasks) return;
    const ordered = this.applyUserOrder(tasks);
    const ids = ordered.map((t) => t.id);
    const srcIdx = ids.indexOf(sourceId);
    if (srcIdx === -1) return;
    ids.splice(srcIdx, 1);
    let dstIdx: number;
    if (atEnd) {
      dstIdx = ids.length;
    } else {
      if (!beforeId) return;
      dstIdx = ids.indexOf(beforeId);
      if (dstIdx === -1) return;
    }
    ids.splice(dstIdx, 0, sourceId);
    this.plugin.settings.taskOrder = ids;
    await this.plugin.saveSettings();
    this.renderBody();
  }

  /** Inline SVG connector between two tasks. */
  private buildConnector(enter: "left" | "top", extendDown: boolean): HTMLElement {
    const svgNS = "http://www.w3.org/2000/svg";
    const wrapper = document.createElement("span");
    wrapper.addClass("iris-tasks-connector");
    wrapper.addClass(`iris-tasks-connector-${enter}`);
    if (extendDown) wrapper.addClass("iris-tasks-connector-extend");

    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 30 30");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("shape-rendering", "geometricPrecision");

    // Branch-point centred at (15, 15) within the 30-unit viewBox. When the
    // main line continues past the branch, the vertical is drawn as one
    // straight stroke and the curve branches off it — so the strokes meet
    // cleanly without a gap between the curve start and the extension.
    const makePath = (d: string): SVGPathElement => {
      const p = document.createElementNS(svgNS, "path");
      p.setAttribute("d", d);
      // Set as attribute (not just CSS) so the stroke stays at its actual
      // pixel width regardless of how the viewBox is scaled to fit.
      p.setAttribute("vector-effect", "non-scaling-stroke");
      return p;
    };
    const main = makePath("");
    if (enter === "left") {
      main.setAttribute("d", "M 0 15 L 24 15");
      svg.appendChild(main);
      if (extendDown) svg.appendChild(makePath("M 7 15 Q 15 15 15 23 L 15 40"));
    } else if (extendDown) {
      main.setAttribute("d", "M 15 -10 L 15 40");
      svg.appendChild(main);
      svg.appendChild(makePath("M 15 7 Q 15 15 23 15 L 24 15"));
    } else {
      main.setAttribute("d", "M 15 -10 L 15 7 Q 15 15 23 15 L 24 15");
      svg.appendChild(main);
    }
    // Arrowhead at the task entrance (every connector terminates at (30, 15)).
    const arrow = document.createElementNS(svgNS, "path");
    // Equilateral: horizontal width 5.5 → base length 11/√3 ≈ 6.351.
    arrow.setAttribute("d", "M 24.5 11.825 L 30 15 L 24.5 18.175 Z");
    arrow.setAttribute("class", "iris-tasks-connector-arrow");
    svg.appendChild(arrow);

    wrapper.appendChild(svg);
    return wrapper;
  }

  /** Same footprint as a connector but invisible — used for layout in branch row prefixes. */
  private buildGhostConnector(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.addClass("iris-tasks-connector");
    wrapper.addClass("iris-tasks-ghost");
    return wrapper;
  }

  /** Update mutable state (completion, titles) on an existing row element. */
  private patchRowElement(item: HTMLElement, row: Row): void {
    const head = row.lineage[0].task;
    const self = item.querySelector<HTMLElement>(".iris-hp-list-item-self");
    if (self) self.classList.toggle("is-completed", head.status === "completed");
    if (self) self.classList.toggle("is-current-task", this.plugin.settings.enableCurrentTask && this.plugin.settings.currentTaskId === head.id);
    if (self) self.classList.toggle("is-selected", this.selectedIds.has(head.id));
    const checkbox = item.querySelector<HTMLInputElement>(
      ".task-list-item-checkbox:not(.iris-tasks-ghost)",
    );
    if (checkbox) checkbox.checked = head.status === "completed";
    const visible = item.querySelectorAll<HTMLElement>(
      ".iris-tasks-title-link:not(.iris-tasks-ghost)",
    );
    const displayed = row.lineage.slice(row.branchAt);
    for (let i = 0; i < Math.min(displayed.length, visible.length); i++) {
      if (visible[i].textContent !== displayed[i].task.title) {
        visible[i].textContent = displayed[i].task.title;
      }
    }
    const ghosts = item.querySelectorAll<HTMLElement>(
      ".iris-tasks-title-link.iris-tasks-ghost",
    );
    const hidden = row.lineage.slice(0, row.branchAt);
    for (let i = 0; i < Math.min(hidden.length, ghosts.length); i++) {
      if (ghosts[i].textContent !== hidden[i].task.title) {
        ghosts[i].textContent = hidden[i].task.title;
      }
    }
  }

  private appendTitleSegment(parent: HTMLElement, task: Task): void {
    // Title is plain text — navigation lives in the trailing nav icon, and
    // "set as current task" lives in the right-click menu. Plain clicks on
    // the title bubble to the row handler (which only manages selection).
    const cls = task.isWait
      ? "iris-tasks-title-link iris-tasks-wait-segment"
      : "iris-tasks-title-link";
    const span = parent.createSpan({ cls, text: task.title });
    span.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (task.isWait) return;
      this.startInlineRename(span, task);
    });
    span.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.selectedIds.has(task.id) && this.selectedIds.size > 1) {
        this.openBulkContextMenu(e);
      } else {
        if (this.selectedIds.size > 0) this.clearSelection();
        this.openContextMenu(task, e);
      }
    });
  }

  /**
   * Trailing icon next to a title segment that navigates to the task's
   * source. Icon glyph reflects what pressing it will do:
   *   - mail email          → mail
   *   - iris-cards review   → loader (matches the spinner used elsewhere)
   *   - other command       → play
   *   - lecture note        → graduation-cap
   *   - other vault file    → file-text
   * Wait tasks have no destination, so they get no icon.
   */
  private appendNavIcon(parent: HTMLElement, task: Task): void {
    if (task.isWait) return;
    let iconName: string;
    let label: string;
    if (task.onClickCommand) {
      if (task.onClickCommand.startsWith("iris-cards:")) {
        iconName = "loader";
        label = "Review flashcards";
      } else {
        iconName = "play";
        label = "Run command";
      }
    } else if (task.linkedFilePath) {
      if (task.linkedFilePath.startsWith("Lectures/")) {
        iconName = "graduation-cap";
        label = "Open lecture";
      } else {
        iconName = "file-text";
        label = "Open file";
      }
    } else {
      iconName = "mail";
      label = "Open email";
    }
    const icon = parent.createSpan({ cls: "iris-tasks-nav-icon" });
    icon.setAttribute("aria-label", label);
    setIcon(icon, iconName);
    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (task.onClickCommand) {
        (this.app as any).commands.executeCommandById(task.onClickCommand);
        return;
      }
      if (task.linkedFilePath) {
        if (this.isWidget) {
          const file = this.app.vault.getAbstractFileByPath(task.linkedFilePath);
          if (file instanceof TFile) {
            this.app.workspace.getLeaf(false).openFile(file);
          }
        } else {
          this.app.workspace.openLinkText(task.linkedFilePath, "", false);
        }
        return;
      }
      this.openMailModal(task);
    });
  }

  private openContextMenu(task: Task, e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Rename…")
        .setIcon("pencil")
        .onClick(() => this.openRenameModal(task)),
    );
    if (this.plugin.settings.enableCurrentTask && !task.isWait) {
      const isCurrent = this.plugin.settings.currentTaskId === task.id;
      menu.addItem((i) =>
        i
          .setTitle(isCurrent ? "Clear current task" : "Set as current task")
          .setIcon(isCurrent ? "circle-x" : "target")
          .onClick(() => {
            if (isCurrent) void this.plugin.clearCurrentTask();
            else void this.plugin.setCurrentTask(task.id, task.title);
          }),
      );
    }
    if (task.source === "manual" && !task.isWait) {
      menu.addItem((i) =>
        i
          .setTitle("Add variation…")
          .setIcon("layers")
          .onClick(() => this.openAddVariationModal(task)),
      );
    }
    if (task.seriesId) {
      menu.addItem((i) =>
        i
          .setTitle("View series…")
          .setIcon("list-ordered")
          .onClick(() => this.openSeriesModal(task)),
      );
    }
    menu.addItem((i) =>
      i
        .setTitle("Add prerequisite…")
        .setIcon("link")
        .onClick(() => this.openPrerequisitePicker(task)),
    );
    const dueCaps = editCapabilities(this.plugin, task.id);
    if (dueCaps.canSetDue !== "blocked") {
      const hasDue = !!(task.dueDate);
      menu.addItem((i) =>
        i
          .setTitle(hasDue ? "Change deadline…" : "Set deadline…")
          .setIcon("calendar")
          .onClick(() => this.openSetDeadlineModal(task)),
      );
      if (hasDue) {
        menu.addItem((i) =>
          i
            .setTitle("Clear deadline")
            .setIcon("calendar-x")
            .onClick(() => void this.applyClearDeadline(task)),
        );
      }
      menu.addItem((i) =>
        i
          .setTitle("Start now")
          .setIcon("play")
          .onClick(() => {
            const mt = this.plugin.settings.manualTasks.find((m) => m.id === task.id);
            if (!mt?.durationMin) {
              new Notice("Set a duration on this task first.");
              return;
            }
            const end = new Date(Date.now() + mt.durationMin * 60_000);
            const date = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
            const time = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
            void this.applySetDeadline(task, date, time);
          }),
      );
    }
    if (this.plugin.settings.taskratchetEnabled) {
      menu.addSeparator();
      const trLink = this.plugin.taskRatchetLinkForTask(task.id);
      if (!trLink) {
        menu.addItem((i) =>
          i
            .setTitle("TaskRatchet")
            .setIcon("lock")
            .onClick(() =>
              void this.plugin.stakeTaskRatchet(
                task.id,
                task.title,
                task.dueDate,
                task.dueTime,
              ),
            ),
        );
      } else {
        menu.addItem((i) =>
          i
            .setTitle(`Staked ${formatStake(trLink.cents)} (${trLink.status})`)
            .setDisabled(true),
        );
        if (trLink.status === "pending") {
          menu.addItem((i) =>
            i
              .setTitle("Forfeit stake (uncle)")
              .setIcon("flag")
              .onClick(() => {
                if (
                  confirm(
                    `Forfeit ${formatStake(trLink.cents)}? Your card will be charged immediately.`,
                  )
                ) {
                  void this.plugin.uncleTaskRatchet(task.id);
                }
              }),
          );
        }
      }
    }
    menu.addSeparator();
    const taskCaps = editCapabilities(this.plugin, task.id);
    const isArchived = this.plugin.settings.archivedTaskIds.includes(task.id);
    if (isArchived) {
      menu.addItem((i) =>
        i
          .setTitle("Unarchive")
          .setIcon("archive-restore")
          .onClick(() => this.applyUnarchive(task)),
      );
    } else if (taskCaps.canArchive) {
      menu.addItem((i) =>
        i
          .setTitle("Archive")
          .setIcon("archive")
          .onClick(() => this.applyArchive(task)),
      );
    }
    if (task.source === "manual" && taskCaps.canDelete) {
      menu.addItem((i) =>
        i
          .setTitle("Delete")
          .setIcon("trash-2")
          .onClick(() => this.applyDelete(task)),
      );
    }
    menu.showAtMouseEvent(e);
  }

  private openRenameModal(task: Task): void {
    new RenameTaskModal(this.app, task.title, (next) =>
      this.applyRename(task, next),
    ).open();
  }

  private startInlineRename(span: HTMLElement, task: Task): void {
    if (span.querySelector("input")) return;
    const original = span.textContent ?? task.title;
    const input = document.createElement("input");
    input.type = "text";
    input.value = original;
    input.addClass("iris-tasks-inline-rename");
    span.textContent = "";
    span.appendChild(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = (commit: boolean): void => {
      if (finished) return;
      finished = true;
      const next = input.value;
      span.textContent = original;
      if (commit) void this.applyRename(task, next);
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
      e.stopPropagation();
    });
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  private async applyRename(task: Task, nextTitle: string): Promise<void> {
    const trimmed = nextTitle.trim();
    if (!trimmed || trimmed === task.title) return;
    const caps = editCapabilities(this.plugin, task.id);
    if (!caps.canRename) {
      new Notice(lockReason(caps));
      return;
    }
    if (task.source === "manual") {
      const list = this.plugin.settings.manualTasks;
      const idx = list.findIndex((m) => m.id === task.id);
      if (idx === -1) return;
      list[idx] = { ...list[idx], title: trimmed };
    } else {
      this.plugin.settings.taskTitleOverrides = {
        ...this.plugin.settings.taskTitleOverrides,
        [task.id]: trimmed,
      };
    }
    if (this.plugin.settings.currentTaskId === task.id) {
      this.plugin.settings.currentTaskTitle = trimmed;
    }
    await this.plugin.saveSettings();
    this.renderBody();
    this.plugin.updateCurrentTaskBar();
  }

  private openSetDeadlineModal(task: Task): void {
    const caps = editCapabilities(this.plugin, task.id);
    new SetDeadlineModal(
      this.app,
      this.plugin,
      task,
      caps.canSetDue,
      (date, time) => this.applySetDeadline(task, date, time),
    ).open();
  }

  private async applySetDeadline(
    task: Task,
    date: string,
    time: string | null,
  ): Promise<void> {
    const caps = editCapabilities(this.plugin, task.id);
    if (caps.canSetDue === "blocked") {
      new Notice(lockReason(caps));
      return;
    }
    const proposedDue = toTaskRatchetDeadline(date, time);
    if (proposedDue !== null) {
      const ok = await this.plugin.tryReduceTaskRatchetDeadline(task.id, proposedDue);
      if (!ok) return;
    }
    if (task.source === "manual") {
      const list = this.plugin.settings.manualTasks;
      const idx = list.findIndex((m) => m.id === task.id);
      if (idx === -1) return;
      list[idx] = { ...list[idx], dueDate: date, dueTime: time };
    }
    this.plugin.settings.taskDueDateOverrides = {
      ...this.plugin.settings.taskDueDateOverrides,
      [task.id]: { date, time },
    };
    await this.plugin.saveSettings();
    this.renderBody();
    TaskView.refreshAll();
  }

  private async applyClearDeadline(task: Task): Promise<void> {
    const caps = editCapabilities(this.plugin, task.id);
    if (caps.canSetDue === "blocked") {
      new Notice(lockReason(caps));
      return;
    }
    const link = this.plugin.taskRatchetLinkForTask(task.id);
    if (link && link.status === "pending") {
      new Notice("TaskRatchet stakes require a deadline — pick an earlier one instead of clearing.");
      return;
    }
    if (task.source === "manual") {
      const list = this.plugin.settings.manualTasks;
      const idx = list.findIndex((m) => m.id === task.id);
      if (idx === -1) return;
      list[idx] = { ...list[idx], dueDate: null, dueTime: null };
    }
    const { [task.id]: _, ...rest } = this.plugin.settings.taskDueDateOverrides;
    this.plugin.settings.taskDueDateOverrides = rest;
    await this.plugin.saveSettings();
    this.renderBody();
    TaskView.refreshAll();
  }

  private openPrerequisitePicker(task: Task): void {
    const all = this.getCurrentTasks() ?? [];
    const existing = new Set(task.dependsOn);
    const candidates = all.filter(
      (t) =>
        t.id !== task.id &&
        !existing.has(t.id) &&
        !addingDependencyWouldCycle(all, task.id, t.id),
    );
    new PrerequisitePickerModal(
      this.app,
      task,
      candidates,
      (picked) => this.applyManualDependency(task, picked),
      () => this.openNewPrerequisiteModal(task, "task"),
      () => this.openNewPrerequisiteModal(task, "wait"),
    ).open();
  }

  private async applyManualDependency(task: Task, prerequisite: Task): Promise<void> {
    const map = this.plugin.settings.manualDependencies;
    const existing = map[task.id] ?? [];
    if (existing.includes(prerequisite.id)) return;
    map[task.id] = [...existing, prerequisite.id];
    await this.plugin.saveSettings();
    this.renderBody();
  }

  private openNewPrerequisiteModal(task: Task, mode: "task" | "wait"): void {
    new NewPrerequisiteModal(this.app, this.plugin, task, mode, (fields) =>
      this.applyNewManualPrerequisite(task, fields),
    ).open();
  }

  private async applyNewManualPrerequisite(
    task: Task,
    fields: {
      title: string;
      dueDate: string | null;
      dueTime: string | null;
      isWait: boolean;
    },
  ): Promise<void> {
    const id =
      "m-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const newTask: ManualTask = {
      id,
      title: fields.title,
      dueDate: fields.dueDate,
      dueTime: fields.dueTime,
      createdAt: new Date().toISOString(),
      completedAt: null,
      ...(fields.isWait ? { kind: "wait" as const } : {}),
    };
    this.plugin.settings.manualTasks.push(newTask);

    const map = this.plugin.settings.manualDependencies;
    map[task.id] = [...(map[task.id] ?? []), id];

    await this.plugin.saveSettings();
    this.renderBody();
  }

  private toggleSelection(id: string): void {
    if (this.selectedIds.has(id)) this.selectedIds.delete(id);
    else this.selectedIds.add(id);
    this.selectionAnchorId = id;
    this.refreshSelectionClasses();
  }

  private extendSelectionTo(id: string): void {
    if (!this.selectionAnchorId) {
      this.selectedIds.add(id);
      this.selectionAnchorId = id;
      this.refreshSelectionClasses();
      return;
    }
    const ids = this.orderedHeadIdsFromDom();
    const a = ids.indexOf(this.selectionAnchorId);
    const b = ids.indexOf(id);
    if (a === -1 || b === -1) {
      this.selectedIds.add(id);
      this.refreshSelectionClasses();
      return;
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) this.selectedIds.add(ids[i]);
    this.refreshSelectionClasses();
  }

  private clearSelection(): void {
    if (this.selectedIds.size === 0 && this.selectionAnchorId === null) return;
    this.selectedIds.clear();
    this.selectionAnchorId = null;
    this.refreshSelectionClasses();
  }

  private orderedHeadIdsFromDom(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const items = this.bodyEl.querySelectorAll<HTMLElement>(".iris-hp-list-item[data-head-id]");
    items.forEach((el) => {
      const id = el.dataset.headId;
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    });
    return out;
  }

  private refreshSelectionClasses(): void {
    const items = this.bodyEl.querySelectorAll<HTMLElement>(".iris-hp-list-item[data-head-id]");
    items.forEach((el) => {
      const id = el.dataset.headId;
      const self = el.querySelector<HTMLElement>(".iris-hp-list-item-self");
      if (!self || !id) return;
      self.classList.toggle("is-selected", this.selectedIds.has(id));
    });
  }

  private openBulkContextMenu(e: MouseEvent): void {
    const ids = [...this.selectedIds];
    if (ids.length === 0) return;
    const tasks = (this.getCurrentTasks() ?? []).filter((t) => ids.includes(t.id));
    if (tasks.length === 0) return;

    const menu = new Menu();
    const archivedSet = new Set(this.plugin.settings.archivedTaskIds);
    const anyIncomplete = tasks.some((t) => t.status !== "completed" && !t.isWait && !t.autoCompletes);
    const anyUnarchived = tasks.some((t) => !archivedSet.has(t.id));
    const allManual = tasks.every((t) => t.source === "manual");

    menu.addItem((i) =>
      i
        .setTitle(anyIncomplete ? `Complete ${tasks.length}` : `Uncomplete ${tasks.length}`)
        .setIcon(anyIncomplete ? "check-circle" : "circle")
        .onClick(() => void this.applyBulkComplete(tasks, anyIncomplete)),
    );
    menu.addItem((i) =>
      i
        .setTitle(anyUnarchived ? `Archive ${tasks.length}` : `Unarchive ${tasks.length}`)
        .setIcon(anyUnarchived ? "archive" : "archive-restore")
        .onClick(() => void this.applyBulkArchive(tasks, anyUnarchived)),
    );
    if (allManual) {
      menu.addItem((i) =>
        i
          .setTitle(`Delete ${tasks.length} (Del)`)
          .setIcon("trash-2")
          .onClick(() => void this.applyBulkDelete(tasks)),
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Clear selection (Esc)").setIcon("x").onClick(() => this.clearSelection()),
    );
    menu.showAtMouseEvent(e);
  }

  private async applyBulkComplete(tasks: Task[], makeComplete: boolean): Promise<void> {
    const list = this.plugin.settings.manualTasks;
    const now = new Date().toISOString();
    let touched = false;
    const completedIds: string[] = [];
    // For uncheck, partition by canUncheck so we can surface a single
    // "skipped N" notice rather than checking inside the loop.
    const split = makeComplete
      ? { allowed: tasks, blocked: [] as Task[] }
      : partitionByPolicy(
          tasks,
          (t) => editCapabilities(this.plugin, t.id).canUncheck,
        );
    for (const t of split.allowed) {
      if (t.isWait || t.autoCompletes) continue;
      if (t.source === "mail" && makeComplete) {
        for (const mid of t.sourceIds) clearMailTodo(this.app, mid);
        if (this.plugin.settings.currentTaskId === t.id) {
          this.plugin.settings.currentTaskId = null;
          this.plugin.settings.currentTaskTitle = null;
        }
        completedIds.push(t.id);
        touched = true;
        continue;
      }
      if (t.source !== "manual") continue;
      const idx = list.findIndex((m) => m.id === t.id);
      if (idx === -1) continue;
      const isComplete = !!list[idx].completedAt;
      if (makeComplete && isComplete) continue;
      if (!makeComplete && !isComplete) continue;
      list[idx] = { ...list[idx], completedAt: makeComplete ? now : null };
      if (makeComplete && this.plugin.settings.currentTaskId === t.id) {
        this.plugin.settings.currentTaskId = null;
        this.plugin.settings.currentTaskTitle = null;
      }
      if (makeComplete) completedIds.push(t.id);
      touched = true;
    }
    this.clearSelection();
    if (split.blocked.length > 0) {
      new Notice(
        `Skipped ${split.blocked.length} task${split.blocked.length === 1 ? "" : "s"} locked by TaskRatchet.`,
      );
    }
    if (touched) {
      await this.plugin.saveSettings();
      TaskView.refreshAll();
      this.plugin.updateCurrentTaskBar();
      for (const id of completedIds) {
        void this.plugin.syncTaskRatchetCompletion(id);
      }
    }
  }

  private async applyBulkArchive(tasks: Task[], makeArchived: boolean): Promise<void> {
    const s = this.plugin.settings;
    let archived = new Set(s.archivedTaskIds);
    let touched = false;
    // Only the archive direction is policy-gated; un-archive is always fine.
    const split = makeArchived
      ? partitionByPolicy(
          tasks,
          (t) => editCapabilities(this.plugin, t.id).canArchive,
        )
      : { allowed: tasks, blocked: [] as Task[] };
    for (const t of split.allowed) {
      if (makeArchived && !archived.has(t.id)) {
        archived.add(t.id);
        if (s.currentTaskId === t.id) {
          s.currentTaskId = null;
          s.currentTaskTitle = null;
        }
        touched = true;
      } else if (!makeArchived && archived.has(t.id)) {
        archived.delete(t.id);
        touched = true;
      }
    }
    this.clearSelection();
    if (split.blocked.length > 0) {
      new Notice(
        `Skipped ${split.blocked.length} task${split.blocked.length === 1 ? "" : "s"} locked by TaskRatchet.`,
      );
    }
    if (touched) {
      s.archivedTaskIds = [...archived];
      await this.plugin.saveSettings();
      TaskView.refreshAll();
      this.plugin.updateCurrentTaskBar();
    }
  }

  private async applyBulkDelete(tasks: Task[]): Promise<void> {
    const manual = tasks.filter((t) => t.source === "manual");
    if (manual.length === 0) return;
    const { allowed: deletable, blocked } = partitionByPolicy(
      manual,
      (t) => editCapabilities(this.plugin, t.id).canDelete,
    );
    if (blocked.length > 0) {
      new Notice(
        `Skipped ${blocked.length} task${blocked.length === 1 ? "" : "s"} locked by TaskRatchet.`,
      );
    }
    if (deletable.length === 0) {
      this.clearSelection();
      return;
    }
    const idSet = new Set(deletable.map((t) => t.id));
    const snapshot = snapshotDeletableState(this.plugin);
    applyDeleteMutation(this.plugin, idSet);
    this.clearSelection();
    await this.plugin.saveSettings();
    TaskView.refreshAll();
    this.plugin.updateCurrentTaskBar();
    showDeleteNoticeWithUndo(
      this.plugin,
      snapshot,
      `${deletable.length} task${deletable.length === 1 ? "" : "s"}`,
    );
  }

  private async applyArchive(task: Task): Promise<void> {
    if (this.plugin.settings.archivedTaskIds.includes(task.id)) return;
    const caps = editCapabilities(this.plugin, task.id);
    if (!caps.canArchive) {
      new Notice(lockReason(caps));
      return;
    }
    this.plugin.settings.archivedTaskIds = [
      ...this.plugin.settings.archivedTaskIds,
      task.id,
    ];
    if (this.plugin.settings.currentTaskId === task.id) {
      this.plugin.settings.currentTaskId = null;
      this.plugin.settings.currentTaskTitle = null;
    }
    await this.plugin.saveSettings();
    TaskView.refreshAll();
    this.plugin.updateCurrentTaskBar();
  }

  private async applyUnarchive(task: Task): Promise<void> {
    const ids = this.plugin.settings.archivedTaskIds;
    if (!ids.includes(task.id)) return;
    this.plugin.settings.archivedTaskIds = ids.filter((id) => id !== task.id);
    await this.plugin.saveSettings();
    TaskView.refreshAll();
  }

  private async applyDelete(task: Task): Promise<void> {
    if (task.source !== "manual") return;
    const caps = editCapabilities(this.plugin, task.id);
    if (!caps.canDelete) {
      new Notice(lockReason(caps));
      return;
    }
    const snapshot = snapshotDeletableState(this.plugin);
    applyDeleteMutation(this.plugin, new Set([task.id]));
    await this.plugin.saveSettings();
    TaskView.refreshAll();
    this.plugin.updateCurrentTaskBar();
    showDeleteNoticeWithUndo(this.plugin, snapshot, `"${task.title}"`);
  }

  private openAddVariationModal(task: Task): void {
    new AddVariationModal(this.app, this.plugin, task, async (fields) => {
      const id =
        "m-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const newTask: ManualTask = {
        id,
        title: fields.title,
        dueDate: fields.dueDate,
        dueTime: fields.dueTime,
        createdAt: new Date().toISOString(),
        completedAt: null,
      };
      this.plugin.settings.manualTasks.push(newTask);

      const existing = this.plugin.settings.taskSeries.find((s) =>
        s.memberIds.includes(task.id),
      );
      if (existing) {
        existing.memberIds.push(id);
      } else {
        const seriesId =
          "s-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        this.plugin.settings.taskSeries.push({
          id: seriesId,
          memberIds: [task.id, id],
        });
      }

      await this.plugin.saveSettings();
      TaskView.refreshAll();
    }).open();
  }

  private openSeriesModal(task: Task): void {
    if (!task.seriesId) return;
    const series = this.plugin.settings.taskSeries.find(
      (s) => s.id === task.seriesId,
    );
    if (!series) return;
    new SeriesModal(this.app, this.plugin, series, task.id).open();
  }

  private openMailModal(task: Task): void {
    if (task.source !== "mail" || task.sourceIds.length === 0) return;
    new MailMessageModal(this.app, task.title, task.sourceIds).open();
  }

  private async handleComplete(task: Task): Promise<void> {
    if (task.isWait || task.autoCompletes) return;
    if (task.source === "mail") {
      for (const id of task.sourceIds) {
        clearMailTodo(this.app, id);
      }
      if (this.plugin.settings.currentTaskId === task.id) {
        void this.plugin.clearCurrentTask();
      }
      return;
    }
    if (task.source === "manual") {
      const list = this.plugin.settings.manualTasks;
      const idx = list.findIndex((m) => m.id === task.id);
      if (idx === -1) return;
      const isCurrentlyComplete = !!list[idx].completedAt;
      // Unchecking a synced staked task would diverge from TR — TR's API
      // doesn't reverse completion, and pending stakes shouldn't be
      // silently un-done either.
      if (isCurrentlyComplete) {
        const caps = editCapabilities(this.plugin, task.id);
        if (!caps.canUncheck) {
          new Notice(lockReason(caps));
          return;
        }
      }
      const now = new Date().toISOString();
      list[idx] = {
        ...list[idx],
        completedAt: isCurrentlyComplete ? null : now,
      };
      const becameComplete = !!list[idx].completedAt;
      if (becameComplete && this.plugin.settings.currentTaskId === task.id) {
        this.plugin.settings.currentTaskId = null;
        this.plugin.settings.currentTaskTitle = null;
      }
      await this.plugin.saveSettings();
      this.renderBody();
      this.plugin.updateCurrentTaskBar();
      if (becameComplete) {
        void this.plugin.syncTaskRatchetCompletion(task.id);
      }
    }
  }

  /** Called on initial load and on every Mail to-do change. */
  private onTodosChanged(): void {
    this.renderBody();
    this.scheduleAiPipeline();
  }

  /**
   * Snapshot of every flagged email's per-email content hash, plus the
   * pre-fetched body string we'll need if we end up calling the AI. Computed
   * once per pipeline invocation so scheduling and execution agree.
   */
  private snapshotEmails(): {
    emails: ReturnType<typeof getRawMailTodos>;
    bodies: Record<string, string>;
    hashes: string[];
    digests: string[];
  } {
    const emails = getRawMailTodos(this.app);
    const bodies: Record<string, string> = {};
    const hashes: string[] = [];
    const digests: string[] = [];
    for (const e of emails) {
      const body = getMailTodoBody(this.app, e.id);
      bodies[e.id] = body;
      const { hash, contentDigest } = hashEmailContent(e, body, COMPOSE_PROMPT_VERSION);
      hashes.push(hash);
      digests.push(contentDigest);
    }
    return { emails, bodies, hashes, digests };
  }

  /**
   * Decide whether per-email composes and/or the merge pass need to run, and
   * either schedule the pipeline behind the debounce or short-circuit.
   */
  private scheduleAiPipeline(): void {
    if (!this.isOpen) return;

    const { emails, hashes } = this.snapshotEmails();
    if (emails.length === 0) {
      this.cancelAiTimer();
      return;
    }

    const cache = this.plugin.settings.taskCache;
    let perEmailWorkPending = false;
    let perEmailHardBlocked = true; // every miss is in failed-hashes
    const cachedEmailIds: string[] = [];
    for (let i = 0; i < emails.length; i++) {
      const h = hashes[i];
      const hit = lookupPerEmail(cache, h);
      if (hit) {
        perEmailHardBlocked = false;
        if (hit.tasks.length > 0) cachedEmailIds.push(emails[i].id);
      } else if (this.perEmailFailedHashes.has(h)) {
        // hard-failed; treated as "no candidate" but doesn't trigger a call
      } else {
        perEmailWorkPending = true;
        perEmailHardBlocked = false;
      }
    }

    let mergeWorkPending = false;
    let mergeBlocked = false;
    if (!perEmailWorkPending) {
      const ungrouped = ungroupedEmailIds(cache, cachedEmailIds);
      if (ungrouped.length > 0) {
        const proposedKey = mergeKey(ungrouped, cache.groups);
        if (this.mergeFailedKey === proposedKey) mergeBlocked = true;
        else mergeWorkPending = true;
      }
    }

    // Terminal: nothing to do, or every remaining miss is blocked.
    if (!perEmailWorkPending && !mergeWorkPending) {
      this.cancelAiTimer();
      if (perEmailHardBlocked && emails.length > 0) {
        this.aiPhase = "compose-failed";
      } else if (mergeBlocked) {
        this.aiPhase = "merge-failed";
      } else {
        this.aiPhase = this.aiPhase === "unavailable" ? "unavailable" : "idle";
      }
      this.renderStatus();
      return;
    }

    const aggHash = aggregateHash(hashes);
    if (this.inflightHash === aggHash) return;

    if (!hasAiAccess(this.app, this.plugin.settings.anthropicApiKey)) {
      this.aiPhase = "unavailable";
      this.renderStatus();
      this.renderBody();
      this.scheduleAiAccessRetry();
      return;
    }

    this.cancelAiTimer();
    this.aiPhase = "pending";
    this.renderStatus();
    this.aiTimer = setTimeout(() => {
      this.aiTimer = null;
      void this.runAiPipeline();
    }, AI_DEBOUNCE_MS);
  }

  /**
   * iris-router (the relay) may not have finished loading the moment we first
   * check `hasAiAccess`. Poll until it appears (or the user sets a key) so the
   * pipeline kicks off without needing a manual reload.
   */
  private scheduleAiAccessRetry(): void {
    if (this.aiAccessRetryTimer) return;
    this.aiAccessRetryTimer = setTimeout(() => {
      this.aiAccessRetryTimer = null;
      if (!this.isOpen) return;
      if (this.aiPhase !== "unavailable") return;
      if (hasAiAccess(this.app, this.plugin.settings.anthropicApiKey)) {
        this.scheduleAiPipeline();
      } else {
        this.scheduleAiAccessRetry();
      }
    }, 1500);
  }

  /**
   * Clear a per-email failed flag and re-schedule with exponential backoff.
   * `transient` errors don't poison `perEmailFailedHashes`; the timer just
   * forces a re-tick. `permanent` errors stay in the failed set until the
   * timer clears them — caps at one extra retry per session for permanents,
   * but transients keep retrying with growing delays.
   */
  private schedulePerEmailRetry(hash: string, transient: boolean): void {
    const attempt = (this.perEmailAttempts.get(hash) ?? 0) + 1;
    this.perEmailAttempts.set(hash, attempt);
    const delay = transient ? backoffDelay(attempt) : 30_000;
    setTimeout(() => {
      if (!this.isOpen) return;
      // Permanent path: only fire if hash is still in the failed set.
      if (!transient && !this.perEmailFailedHashes.has(hash)) return;
      this.perEmailFailedHashes.delete(hash);
      this.scheduleAiPipeline();
    }, delay);
  }

  private scheduleMergeRetry(key: string, transient: boolean): void {
    const attempt = (this.mergeAttempts.get(key) ?? 0) + 1;
    this.mergeAttempts.set(key, attempt);
    const delay = transient ? backoffDelay(attempt) : 30_000;
    setTimeout(() => {
      if (!this.isOpen) return;
      if (!transient && this.mergeFailedKey !== key) return;
      this.mergeFailedKey = null;
      this.scheduleAiPipeline();
    }, delay);
  }

  private cancelAiTimer(): void {
    if (this.aiTimer) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
  }

  private sameEmailIds(a: ReturnType<typeof getRawMailTodos>, b: ReturnType<typeof getRawMailTodos>): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
    return true;
  }

  /**
   * Phase 1: compose any per-email entries that aren't cached.
   * Phase 2: assign any ungrouped per-email candidates to existing groups
   * or new groups via a title-only merge call.
   * Drift checks after each AI call bail to a fresh schedule.
   */
  private async runAiPipeline(): Promise<void> {
    if (!this.isOpen) return;
    const snapshot = this.snapshotEmails();
    const { emails, bodies, hashes, digests } = snapshot;
    if (emails.length === 0) return;

    const aggHash = aggregateHash(hashes);
    this.inflightHash = aggHash;

    // ---- Phase 1: per-email compose ----
    const candidates: ComposedTask[] = [];
    const needsCall: { email: typeof emails[number]; hash: string; digest: string }[] = [];
    let cache = this.plugin.settings.taskCache;
    for (let i = 0; i < emails.length; i++) {
      const e = emails[i];
      const h = hashes[i];
      const hit = lookupPerEmail(cache, h);
      if (hit) {
        candidates.push(...hit.tasks);
      } else if (!this.perEmailFailedHashes.has(h)) {
        needsCall.push({ email: e, hash: h, digest: digests[i] });
      }
    }

    if (needsCall.length > 0) {
      this.aiPhase = "composing";
      this.renderStatus();
      let anySucceeded = false;

      // When iris-router is present it handles its own queue + rate limits,
      // so fan out the whole batch. Without the relay we hit the Anthropic
      // API directly, where parallel calls risk 429s — fall back to serial.
      const fanOut = hasIrisRelay(this.app);
      const tasksFor = (email: typeof emails[number]) =>
        aiComposeEmail({
          app: this.app,
          email,
          body: bodies[email.id],
          localApiKey: this.plugin.settings.anthropicApiKey,
        });

      type Outcome = {
        item: typeof needsCall[number];
        tasks: ComposedTask[] | null;
        error: unknown;
      };
      let outcomes: Outcome[];
      if (fanOut) {
        const settled = await Promise.allSettled(needsCall.map((it) => tasksFor(it.email)));
        outcomes = settled.map((s, i) => ({
          item: needsCall[i],
          tasks: s.status === "fulfilled" ? s.value : null,
          error: s.status === "rejected" ? s.reason : null,
        }));
        for (let i = 0; i < settled.length; i++) {
          const s = settled[i];
          if (s.status === "rejected") {
            console.warn("[iris-tasks] AI compose failed for", needsCall[i].email.id, s.reason);
            this.lastComposeError = errorMessage(s.reason);
          }
        }
      } else {
        outcomes = [];
        for (const it of needsCall) {
          try {
            outcomes.push({ item: it, tasks: await tasksFor(it.email), error: null });
          } catch (err) {
            console.warn("[iris-tasks] AI compose failed for", it.email.id, err);
            this.lastComposeError = errorMessage(err);
            outcomes.push({ item: it, tasks: null, error: err });
          }
        }
      }

      if (!this.sameEmailIds(getRawMailTodos(this.app), emails)) {
        this.inflightHash = null;
        this.scheduleAiPipeline();
        return;
      }

      for (const { item, tasks, error } of outcomes) {
        if (tasks === null) {
          const transient = error instanceof AIError && error.kind === "transient";
          if (transient) {
            this.schedulePerEmailRetry(item.hash, true);
          } else {
            this.perEmailFailedHashes.add(item.hash);
            this.schedulePerEmailRetry(item.hash, false);
          }
          continue;
        }
        // Success — clear any prior transient attempt count.
        this.perEmailAttempts.delete(item.hash);
        cache = storePerEmail(cache, {
          hash: item.hash,
          emailId: item.email.id,
          contentDigest: item.digest,
          tasks,
          promptVersion: COMPOSE_PROMPT_VERSION,
          storedAt: Date.now(),
        });
        candidates.push(...tasks);
        anySucceeded = true;
      }
      if (anySucceeded) this.lastComposeError = null;
      cache = gcPerEmail(cache, new Set(emails.map((e) => e.id)));
      this.plugin.settings.taskCache = cache;
      await this.plugin.saveSettings();

      const allFailed = !anySucceeded && candidates.length === 0;
      if (allFailed) {
        this.aiPhase = "compose-failed";
        this.inflightHash = null;
        this.renderStatus();
        this.renderBody();
        return;
      }
      this.renderBody();
    }

    // ---- Phase 2: incremental merge ----
    // Collect ungrouped per-email candidates from the freshly-saved cache.
    cache = this.plugin.settings.taskCache;
    const cachedTitleByEmail = new Map<string, string>();
    for (const entry of cache.perEmail) {
      if (entry.tasks.length > 0) {
        cachedTitleByEmail.set(entry.emailId, entry.tasks[0].title);
      }
    }
    const ungrouped = ungroupedEmailIds(cache, [...cachedTitleByEmail.keys()])
      .filter((id) => emails.some((e) => e.id === id));

    if (ungrouped.length === 0) {
      const preGroups = this.plugin.settings.taskCache.groups;
      cache = gcGroups(cache, new Set(emails.map((e) => e.id)));
      migrateSettingsForIdChanges(preGroups, cache.groups, this.plugin.settings);
      this.plugin.settings.taskCache = cache;
      await this.plugin.saveSettings();
      this.aiPhase = "idle";
      this.inflightHash = null;
      this.renderBody();
      this.renderStatus();
      return;
    }

    const proposedKey = mergeKey(ungrouped, cache.groups);
    if (this.mergeFailedKey === proposedKey) {
      this.aiPhase = "merge-failed";
      this.inflightHash = null;
      this.renderStatus();
      this.renderBody();
      return;
    }

    let assignments: Assignment[];
    if (ungrouped.length === 1 && cache.groups.length === 0) {
      // Trivial: nothing to merge against, skip the AI call.
      const id = ungrouped[0];
      assignments = [
        { emailId: id, title: cachedTitleByEmail.get(id) ?? id, newToken: "n1" },
      ];
    } else {
      this.aiPhase = "merging";
      this.renderStatus();
      try {
        assignments = await aiAssignToGroups({
          app: this.app,
          candidates: ungrouped.map((id) => ({
            emailId: id,
            title: cachedTitleByEmail.get(id) ?? id,
          })),
          existingGroups: cache.groups.map((g) => ({ id: g.id, title: g.title })),
          localApiKey: this.plugin.settings.anthropicApiKey,
        });
      } catch (err) {
        console.warn("[iris-tasks] AI merge failed:", err);
        this.lastMergeError = errorMessage(err);
        const transient = err instanceof AIError && err.kind === "transient";
        // Don't poison mergeFailedKey on transient errors — let the next
        // pipeline tick retry naturally; the scheduled retry forces it.
        this.mergeFailedKey = transient ? null : proposedKey;
        this.aiPhase = "merge-failed";
        this.inflightHash = null;
        this.renderStatus();
        this.renderBody();
        this.scheduleMergeRetry(proposedKey, transient);
        return;
      }
      if (!this.sameEmailIds(getRawMailTodos(this.app), emails)) {
        this.inflightHash = null;
        this.scheduleAiPipeline();
        return;
      }
    }

    this.lastMergeError = null;
    this.mergeAttempts.delete(proposedKey);
    const preGroups = this.plugin.settings.taskCache.groups;
    cache = applyAssignments(cache, assignments);
    cache = gcGroups(cache, new Set(emails.map((e) => e.id)));
    migrateSettingsForIdChanges(preGroups, cache.groups, this.plugin.settings);
    this.plugin.settings.taskCache = cache;
    await this.plugin.saveSettings();

    this.aiPhase = "idle";
    this.inflightHash = null;
    this.renderBody();
    this.renderStatus();
  }
}

/**
 * Stable fingerprint of a merge call's inputs — used to detect when a
 * blocked merge would re-attempt with the same parameters.
 */
function mergeKey(ungrouped: string[], groups: Group[]): string {
  const groupTokens = groups.map((g) => `${g.id}:${g.title}`);
  return hashIdSet([...ungrouped, ...groupTokens], "merge");
}

/**
 * Exponential backoff with jitter for transient AI errors.
 * Sequence: ~30s, 60s, 120s, 240s, 480s, capped at 600s (10min).
 */
function backoffDelay(attempt: number): number {
  const base = 30_000;
  const max = 600_000;
  const exp = Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), max);
  const jitter = exp * 0.2 * Math.random();
  return Math.round(exp + jitter);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * True if making `dependent` depend on `prerequisite` would create a cycle —
 * i.e. `prerequisite` already (transitively) depends on `dependent` via the
 * existing `dependsOn` graph.
 */
function addingDependencyWouldCycle(
  tasks: Task[],
  dependent: string,
  prerequisite: string,
): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const stack = [prerequisite];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === dependent) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const t = byId.get(cur);
    if (!t) continue;
    for (const dep of t.dependsOn) stack.push(dep);
  }
  return false;
}

type PickerItem =
  | { kind: "new-task" }
  | { kind: "wait-until" }
  | { kind: "existing"; task: Task };

class PrerequisitePickerModal extends SuggestModal<PickerItem> {
  private candidates: Task[];
  private onPickExisting: (task: Task) => void;
  private onPickNewTask: () => void;
  private onPickWaitUntil: () => void;

  constructor(
    app: App,
    dependent: Task,
    candidates: Task[],
    onPickExisting: (task: Task) => void,
    onPickNewTask: () => void,
    onPickWaitUntil: () => void,
  ) {
    super(app);
    this.candidates = candidates;
    this.onPickExisting = onPickExisting;
    this.onPickNewTask = onPickNewTask;
    this.onPickWaitUntil = onPickWaitUntil;
    this.setPlaceholder(`Prerequisite for "${dependent.title}"`);
  }

  getSuggestions(query: string): PickerItem[] {
    const q = query.toLowerCase().trim();
    const matched = q
      ? this.candidates.filter((t) => t.title.toLowerCase().includes(q))
      : this.candidates;
    const items: PickerItem[] = [{ kind: "new-task" }, { kind: "wait-until" }];
    for (const task of matched) items.push({ kind: "existing", task });
    return items;
  }

  renderSuggestion(item: PickerItem, el: HTMLElement): void {
    if (item.kind === "new-task") el.setText("+ Create new task…");
    else if (item.kind === "wait-until") el.setText("+ Wait until…");
    else el.setText(item.task.title);
  }

  onChooseSuggestion(item: PickerItem): void {
    if (item.kind === "new-task") this.onPickNewTask();
    else if (item.kind === "wait-until") this.onPickWaitUntil();
    else this.onPickExisting(item.task);
  }
}

interface NewPrerequisiteFields {
  title: string;
  dueDate: string | null;
  dueTime: string | null;
  isWait: boolean;
}

/**
 * Modal that captures a brand-new prerequisite task: title plus a free-text
 * due date parsed via iris-calendar's shared NL datetime parser.
 */
class NewPrerequisiteModal extends Modal {
  private plugin: IrisTasksPlugin;
  private dependent: Task;
  private mode: "task" | "wait";
  private onSubmit: (fields: NewPrerequisiteFields) => Promise<void>;
  private submitting = false;

  constructor(
    app: App,
    plugin: IrisTasksPlugin,
    dependent: Task,
    mode: "task" | "wait",
    onSubmit: (fields: NewPrerequisiteFields) => Promise<void>,
  ) {
    super(app);
    this.plugin = plugin;
    this.dependent = dependent;
    this.mode = mode;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    const heading =
      this.mode === "wait" ? "Wait until…" : "New task";
    titleEl.setText(`${heading} (prerequisite for "${this.dependent.title}")`);
    contentEl.addClass("iris-tasks-new-prereq-modal");

    let titleInput: HTMLInputElement | null = null;
    if (this.mode === "task") {
      titleInput = this.addField(contentEl, "", "Task name…");
    }
    const duePlaceholder =
      this.mode === "wait"
        ? "May 5, next Tuesday, in 3 days…"
        : "tomorrow 3pm, next Friday…";
    const dueInput = this.addField(contentEl, "Due", duePlaceholder);

    const btn = contentEl.createEl("button", {
      cls: "iris-tasks-new-prereq-submit mod-cta",
      text: "Create",
    });
    btn.disabled = true;

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.submit(titleInput, dueInput, btn);
    });

    const refreshEnabled = () => {
      const hasInput =
        this.mode === "wait"
          ? dueInput.value.trim().length > 0
          : (titleInput?.value.trim().length ?? 0) > 0;
      btn.disabled = !hasInput;
    };

    titleInput?.addEventListener("input", refreshEnabled);
    dueInput.addEventListener("input", refreshEnabled);

    const handleEnter = (e: KeyboardEvent, next: HTMLInputElement | null) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (next) next.focus();
      else if (!btn.disabled) void this.submit(titleInput, dueInput, btn);
    };
    if (titleInput) {
      titleInput.addEventListener("keydown", (e) => handleEnter(e, dueInput));
    }
    dueInput.addEventListener("keydown", (e) => handleEnter(e, null));

    (titleInput ?? dueInput).focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private addField(
    parent: HTMLElement,
    label: string,
    placeholder: string,
  ): HTMLInputElement {
    const row = parent.createDiv({ cls: "iris-tasks-new-prereq-field" });
    if (label) row.createEl("label", { text: label });
    const input = row.createEl("input", { type: "text" });
    if (placeholder) input.placeholder = placeholder;
    return input;
  }

  private async submit(
    titleInput: HTMLInputElement | null,
    dueInput: HTMLInputElement,
    btn: HTMLButtonElement,
  ): Promise<void> {
    if (this.submitting) return;
    const typedTitle = titleInput?.value.trim() ?? "";
    const raw = dueInput.value.trim();
    if (this.mode === "task" && !typedTitle) {
      new Notice("Task name is required");
      return;
    }
    if (this.mode === "wait" && !raw) {
      new Notice("Date is required");
      return;
    }

    this.submitting = true;
    const originalText = btn.textContent ?? "Create";
    btn.disabled = true;
    btn.setText("Creating…");
    if (titleInput) titleInput.disabled = true;
    dueInput.disabled = true;

    let dueDate: string | null = null;
    let dueTime: string | null = null;
    if (raw) {
      const due = await parseDueDate(this.plugin, raw);
      if (!due) {
        new Notice("Couldn't understand that date");
        btn.setText(originalText);
        btn.disabled = false;
        if (titleInput) titleInput.disabled = false;
        dueInput.disabled = false;
        dueInput.focus();
        this.submitting = false;
        return;
      }
      dueDate = due.date;
      dueTime = due.time;
    }

    const isWait = this.mode === "wait";
    const title = isWait ? formatWaitTitle(dueDate!, dueTime) : typedTitle;

    try {
      await this.onSubmit({ title, dueDate, dueTime, isWait });
      this.close();
    } finally {
      this.submitting = false;
    }
  }
}

/** Synthesize a title for a date-only prerequisite ("Wait until May 5"). */
function formatWaitTitle(dueDate: string, dueTime: string | null): string {
  const iso = dueTime ? `${dueDate}T${dueTime}` : `${dueDate}T00:00:00`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return `Wait until ${dueDate}`;
  const datePart = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  if (!dueTime) return `Wait until ${datePart}`;
  const timePart = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `Wait until ${datePart}, ${timePart}`;
}

type TreeNode = {
  task: Task;
  children: TreeNode[];
  /** True when the main line should continue past this node's row (it has more siblings below). */
  extendDown: boolean;
};

interface Row {
  /** Tree-node path from root to leaf. */
  lineage: TreeNode[];
  /** Number of leading lineage segments to hide (their connectors render as ghosts). */
  branchAt: number;
  /** First (head) row of a tree gets the checkbox; later rows are branches. */
  isFirstRow: boolean;
}

/**
 * Merge chains that share a prefix into a forest. Tasks are matched by id, so
 * identical prefixes collapse into a single tree branch. Insertion order is
 * preserved within each level so the leftmost-priority chain stays the
 * "trunk" of the rendered tree. Each child node is annotated with
 * `extendDown` so the renderer can draw the shared vertical line between
 * siblings.
 */
function buildForest(chains: Task[][]): TreeNode[] {
  const forest: TreeNode[] = [];
  for (const chain of chains) {
    let level = forest;
    for (const t of chain) {
      let node = level.find((n) => n.task.id === t.id);
      if (!node) {
        node = { task: t, children: [], extendDown: false };
        level.push(node);
      }
      level = node.children;
    }
  }
  const annotate = (children: TreeNode[]) => {
    for (let i = 0; i < children.length; i++) {
      children[i].extendDown = i < children.length - 1;
      annotate(children[i].children);
    }
  };
  annotate(forest);
  // Forest roots aren't siblings of one another — no shared line between trees.
  for (const root of forest) root.extendDown = false;
  return forest;
}

/**
 * Walk each tree depth-first into a flat list of rows. The leftmost path
 * becomes the trunk row; each non-first child of any internal node starts a
 * new branch row that is rendered with a curved top-entering connector,
 * positioned to align with its siblings on the trunk.
 */
function flattenForest(forest: TreeNode[]): Row[] {
  const rows: Row[] = [];
  for (const tree of forest) walkTree(tree, [], 0, rows, true);
  return rows;
}

function walkTree(
  node: TreeNode,
  lineage: TreeNode[],
  branchAt: number,
  rows: Row[],
  isFirstRowOfTree: boolean,
): void {
  lineage.push(node);
  if (node.children.length === 0) {
    rows.push({
      lineage: [...lineage],
      branchAt,
      isFirstRow: isFirstRowOfTree,
    });
  } else {
    walkTree(node.children[0], lineage, branchAt, rows, isFirstRowOfTree);
    for (let i = 1; i < node.children.length; i++) {
      walkTree(node.children[i], lineage, lineage.length, rows, false);
    }
  }
  lineage.pop();
}

/**
 * Build one chain per leaf task (no other task depends on it). Each chain is
 * `[root, …, leaf]` walking up from the leaf via `dependsOn`. A prerequisite
 * shared by two leaves appears in both chains so the user can see the
 * fan-out. Chains are ordered by the earliest sorted-position of any member
 * (so an urgent prereq with multiple dependents surfaces near the top, with
 * its dependent chains adjacent), then by leaf position as a tiebreak.
 *
 * Multi-parent tasks follow only the first listed parent for the visual
 * chain — full DAG rendering is out of scope.
 */
function buildChains(tasks: Task[]): Task[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const sortedIndex = new Map<string, number>();
  tasks.forEach((t, i) => sortedIndex.set(t.id, i));

  const dependents = new Set<string>();
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (byId.has(dep)) dependents.add(dep);
    }
  }

  const ancestorsOf = (id: string): Set<string> => {
    const out = new Set<string>();
    const stack: string[] = [...(byId.get(id)?.dependsOn ?? [])];
    while (stack.length > 0) {
      const x = stack.pop()!;
      if (out.has(x) || !byId.has(x)) continue;
      out.add(x);
      for (const d of byId.get(x)!.dependsOn) stack.push(d);
    }
    return out;
  };

  // Among a task's parents, pick the one furthest from the root — its
  // ancestor closure should cover the other candidates. This makes
  // C.dependsOn=[A,B] with B.dependsOn=[A] resolve to ...→B→A rather than
  // collapsing straight to A and hiding the B link.
  const pickDeepestParent = (candidates: string[]): string => {
    if (candidates.length === 1) return candidates[0];
    let best = candidates[0];
    let bestCount = -1;
    for (const p of candidates) {
      const anc = ancestorsOf(p);
      const covered = candidates.reduce(
        (n, q) => (q !== p && anc.has(q) ? n + 1 : n),
        0,
      );
      if (covered > bestCount) {
        bestCount = covered;
        best = p;
      }
    }
    return best;
  };

  const buildFromLeaf = (leaf: Task): Task[] => {
    const chain: Task[] = [leaf];
    const seen = new Set<string>([leaf.id]);
    let cur = leaf;
    while (true) {
      const parents = cur.dependsOn.filter((id) => byId.has(id) && !seen.has(id));
      if (parents.length === 0) break;
      const parentId = pickDeepestParent(parents);
      const parent = byId.get(parentId)!;
      chain.push(parent);
      seen.add(parent.id);
      cur = parent;
    }
    return chain.reverse();
  };

  const built: Task[][] = [];
  const placed = new Set<string>();
  for (const t of tasks) {
    if (dependents.has(t.id)) continue;
    const chain = buildFromLeaf(t);
    built.push(chain);
    for (const x of chain) placed.add(x.id);
  }
  // Cycle survivors and detached nodes that didn't end up in any chain.
  for (const t of tasks) {
    if (!placed.has(t.id)) built.push([t]);
  }

  const indexOf = (id: string) => sortedIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
  return built
    .map((chain) => ({
      chain,
      anchor: Math.min(...chain.map((t) => indexOf(t.id))),
      leaf: indexOf(chain[chain.length - 1].id),
    }))
    .sort((a, b) => a.anchor - b.anchor || a.leaf - b.leaf)
    .map((entry) => entry.chain);
}

class RenameTaskModal extends Modal {
  private initialTitle: string;
  private onSubmit: (next: string) => Promise<void>;
  private submitting = false;

  constructor(
    app: App,
    initialTitle: string,
    onSubmit: (next: string) => Promise<void>,
  ) {
    super(app);
    this.initialTitle = initialTitle;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Rename task");
    contentEl.addClass("iris-tasks-new-prereq-modal");

    const row = contentEl.createDiv({ cls: "iris-tasks-new-prereq-field" });
    const input = row.createEl("input", { type: "text" });
    input.value = this.initialTitle;

    const btn = contentEl.createEl("button", {
      cls: "iris-tasks-new-prereq-submit mod-cta",
      text: "Save",
    });

    const refreshEnabled = () => {
      const trimmed = input.value.trim();
      btn.disabled = !trimmed || trimmed === this.initialTitle;
    };
    refreshEnabled();
    input.addEventListener("input", refreshEnabled);

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.submit(input, btn);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!btn.disabled) void this.submit(input, btn);
      }
    });

    input.focus();
    input.select();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(
    input: HTMLInputElement,
    btn: HTMLButtonElement,
  ): Promise<void> {
    if (this.submitting) return;
    const next = input.value.trim();
    if (!next || next === this.initialTitle) return;
    this.submitting = true;
    btn.disabled = true;
    btn.setText("Saving…");
    input.disabled = true;
    try {
      await this.onSubmit(next);
      this.close();
    } finally {
      this.submitting = false;
    }
  }
}

class SetDeadlineModal extends Modal {
  private plugin: IrisTasksPlugin;
  private task: Task;
  private constraint: "any" | "earlier-only";
  private onSubmit: (date: string, time: string | null) => Promise<void>;
  private submitting = false;

  constructor(
    app: App,
    plugin: IrisTasksPlugin,
    task: Task,
    constraint: "any" | "earlier-only" | "blocked",
    onSubmit: (date: string, time: string | null) => Promise<void>,
  ) {
    super(app);
    this.plugin = plugin;
    this.task = task;
    this.constraint = constraint === "blocked" ? "any" : constraint;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Set deadline");
    contentEl.addClass("iris-tasks-new-prereq-modal");

    if (this.constraint === "earlier-only") {
      contentEl.createEl("p", {
        cls: "iris-tasks-deadline-hint",
        text: "TaskRatchet stake active — deadline can only be moved earlier.",
      });
    }

    const row = contentEl.createDiv({ cls: "iris-tasks-new-prereq-field" });
    row.createEl("label", { text: "Due" });
    const input = row.createEl("input", { type: "text" });
    input.placeholder = "tomorrow 3pm, next Friday, in 2 days…";

    const btn = contentEl.createEl("button", {
      cls: "iris-tasks-new-prereq-submit mod-cta",
      text: "Save",
    });
    btn.disabled = true;

    input.addEventListener("input", () => {
      btn.disabled = input.value.trim().length === 0;
    });

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.submit(input, btn);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!btn.disabled) void this.submit(input, btn);
      }
    });

    input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(
    input: HTMLInputElement,
    btn: HTMLButtonElement,
  ): Promise<void> {
    if (this.submitting) return;
    const raw = input.value.trim();
    if (!raw) return;

    this.submitting = true;
    btn.disabled = true;
    btn.setText("Saving…");
    input.disabled = true;

    const due = await parseDueDate(this.plugin, raw);
    if (!due) {
      new Notice("Couldn't understand that date");
      btn.setText("Save");
      btn.disabled = false;
      input.disabled = false;
      input.focus();
      this.submitting = false;
      return;
    }

    if (this.constraint === "earlier-only" && this.task.dueDate) {
      const link = this.plugin.taskRatchetLinkForTask(this.task.id);
      const refDueSec = link?.due ?? null;
      if (refDueSec !== null) {
        const proposedSec = toTaskRatchetDeadline(due.date, due.time);
        if (proposedSec !== null && proposedSec >= refDueSec) {
          new Notice("Deadline must be earlier than the current one (TaskRatchet constraint)");
          btn.setText("Save");
          btn.disabled = false;
          input.disabled = false;
          input.focus();
          this.submitting = false;
          return;
        }
      }
    }

    try {
      await this.onSubmit(due.date, due.time);
      this.close();
    } finally {
      this.submitting = false;
    }
  }
}

class AddVariationModal extends Modal {
  private plugin: IrisTasksPlugin;
  private sourceTask: Task;
  private onSubmit: (fields: {
    title: string;
    dueDate: string | null;
    dueTime: string | null;
  }) => Promise<void>;
  private submitting = false;

  constructor(
    app: App,
    plugin: IrisTasksPlugin,
    sourceTask: Task,
    onSubmit: (fields: {
      title: string;
      dueDate: string | null;
      dueTime: string | null;
    }) => Promise<void>,
  ) {
    super(app);
    this.plugin = plugin;
    this.sourceTask = sourceTask;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Add variation of "${this.sourceTask.title}"`);
    contentEl.addClass("iris-tasks-new-prereq-modal");

    const titleInput = this.addField(contentEl, "", "Variation title…");
    const dueInput = this.addField(contentEl, "Due", "tomorrow 3pm, next Friday…");

    const btn = contentEl.createEl("button", {
      cls: "iris-tasks-new-prereq-submit mod-cta",
      text: "Create",
    });
    btn.disabled = true;

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.submit(titleInput, dueInput, btn);
    });

    titleInput.addEventListener("input", () => {
      btn.disabled = titleInput.value.trim().length === 0;
    });

    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        dueInput.focus();
      }
    });
    dueInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!btn.disabled) void this.submit(titleInput, dueInput, btn);
      }
    });

    titleInput.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private addField(parent: HTMLElement, label: string, placeholder: string): HTMLInputElement {
    const row = parent.createDiv({ cls: "iris-tasks-new-prereq-field" });
    if (label) row.createEl("label", { text: label });
    const input = row.createEl("input", { type: "text" });
    if (placeholder) input.placeholder = placeholder;
    return input;
  }

  private async submit(
    titleInput: HTMLInputElement,
    dueInput: HTMLInputElement,
    btn: HTMLButtonElement,
  ): Promise<void> {
    if (this.submitting) return;
    const title = titleInput.value.trim();
    if (!title) {
      new Notice("Title is required");
      return;
    }

    this.submitting = true;
    const originalText = btn.textContent ?? "Create";
    btn.disabled = true;
    btn.setText("Creating…");
    titleInput.disabled = true;
    dueInput.disabled = true;

    let dueDate: string | null = null;
    let dueTime: string | null = null;
    const raw = dueInput.value.trim();
    if (raw) {
      const due = await parseDueDate(this.plugin, raw);
      if (!due) {
        new Notice("Couldn't understand that date");
        btn.setText(originalText);
        btn.disabled = false;
        titleInput.disabled = false;
        dueInput.disabled = false;
        dueInput.focus();
        this.submitting = false;
        return;
      }
      dueDate = due.date;
      dueTime = due.time;
    }

    try {
      await this.onSubmit({ title, dueDate, dueTime });
      this.close();
    } finally {
      this.submitting = false;
    }
  }
}

class SeriesModal extends Modal {
  private plugin: IrisTasksPlugin;
  private series: { id: string; memberIds: string[] };
  private bodyEl!: HTMLElement;
  private draggingTaskId: string | null = null;
  /** Member ids being group-dragged (when set, drag is a multi-selection drag). */
  private draggingGroupIds: string[] = [];
  private dropBeforeId: string | null = null;
  private dropAtEnd = false;
  private selectedIds = new Set<string>();
  private selectionAnchorId: string | null = null;

  constructor(
    app: App,
    plugin: IrisTasksPlugin,
    series: { id: string; memberIds: string[] },
    _currentId: string,
  ) {
    super(app);
    this.plugin = plugin;
    this.series = series;
  }

  private toolbarEl!: HTMLElement;
  private selectAllBtn!: HTMLButtonElement;

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Task series");
    contentEl.addClass("iris-tasks-series-modal", "iris-tasks");

    this.toolbarEl = contentEl.createDiv({ cls: "iris-tasks-series-toolbar" });
    this.selectAllBtn = this.toolbarEl.createEl("button", {
      cls: "iris-tasks-series-toolbar-btn",
      text: "Select all",
    });
    this.selectAllBtn.addEventListener("click", () => this.toggleSelectAll());

    this.bodyEl = contentEl.createDiv({ cls: "iris-hp-list-container" });
    this.bodyEl.tabIndex = -1;
    contentEl.addEventListener("keydown", (e) => this.handleKeydown(e));
    this.renderContent();
    this.refreshToolbar();
  }

  private toggleSelectAll(): void {
    const allSelected = this.series.memberIds.length > 0
      && this.series.memberIds.every((id) => this.selectedIds.has(id));
    if (allSelected) {
      this.clearSelection();
    } else {
      this.selectedIds = new Set(this.series.memberIds);
      this.selectionAnchorId = this.series.memberIds[0] ?? null;
      this.refreshSelectionClasses();
    }
  }

  private refreshToolbar(): void {
    if (!this.selectAllBtn) return;
    const allSelected = this.series.memberIds.length > 0
      && this.series.memberIds.every((id) => this.selectedIds.has(id));
    this.selectAllBtn.setText(allSelected ? "Clear all" : "Select all");
  }

  private handleKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target.matches("input, textarea")) return;
    if (e.key === "Escape" && this.selectedIds.size > 0) {
      e.preventDefault();
      e.stopPropagation();
      this.clearSelection();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      e.preventDefault();
      this.selectedIds = new Set(this.series.memberIds);
      this.selectionAnchorId = this.series.memberIds[0] ?? null;
      this.refreshSelectionClasses();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.selectedIds.size > 1) {
      e.preventDefault();
      const ids = [...this.selectedIds];
      const list = this.plugin.settings.manualTasks;
      const tasks = ids
        .map((id) => list.find((m) => m.id === id))
        .filter((m): m is ManualTask => !!m);
      if (tasks.length > 0) void this.applyBulkDelete(tasks);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderContent(): void {
    this.bodyEl.empty();
    const manualById = new Map(
      this.plugin.settings.manualTasks.map((m) => [m.id, m]),
    );
    const total = this.series.memberIds.length;
    for (let i = 0; i < total; i++) {
      const mid = this.series.memberIds[i];
      const m = manualById.get(mid);
      if (!m) continue;
      this.bodyEl.appendChild(this.buildRowElement(mid, m, i + 1, total));
    }
    const entry = document.createElement("div");
    entry.addClass("iris-hp-list-item", "iris-tasks-create-entry");
    this.renderCreateEntryIdle(entry);
    this.bodyEl.appendChild(entry);
  }

  private startInlineRename(span: HTMLElement, mid: string, currentTitle: string): void {
    if (span.querySelector("input")) return;
    const original = span.textContent ?? currentTitle;
    const input = document.createElement("input");
    input.type = "text";
    input.value = original;
    input.addClass("iris-tasks-inline-rename");
    span.textContent = "";
    span.appendChild(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = (commit: boolean): void => {
      if (finished) return;
      finished = true;
      const next = input.value.trim();
      span.textContent = original;
      if (!commit) return;
      if (!next || next === original) return;
      const list = this.plugin.settings.manualTasks;
      const idx = list.findIndex((m) => m.id === mid);
      if (idx === -1) return;
      list[idx] = { ...list[idx], title: next };
      if (this.plugin.settings.currentTaskId === mid) {
        this.plugin.settings.currentTaskTitle = next;
      }
      void this.plugin.saveSettings().then(() => {
        this.renderContent();
        TaskView.refreshAll();
        this.plugin.updateCurrentTaskBar();
      });
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
      e.stopPropagation();
    });
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  private renderCreateEntryIdle(el: HTMLElement): void {
    el.empty();
    el.removeClass("is-editing");
    const self = el.createDiv({ cls: "iris-hp-list-item-self iris-tasks-create-entry-self" });
    self.createSpan({ cls: "iris-tasks-drag-handle iris-tasks-ghost" });
    const icon = self.createSpan({ cls: "iris-tasks-create-entry-icon" });
    setIcon(icon, "plus");
    el.onclick = () => this.renderCreateEntryEditing(el);
  }

  private renderCreateEntryEditing(el: HTMLElement): void {
    el.empty();
    el.addClass("is-editing");
    el.onclick = null;
    const self = el.createDiv({ cls: "iris-hp-list-item-self iris-tasks-create-entry-self" });
    self.createSpan({ cls: "iris-tasks-drag-handle iris-tasks-ghost" });
    const input = self.createEl("input", {
      type: "text",
      cls: "iris-tasks-create-entry-input",
    });
    input.placeholder = "Task name…";

    const submit = async (): Promise<void> => {
      const title = input.value.trim();
      if (!title) {
        this.renderCreateEntryIdle(el);
        return;
      }
      input.disabled = true;
      const id =
        "m-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      this.plugin.settings.manualTasks.push({
        id,
        title,
        dueDate: null,
        dueTime: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      this.series.memberIds.push(id);
      const s = this.plugin.settings.taskSeries.find((ts) => ts.id === this.series.id);
      if (s) s.memberIds = [...this.series.memberIds];
      await this.plugin.saveSettings();
      this.renderContent();
      TaskView.refreshAll();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.renderCreateEntryIdle(el);
      }
    });
    input.addEventListener("blur", () => {
      if (input.disabled) return;
      if (!input.value.trim()) this.renderCreateEntryIdle(el);
    });
    input.focus();
  }

  private buildRowElement(
    mid: string,
    m: ManualTask,
    index: number,
    total: number,
  ): HTMLElement {
    const isComplete = !!m.completedAt;
    const isCurrent = this.plugin.settings.enableCurrentTask && this.plugin.settings.currentTaskId === mid;
    const isArchived = this.plugin.settings.archivedTaskIds.includes(mid);
    const overrideTitle = this.plugin.settings.taskTitleOverrides[mid];
    const title = overrideTitle ?? m.title;

    const item = document.createElement("div");
    item.addClass("iris-hp-list-item");
    item.dataset.taskId = mid;
    item.setAttribute("draggable", "true");
    this.attachItemDragHandlers(item, mid);

    const selfClasses = ["iris-hp-list-item-self", "is-clickable"];
    if (isComplete) selfClasses.push("is-completed");
    if (isCurrent) selfClasses.push("is-current-task");
    if (isArchived) selfClasses.push("is-archived");
    if (this.selectedIds.has(mid)) selfClasses.push("is-selected");
    const self = item.createDiv({ cls: selfClasses.join(" ") });

    self.addEventListener("click", (e) => {
      if (e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        this.extendSelectionTo(mid);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleSelection(mid);
        return;
      }
      if (this.selectedIds.size > 0) {
        this.clearSelection();
        return;
      }
      if (this.plugin.settings.enableCurrentTask) {
        if (this.plugin.settings.currentTaskId === mid) {
          void this.plugin.clearCurrentTask().then(() => this.renderContent());
        } else {
          void this.plugin
            .setCurrentTask(mid, title)
            .then(() => this.renderContent());
        }
      }
    });

    this.attachDragHandle(self, mid);
    this.attachDropTarget(item, mid);

    const checkbox = self.createEl("input", {
      cls: "task-list-item-checkbox",
      type: "checkbox",
    });
    checkbox.checked = isComplete;
    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.toggleComplete(mid);
    });

    const inner = self.createDiv({ cls: "iris-hp-list-item-inner" });
    {
      const trLink = this.plugin.taskRatchetLinkForTask(mid);
      if (trLink) {
        const gear = inner.createSpan({ cls: `iris-tasks-tr-lock iris-tasks-tr-lock-${trLink.status}` });
        gear.setAttribute("aria-label", `TaskRatchet: ${formatStake(trLink.cents)} (${trLink.status})`);
        setIcon(gear, "lock");
        if (trLink.status === "pending") {
          gear.addEventListener("click", (e) => {
            e.stopPropagation();
            showTaskRatchetGearMenu(this.plugin, mid, trLink, e);
          });
        }
      }
    }
    const titleSpan = inner.createSpan({
      cls: "iris-tasks-title-link",
      text: title,
    });
    titleSpan.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.shiftKey) {
        e.preventDefault();
        this.extendSelectionTo(mid);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.toggleSelection(mid);
        return;
      }
      if (this.selectedIds.size > 0) {
        this.clearSelection();
        return;
      }
      void this.plugin
        .setCurrentTask(mid, title)
        .then(() => this.renderContent());
    });
    titleSpan.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.startInlineRename(titleSpan, mid, title);
    });
    titleSpan.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.selectedIds.has(mid) && this.selectedIds.size > 1) {
        this.openBulkContextMenu(e);
      } else {
        if (this.selectedIds.size > 0) this.clearSelection();
        this.openContextMenu(mid, title, e);
      }
    });

    inner.createSpan({
      cls: "iris-tasks-series-badge",
      text: `${index}/${total}`,
    });

    return item;
  }

  private attachDragHandle(self: HTMLElement, _taskId: string): void {
    // Visual cue only — the row item is the actual draggable element. See attachItemDragHandlers.
    const handle = document.createElement("span");
    handle.addClass("iris-tasks-drag-handle");
    handle.setAttribute("aria-label", "Drag to reorder");

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 10 16");
    svg.setAttribute("aria-hidden", "true");
    for (const [cx, cy] of [[3, 3], [7, 3], [3, 8], [7, 8], [3, 13], [7, 13]]) {
      const c = document.createElementNS(svgNS, "circle");
      c.setAttribute("cx", String(cx));
      c.setAttribute("cy", String(cy));
      c.setAttribute("r", "1.2");
      svg.appendChild(c);
    }
    handle.appendChild(svg);

    self.insertBefore(handle, self.firstChild);
  }

  private attachItemDragHandlers(item: HTMLElement, taskId: string): void {
    item.addEventListener("dragstart", (e) => {
      if ((e.target as HTMLElement).closest("input, textarea")) {
        e.preventDefault();
        return;
      }
      e.stopPropagation();
      this.draggingTaskId = taskId;
      this.dropBeforeId = null;
      this.dropAtEnd = false;
      if (this.selectedIds.has(taskId) && this.selectedIds.size > 1) {
        this.draggingGroupIds = this.series.memberIds.filter((id) => this.selectedIds.has(id));
        for (const id of this.draggingGroupIds) {
          const row = this.bodyEl.querySelector<HTMLElement>(
            `.iris-hp-list-item[data-task-id="${CSS.escape(id)}"]`,
          );
          row?.classList.add("is-dragging");
        }
      } else {
        this.draggingGroupIds = [];
        item.classList.add("is-dragging");
      }
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", taskId);
      }
    });
    item.addEventListener("dragend", () => {
      this.draggingTaskId = null;
      this.draggingGroupIds = [];
      this.dropBeforeId = null;
      this.dropAtEnd = false;
      this.clearDropIndicators();
      this.bodyEl.querySelectorAll(".is-dragging").forEach((el) => {
        el.classList.remove("is-dragging");
      });
    });
  }

  private clearDropIndicators(): void {
    this.bodyEl.querySelectorAll(".is-drop-above, .is-drop-below").forEach((el) => {
      el.classList.remove("is-drop-above", "is-drop-below");
    });
  }

  private attachDropTarget(item: HTMLElement, taskId: string): void {
    const isInDraggedSet = (id: string): boolean => {
      if (this.draggingGroupIds.length > 0) return this.draggingGroupIds.includes(id);
      return id === this.draggingTaskId;
    };

    item.addEventListener("dragover", (e) => {
      if (!this.draggingTaskId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = item.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      this.clearDropIndicators();
      if (above) {
        if (isInDraggedSet(taskId)) {
          this.dropBeforeId = null;
          this.dropAtEnd = false;
          return;
        }
        item.classList.add("is-drop-above");
        this.dropBeforeId = taskId;
        this.dropAtEnd = false;
      } else {
        const next = item.nextElementSibling as HTMLElement | null;
        const nextIsRow = !!next && next.classList.contains("iris-hp-list-item") && !!next.dataset.taskId;
        if (nextIsRow && next) {
          const nextId = next.dataset.taskId ?? "";
          if (isInDraggedSet(nextId) || isInDraggedSet(taskId)) {
            this.dropBeforeId = null;
            this.dropAtEnd = false;
            return;
          }
          next.classList.add("is-drop-above");
          this.dropBeforeId = nextId;
          this.dropAtEnd = false;
        } else {
          if (isInDraggedSet(taskId)) {
            this.dropBeforeId = null;
            this.dropAtEnd = false;
            return;
          }
          item.classList.add("is-drop-below");
          this.dropBeforeId = null;
          this.dropAtEnd = true;
        }
      }
    });
    item.addEventListener("drop", (e) => {
      const sourceId = this.draggingTaskId;
      if (!sourceId) return;
      e.preventDefault();
      const before = this.dropBeforeId;
      const atEnd = this.dropAtEnd;
      const groupIds = [...this.draggingGroupIds];
      this.clearDropIndicators();
      this.dropBeforeId = null;
      this.dropAtEnd = false;
      if (!atEnd && !before) return;
      if (groupIds.length > 0) {
        void this.reorderSeriesMembersBulk(groupIds, before, atEnd);
      } else {
        void this.reorderSeriesMembers(sourceId, before, atEnd);
      }
    });
  }

  private async reorderSeriesMembersBulk(
    sourceIds: string[],
    beforeId: string | null,
    atEnd: boolean,
  ): Promise<void> {
    if (sourceIds.length === 0) return;
    const movingSet = new Set(sourceIds);
    const ids = [...this.series.memberIds];
    const moving = ids.filter((id) => movingSet.has(id));
    if (moving.length === 0) return;
    const remaining = ids.filter((id) => !movingSet.has(id));
    let dstIdx: number;
    if (atEnd) {
      dstIdx = remaining.length;
    } else {
      if (!beforeId) return;
      dstIdx = remaining.indexOf(beforeId);
      if (dstIdx === -1) return;
    }
    remaining.splice(dstIdx, 0, ...moving);
    this.series.memberIds = remaining;
    const s = this.plugin.settings.taskSeries.find((ts) => ts.id === this.series.id);
    if (s) s.memberIds = remaining;
    await this.plugin.saveSettings();
    this.renderContent();
    TaskView.refreshAll();
  }

  private toggleSelection(id: string): void {
    if (this.selectedIds.has(id)) this.selectedIds.delete(id);
    else this.selectedIds.add(id);
    this.selectionAnchorId = id;
    this.refreshSelectionClasses();
  }

  private extendSelectionTo(id: string): void {
    if (!this.selectionAnchorId) {
      this.selectedIds.add(id);
      this.selectionAnchorId = id;
      this.refreshSelectionClasses();
      return;
    }
    const ids = this.series.memberIds;
    const a = ids.indexOf(this.selectionAnchorId);
    const b = ids.indexOf(id);
    if (a === -1 || b === -1) {
      this.selectedIds.add(id);
      this.refreshSelectionClasses();
      return;
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) this.selectedIds.add(ids[i]);
    this.refreshSelectionClasses();
  }

  private clearSelection(): void {
    if (this.selectedIds.size === 0 && this.selectionAnchorId === null) return;
    this.selectedIds.clear();
    this.selectionAnchorId = null;
    this.refreshSelectionClasses();
  }

  private refreshSelectionClasses(): void {
    const items = this.bodyEl.querySelectorAll<HTMLElement>(".iris-hp-list-item[data-task-id]");
    items.forEach((el) => {
      const id = el.dataset.taskId;
      const self = el.querySelector<HTMLElement>(".iris-hp-list-item-self");
      if (!self || !id) return;
      self.classList.toggle("is-selected", this.selectedIds.has(id));
    });
    this.refreshToolbar();
  }

  private openBulkContextMenu(e: MouseEvent): void {
    const ids = [...this.selectedIds];
    if (ids.length === 0) return;
    const list = this.plugin.settings.manualTasks;
    const tasks = ids
      .map((id) => list.find((m) => m.id === id))
      .filter((m): m is ManualTask => !!m);
    if (tasks.length === 0) return;

    const menu = new Menu();
    const archivedSet = new Set(this.plugin.settings.archivedTaskIds);
    const anyIncomplete = tasks.some((t) => !t.completedAt);
    const anyUnarchived = tasks.some((t) => !archivedSet.has(t.id));

    menu.addItem((i) =>
      i
        .setTitle(anyIncomplete ? `Complete ${tasks.length}` : `Uncomplete ${tasks.length}`)
        .setIcon(anyIncomplete ? "check-circle" : "circle")
        .onClick(() => void this.applyBulkComplete(tasks, anyIncomplete)),
    );
    menu.addItem((i) =>
      i
        .setTitle(anyUnarchived ? `Archive ${tasks.length}` : `Unarchive ${tasks.length}`)
        .setIcon(anyUnarchived ? "archive" : "archive-restore")
        .onClick(() => void this.applyBulkArchive(tasks, anyUnarchived)),
    );
    menu.addItem((i) =>
      i
        .setTitle(`Delete ${tasks.length} (Del)`)
        .setIcon("trash-2")
        .onClick(() => void this.applyBulkDelete(tasks)),
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Clear selection (Esc)").setIcon("x").onClick(() => this.clearSelection()),
    );
    menu.showAtMouseEvent(e);
  }

  private async applyBulkComplete(tasks: ManualTask[], makeComplete: boolean): Promise<void> {
    const list = this.plugin.settings.manualTasks;
    const now = new Date().toISOString();
    let touched = false;
    const completedIds: string[] = [];
    const split = makeComplete
      ? { allowed: tasks, blocked: [] as ManualTask[] }
      : partitionByPolicy(
          tasks,
          (t) => editCapabilities(this.plugin, t.id).canUncheck,
        );
    for (const t of split.allowed) {
      const idx = list.findIndex((m) => m.id === t.id);
      if (idx === -1) continue;
      const isComplete = !!list[idx].completedAt;
      if (makeComplete && isComplete) continue;
      if (!makeComplete && !isComplete) continue;
      list[idx] = { ...list[idx], completedAt: makeComplete ? now : null };
      if (makeComplete && this.plugin.settings.currentTaskId === t.id) {
        this.plugin.settings.currentTaskId = null;
        this.plugin.settings.currentTaskTitle = null;
      }
      if (makeComplete) completedIds.push(t.id);
      touched = true;
    }
    this.clearSelection();
    if (split.blocked.length > 0) {
      new Notice(
        `Skipped ${split.blocked.length} task${split.blocked.length === 1 ? "" : "s"} locked by TaskRatchet.`,
      );
    }
    if (touched) {
      await this.plugin.saveSettings();
      this.renderContent();
      TaskView.refreshAll();
      this.plugin.updateCurrentTaskBar();
      for (const id of completedIds) {
        void this.plugin.syncTaskRatchetCompletion(id);
      }
    }
  }

  private async applyBulkArchive(tasks: ManualTask[], makeArchived: boolean): Promise<void> {
    const s = this.plugin.settings;
    const archived = new Set(s.archivedTaskIds);
    let touched = false;
    const split = makeArchived
      ? partitionByPolicy(
          tasks,
          (t) => editCapabilities(this.plugin, t.id).canArchive,
        )
      : { allowed: tasks, blocked: [] as ManualTask[] };
    for (const t of split.allowed) {
      if (makeArchived && !archived.has(t.id)) {
        archived.add(t.id);
        if (s.currentTaskId === t.id) {
          s.currentTaskId = null;
          s.currentTaskTitle = null;
        }
        touched = true;
      } else if (!makeArchived && archived.has(t.id)) {
        archived.delete(t.id);
        touched = true;
      }
    }
    this.clearSelection();
    if (split.blocked.length > 0) {
      new Notice(
        `Skipped ${split.blocked.length} task${split.blocked.length === 1 ? "" : "s"} locked by TaskRatchet.`,
      );
    }
    if (touched) {
      s.archivedTaskIds = [...archived];
      await this.plugin.saveSettings();
      this.renderContent();
      TaskView.refreshAll();
      this.plugin.updateCurrentTaskBar();
    }
  }

  private async applyBulkDelete(tasks: ManualTask[]): Promise<void> {
    if (tasks.length === 0) return;
    const { allowed: deletable, blocked } = partitionByPolicy(
      tasks,
      (t) => editCapabilities(this.plugin, t.id).canDelete,
    );
    if (blocked.length > 0) {
      new Notice(
        `Skipped ${blocked.length} task${blocked.length === 1 ? "" : "s"} locked by TaskRatchet.`,
      );
    }
    if (deletable.length === 0) {
      this.clearSelection();
      return;
    }
    const idSet = new Set(deletable.map((t) => t.id));
    const snapshot = snapshotDeletableState(this.plugin);
    const destroyedSeries = applyDeleteMutation(this.plugin, idSet);
    const seriesGone = destroyedSeries.includes(this.series.id);
    if (!seriesGone) {
      const live = this.plugin.settings.taskSeries.find((ts) => ts.id === this.series.id);
      if (live) this.series.memberIds = [...live.memberIds];
    }
    this.clearSelection();
    await this.plugin.saveSettings();
    TaskView.refreshAll();
    this.plugin.updateCurrentTaskBar();
    if (seriesGone) this.close();
    else this.renderContent();
    showDeleteNoticeWithUndo(
      this.plugin,
      snapshot,
      `${deletable.length} task${deletable.length === 1 ? "" : "s"}`,
    );
  }

  private async reorderSeriesMembers(
    sourceId: string,
    beforeId: string | null,
    atEnd: boolean,
  ): Promise<void> {
    const ids = [...this.series.memberIds];
    const srcIdx = ids.indexOf(sourceId);
    if (srcIdx === -1) return;
    ids.splice(srcIdx, 1);
    let dstIdx: number;
    if (atEnd) {
      dstIdx = ids.length;
    } else {
      if (!beforeId) return;
      dstIdx = ids.indexOf(beforeId);
      if (dstIdx === -1) return;
    }
    ids.splice(dstIdx, 0, sourceId);
    this.series.memberIds = ids;
    const s = this.plugin.settings.taskSeries.find((ts) => ts.id === this.series.id);
    if (s) s.memberIds = ids;
    await this.plugin.saveSettings();
    this.renderContent();
    TaskView.refreshAll();
  }

  private async toggleComplete(mid: string): Promise<void> {
    const list = this.plugin.settings.manualTasks;
    const idx = list.findIndex((mt) => mt.id === mid);
    if (idx === -1) return;
    const isCurrentlyComplete = !!list[idx].completedAt;
    if (isCurrentlyComplete) {
      const caps = editCapabilities(this.plugin, mid);
      if (!caps.canUncheck) {
        new Notice(lockReason(caps));
        return;
      }
    }
    const now = new Date().toISOString();
    list[idx] = {
      ...list[idx],
      completedAt: isCurrentlyComplete ? null : now,
    };
    const becameComplete = !!list[idx].completedAt;
    if (becameComplete && this.plugin.settings.currentTaskId === mid) {
      this.plugin.settings.currentTaskId = null;
      this.plugin.settings.currentTaskTitle = null;
    }
    await this.plugin.saveSettings();
    this.renderContent();
    TaskView.refreshAll();
    this.plugin.updateCurrentTaskBar();
    if (becameComplete) {
      void this.plugin.syncTaskRatchetCompletion(mid);
    }
  }

  private openContextMenu(mid: string, title: string, e: MouseEvent): void {
    const menu = new Menu();
    const caps = editCapabilities(this.plugin, mid);
    menu.addItem((i) =>
      i
        .setTitle(caps.canRename ? "Rename…" : "Rename (locked)")
        .setIcon("pencil")
        .setDisabled(!caps.canRename)
        .onClick(() => {
          new RenameTaskModal(this.app, title, async (next) => {
            const trimmed = next.trim();
            if (!trimmed || trimmed === title) return;
            const live = editCapabilities(this.plugin, mid);
            if (!live.canRename) {
              new Notice(lockReason(live));
              return;
            }
            const list = this.plugin.settings.manualTasks;
            const idx = list.findIndex((mt) => mt.id === mid);
            if (idx === -1) return;
            list[idx] = { ...list[idx], title: trimmed };
            if (this.plugin.settings.currentTaskId === mid) {
              this.plugin.settings.currentTaskTitle = trimmed;
            }
            await this.plugin.saveSettings();
            this.renderContent();
            TaskView.refreshAll();
            this.plugin.updateCurrentTaskBar();
          }).open();
        }),
    );

    if (caps.canSetDue !== "blocked") {
      const manual = this.plugin.settings.manualTasks.find((m) => m.id === mid);
      const hasDue = !!(manual?.dueDate || this.plugin.settings.taskDueDateOverrides[mid]);
      menu.addItem((i) =>
        i
          .setTitle(hasDue ? "Change deadline…" : "Set deadline…")
          .setIcon("calendar")
          .onClick(() => {
            const task: Task = {
              id: mid,
              title,
              status: manual?.completedAt ? "completed" : "incomplete",
              priority: null,
              dueDate: manual?.dueDate ?? null,
              dueTime: manual?.dueTime ?? null,
              created: manual?.createdAt ?? null,
              source: "manual",
              sourceIds: [],
              dependsOn: [],
              aiRank: null,
            };
            this.openSetDeadlineModal(task);
          }),
      );
      if (hasDue) {
        menu.addItem((i) =>
          i
            .setTitle("Clear deadline")
            .setIcon("calendar-x")
            .onClick(() => {
              const task: Task = {
                id: mid,
                title,
                status: "incomplete",
                priority: null,
                dueDate: manual?.dueDate ?? null,
                dueTime: manual?.dueTime ?? null,
                created: manual?.createdAt ?? null,
                source: "manual",
                sourceIds: [],
                dependsOn: [],
                aiRank: null,
              };
              void this.applyClearDeadline(task);
            }),
        );
      }
      menu.addItem((i) =>
        i
          .setTitle("Start now")
          .setIcon("play")
          .onClick(() => {
            if (!manual?.durationMin) {
              new Notice("Set a duration on this task first.");
              return;
            }
            const end = new Date(Date.now() + manual.durationMin * 60_000);
            const date = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
            const time = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
            const task: Task = {
              id: mid,
              title,
              status: "incomplete",
              priority: null,
              dueDate: manual?.dueDate ?? null,
              dueTime: manual?.dueTime ?? null,
              created: manual?.createdAt ?? null,
              source: "manual",
              sourceIds: [],
              dependsOn: [],
              aiRank: null,
            };
            void this.applySetDeadline(task, date, time);
          }),
      );
    }

    if (this.plugin.settings.taskratchetEnabled) {
      menu.addSeparator();
      const trLink = this.plugin.taskRatchetLinkForTask(mid);
      const manual = this.plugin.settings.manualTasks.find((m) => m.id === mid);
      if (!trLink) {
        menu.addItem((i) =>
          i
            .setTitle("TaskRatchet")
            .setIcon("lock")
            .onClick(() =>
              void this.plugin.stakeTaskRatchet(
                mid,
                title,
                manual?.dueDate ?? null,
                manual?.dueTime ?? null,
              ),
            ),
        );
      } else {
        menu.addItem((i) =>
          i
            .setTitle(`Staked ${formatStake(trLink.cents)} (${trLink.status})`)
            .setDisabled(true),
        );
        if (trLink.status === "pending") {
          menu.addItem((i) =>
            i
              .setTitle("Forfeit stake (uncle)")
              .setIcon("flag")
              .onClick(() => {
                if (
                  confirm(
                    `Forfeit ${formatStake(trLink.cents)}? Your card will be charged immediately.`,
                  )
                ) {
                  void this.plugin.uncleTaskRatchet(mid);
                }
              }),
          );
        }
      }
    }

    const isArchived = this.plugin.settings.archivedTaskIds.includes(mid);
    const showArchive = isArchived || caps.canArchive;
    const showDelete = caps.canDelete;
    if (showArchive || showDelete) menu.addSeparator();

    if (showArchive) {
      menu.addItem((i) =>
        i
          .setTitle(isArchived ? "Unarchive" : "Archive")
          .setIcon(isArchived ? "archive-restore" : "archive")
          .onClick(async () => {
            const arr = this.plugin.settings.archivedTaskIds;
            if (isArchived) {
              this.plugin.settings.archivedTaskIds = arr.filter((id) => id !== mid);
            } else {
              const live = editCapabilities(this.plugin, mid);
              if (!live.canArchive) {
                new Notice(lockReason(live));
                return;
              }
              if (!arr.includes(mid)) arr.push(mid);
            }
            await this.plugin.saveSettings();
            this.renderContent();
            TaskView.refreshAll();
          }),
      );
    }

    if (showDelete) {
      menu.addItem((i) =>
        i
          .setTitle("Delete")
          .setIcon("trash-2")
          .onClick(() => void this.deleteMember(mid, title)),
      );
    }

    menu.showAtMouseEvent(e);
  }

  private async deleteMember(mid: string, title: string): Promise<void> {
    const caps = editCapabilities(this.plugin, mid);
    if (!caps.canDelete) {
      new Notice(lockReason(caps));
      return;
    }
    const snapshot = snapshotDeletableState(this.plugin);
    const destroyedSeries = applyDeleteMutation(this.plugin, new Set([mid]));
    const seriesGone = destroyedSeries.includes(this.series.id);
    if (!seriesGone) {
      const live = this.plugin.settings.taskSeries.find((ts) => ts.id === this.series.id);
      if (live) this.series.memberIds = [...live.memberIds];
    }
    await this.plugin.saveSettings();
    TaskView.refreshAll();
    this.plugin.updateCurrentTaskBar();
    if (seriesGone) this.close();
    else this.renderContent();
    showDeleteNoticeWithUndo(this.plugin, snapshot, `"${title}"`);
  }

  private openSetDeadlineModal(task: Task): void {
    const caps = editCapabilities(this.plugin, task.id);
    new SetDeadlineModal(
      this.app,
      this.plugin,
      task,
      caps.canSetDue,
      async (date, time) => {
        const live = editCapabilities(this.plugin, task.id);
        if (live.canSetDue === "blocked") {
          new Notice(lockReason(live));
          return;
        }
        const proposedDue = toTaskRatchetDeadline(date, time);
        if (proposedDue !== null) {
          const ok = await this.plugin.tryReduceTaskRatchetDeadline(task.id, proposedDue);
          if (!ok) return;
        }
        const list = this.plugin.settings.manualTasks;
        const idx = list.findIndex((m) => m.id === task.id);
        if (idx !== -1) {
          list[idx] = { ...list[idx], dueDate: date, dueTime: time };
        }
        this.plugin.settings.taskDueDateOverrides = {
          ...this.plugin.settings.taskDueDateOverrides,
          [task.id]: { date, time },
        };
        await this.plugin.saveSettings();
        this.renderContent();
        TaskView.refreshAll();
      },
    ).open();
  }

  private async applyClearDeadline(task: Task): Promise<void> {
    const caps = editCapabilities(this.plugin, task.id);
    if (caps.canSetDue === "blocked") {
      new Notice(lockReason(caps));
      return;
    }
    const link = this.plugin.taskRatchetLinkForTask(task.id);
    if (link && link.status === "pending") {
      new Notice("TaskRatchet stakes require a deadline — pick an earlier one instead of clearing.");
      return;
    }
    const list = this.plugin.settings.manualTasks;
    const idx = list.findIndex((m) => m.id === task.id);
    if (idx !== -1) {
      list[idx] = { ...list[idx], dueDate: null, dueTime: null };
    }
    const { [task.id]: _, ...rest } = this.plugin.settings.taskDueDateOverrides;
    this.plugin.settings.taskDueDateOverrides = rest;
    await this.plugin.saveSettings();
    this.renderContent();
    TaskView.refreshAll();
  }
}
