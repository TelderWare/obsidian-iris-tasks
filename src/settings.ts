import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type IrisTasksPlugin from "./main";
import { emptyCache, migrateCache, type TaskCache } from "./task-cache";
import {
  fetchProfile as fetchTaskRatchetProfile,
  type TaskRatchetLink,
  type TaskRatchetStatus,
} from "./taskratchet";
import { TaskView } from "./task-view";

export interface IrisTasksSettings {
  showCompleted: boolean;
  /** When true, hide tasks whose prerequisites aren't all complete. */
  actionableOnly: boolean;
  /** When true, archived tasks are surfaced in the list (faded) so they can be unarchived. */
  showArchived: boolean;
  /** Per-widget overrides — independent of the standalone view's settings. */
  widgetShowCompleted: boolean;
  /** Show a notification when a task with a due time is about to start. */
  enableStartNotifications: boolean;
  /** How many minutes before the scheduled time to fire the notification. */
  notifyMinutesBefore: number;
  /** Keys of tasks already notified (pruned after 2 days). */
  notifiedStartTimes: string[];
  /**
   * Direct Anthropic API key. Used only when `app.irisRelay` (the iris-router
   * plugin) isn't installed. Plaintext for now — the relay path is preferred.
   */
  anthropicApiKey: string;
  taskCache: TaskCache;
  /**
   * Internal task ids the user has archived. Keyed by `composedTaskId`
   * (a hash of the task's sourceIds), so an archive naturally clears if the
   * AI re-groups the underlying emails.
   */
  archivedTaskIds: string[];
  /**
   * User-declared task prerequisites, merged on top of the AI's `dependsOn`.
   * Keyed by the dependent task's internal id; the value is a list of
   * prerequisite internal ids ("must complete before this task"). Stale
   * entries are pruned on render.
   */
  manualDependencies: { [taskId: string]: string[] };
  /**
   * Plugin-owned tasks (not sourced from mail). Created via the
   * "Add new prerequisite…" action and rendered alongside mail tasks.
   */
  manualTasks: ManualTask[];
  /**
   * User-renamed task titles, keyed by task id. Applied at render time so
   * the override wins over the AI-composed or email-derived title. Stale
   * entries (from re-composed mail tasks) are harmless — the key just no
   * longer matches any task.
   */
  taskTitleOverrides: { [taskId: string]: string };
  /**
   * User-set deadlines, keyed by task id. Each value holds dueDate and
   * optional dueTime. Applied at render time so the override wins over the
   * AI-composed deadline. Works for both mail and manual tasks.
   */
  taskDueDateOverrides: { [taskId: string]: { date: string; time: string | null } };
  /**
   * Ordered task ids the user has explicitly placed via drag-reorder. Tasks
   * present here are sorted by their position in this list and override the
   * smart sort. Tasks not in the list fall to the bottom in smart-sort order.
   */
  taskOrder: string[];
  /**
   * Groups of manual tasks that represent variations of the same underlying
   * task. Rendered one-at-a-time: only the first incomplete member is shown.
   */
  taskSeries: TaskSeries[];
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  enableCurrentTask: boolean;
  /** TaskRatchet integration. */
  taskratchetEnabled: boolean;
  taskratchetApiKey: string;
  /** Default stake in cents (>= 100). */
  taskratchetDefaultCents: number;
  taskratchetMyUserId: string | null;
  taskratchetTaskLinks: TaskRatchetLink[];
}

export interface AutoCompleteCondition {
  filePath: string;
  frontmatterKey: string;
  oneOf: string[];
}

export interface AutoCompleteWordCountCondition {
  filePath: string;
  minWords: number;
}

export interface ManualTask {
  id: string;
  title: string;
  dueDate: string | null;
  dueTime: string | null;
  createdAt: string;
  completedAt: string | null;
  /** "wait" = date-only prerequisite that auto-resolves when the date passes. */
  kind?: "wait";
  /** When set, the task auto-completes if the file's frontmatter value matches any entry in `oneOf`. */
  autoCompleteWhen?: AutoCompleteCondition;
  /** When set, the task auto-completes once the file reaches the specified word count. */
  autoCompleteWhenWordCount?: AutoCompleteWordCountCondition;
  /** When set, clicking the task title executes this Obsidian command instead of opening a file. */
  onClickCommand?: string;
  /** When true, an external plugin manages completion — no checkbox is shown. */
  autoCompletes?: boolean;
  /** Expected duration in minutes; consumed by iris-calendar for time-block rendering. */
  durationMin?: number;
}

export interface TaskSeries {
  id: string;
  memberIds: string[];
}

export const DEFAULT_SETTINGS: IrisTasksSettings = {
  showCompleted: false,
  actionableOnly: false,
  showArchived: false,
  widgetShowCompleted: false,
  enableStartNotifications: true,
  notifyMinutesBefore: 0,
  notifiedStartTimes: [],
  anthropicApiKey: "",
  taskCache: emptyCache(),
  archivedTaskIds: [],
  manualDependencies: {},
  manualTasks: [],
  taskTitleOverrides: {},
  taskDueDateOverrides: {},
  taskOrder: [],
  taskSeries: [],
  currentTaskId: null,
  currentTaskTitle: null,
  enableCurrentTask: false,
  taskratchetEnabled: false,
  taskratchetApiKey: "",
  taskratchetDefaultCents: 500,
  taskratchetMyUserId: null,
  taskratchetTaskLinks: [],
};

/**
 * Merge persisted data with defaults, dropping any cache shape that doesn't
 * match the current `TaskCache` (e.g. the old `orderCache` from when the AI
 * only sorted instead of composed). The cache rebuilds itself on next refresh.
 */
export function hydrateSettings(raw: unknown): IrisTasksSettings {
  const merged: IrisTasksSettings = Object.assign(
    {},
    DEFAULT_SETTINGS,
    raw && typeof raw === "object" ? raw : {},
  );
  merged.taskCache = migrateCache((raw as { taskCache?: unknown })?.taskCache);
  const rawArchived = (raw as { archivedTaskIds?: unknown })?.archivedTaskIds;
  merged.archivedTaskIds =
    Array.isArray(rawArchived) && rawArchived.every((x) => typeof x === "string")
      ? (rawArchived as string[])
      : [];
  const rawDeps = (raw as { manualDependencies?: unknown })?.manualDependencies;
  if (rawDeps && typeof rawDeps === "object" && !Array.isArray(rawDeps)) {
    const cleaned: { [taskId: string]: string[] } = {};
    for (const [k, v] of Object.entries(rawDeps as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        cleaned[k] = v as string[];
      }
    }
    merged.manualDependencies = cleaned;
  } else {
    merged.manualDependencies = {};
  }
  const rawOverrides = (raw as { taskTitleOverrides?: unknown })?.taskTitleOverrides;
  if (rawOverrides && typeof rawOverrides === "object" && !Array.isArray(rawOverrides)) {
    const cleaned: { [taskId: string]: string } = {};
    for (const [k, v] of Object.entries(rawOverrides as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim().length > 0) cleaned[k] = v;
    }
    merged.taskTitleOverrides = cleaned;
  } else {
    merged.taskTitleOverrides = {};
  }
  const rawDueOverrides = (raw as { taskDueDateOverrides?: unknown })?.taskDueDateOverrides;
  if (rawDueOverrides && typeof rawDueOverrides === "object" && !Array.isArray(rawDueOverrides)) {
    const cleaned: { [taskId: string]: { date: string; time: string | null } } = {};
    for (const [k, v] of Object.entries(rawDueOverrides as Record<string, unknown>)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const entry = v as Record<string, unknown>;
        if (typeof entry.date === "string" && entry.date.length > 0) {
          cleaned[k] = {
            date: entry.date,
            time: typeof entry.time === "string" ? entry.time : null,
          };
        }
      }
    }
    merged.taskDueDateOverrides = cleaned;
  } else {
    merged.taskDueDateOverrides = {};
  }
  const rawManual = (raw as { manualTasks?: unknown })?.manualTasks;
  if (Array.isArray(rawManual)) {
    const cleaned: ManualTask[] = [];
    for (const entry of rawManual) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== "string" || typeof e.title !== "string") continue;
      if (typeof e.createdAt !== "string") continue;
      const task: ManualTask = {
        id: e.id,
        title: e.title,
        dueDate: typeof e.dueDate === "string" ? e.dueDate : null,
        dueTime: typeof e.dueTime === "string" ? e.dueTime : null,
        createdAt: e.createdAt,
        completedAt: typeof e.completedAt === "string" ? e.completedAt : null,
        ...(e.kind === "wait" ? { kind: "wait" as const } : {}),
      };
      if (
        e.autoCompleteWhen &&
        typeof e.autoCompleteWhen === "object" &&
        !Array.isArray(e.autoCompleteWhen)
      ) {
        const ac = e.autoCompleteWhen as Record<string, unknown>;
        if (
          typeof ac.filePath === "string" &&
          typeof ac.frontmatterKey === "string" &&
          Array.isArray(ac.oneOf) &&
          ac.oneOf.every((v) => typeof v === "string")
        ) {
          task.autoCompleteWhen = {
            filePath: ac.filePath,
            frontmatterKey: ac.frontmatterKey,
            oneOf: ac.oneOf as string[],
          };
        }
      }
      if (
        e.autoCompleteWhenWordCount &&
        typeof e.autoCompleteWhenWordCount === "object" &&
        !Array.isArray(e.autoCompleteWhenWordCount)
      ) {
        const wc = e.autoCompleteWhenWordCount as Record<string, unknown>;
        if (
          typeof wc.filePath === "string" &&
          typeof wc.minWords === "number" &&
          wc.minWords > 0
        ) {
          task.autoCompleteWhenWordCount = {
            filePath: wc.filePath,
            minWords: wc.minWords,
          };
        }
      }
      if (typeof e.onClickCommand === "string") {
        task.onClickCommand = e.onClickCommand;
      }
      if (e.autoCompletes === true) {
        task.autoCompletes = true;
      }
      if (typeof e.durationMin === "number" && e.durationMin > 0) {
        task.durationMin = e.durationMin;
      }
      cleaned.push(task);
    }
    merged.manualTasks = cleaned;
  } else {
    merged.manualTasks = [];
  }
  const rawOrder = (raw as { taskOrder?: unknown })?.taskOrder;
  merged.taskOrder =
    Array.isArray(rawOrder) && rawOrder.every((x) => typeof x === "string")
      ? (rawOrder as string[])
      : [];
  const rawSeries = (raw as { taskSeries?: unknown })?.taskSeries;
  if (Array.isArray(rawSeries)) {
    const cleaned: TaskSeries[] = [];
    for (const entry of rawSeries) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== "string") continue;
      if (!Array.isArray(e.memberIds) || !e.memberIds.every((x) => typeof x === "string")) continue;
      if (e.memberIds.length < 2) continue;
      cleaned.push({ id: e.id, memberIds: e.memberIds as string[] });
    }
    merged.taskSeries = cleaned;
  } else {
    merged.taskSeries = [];
  }
  const liveTaskIds = new Set(merged.manualTasks.map((t) => t.id));
  for (let i = merged.taskSeries.length - 1; i >= 0; i--) {
    merged.taskSeries[i].memberIds = merged.taskSeries[i].memberIds.filter(
      (mid) => liveTaskIds.has(mid),
    );
    if (merged.taskSeries[i].memberIds.length <= 1) {
      merged.taskSeries.splice(i, 1);
    }
  }
  const rawCurId = (raw as { currentTaskId?: unknown })?.currentTaskId;
  merged.currentTaskId = typeof rawCurId === "string" ? rawCurId : null;
  const rawCurTitle = (raw as { currentTaskTitle?: unknown })?.currentTaskTitle;
  merged.currentTaskTitle = typeof rawCurTitle === "string" ? rawCurTitle : null;
  const rawEnable = (raw as { enableCurrentTask?: unknown })?.enableCurrentTask;
  merged.enableCurrentTask = typeof rawEnable === "boolean" ? rawEnable : false;
  const rawStartNotify = (raw as { enableStartNotifications?: unknown })?.enableStartNotifications;
  merged.enableStartNotifications = typeof rawStartNotify === "boolean" ? rawStartNotify : true;
  const rawNotifyMins = (raw as { notifyMinutesBefore?: unknown })?.notifyMinutesBefore;
  merged.notifyMinutesBefore =
    typeof rawNotifyMins === "number" && rawNotifyMins >= 0 ? Math.round(rawNotifyMins) : 0;
  const rawNotified = (raw as { notifiedStartTimes?: unknown })?.notifiedStartTimes;
  merged.notifiedStartTimes =
    Array.isArray(rawNotified) && rawNotified.every((x) => typeof x === "string")
      ? (rawNotified as string[])
      : [];
  const rawTrEnabled = (raw as { taskratchetEnabled?: unknown })?.taskratchetEnabled;
  merged.taskratchetEnabled = typeof rawTrEnabled === "boolean" ? rawTrEnabled : false;
  const rawTrKey = (raw as { taskratchetApiKey?: unknown })?.taskratchetApiKey;
  merged.taskratchetApiKey = typeof rawTrKey === "string" ? rawTrKey : "";
  const rawTrCents = (raw as { taskratchetDefaultCents?: unknown })?.taskratchetDefaultCents;
  merged.taskratchetDefaultCents =
    typeof rawTrCents === "number" && rawTrCents >= 100 ? Math.round(rawTrCents) : 500;
  const rawTrUid = (raw as { taskratchetMyUserId?: unknown })?.taskratchetMyUserId;
  merged.taskratchetMyUserId = typeof rawTrUid === "string" ? rawTrUid : null;
  const rawTrLinks = (raw as { taskratchetTaskLinks?: unknown })?.taskratchetTaskLinks;
  if (Array.isArray(rawTrLinks)) {
    const validStatus = (s: unknown): s is TaskRatchetStatus =>
      s === "pending" || s === "complete" || s === "expired";
    const cleaned: TaskRatchetLink[] = [];
    for (const entry of rawTrLinks) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (
        typeof e.taskId === "string" &&
        typeof e.trTaskId === "string" &&
        typeof e.cents === "number" &&
        typeof e.due === "number" &&
        typeof e.linkedAt === "string" &&
        validStatus(e.status)
      ) {
        const link: TaskRatchetLink = {
          taskId: e.taskId,
          trTaskId: e.trTaskId,
          cents: e.cents,
          due: e.due,
          linkedAt: e.linkedAt,
          status: e.status,
        };
        if (e.pendingComplete === true) link.pendingComplete = true;
        cleaned.push(link);
      }
    }
    merged.taskratchetTaskLinks = cleaned;
  } else {
    merged.taskratchetTaskLinks = [];
  }
  return merged;
}

export class IrisTasksSettingTab extends PluginSettingTab {
  plugin: IrisTasksPlugin;

  constructor(app: App, plugin: IrisTasksPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Iris Tasks" });

    new Setting(containerEl)
      .setName("Current task")
      .setDesc("Show a status bar item tracking your active task.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableCurrentTask)
          .onChange(async (value) => {
            this.plugin.settings.enableCurrentTask = value;
            if (!value) await this.plugin.clearCurrentTask();
            else this.plugin.updateCurrentTaskBar();
            await this.plugin.saveSettings();
            TaskView.refreshAll();
          }),
      );

    new Setting(containerEl)
      .setName("Start-time notifications")
      .setDesc("Show a notification when a scheduled task is about to start.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableStartNotifications)
          .onChange(async (value) => {
            this.plugin.settings.enableStartNotifications = value;
            await this.plugin.saveSettings();
            this.plugin.refreshStartNotifications();
          }),
      );

    new Setting(containerEl)
      .setName("Notify minutes before")
      .setDesc("How many minutes before a task starts to send the notification. 0 = at start time.")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.notifyMinutesBefore))
          .onChange(async (value) => {
            const mins = Number(value);
            if (Number.isFinite(mins) && mins >= 0) {
              this.plugin.settings.notifyMinutesBefore = Math.round(mins);
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc(
        "Used to compose to-do messages with Claude. Only needed if the iris-router relay isn't installed.",
      )
      .addText((text) =>
        text
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.anthropicApiKey)
          .onChange(async (value) => {
            this.plugin.settings.anthropicApiKey = value.trim();
            await this.plugin.saveSettings();
            TaskView.refreshAll();
          }),
      );

    containerEl.createEl("h2", { text: "TaskRatchet" });

    new Setting(containerEl)
      .setName("Enable TaskRatchet integration")
      .setDesc(
        "Lets you stake money on individual tasks. If you don't complete the task by its due date, your card is charged.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.taskratchetEnabled).onChange(async (value) => {
          this.plugin.settings.taskratchetEnabled = value;
          await this.plugin.saveSettings();
          this.plugin.refreshTaskRatchet();
          TaskView.refreshAll();
        }),
      );

    const apiSetting = new Setting(containerEl)
      .setName("TaskRatchet API token")
      .addText((text) =>
        text
          .setPlaceholder("...")
          .setValue(this.plugin.settings.taskratchetApiKey)
          .onChange(async (value) => {
            this.plugin.settings.taskratchetApiKey = value.trim();
            this.plugin.settings.taskratchetMyUserId = null;
            await this.plugin.saveSettings();
            this.plugin.refreshTaskRatchet();
            TaskView.refreshAll();
          }),
      );
    apiSetting.descEl.appendText("API v2 token. To request one, email ");
    apiSetting.descEl.createEl("a", {
      text: "support@taskratchet.com",
      href: "mailto:support@taskratchet.com?subject=API%20v2%20token%20request",
    });
    apiSetting.descEl.appendText(".");

    new Setting(containerEl)
      .setName("Default stake (USD)")
      .setDesc("Pre-filled stake when staking a task. Minimum $1.")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.taskratchetDefaultCents / 100))
          .onChange(async (value) => {
            const dollars = Number(value);
            if (Number.isFinite(dollars) && dollars >= 1) {
              this.plugin.settings.taskratchetDefaultCents = Math.round(dollars * 100);
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify the TaskRatchet API token.")
      .addButton((btn) =>
        btn.setButtonText("Test").onClick(async () => {
          const key = this.plugin.settings.taskratchetApiKey;
          if (!key) {
            new Notice("Set a TaskRatchet API token first.");
            return;
          }
          btn.setDisabled(true).setButtonText("Testing…");
          try {
            const profile = await fetchTaskRatchetProfile(key);
            this.plugin.settings.taskratchetMyUserId = profile.id;
            await this.plugin.saveSettings();
            new Notice(
              `Connected to TaskRatchet${profile.name ? ` as ${profile.name}` : ""}.`,
            );
          } catch (err) {
            new Notice(`TaskRatchet connection failed: ${(err as Error).message}`);
          } finally {
            btn.setDisabled(false).setButtonText("Test");
          }
        }),
      );
  }
}
