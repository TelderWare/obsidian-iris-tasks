import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import type IrisTasksPlugin from "./main";
import { Task, SortKey, parseTasks, sortTasks } from "./task-parser";

export const VIEW_TYPE_TASKS = "iris-tasks-view";

export class TaskView extends ItemView {
  private plugin: IrisTasksPlugin;
  private bodyEl!: HTMLElement;
  private layoutReady = false;

  private sortKey: SortKey = "dueDate";

  constructor(leaf: WorkspaceLeaf, plugin: IrisTasksPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_TASKS; }
  getDisplayText(): string { return "Iris Tasks"; }
  getIcon(): string { return "list-checks"; }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.vault.on("create", () => this.debouncedRender()));
    this.registerEvent(this.app.vault.on("delete", () => this.debouncedRender()));
    this.registerEvent(this.app.vault.on("modify", () => this.debouncedRender()));
    this.registerEvent(this.app.vault.on("rename", () => this.debouncedRender()));
    this.render();
  }

  async onClose(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debouncedRender(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.render(), 400);
  }

  private ensureLayout(): void {
    if (this.layoutReady) return;
    this.layoutReady = true;

    const container = this.contentEl;
    container.empty();
    container.addClass("iris-tasks");

    const header = container.createDiv({ cls: "iris-tasks-header" });
    header.createEl("h6", { text: "Tasks", cls: "iris-hp-widget-title" });

    const toggle = header.createEl("button", {
      cls: "iris-tasks-toggle clickable-icon",
      attr: { "aria-label": "Toggle completed tasks" },
    });
    setIcon(toggle, this.plugin.settings.showCompleted ? "eye" : "eye-off");
    toggle.addEventListener("click", async () => {
      this.plugin.settings.showCompleted = !this.plugin.settings.showCompleted;
      await this.plugin.saveSettings();
      setIcon(toggle, this.plugin.settings.showCompleted ? "eye" : "eye-off");
      this.renderBody();
    });

    this.bodyEl = container.createDiv({ cls: "iris-hp-list-container" });
  }

  private render(): void {
    this.ensureLayout();
    this.renderBody();
  }

  private renderBody(): void {
    this.bodyEl.empty();

    let tasks = parseTasks(this.app, this.plugin.settings.folders)
      .filter((t) => t.status !== "archived");
    if (!this.plugin.settings.showCompleted) {
      tasks = tasks.filter((t) => t.status !== "completed");
    }
    tasks = sortTasks(tasks, this.sortKey);

    if (tasks.length === 0) {
      const empty = this.bodyEl.createDiv({ cls: "iris-hp-empty" });
      empty.setText("No tasks found");
      return;
    }

    for (const task of tasks) {
      this.renderItem(this.bodyEl, task);
    }
  }

  private renderItem(parent: HTMLElement, task: Task): void {
    const item = parent.createDiv({ cls: "iris-hp-list-item" });
    const self = item.createDiv({
      cls: `iris-hp-list-item-self is-clickable ${task.status === "completed" ? "is-completed" : ""}`,
    });

    const checkbox = self.createEl("input", { cls: "task-list-item-checkbox", type: "checkbox" });
    checkbox.checked = task.status === "completed";
    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleStatus(task);
    });

    const inner = self.createDiv({ cls: "iris-hp-list-item-inner" });
    inner.setText(task.title);

    if (task.dueDate) {
      const flair = self.createDiv({ cls: "iris-hp-list-item-flair" });
      flair.setText(formatDueDate(task.dueDate));
    }

    self.addEventListener("click", () => {
      this.app.workspace.getLeaf(false).openFile(task.file);
    });

    self.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((item) => {
        item.setTitle("Archive task")
          .setIcon("archive")
          .onClick(() => this.archiveTask(task));
      });
      menu.showAtMouseEvent(e);
    });
  }

  private async toggleStatus(task: Task): Promise<void> {
    const newStatus = task.status === "completed" ? "" : "completed";
    await this.app.fileManager.processFrontMatter(task.file, (fm) => {
      fm.status = newStatus;
    });
  }

  private async archiveTask(task: Task): Promise<void> {
    await this.app.fileManager.processFrontMatter(task.file, (fm) => {
      fm.status = "archived";
    });
  }
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDueDate(date: string): string {
  const parts = date.split("-");
  const target = new Date(+parts[0], +parts[1] - 1, +parts[2]);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((target.getTime() - today.getTime()) / 86400000);

  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  if (diff > 1 && diff <= 7) return "in " + diff + " days";
  if (diff < -1 && diff >= -7) return Math.abs(diff) + " days ago";
  if (diff > 7 && diff <= 14) return "next " + DAY_NAMES[target.getDay()];
  if (diff < -7 && diff >= -14) return "last " + DAY_NAMES[target.getDay()];
  if (diff > 14) {
    const months = Math.round(diff / 30);
    if (months < 1) return "in " + Math.round(diff / 7) + " weeks";
    if (months < 12) return "in " + months + " month" + (months > 1 ? "s" : "");
    const years = Math.round(diff / 365);
    return "in " + years + " year" + (years > 1 ? "s" : "");
  }
  const absDiff = Math.abs(diff);
  const months = Math.round(absDiff / 30);
  if (months < 1) return Math.round(absDiff / 7) + " weeks ago";
  if (months < 12) return months + " month" + (months > 1 ? "s" : "") + " ago";
  const years = Math.round(absDiff / 365);
  return years + " year" + (years > 1 ? "s" : "") + " ago";
}
