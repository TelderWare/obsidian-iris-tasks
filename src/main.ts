import { Menu, Notice, Plugin, TFile, type EventRef } from "obsidian";
import { TaskView, VIEW_TYPE_TASKS } from "./task-view";
import { isSpecialDueDate } from "./task-parser";
import {
  IrisTasksSettings,
  IrisTasksSettingTab,
  hydrateSettings,
  type ManualTask,
  type AutoCompleteCondition,
  type AutoCompleteWordCountCondition,
} from "./settings";
import {
  buildIrisHomepageWidgets,
  type IrisHomepageWidgetDescriptor,
} from "./widgets/IrisHomepageWidgets";
import {
  createTask as createTaskRatchetTask,
  fetchTask as fetchTaskRatchetTask,
  formatStake,
  markComplete as markTaskRatchetComplete,
  toTaskRatchetDeadline,
  uncleTask as uncleTaskRatchetTask,
  updateTask as updateTaskRatchetTask,
  type TaskRatchetLink,
} from "./taskratchet";
import {
  TaskRatchetApiKeyModal,
  TaskRatchetStakeModal,
} from "./taskratchet-modal";
import {
  editCapabilities,
  fieldUpdatePolicy,
  lockReason,
} from "./task-edit-policy";

export default class IrisTasksPlugin extends Plugin {
  settings!: IrisTasksSettings;
  statusBarEl: HTMLElement | null = null;
  /** Title of whatever's at the top of the most recently rendered task list. */
  topTaskTitle: string | null = null;
  private metaRef: EventRef | null = null;
  private vaultModifyRef: EventRef | null = null;
  private taskratchetPollHandle: number | null = null;
  /** Debounce timer per file path for word-count auto-complete checks. */
  private wordCountTimers: Map<string, number> = new Map();
  /** Cached word counts per file path, updated on file modify events. */
  wordCountCache: Map<string, number> = new Map();
  private static readonly WORD_COUNT_DEBOUNCE_MS = 500;
  private startNotifyHandle: number | null = null;
  private static readonly START_NOTIFY_INTERVAL_MS = 30_000;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_TASKS, (leaf) => new TaskView(leaf, this));
    this.addRibbonIcon("list-todo", "Open Tasks", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-iris-tasks",
      name: "Open Tasks",
      callback: () => this.activateView(),
    });

    this.addSettingTab(new IrisTasksSettingTab(this.app, this));

    if (this.settings.enableCurrentTask) {
      this.statusBarEl = this.addStatusBarItem();
      this.statusBarEl.addClass("iris-tasks-current-task-bar");
      this.statusBarEl.addEventListener("click", (e) => this.showCurrentTaskMenu(e));
      this.updateCurrentTaskBar();
    }

    this.metaRef = this.app.metadataCache.on("changed", (file) => {
      void this.checkAutoComplete(file);
    });

    this.vaultModifyRef = this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) {
        this.scheduleWordCountAutoComplete(file);
      }
    });

    this.refreshTaskRatchet();
    this.refreshStartNotifications();
  }

  async onunload(): Promise<void> {
    if (this.metaRef) this.app.metadataCache.offref(this.metaRef);
    if (this.vaultModifyRef) this.app.vault.offref(this.vaultModifyRef);
    for (const handle of this.wordCountTimers.values()) window.clearTimeout(handle);
    this.wordCountTimers.clear();
    this.stopStartNotificationPolling();
    this.stopTaskRatchetPolling();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TASKS);
  }

  private async checkAutoComplete(file: TFile): Promise<void> {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    let mutated = false;
    let completed = false;
    for (const task of this.settings.manualTasks) {
      if (task.completedAt) continue;
      const ac = task.autoCompleteWhen;
      if (!ac || ac.filePath !== file.path) continue;
      const raw = fm?.[ac.frontmatterKey];
      const value = raw == null ? "" : String(raw).trim().toLowerCase();
      if (value !== "" && ac.oneOf.includes(value)) {
        const r = await this.autoCompleteTask(task);
        if (r.mutated) mutated = true;
        if (r.completed) completed = true;
      }
    }
    if (mutated) {
      await this.saveSettings();
      if (completed) TaskView.refreshAll();
    }
  }

  /**
   * Auto-complete a task, deferring to TaskRatchet when staked. TR is the
   * source of truth once a stake is in place, so we ask TR first and only
   * set local `completedAt` after TR confirms. On TR failure, mark the
   * link `pendingComplete` so the next poll retries — the task stays
   * locally incomplete in the meantime so we never claim completion the
   * stake hasn't been credited for.
   */
  private async autoCompleteTask(
    task: ManualTask,
  ): Promise<{ completed: boolean; mutated: boolean }> {
    const link = this.taskRatchetLinkForTask(task.id);
    if (link && link.status === "pending") {
      const key = this.settings.taskratchetApiKey;
      if (!this.settings.taskratchetEnabled || !key) {
        console.warn(
          `iris-tasks: skipping auto-complete for "${task.title}" — staked but TaskRatchet disabled`,
        );
        return { completed: false, mutated: false };
      }
      try {
        const updated = await markTaskRatchetComplete(key, link.trTaskId);
        link.status = updated.status ?? "complete";
        delete link.pendingComplete;
      } catch (err) {
        console.warn(
          `iris-tasks: auto-complete TR sync failed for "${task.title}", will retry`,
          err,
        );
        const wasPending = link.pendingComplete === true;
        link.pendingComplete = true;
        return { completed: false, mutated: !wasPending };
      }
    }
    task.completedAt = new Date().toISOString();
    new Notice(`Completed: ${task.title}`);
    return { completed: true, mutated: true };
  }

  private hasWordCountWatcher(path: string): boolean {
    for (const t of this.settings.manualTasks) {
      if (!t.completedAt && t.autoCompleteWhenWordCount?.filePath === path) return true;
    }
    return false;
  }

  private scheduleWordCountAutoComplete(file: TFile): void {
    // Skip if no incomplete word-count task watches this file. Avoids
    // creating timers for the 99% of files that aren't goals.
    if (!this.hasWordCountWatcher(file.path)) return;
    const existing = this.wordCountTimers.get(file.path);
    if (existing != null) window.clearTimeout(existing);
    const handle = window.setTimeout(() => {
      this.wordCountTimers.delete(file.path);
      void this.checkWordCountAutoComplete(file);
    }, IrisTasksPlugin.WORD_COUNT_DEBOUNCE_MS);
    this.wordCountTimers.set(file.path, handle);
  }

  private async checkWordCountAutoComplete(file: TFile): Promise<void> {
    const candidates = this.settings.manualTasks.filter(
      (t) => !t.completedAt && t.autoCompleteWhenWordCount?.filePath === file.path,
    );
    if (candidates.length === 0) return;
    const content = await this.app.vault.cachedRead(file);
    const wordCount = this.countWords(content);
    this.wordCountCache.set(file.path, wordCount);
    let mutated = false;
    let completed = false;
    for (const task of candidates) {
      if (wordCount >= task.autoCompleteWhenWordCount!.minWords) {
        const r = await this.autoCompleteTask(task);
        if (r.mutated) mutated = true;
        if (r.completed) completed = true;
      }
    }
    if (mutated) {
      await this.saveSettings();
      if (completed) TaskView.refreshAll();
    }
  }

  /**
   * Use iris-editor's `countWordsWc` when available so word-count goals match
   * the count shown in iris-editor's status bar (which respects user toggles
   * for frontmatter, code blocks, tables, citations, etc.). Falls back to a
   * simple whitespace split when iris-editor isn't installed.
   */
  countWords(text: string): number {
    const editor = (this.app as any).plugins?.getPlugin?.("iris-editor");
    if (editor && typeof editor.countWordsWc === "function") {
      try {
        const n = editor.countWordsWc(text);
        if (typeof n === "number" && Number.isFinite(n)) return n;
      } catch (err) {
        console.warn("iris-tasks: iris-editor countWordsWc failed, falling back", err);
      }
    }
    // Obsidian's vanilla "Word Count" core plugin only renders for the
    // active editor — it doesn't expose an API for counting arbitrary text.
    // Use Intl.Segmenter (what modern word counters use under the hood)
    // for Unicode-aware word segmentation that handles CJK, contractions, etc.
    type SegmenterCtor = new (
      locale?: string,
      opts?: { granularity?: "grapheme" | "word" | "sentence" },
    ) => { segment(s: string): Iterable<{ segment: string; isWordLike?: boolean }> };
    const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
    if (typeof Segmenter === "function") {
      const seg = new Segmenter(undefined, { granularity: "word" });
      let count = 0;
      for (const part of seg.segment(text)) {
        if (part.isWordLike) count++;
      }
      return count;
    }
    // Last-resort regex (older runtimes without Intl.Segmenter).
    let count = 0;
    for (const tok of text.split(/\s+/)) {
      if (tok && /[\p{L}\p{N}]/u.test(tok)) count++;
    }
    return count;
  }

  async upsertExternalTask(request: {
    id: string;
    title: string;
    dueDate?: string | null;
    dueTime?: string | null;
    durationMin?: number | null;
    onClickCommand?: string;
    autoCompleteWhen?: AutoCompleteCondition;
    autoCompleteWhenWordCount?: AutoCompleteWordCountCondition;
    autoCompletes?: boolean;
  }): Promise<string> {
    const existing = this.settings.manualTasks.find((t) => t.id === request.id);
    if (existing) {
      // Per-field policy decides what to do for each requested change.
      // For unstaked tasks every field is "allow" — same as the historical
      // behavior. For staked tasks, fields TR doesn't care about still go
      // through; title/reopen are dropped; due fields round-trip via TR.
      const allow = (field: Parameters<typeof fieldUpdatePolicy>[2]) =>
        fieldUpdatePolicy(this, existing.id, field) === "allow";

      if (allow("title")) existing.title = request.title;

      if (request.dueDate !== undefined || request.dueTime !== undefined) {
        const duePolicy = fieldUpdatePolicy(this, existing.id, "dueDate");
        if (duePolicy === "allow") {
          if (request.dueDate !== undefined) existing.dueDate = request.dueDate ?? null;
          if (request.dueTime !== undefined) existing.dueTime = request.dueTime ?? null;
        } else if (duePolicy === "tr-mediated") {
          // Compose the proposed deadline from the request, falling back
          // to the existing fields for ones the caller didn't pass. Only
          // attempt TR if it's actually different.
          const proposedDate = request.dueDate ?? existing.dueDate ?? null;
          const proposedTime =
            request.dueTime !== undefined ? request.dueTime : existing.dueTime;
          const proposedDue = toTaskRatchetDeadline(proposedDate, proposedTime);
          const link = this.taskRatchetLinkForTask(existing.id);
          if (proposedDue !== null && link && proposedDue !== link.due) {
            const ok = await this.tryReduceTaskRatchetDeadline(
              existing.id,
              proposedDue,
            );
            if (ok) {
              if (request.dueDate !== undefined) existing.dueDate = request.dueDate ?? null;
              if (request.dueTime !== undefined) existing.dueTime = request.dueTime ?? null;
            }
          }
        }
        // duePolicy === "drop": leave existing due fields alone.
      }

      if (request.durationMin !== undefined && allow("durationMin")) {
        if (typeof request.durationMin === "number" && request.durationMin > 0) {
          existing.durationMin = request.durationMin;
        } else {
          delete existing.durationMin;
        }
      }
      if (request.onClickCommand !== undefined && allow("onClickCommand")) {
        existing.onClickCommand = request.onClickCommand;
      }
      if (request.autoCompleteWhen !== undefined && allow("autoCompleteWhen")) {
        existing.autoCompleteWhen = request.autoCompleteWhen;
      }
      if (request.autoCompleteWhenWordCount !== undefined && allow("autoCompleteWhenWordCount")) {
        existing.autoCompleteWhenWordCount = request.autoCompleteWhenWordCount;
      }
      if (request.autoCompletes !== undefined && allow("autoCompletes")) {
        existing.autoCompletes = request.autoCompletes;
      }
      if (existing.completedAt && allow("reopen")) {
        existing.completedAt = null;
      }
    } else {
      // When the external source changes a task's id (e.g. iris-course
      // regenerates its Iris ID during a sync), carry over archive status
      // from the stale duplicate so the user doesn't have to re-archive.
      const fp = request.autoCompleteWhen?.filePath ?? request.autoCompleteWhenWordCount?.filePath;
      if (fp) {
        const archivedSet = new Set(this.settings.archivedTaskIds);
        let shouldArchive = false;
        const staleIds: string[] = [];
        for (const t of this.settings.manualTasks) {
          if (t.id === request.id) continue;
          const tFp = t.autoCompleteWhen?.filePath ?? t.autoCompleteWhenWordCount?.filePath;
          if (tFp !== fp) continue;
          staleIds.push(t.id);
          if (archivedSet.has(t.id)) shouldArchive = true;
        }
        if (shouldArchive) {
          this.settings.archivedTaskIds.push(request.id);
        }
        if (staleIds.length > 0) {
          const staleSet = new Set(staleIds);
          this.settings.manualTasks = this.settings.manualTasks.filter(
            (t) => !staleSet.has(t.id),
          );
          this.settings.archivedTaskIds = this.settings.archivedTaskIds.filter(
            (id) => !staleSet.has(id),
          );
        }
      }

      const manual: ManualTask = {
        id: request.id,
        title: request.title,
        dueDate: request.dueDate ?? null,
        dueTime: request.dueTime ?? null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      };
      if (request.onClickCommand) manual.onClickCommand = request.onClickCommand;
      if (request.autoCompleteWhen) manual.autoCompleteWhen = request.autoCompleteWhen;
      if (request.autoCompleteWhenWordCount) manual.autoCompleteWhenWordCount = request.autoCompleteWhenWordCount;
      if (request.autoCompletes) manual.autoCompletes = true;
      if (typeof request.durationMin === "number" && request.durationMin > 0) {
        manual.durationMin = request.durationMin;
      }
      this.settings.manualTasks.push(manual);
    }
    await this.saveSettings();
    TaskView.refreshAll();
    return request.id;
  }

  /**
   * Returns manual tasks with a due date set. Consumed by other plugins
   * (e.g. iris-calendar) to render tasks on a calendar grid. Excludes
   * completed tasks and "wait" pseudo-tasks (those are gating dates, not
   * deliverables to surface in a separate view).
   */
  getTasksWithDue(): Array<{
    id: string;
    title: string;
    dueDate: string;
    dueTime: string | null;
    durationMin: number | null;
    module: string | null;
    autoCompletes: boolean;
    completedAt: string | null;
  }> {
    const out: Array<{
      id: string;
      title: string;
      dueDate: string;
      dueTime: string | null;
      durationMin: number | null;
      module: string | null;
      autoCompletes: boolean;
      completedAt: string | null;
    }> = [];
    for (const t of this.settings.manualTasks) {
      if (t.kind === "wait") continue;
      if (!t.dueDate) continue;
      let module: string | null = null;
      const linkedFp = t.autoCompleteWhen?.filePath ?? t.autoCompleteWhenWordCount?.filePath;
      if (linkedFp) {
        const cache = this.app.metadataCache.getCache(linkedFp);
        const fmModule = cache?.frontmatter?.module;
        if (typeof fmModule === "string" && fmModule.trim()) module = fmModule;
      }
      out.push({
        id: t.id,
        title: t.title,
        dueDate: t.dueDate,
        dueTime: t.dueTime,
        durationMin: t.durationMin ?? null,
        module,
        autoCompletes: !!(t.autoCompletes || t.autoCompleteWhen || t.autoCompleteWhenWordCount),
        completedAt: t.completedAt ?? null,
      });
    }
    return out;
  }

  handleTaskClick(taskId: string): void {
    const mt = this.settings.manualTasks.find((t) => t.id === taskId);
    if (!mt) {
      void this.activateView();
      return;
    }
    if (mt.kind !== "wait") {
      void this.setCurrentTask(taskId, mt.title);
    }
    if (mt.onClickCommand) {
      (this.app as any).commands.executeCommandById(mt.onClickCommand);
      return;
    }
    const linkedPath = mt.autoCompleteWhen?.filePath;
    if (linkedPath) {
      this.app.workspace.openLinkText(linkedPath, "", false);
      return;
    }
    void this.activateView();
  }

  async completeExternalTask(id: string): Promise<void> {
    const task = this.settings.manualTasks.find((t) => t.id === id);
    if (!task || task.completedAt) return;
    task.completedAt = new Date().toISOString();
    await this.saveSettings();
    TaskView.refreshAll();
  }

  async removeExternalTask(id: string): Promise<void> {
    const caps = editCapabilities(this, id);
    if (!caps.canDelete) {
      new Notice(lockReason(caps));
      return;
    }
    const idx = this.settings.manualTasks.findIndex((t) => t.id === id);
    if (idx === -1) return;
    this.settings.manualTasks.splice(idx, 1);
    this.settings.archivedTaskIds = this.settings.archivedTaskIds.filter(
      (tid) => tid !== id,
    );
    for (let i = this.settings.taskSeries.length - 1; i >= 0; i--) {
      const series = this.settings.taskSeries[i];
      const before = series.memberIds.length;
      series.memberIds = series.memberIds.filter((mid) => mid !== id);
      if (series.memberIds.length < before && series.memberIds.length <= 1) {
        this.settings.taskSeries.splice(i, 1);
      }
    }
    await this.saveSettings();
    TaskView.refreshAll();
  }

  /** Toggle archive state for an external task. Used by iris-calendar's
   *  context menu so users can archive a task without leaving the grid. */
  async setTaskArchived(id: string, archived: boolean): Promise<void> {
    if (archived) {
      const caps = editCapabilities(this, id);
      if (!caps.canArchive) {
        new Notice(lockReason(caps));
        return;
      }
    }
    const list = this.settings.archivedTaskIds;
    const idx = list.indexOf(id);
    if (archived && idx === -1) list.push(id);
    else if (!archived && idx !== -1) list.splice(idx, 1);
    else return;
    await this.saveSettings();
    TaskView.refreshAll();
  }

  async createSeriesFromExternal(request: {
    tasks: Array<{
      title: string;
      dueDate?: string | null;
      dueTime?: string | null;
      durationMin?: number | null;
      autoCompleteWhen?: AutoCompleteCondition;
      autoCompleteWhenWordCount?: AutoCompleteWordCountCondition;
    }>;
  }): Promise<string | null> {
    if (!request.tasks || request.tasks.length < 2) return null;
    const now = new Date().toISOString();
    const memberIds: string[] = [];
    for (const t of request.tasks) {
      const id =
        "m-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const manual: ManualTask = {
        id,
        title: t.title,
        dueDate: t.dueDate ?? null,
        dueTime: t.dueTime ?? null,
        createdAt: now,
        completedAt: null,
      };
      if (t.autoCompleteWhen) manual.autoCompleteWhen = t.autoCompleteWhen;
      if (t.autoCompleteWhenWordCount) manual.autoCompleteWhenWordCount = t.autoCompleteWhenWordCount;
      if (typeof t.durationMin === "number" && t.durationMin > 0) {
        manual.durationMin = t.durationMin;
      }
      this.settings.manualTasks.push(manual);
      memberIds.push(id);
    }
    const seriesId =
      "s-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    this.settings.taskSeries.push({ id: seriesId, memberIds });
    await this.saveSettings();
    TaskView.refreshAll();
    return seriesId;
  }

  /**
   * Append manual tasks to an existing external series. Lets external sources
   * (e.g. iris-student) extend a series without rebuilding it from scratch,
   * preserving manual completion state on existing members.
   */
  async appendToSeriesFromExternal(request: {
    seriesId: string;
    tasks: Array<{
      title: string;
      dueDate?: string | null;
      dueTime?: string | null;
      durationMin?: number | null;
      autoCompleteWhen?: AutoCompleteCondition;
      autoCompleteWhenWordCount?: AutoCompleteWordCountCondition;
    }>;
  }): Promise<string[] | null> {
    const series = this.settings.taskSeries.find((s) => s.id === request.seriesId);
    if (!series) return null;
    if (!request.tasks || request.tasks.length === 0) return [];
    const now = new Date().toISOString();
    const newIds: string[] = [];
    for (const t of request.tasks) {
      const id =
        "m-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const manual: ManualTask = {
        id,
        title: t.title,
        dueDate: t.dueDate ?? null,
        dueTime: t.dueTime ?? null,
        createdAt: now,
        completedAt: null,
      };
      if (t.autoCompleteWhen) manual.autoCompleteWhen = t.autoCompleteWhen;
      if (t.autoCompleteWhenWordCount) manual.autoCompleteWhenWordCount = t.autoCompleteWhenWordCount;
      if (typeof t.durationMin === "number" && t.durationMin > 0) {
        manual.durationMin = t.durationMin;
      }
      this.settings.manualTasks.push(manual);
      series.memberIds.push(id);
      newIds.push(id);
    }
    await this.saveSettings();
    TaskView.refreshAll();
    return newIds;
  }

  /** Widget provider consumed by the Iris Homepage plugin. */
  irisHomepageWidgets(): IrisHomepageWidgetDescriptor[] {
    return buildIrisHomepageWidgets(this);
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = hydrateSettings(data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Notify other plugins (e.g. iris-calendar) that task state changed.
    this.app.workspace.trigger("iris-tasks:changed");
  }

  updateCurrentTaskBar(): void {
    if (!this.settings.enableCurrentTask) {
      if (this.statusBarEl) {
        this.statusBarEl.remove();
        this.statusBarEl = null;
      }
      return;
    }
    if (!this.statusBarEl) {
      this.statusBarEl = this.addStatusBarItem();
      this.statusBarEl.addClass("iris-tasks-current-task-bar");
      this.statusBarEl.addEventListener("click", (e) => this.showCurrentTaskMenu(e));
    }
    this.statusBarEl.style.display = "";
    this.statusBarEl.empty();
    this.statusBarEl.createSpan({
      cls: "iris-tasks-current-task-prefix",
      text: "Current task: ",
    });
    const title = this.settings.currentTaskId && this.settings.currentTaskTitle
      ? this.settings.currentTaskTitle
      : "Don't know";
    this.statusBarEl.createSpan({
      cls: "iris-tasks-current-task-label",
      text: title,
    });
  }

  async setCurrentTask(id: string, title: string): Promise<void> {
    this.settings.currentTaskId = id;
    this.settings.currentTaskTitle = title;
    await this.saveSettings();
    this.updateCurrentTaskBar();
    TaskView.refreshAll();
  }

  async clearCurrentTask(): Promise<void> {
    if (!this.settings.currentTaskId) return;
    this.settings.currentTaskId = null;
    this.settings.currentTaskTitle = null;
    await this.saveSettings();
    this.updateCurrentTaskBar();
    TaskView.refreshAll();
  }

  private showCurrentTaskMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Open Tasks")
        .setIcon("list-checks")
        .onClick(() => void this.activateView()),
    );
    if (this.settings.currentTaskId) {
      menu.addItem((item) =>
        item
          .setTitle("Clear current task")
          .setIcon("x")
          .onClick(() => void this.clearCurrentTask()),
      );
    }
    menu.showAtMouseEvent(event);
  }

  private async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_TASKS, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  // ── Start-time notifications ──────────────────────────────────────────

  refreshStartNotifications(): void {
    if (this.settings.enableStartNotifications) {
      this.startNotificationPolling();
    } else {
      this.stopStartNotificationPolling();
    }
  }

  private startNotificationPolling(): void {
    if (this.startNotifyHandle != null) return;
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    void this.checkStartNotifications();
    this.startNotifyHandle = window.setInterval(() => {
      void this.checkStartNotifications();
    }, IrisTasksPlugin.START_NOTIFY_INTERVAL_MS);
    this.registerInterval(this.startNotifyHandle);
  }

  private stopStartNotificationPolling(): void {
    if (this.startNotifyHandle == null) return;
    window.clearInterval(this.startNotifyHandle);
    this.startNotifyHandle = null;
  }

  private async checkStartNotifications(): Promise<void> {
    if (!this.settings.enableStartNotifications) return;
    const now = Date.now();
    const notifiedSet = new Set(this.settings.notifiedStartTimes);
    let changed = false;

    for (const task of this.settings.manualTasks) {
      if (task.completedAt) continue;
      if (!task.dueDate || !task.dueTime) continue;
      if (isSpecialDueDate(task.dueDate)) continue;

      const key = `${task.id}::${task.dueDate}::${task.dueTime}`;
      if (notifiedSet.has(key)) continue;

      const dueMs = new Date(`${task.dueDate}T${task.dueTime}:00`).getTime();
      if (isNaN(dueMs)) continue;

      // dueTime is the deadline (end of the slot). For tasks with a
      // durationMin, the user should start `durationMin` minutes earlier.
      const slotStartMs =
        dueMs - (task.durationMin ?? 0) * 60_000;

      const triggerTime =
        slotStartMs - this.settings.notifyMinutesBefore * 60_000;
      const lateWindowMs = 5 * 60_000;
      if (now >= triggerTime && now <= slotStartMs + lateWindowMs) {
        const minsLeft = Math.max(
          0,
          Math.round((slotStartMs - now) / 60_000),
        );
        const d = new Date(slotStartMs);
        const startTimeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        this.fireStartNotification(task.title, startTimeStr, minsLeft);
        notifiedSet.add(key);
        this.settings.notifiedStartTimes.push(key);
        changed = true;
      }
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 2);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const before = this.settings.notifiedStartTimes.length;
    this.settings.notifiedStartTimes =
      this.settings.notifiedStartTimes.filter((entry) => {
        const datePart = entry.split("::")[1];
        return datePart >= cutoffStr;
      });
    if (this.settings.notifiedStartTimes.length !== before) changed = true;

    if (changed) await this.saveSettings();
  }

  private fireStartNotification(
    title: string,
    time: string,
    minutesLeft: number,
  ): void {
    const label =
      minutesLeft > 0
        ? `Starting in ${minutesLeft} min: ${title} (${time})`
        : `Starting now: ${title} (${time})`;
    new Notice(label, 30_000);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Task starting", { body: label });
    }
  }

  // ── TaskRatchet ────────────────────────────────────────────────────────

  taskRatchetLinkForTask(taskId: string): TaskRatchetLink | null {
    return this.settings.taskratchetTaskLinks.find((l) => l.taskId === taskId) ?? null;
  }

  private removeTaskRatchetLink(taskId: string): void {
    this.settings.taskratchetTaskLinks = this.settings.taskratchetTaskLinks.filter(
      (l) => l.taskId !== taskId,
    );
  }

  refreshTaskRatchet(): void {
    const enabled =
      this.settings.taskratchetEnabled && this.settings.taskratchetApiKey.length > 0;
    if (!enabled) {
      this.stopTaskRatchetPolling();
      return;
    }
    void this.pollTaskRatchet();
    this.startTaskRatchetPolling();
  }

  private startTaskRatchetPolling(): void {
    if (this.taskratchetPollHandle != null) return;
    this.taskratchetPollHandle = window.setInterval(() => {
      void this.pollTaskRatchet();
    }, 5 * 60_000);
    this.registerInterval(this.taskratchetPollHandle);
  }

  private stopTaskRatchetPolling(): void {
    if (this.taskratchetPollHandle == null) return;
    window.clearInterval(this.taskratchetPollHandle);
    this.taskratchetPollHandle = null;
  }

  /**
   * Open the stake modal for a task and create the TaskRatchet task on confirm.
   * Requires a concrete date (and ideally a time); special tokens like "ASAP"
   * aren't supported because TaskRatchet needs a real deadline.
   */
  async stakeTaskRatchet(
    taskId: string,
    title: string,
    dueDate: string | null,
    dueTime: string | null,
  ): Promise<void> {
    if (!this.settings.taskratchetEnabled) return;
    const due = toTaskRatchetDeadline(dueDate, dueTime);
    if (!due) {
      new Notice("TaskRatchet needs a concrete due date (YYYY-MM-DD).");
      return;
    }
    if (due * 1000 <= Date.now()) {
      new Notice("Due date is in the past — can't stake on TaskRatchet.");
      return;
    }
    if (this.taskRatchetLinkForTask(taskId)) {
      new Notice("This task already has a TaskRatchet stake.");
      return;
    }
    let key = this.settings.taskratchetApiKey;
    if (!key) {
      const entered = await new TaskRatchetApiKeyModal(this.app).open();
      if (!entered) return;
      this.settings.taskratchetApiKey = entered;
      this.settings.taskratchetMyUserId = null;
      await this.saveSettings();
      key = entered;
    }
    const deadlineLabel = new Date(due * 1000).toLocaleString();
    const choice = await new TaskRatchetStakeModal(
      this.app,
      title,
      deadlineLabel,
      this.settings.taskratchetDefaultCents,
    ).open();
    if (!choice) return;
    try {
      const created = await createTaskRatchetTask(key, {
        task: title,
        dueUnixSec: due,
        cents: choice.cents,
      });
      this.settings.taskratchetTaskLinks.push({
        taskId,
        trTaskId: created.id,
        cents: created.cents,
        due: created.due,
        linkedAt: new Date().toISOString(),
        status: created.status ?? "pending",
      });
      await this.saveSettings();
      new Notice(`Staked ${formatStake(created.cents)} on "${title}".`);
      TaskView.refreshAll();
    } catch (err) {
      new Notice(`TaskRatchet stake failed: ${(err as Error).message}`);
    }
  }

  /**
   * Push local completion to TaskRatchet for a task. Called by the view
   * after toggling completion. If the call fails, mark `pendingComplete`
   * so the next poll retries.
   */
  async syncTaskRatchetCompletion(taskId: string): Promise<void> {
    if (!this.settings.taskratchetEnabled) return;
    const link = this.taskRatchetLinkForTask(taskId);
    if (!link) return;
    if (link.status !== "pending") return;
    const key = this.settings.taskratchetApiKey;
    if (!key) return;
    try {
      const updated = await markTaskRatchetComplete(key, link.trTaskId);
      link.status = updated.status ?? "complete";
      delete link.pendingComplete;
      await this.saveSettings();
      TaskView.refreshAll();
    } catch (err) {
      link.pendingComplete = true;
      await this.saveSettings();
      console.warn("TaskRatchet completion sync failed:", err);
    }
  }

  /**
   * Voluntarily forfeit the stake. Calls TaskRatchet's "uncle" endpoint,
   * which charges the card immediately. Confirms via Notice — caller is
   * expected to gate this behind a confirmation in the UI.
   */
  async uncleTaskRatchet(taskId: string): Promise<void> {
    if (!this.settings.taskratchetEnabled) return;
    const link = this.taskRatchetLinkForTask(taskId);
    if (!link) return;
    const key = this.settings.taskratchetApiKey;
    if (!key) return;
    try {
      await uncleTaskRatchetTask(key, link.trTaskId);
      const cents = link.cents;
      this.removeTaskRatchetLink(taskId);
      await this.saveSettings();
      new Notice(`Forfeited ${formatStake(cents)} stake.`);
      TaskView.refreshAll();
    } catch (err) {
      new Notice(`TaskRatchet uncle failed: ${(err as Error).message}`);
    }
  }

  /**
   * Push a deadline-earlier change to TaskRatchet for a staked task. TR's
   * one allowed mutation on `due` is "earlier only" — we pre-check so we
   * can short-circuit obvious no-ops, but we let TR be the final authority
   * on whether the change is accepted.
   *
   * Returns true when the link state is consistent with the new deadline
   * (no link, settled link, unchanged value, or successful TR push).
   * Returns false when the change is rejected, surfacing a Notice.
   */
  async tryReduceTaskRatchetDeadline(
    taskId: string,
    newDueUnixSec: number,
  ): Promise<boolean> {
    const link = this.taskRatchetLinkForTask(taskId);
    if (!link || link.status !== "pending") return true;
    if (newDueUnixSec === link.due) return true;
    if (newDueUnixSec > link.due) {
      new Notice(
        "TaskRatchet only allows moving deadlines earlier — keeping the existing deadline.",
      );
      return false;
    }
    const key = this.settings.taskratchetApiKey;
    if (!key) {
      new Notice("TaskRatchet API key missing — can't update deadline.");
      return false;
    }
    try {
      const updated = await updateTaskRatchetTask(key, link.trTaskId, {
        due: newDueUnixSec,
      });
      if (typeof updated.due === "number") link.due = updated.due;
      if (typeof updated.cents === "number") link.cents = updated.cents;
      if (updated.status) link.status = updated.status;
      await this.saveSettings();
      TaskView.refreshAll();
      return true;
    } catch (err) {
      new Notice(`TaskRatchet update failed: ${(err as Error).message}`);
      return false;
    }
  }

  async pollTaskRatchet(): Promise<void> {
    const key = this.settings.taskratchetApiKey;
    if (!this.settings.taskratchetEnabled || !key) return;
    const links = this.settings.taskratchetTaskLinks;
    if (links.length === 0) return;
    let mutated = false;
    const expiredTaskIds: string[] = [];
    for (const link of links) {
      if (link.status === "complete" || link.status === "expired") continue;
      try {
        // Retry pending completion sync first.
        if (link.pendingComplete) {
          try {
            const updated = await markTaskRatchetComplete(key, link.trTaskId);
            link.status = updated.status ?? "complete";
            delete link.pendingComplete;
            // If the deferred sync was kicked off by an auto-complete that
            // hadn't yet set local state (TR-first flow), mirror the now-
            // confirmed completion onto the local task.
            const task = this.settings.manualTasks.find((t) => t.id === link.taskId);
            if (task && !task.completedAt) {
              task.completedAt = new Date().toISOString();
              new Notice(`Completed: ${task.title}`);
            }
            mutated = true;
            continue;
          } catch {
            // Fall through to status fetch — the task might already be expired.
          }
        }
        const fresh = await fetchTaskRatchetTask(key, link.trTaskId);
        if (fresh.status !== link.status) {
          if (fresh.status === "expired") {
            new Notice(`TaskRatchet stake of ${formatStake(link.cents)} forfeited (deadline passed).`);
            expiredTaskIds.push(link.taskId);
            mutated = true;
            continue;
          }
          link.status = fresh.status;
          mutated = true;
        }
        // TR is the source of truth for stake amount and deadline — if the
        // user edited the task on the TaskRatchet webapp, mirror those
        // changes into our link so the badge and any downstream logic
        // reflect TR's record.
        if (typeof fresh.cents === "number" && fresh.cents !== link.cents) {
          link.cents = fresh.cents;
          mutated = true;
        }
        if (typeof fresh.due === "number" && fresh.due !== link.due) {
          link.due = fresh.due;
          mutated = true;
        }
      } catch (err) {
        console.warn("TaskRatchet poll failed for link", link.trTaskId, err);
      }
    }
    for (const taskId of expiredTaskIds) {
      this.removeTaskRatchetLink(taskId);
    }
    if (mutated) {
      await this.saveSettings();
      TaskView.refreshAll();
    }
  }
}
