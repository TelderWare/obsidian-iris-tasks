var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => IrisTasksPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian4 = require("obsidian");

// src/task-view.ts
var import_obsidian2 = require("obsidian");

// src/task-parser.ts
var import_obsidian = require("obsidian");
var PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
function parseTasks(app, folders) {
  const tasks = [];
  for (const folderPath of folders) {
    const abstract = app.vault.getAbstractFileByPath(folderPath);
    if (!abstract || !(abstract instanceof import_obsidian.TFolder)) continue;
    const source = folderPath.includes("Assignment") ? "assignment" : "task";
    collectFiles(abstract).forEach((file) => {
      const task = parseFile(app, file, source);
      if (task) tasks.push(task);
    });
  }
  return tasks;
}
function collectFiles(folder) {
  const files = [];
  for (const child of folder.children) {
    if (child instanceof import_obsidian.TFile && child.extension === "md") {
      files.push(child);
    } else if (child instanceof import_obsidian.TFolder) {
      files.push(...collectFiles(child));
    }
  }
  return files;
}
function parseFile(app, file, source) {
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
      source
    };
  }
  const title = fm.displayTitle ?? fm.title ?? file.basename;
  const status = normalizeStatus(fm.status);
  const priority = fm.priority ?? null;
  const dueDate = fm.closes ?? fm.closeDate ?? null;
  const dueTime = fm.closeTime ?? null;
  const created = fm.created ?? null;
  const module2 = fm.module ?? null;
  const from = fm.from ?? null;
  const tags = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [];
  return { file, title, status, priority, dueDate, dueTime, created, module: module2, from, tags, source };
}
function normalizeStatus(raw) {
  if (!raw || typeof raw !== "string") return "incomplete";
  const lower = raw.toLowerCase().trim();
  if (lower === "archived") return "archived";
  if (lower === "completed" || lower === "done" || lower === "submitted") return "completed";
  if (lower === "in-progress" || lower === "in progress" || lower === "working") return "in-progress";
  return "incomplete";
}
function sortTasks(tasks, key) {
  return [...tasks].sort((a, b) => {
    switch (key) {
      case "dueDate": {
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return 0;
      }
      case "priority": {
        const pa = a.priority ? PRIORITY_ORDER[a.priority] ?? 3 : 3;
        const pb = b.priority ? PRIORITY_ORDER[b.priority] ?? 3 : 3;
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

// src/task-view.ts
var VIEW_TYPE_TASKS = "iris-tasks-view";
var TaskView = class extends import_obsidian2.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.layoutReady = false;
    this.sortKey = "dueDate";
    this.debounceTimer = null;
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_TASKS;
  }
  getDisplayText() {
    return "Iris Tasks";
  }
  getIcon() {
    return "list-checks";
  }
  async onOpen() {
    this.registerEvent(this.app.vault.on("create", () => this.debouncedRender()));
    this.registerEvent(this.app.vault.on("delete", () => this.debouncedRender()));
    this.registerEvent(this.app.vault.on("modify", () => this.debouncedRender()));
    this.registerEvent(this.app.vault.on("rename", () => this.debouncedRender()));
    this.render();
  }
  async onClose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }
  debouncedRender() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.render(), 400);
  }
  ensureLayout() {
    if (this.layoutReady) return;
    this.layoutReady = true;
    const container = this.contentEl;
    container.empty();
    container.addClass("iris-tasks");
    this.bodyEl = container.createDiv({ cls: "iris-hp-list-container" });
  }
  render() {
    this.ensureLayout();
    this.renderBody();
  }
  renderBody() {
    this.bodyEl.empty();
    this.bodyEl.createEl("h6", { text: "Tasks", cls: "iris-hp-widget-title" });
    let tasks = parseTasks(this.app, this.plugin.settings.folders).filter((t) => t.status !== "archived");
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
  renderItem(parent, task) {
    const item = parent.createDiv({ cls: "iris-hp-list-item" });
    const self = item.createDiv({
      cls: `iris-hp-list-item-self is-clickable ${task.status === "completed" ? "is-completed" : ""}`
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
      const menu = new import_obsidian2.Menu();
      menu.addItem((item2) => {
        item2.setTitle("Archive task").setIcon("archive").onClick(() => this.archiveTask(task));
      });
      menu.showAtMouseEvent(e);
    });
  }
  async toggleStatus(task) {
    const newStatus = task.status === "completed" ? "" : "completed";
    await this.app.fileManager.processFrontMatter(task.file, (fm) => {
      fm.status = newStatus;
    });
  }
  async archiveTask(task) {
    await this.app.fileManager.processFrontMatter(task.file, (fm) => {
      fm.status = "archived";
    });
  }
};
var DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function formatDueDate(date) {
  const parts = date.split("-");
  const target = new Date(+parts[0], +parts[1] - 1, +parts[2]);
  const now = /* @__PURE__ */ new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((target.getTime() - today.getTime()) / 864e5);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  if (diff > 1 && diff <= 7) return "in " + diff + " days";
  if (diff < -1 && diff >= -7) return Math.abs(diff) + " days ago";
  if (diff > 7 && diff <= 14) return "next " + DAY_NAMES[target.getDay()];
  if (diff < -7 && diff >= -14) return "last " + DAY_NAMES[target.getDay()];
  if (diff > 14) {
    const months2 = Math.round(diff / 30);
    if (months2 < 1) return "in " + Math.round(diff / 7) + " weeks";
    if (months2 < 12) return "in " + months2 + " month" + (months2 > 1 ? "s" : "");
    const years2 = Math.round(diff / 365);
    return "in " + years2 + " year" + (years2 > 1 ? "s" : "");
  }
  const absDiff = Math.abs(diff);
  const months = Math.round(absDiff / 30);
  if (months < 1) return Math.round(absDiff / 7) + " weeks ago";
  if (months < 12) return months + " month" + (months > 1 ? "s" : "") + " ago";
  const years = Math.round(absDiff / 365);
  return years + " year" + (years > 1 ? "s" : "") + " ago";
}

// src/settings.ts
var import_obsidian3 = require("obsidian");
var DEFAULT_SETTINGS = {
  folders: ["Tasks", "Iris/Tabula/Assignments"]
};
var IrisTasksSettingTab = class extends import_obsidian3.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Iris Tasks" });
    new import_obsidian3.Setting(containerEl).setName("Task folders").setDesc("Comma-separated list of vault folders to scan for tasks.").addText(
      (text) => text.setPlaceholder("Tasks, Iris/Tabula/Assignments").setValue(this.plugin.settings.folders.join(", ")).onChange(async (value) => {
        this.plugin.settings.folders = value.split(",").map((s) => s.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      })
    );
  }
};

// src/main.ts
var IrisTasksPlugin = class extends import_obsidian4.Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE_TASKS, (leaf) => new TaskView(leaf, this));
    this.addRibbonIcon("list-checks", "Open Iris Tasks", () => {
      this.activateView();
    });
    this.addCommand({
      id: "open-iris-tasks",
      name: "Open Iris Tasks",
      callback: () => this.activateView()
    });
    this.addSettingTab(new IrisTasksSettingTab(this.app, this));
  }
  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TASKS);
  }
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_TASKS, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
};
