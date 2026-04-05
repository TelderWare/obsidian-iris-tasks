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
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
  const fm = (_a = app.metadataCache.getFileCache(file)) == null ? void 0 : _a.frontmatter;
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
  const title = (_c = (_b = fm.displayTitle) != null ? _b : fm.title) != null ? _c : file.basename;
  const status = normalizeStatus(fm.status);
  const priority = (_d = fm.priority) != null ? _d : null;
  const dueDate = (_f = (_e = fm.closes) != null ? _e : fm.closeDate) != null ? _f : null;
  const dueTime = (_g = fm.closeTime) != null ? _g : null;
  const created = (_h = fm.created) != null ? _h : null;
  const module2 = (_i = fm.module) != null ? _i : null;
  const from = (_j = fm.from) != null ? _j : null;
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
    var _a, _b;
    switch (key) {
      case "dueDate": {
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return 0;
      }
      case "priority": {
        const pa = a.priority ? (_a = PRIORITY_ORDER[a.priority]) != null ? _a : 3 : 3;
        const pb = b.priority ? (_b = PRIORITY_ORDER[b.priority]) != null ? _b : 3 : 3;
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
    container.addClass("nav-files-container", "iris-tasks");
    this.bodyEl = container.createDiv({ cls: "tree-item-children" });
  }
  render() {
    this.ensureLayout();
    this.renderBody();
  }
  renderBody() {
    this.bodyEl.empty();
    let tasks = parseTasks(this.app, this.plugin.settings.folders).filter((t) => t.status !== "archived");
    tasks = sortTasks(tasks, this.sortKey);
    if (tasks.length === 0) {
      const empty = this.bodyEl.createDiv({ cls: "pane-empty" });
      empty.setText("No tasks found");
      return;
    }
    for (const task of tasks) {
      this.renderItem(this.bodyEl, task);
    }
  }
  renderItem(parent, task) {
    const item = parent.createDiv({ cls: "tree-item" });
    const self = item.createDiv({
      cls: `tree-item-self is-clickable ${task.status === "completed" ? "is-completed" : ""}`
    });
    const checkbox = self.createEl("input", { cls: "task-list-item-checkbox", type: "checkbox" });
    checkbox.checked = task.status === "completed";
    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleStatus(task);
    });
    const inner = self.createDiv({ cls: "tree-item-inner" });
    inner.setText(task.title);
    if (task.dueDate) {
      const flair = self.createDiv({ cls: "tree-item-flair-outer" });
      const span = flair.createSpan({ cls: "tree-item-flair" });
      span.setText(formatDueDate(task.dueDate));
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL21haW4udHMiLCAic3JjL3Rhc2stdmlldy50cyIsICJzcmMvdGFzay1wYXJzZXIudHMiLCAic3JjL3NldHRpbmdzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBQbHVnaW4sIFdvcmtzcGFjZUxlYWYgfSBmcm9tIFwib2JzaWRpYW5cIjtcbmltcG9ydCB7IFRhc2tWaWV3LCBWSUVXX1RZUEVfVEFTS1MgfSBmcm9tIFwiLi90YXNrLXZpZXdcIjtcbmltcG9ydCB7IElyaXNUYXNrc1NldHRpbmdzLCBJcmlzVGFza3NTZXR0aW5nVGFiLCBERUZBVUxUX1NFVFRJTkdTIH0gZnJvbSBcIi4vc2V0dGluZ3NcIjtcblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgSXJpc1Rhc2tzUGx1Z2luIGV4dGVuZHMgUGx1Z2luIHtcbiAgc2V0dGluZ3MhOiBJcmlzVGFza3NTZXR0aW5ncztcblxuICBhc3luYyBvbmxvYWQoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5sb2FkU2V0dGluZ3MoKTtcblxuICAgIHRoaXMucmVnaXN0ZXJWaWV3KFZJRVdfVFlQRV9UQVNLUywgKGxlYWYpID0+IG5ldyBUYXNrVmlldyhsZWFmLCB0aGlzKSk7XG5cbiAgICB0aGlzLmFkZFJpYmJvbkljb24oXCJsaXN0LWNoZWNrc1wiLCBcIk9wZW4gSXJpcyBUYXNrc1wiLCAoKSA9PiB7XG4gICAgICB0aGlzLmFjdGl2YXRlVmlldygpO1xuICAgIH0pO1xuXG4gICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgIGlkOiBcIm9wZW4taXJpcy10YXNrc1wiLFxuICAgICAgbmFtZTogXCJPcGVuIElyaXMgVGFza3NcIixcbiAgICAgIGNhbGxiYWNrOiAoKSA9PiB0aGlzLmFjdGl2YXRlVmlldygpLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hZGRTZXR0aW5nVGFiKG5ldyBJcmlzVGFza3NTZXR0aW5nVGFiKHRoaXMuYXBwLCB0aGlzKSk7XG4gIH1cblxuICBhc3luYyBvbnVubG9hZCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLmFwcC53b3Jrc3BhY2UuZGV0YWNoTGVhdmVzT2ZUeXBlKFZJRVdfVFlQRV9UQVNLUyk7XG4gIH1cblxuICBhc3luYyBsb2FkU2V0dGluZ3MoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgZGF0YSA9IGF3YWl0IHRoaXMubG9hZERhdGEoKTtcbiAgICB0aGlzLnNldHRpbmdzID0gT2JqZWN0LmFzc2lnbih7fSwgREVGQVVMVF9TRVRUSU5HUywgZGF0YSk7XG4gIH1cblxuICBhc3luYyBzYXZlU2V0dGluZ3MoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5zYXZlRGF0YSh0aGlzLnNldHRpbmdzKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgYWN0aXZhdGVWaWV3KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5hcHAud29ya3NwYWNlLmdldExlYXZlc09mVHlwZShWSUVXX1RZUEVfVEFTS1MpO1xuICAgIGlmIChleGlzdGluZy5sZW5ndGggPiAwKSB7XG4gICAgICB0aGlzLmFwcC53b3Jrc3BhY2UucmV2ZWFsTGVhZihleGlzdGluZ1swXSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGxlYWYgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0TGVhZihcInRhYlwiKTtcbiAgICBhd2FpdCBsZWFmLnNldFZpZXdTdGF0ZSh7IHR5cGU6IFZJRVdfVFlQRV9UQVNLUywgYWN0aXZlOiB0cnVlIH0pO1xuICAgIHRoaXMuYXBwLndvcmtzcGFjZS5yZXZlYWxMZWFmKGxlYWYpO1xuICB9XG59XG4iLCAiaW1wb3J0IHsgSXRlbVZpZXcsIE1lbnUsIFdvcmtzcGFjZUxlYWYsIHNldEljb24gfSBmcm9tIFwib2JzaWRpYW5cIjtcbmltcG9ydCB0eXBlIElyaXNUYXNrc1BsdWdpbiBmcm9tIFwiLi9tYWluXCI7XG5pbXBvcnQgeyBUYXNrLCBTb3J0S2V5LCBwYXJzZVRhc2tzLCBzb3J0VGFza3MgfSBmcm9tIFwiLi90YXNrLXBhcnNlclwiO1xuXG5leHBvcnQgY29uc3QgVklFV19UWVBFX1RBU0tTID0gXCJpcmlzLXRhc2tzLXZpZXdcIjtcblxuZXhwb3J0IGNsYXNzIFRhc2tWaWV3IGV4dGVuZHMgSXRlbVZpZXcge1xuICBwcml2YXRlIHBsdWdpbjogSXJpc1Rhc2tzUGx1Z2luO1xuICBwcml2YXRlIGJvZHlFbCE6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIGxheW91dFJlYWR5ID0gZmFsc2U7XG5cbiAgcHJpdmF0ZSBzb3J0S2V5OiBTb3J0S2V5ID0gXCJkdWVEYXRlXCI7XG5cbiAgY29uc3RydWN0b3IobGVhZjogV29ya3NwYWNlTGVhZiwgcGx1Z2luOiBJcmlzVGFza3NQbHVnaW4pIHtcbiAgICBzdXBlcihsZWFmKTtcbiAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgfVxuXG4gIGdldFZpZXdUeXBlKCk6IHN0cmluZyB7IHJldHVybiBWSUVXX1RZUEVfVEFTS1M7IH1cbiAgZ2V0RGlzcGxheVRleHQoKTogc3RyaW5nIHsgcmV0dXJuIFwiSXJpcyBUYXNrc1wiOyB9XG4gIGdldEljb24oKTogc3RyaW5nIHsgcmV0dXJuIFwibGlzdC1jaGVja3NcIjsgfVxuXG4gIGFzeW5jIG9uT3BlbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLnJlZ2lzdGVyRXZlbnQodGhpcy5hcHAudmF1bHQub24oXCJjcmVhdGVcIiwgKCkgPT4gdGhpcy5kZWJvdW5jZWRSZW5kZXIoKSkpO1xuICAgIHRoaXMucmVnaXN0ZXJFdmVudCh0aGlzLmFwcC52YXVsdC5vbihcImRlbGV0ZVwiLCAoKSA9PiB0aGlzLmRlYm91bmNlZFJlbmRlcigpKSk7XG4gICAgdGhpcy5yZWdpc3RlckV2ZW50KHRoaXMuYXBwLnZhdWx0Lm9uKFwibW9kaWZ5XCIsICgpID0+IHRoaXMuZGVib3VuY2VkUmVuZGVyKCkpKTtcbiAgICB0aGlzLnJlZ2lzdGVyRXZlbnQodGhpcy5hcHAudmF1bHQub24oXCJyZW5hbWVcIiwgKCkgPT4gdGhpcy5kZWJvdW5jZWRSZW5kZXIoKSkpO1xuICAgIHRoaXMucmVuZGVyKCk7XG4gIH1cblxuICBhc3luYyBvbkNsb3NlKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLmRlYm91bmNlVGltZXIpIGNsZWFyVGltZW91dCh0aGlzLmRlYm91bmNlVGltZXIpO1xuICB9XG5cbiAgcHJpdmF0ZSBkZWJvdW5jZVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGRlYm91bmNlZFJlbmRlcigpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5kZWJvdW5jZVRpbWVyKSBjbGVhclRpbWVvdXQodGhpcy5kZWJvdW5jZVRpbWVyKTtcbiAgICB0aGlzLmRlYm91bmNlVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHRoaXMucmVuZGVyKCksIDQwMCk7XG4gIH1cblxuICBwcml2YXRlIGVuc3VyZUxheW91dCgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5sYXlvdXRSZWFkeSkgcmV0dXJuO1xuICAgIHRoaXMubGF5b3V0UmVhZHkgPSB0cnVlO1xuXG4gICAgY29uc3QgY29udGFpbmVyID0gdGhpcy5jb250ZW50RWw7XG4gICAgY29udGFpbmVyLmVtcHR5KCk7XG4gICAgY29udGFpbmVyLmFkZENsYXNzKFwibmF2LWZpbGVzLWNvbnRhaW5lclwiLCBcImlyaXMtdGFza3NcIik7XG5cbiAgICB0aGlzLmJvZHlFbCA9IGNvbnRhaW5lci5jcmVhdGVEaXYoeyBjbHM6IFwidHJlZS1pdGVtLWNoaWxkcmVuXCIgfSk7XG4gIH1cblxuICBwcml2YXRlIHJlbmRlcigpOiB2b2lkIHtcbiAgICB0aGlzLmVuc3VyZUxheW91dCgpO1xuICAgIHRoaXMucmVuZGVyQm9keSgpO1xuICB9XG5cbiAgcHJpdmF0ZSByZW5kZXJCb2R5KCk6IHZvaWQge1xuICAgIHRoaXMuYm9keUVsLmVtcHR5KCk7XG5cbiAgICBsZXQgdGFza3MgPSBwYXJzZVRhc2tzKHRoaXMuYXBwLCB0aGlzLnBsdWdpbi5zZXR0aW5ncy5mb2xkZXJzKVxuICAgICAgLmZpbHRlcigodCkgPT4gdC5zdGF0dXMgIT09IFwiYXJjaGl2ZWRcIik7XG4gICAgdGFza3MgPSBzb3J0VGFza3ModGFza3MsIHRoaXMuc29ydEtleSk7XG5cbiAgICBpZiAodGFza3MubGVuZ3RoID09PSAwKSB7XG4gICAgICBjb25zdCBlbXB0eSA9IHRoaXMuYm9keUVsLmNyZWF0ZURpdih7IGNsczogXCJwYW5lLWVtcHR5XCIgfSk7XG4gICAgICBlbXB0eS5zZXRUZXh0KFwiTm8gdGFza3MgZm91bmRcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCB0YXNrIG9mIHRhc2tzKSB7XG4gICAgICB0aGlzLnJlbmRlckl0ZW0odGhpcy5ib2R5RWwsIHRhc2spO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgcmVuZGVySXRlbShwYXJlbnQ6IEhUTUxFbGVtZW50LCB0YXNrOiBUYXNrKTogdm9pZCB7XG4gICAgY29uc3QgaXRlbSA9IHBhcmVudC5jcmVhdGVEaXYoeyBjbHM6IFwidHJlZS1pdGVtXCIgfSk7XG4gICAgY29uc3Qgc2VsZiA9IGl0ZW0uY3JlYXRlRGl2KHtcbiAgICAgIGNsczogYHRyZWUtaXRlbS1zZWxmIGlzLWNsaWNrYWJsZSAke3Rhc2suc3RhdHVzID09PSBcImNvbXBsZXRlZFwiID8gXCJpcy1jb21wbGV0ZWRcIiA6IFwiXCJ9YCxcbiAgICB9KTtcblxuICAgIGNvbnN0IGNoZWNrYm94ID0gc2VsZi5jcmVhdGVFbChcImlucHV0XCIsIHsgY2xzOiBcInRhc2stbGlzdC1pdGVtLWNoZWNrYm94XCIsIHR5cGU6IFwiY2hlY2tib3hcIiB9KTtcbiAgICBjaGVja2JveC5jaGVja2VkID0gdGFzay5zdGF0dXMgPT09IFwiY29tcGxldGVkXCI7XG4gICAgY2hlY2tib3guYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgdGhpcy50b2dnbGVTdGF0dXModGFzayk7XG4gICAgfSk7XG5cbiAgICBjb25zdCBpbm5lciA9IHNlbGYuY3JlYXRlRGl2KHsgY2xzOiBcInRyZWUtaXRlbS1pbm5lclwiIH0pO1xuICAgIGlubmVyLnNldFRleHQodGFzay50aXRsZSk7XG5cbiAgICBpZiAodGFzay5kdWVEYXRlKSB7XG4gICAgICBjb25zdCBmbGFpciA9IHNlbGYuY3JlYXRlRGl2KHsgY2xzOiBcInRyZWUtaXRlbS1mbGFpci1vdXRlclwiIH0pO1xuICAgICAgY29uc3Qgc3BhbiA9IGZsYWlyLmNyZWF0ZVNwYW4oeyBjbHM6IFwidHJlZS1pdGVtLWZsYWlyXCIgfSk7XG4gICAgICBzcGFuLnNldFRleHQoZm9ybWF0RHVlRGF0ZSh0YXNrLmR1ZURhdGUpKTtcbiAgICB9XG5cbiAgICBzZWxmLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgICB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0TGVhZihmYWxzZSkub3BlbkZpbGUodGFzay5maWxlKTtcbiAgICB9KTtcblxuICAgIHNlbGYuYWRkRXZlbnRMaXN0ZW5lcihcImNvbnRleHRtZW51XCIsIChlKSA9PiB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBjb25zdCBtZW51ID0gbmV3IE1lbnUoKTtcbiAgICAgIG1lbnUuYWRkSXRlbSgoaXRlbSkgPT4ge1xuICAgICAgICBpdGVtLnNldFRpdGxlKFwiQXJjaGl2ZSB0YXNrXCIpXG4gICAgICAgICAgLnNldEljb24oXCJhcmNoaXZlXCIpXG4gICAgICAgICAgLm9uQ2xpY2soKCkgPT4gdGhpcy5hcmNoaXZlVGFzayh0YXNrKSk7XG4gICAgICB9KTtcbiAgICAgIG1lbnUuc2hvd0F0TW91c2VFdmVudChlKTtcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgdG9nZ2xlU3RhdHVzKHRhc2s6IFRhc2spOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBuZXdTdGF0dXMgPSB0YXNrLnN0YXR1cyA9PT0gXCJjb21wbGV0ZWRcIiA/IFwiXCIgOiBcImNvbXBsZXRlZFwiO1xuICAgIGF3YWl0IHRoaXMuYXBwLmZpbGVNYW5hZ2VyLnByb2Nlc3NGcm9udE1hdHRlcih0YXNrLmZpbGUsIChmbSkgPT4ge1xuICAgICAgZm0uc3RhdHVzID0gbmV3U3RhdHVzO1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBhcmNoaXZlVGFzayh0YXNrOiBUYXNrKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5hcHAuZmlsZU1hbmFnZXIucHJvY2Vzc0Zyb250TWF0dGVyKHRhc2suZmlsZSwgKGZtKSA9PiB7XG4gICAgICBmbS5zdGF0dXMgPSBcImFyY2hpdmVkXCI7XG4gICAgfSk7XG4gIH1cbn1cblxuY29uc3QgREFZX05BTUVTID0gW1wiU3VuZGF5XCIsIFwiTW9uZGF5XCIsIFwiVHVlc2RheVwiLCBcIldlZG5lc2RheVwiLCBcIlRodXJzZGF5XCIsIFwiRnJpZGF5XCIsIFwiU2F0dXJkYXlcIl07XG5cbmZ1bmN0aW9uIGZvcm1hdER1ZURhdGUoZGF0ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcGFydHMgPSBkYXRlLnNwbGl0KFwiLVwiKTtcbiAgY29uc3QgdGFyZ2V0ID0gbmV3IERhdGUoK3BhcnRzWzBdLCArcGFydHNbMV0gLSAxLCArcGFydHNbMl0pO1xuICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpO1xuICBjb25zdCB0b2RheSA9IG5ldyBEYXRlKG5vdy5nZXRGdWxsWWVhcigpLCBub3cuZ2V0TW9udGgoKSwgbm93LmdldERhdGUoKSk7XG4gIGNvbnN0IGRpZmYgPSBNYXRoLnJvdW5kKCh0YXJnZXQuZ2V0VGltZSgpIC0gdG9kYXkuZ2V0VGltZSgpKSAvIDg2NDAwMDAwKTtcblxuICBpZiAoZGlmZiA9PT0gMCkgcmV0dXJuIFwidG9kYXlcIjtcbiAgaWYgKGRpZmYgPT09IDEpIHJldHVybiBcInRvbW9ycm93XCI7XG4gIGlmIChkaWZmID09PSAtMSkgcmV0dXJuIFwieWVzdGVyZGF5XCI7XG4gIGlmIChkaWZmID4gMSAmJiBkaWZmIDw9IDcpIHJldHVybiBcImluIFwiICsgZGlmZiArIFwiIGRheXNcIjtcbiAgaWYgKGRpZmYgPCAtMSAmJiBkaWZmID49IC03KSByZXR1cm4gTWF0aC5hYnMoZGlmZikgKyBcIiBkYXlzIGFnb1wiO1xuICBpZiAoZGlmZiA+IDcgJiYgZGlmZiA8PSAxNCkgcmV0dXJuIFwibmV4dCBcIiArIERBWV9OQU1FU1t0YXJnZXQuZ2V0RGF5KCldO1xuICBpZiAoZGlmZiA8IC03ICYmIGRpZmYgPj0gLTE0KSByZXR1cm4gXCJsYXN0IFwiICsgREFZX05BTUVTW3RhcmdldC5nZXREYXkoKV07XG4gIGlmIChkaWZmID4gMTQpIHtcbiAgICBjb25zdCBtb250aHMgPSBNYXRoLnJvdW5kKGRpZmYgLyAzMCk7XG4gICAgaWYgKG1vbnRocyA8IDEpIHJldHVybiBcImluIFwiICsgTWF0aC5yb3VuZChkaWZmIC8gNykgKyBcIiB3ZWVrc1wiO1xuICAgIGlmIChtb250aHMgPCAxMikgcmV0dXJuIFwiaW4gXCIgKyBtb250aHMgKyBcIiBtb250aFwiICsgKG1vbnRocyA+IDEgPyBcInNcIiA6IFwiXCIpO1xuICAgIGNvbnN0IHllYXJzID0gTWF0aC5yb3VuZChkaWZmIC8gMzY1KTtcbiAgICByZXR1cm4gXCJpbiBcIiArIHllYXJzICsgXCIgeWVhclwiICsgKHllYXJzID4gMSA/IFwic1wiIDogXCJcIik7XG4gIH1cbiAgY29uc3QgYWJzRGlmZiA9IE1hdGguYWJzKGRpZmYpO1xuICBjb25zdCBtb250aHMgPSBNYXRoLnJvdW5kKGFic0RpZmYgLyAzMCk7XG4gIGlmIChtb250aHMgPCAxKSByZXR1cm4gTWF0aC5yb3VuZChhYnNEaWZmIC8gNykgKyBcIiB3ZWVrcyBhZ29cIjtcbiAgaWYgKG1vbnRocyA8IDEyKSByZXR1cm4gbW9udGhzICsgXCIgbW9udGhcIiArIChtb250aHMgPiAxID8gXCJzXCIgOiBcIlwiKSArIFwiIGFnb1wiO1xuICBjb25zdCB5ZWFycyA9IE1hdGgucm91bmQoYWJzRGlmZiAvIDM2NSk7XG4gIHJldHVybiB5ZWFycyArIFwiIHllYXJcIiArICh5ZWFycyA+IDEgPyBcInNcIiA6IFwiXCIpICsgXCIgYWdvXCI7XG59XG4iLCAiaW1wb3J0IHsgQXBwLCBURmlsZSwgVEZvbGRlciB9IGZyb20gXCJvYnNpZGlhblwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFRhc2sge1xuICBmaWxlOiBURmlsZTtcbiAgdGl0bGU6IHN0cmluZztcbiAgc3RhdHVzOiBzdHJpbmc7XG4gIHByaW9yaXR5OiBzdHJpbmcgfCBudWxsO1xuICBkdWVEYXRlOiBzdHJpbmcgfCBudWxsO1xuICBkdWVUaW1lOiBzdHJpbmcgfCBudWxsO1xuICBjcmVhdGVkOiBzdHJpbmcgfCBudWxsO1xuICBtb2R1bGU6IHN0cmluZyB8IG51bGw7XG4gIGZyb206IHN0cmluZyB8IG51bGw7XG4gIHRhZ3M6IHN0cmluZ1tdO1xuICBzb3VyY2U6IFwidGFza1wiIHwgXCJhc3NpZ25tZW50XCI7XG59XG5cbmNvbnN0IFBSSU9SSVRZX09SREVSOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0geyBoaWdoOiAwLCBtZWRpdW06IDEsIGxvdzogMiB9O1xuXG5leHBvcnQgdHlwZSBTb3J0S2V5ID0gXCJkdWVEYXRlXCIgfCBcInByaW9yaXR5XCIgfCBcImNyZWF0ZWRcIiB8IFwidGl0bGVcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlVGFza3MoYXBwOiBBcHAsIGZvbGRlcnM6IHN0cmluZ1tdKTogVGFza1tdIHtcbiAgY29uc3QgdGFza3M6IFRhc2tbXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgZm9sZGVyUGF0aCBvZiBmb2xkZXJzKSB7XG4gICAgY29uc3QgYWJzdHJhY3QgPSBhcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKGZvbGRlclBhdGgpO1xuICAgIGlmICghYWJzdHJhY3QgfHwgIShhYnN0cmFjdCBpbnN0YW5jZW9mIFRGb2xkZXIpKSBjb250aW51ZTtcblxuICAgIGNvbnN0IHNvdXJjZTogXCJ0YXNrXCIgfCBcImFzc2lnbm1lbnRcIiA9IGZvbGRlclBhdGguaW5jbHVkZXMoXCJBc3NpZ25tZW50XCIpXG4gICAgICA/IFwiYXNzaWdubWVudFwiXG4gICAgICA6IFwidGFza1wiO1xuXG4gICAgY29sbGVjdEZpbGVzKGFic3RyYWN0KS5mb3JFYWNoKChmaWxlKSA9PiB7XG4gICAgICBjb25zdCB0YXNrID0gcGFyc2VGaWxlKGFwcCwgZmlsZSwgc291cmNlKTtcbiAgICAgIGlmICh0YXNrKSB0YXNrcy5wdXNoKHRhc2spO1xuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHRhc2tzO1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0RmlsZXMoZm9sZGVyOiBURm9sZGVyKTogVEZpbGVbXSB7XG4gIGNvbnN0IGZpbGVzOiBURmlsZVtdID0gW107XG4gIGZvciAoY29uc3QgY2hpbGQgb2YgZm9sZGVyLmNoaWxkcmVuKSB7XG4gICAgaWYgKGNoaWxkIGluc3RhbmNlb2YgVEZpbGUgJiYgY2hpbGQuZXh0ZW5zaW9uID09PSBcIm1kXCIpIHtcbiAgICAgIGZpbGVzLnB1c2goY2hpbGQpO1xuICAgIH0gZWxzZSBpZiAoY2hpbGQgaW5zdGFuY2VvZiBURm9sZGVyKSB7XG4gICAgICBmaWxlcy5wdXNoKC4uLmNvbGxlY3RGaWxlcyhjaGlsZCkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmlsZXM7XG59XG5cbmZ1bmN0aW9uIHBhcnNlRmlsZShhcHA6IEFwcCwgZmlsZTogVEZpbGUsIHNvdXJjZTogXCJ0YXNrXCIgfCBcImFzc2lnbm1lbnRcIik6IFRhc2sgfCBudWxsIHtcbiAgY29uc3QgZm0gPSBhcHAubWV0YWRhdGFDYWNoZS5nZXRGaWxlQ2FjaGUoZmlsZSk/LmZyb250bWF0dGVyO1xuICBpZiAoIWZtKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZpbGUsXG4gICAgICB0aXRsZTogZmlsZS5iYXNlbmFtZSxcbiAgICAgIHN0YXR1czogXCJcIixcbiAgICAgIHByaW9yaXR5OiBudWxsLFxuICAgICAgZHVlRGF0ZTogbnVsbCxcbiAgICAgIGR1ZVRpbWU6IG51bGwsXG4gICAgICBjcmVhdGVkOiBudWxsLFxuICAgICAgbW9kdWxlOiBudWxsLFxuICAgICAgZnJvbTogbnVsbCxcbiAgICAgIHRhZ3M6IFtdLFxuICAgICAgc291cmNlLFxuICAgIH07XG4gIH1cblxuICBjb25zdCB0aXRsZSA9IGZtLmRpc3BsYXlUaXRsZSA/PyBmbS50aXRsZSA/PyBmaWxlLmJhc2VuYW1lO1xuICBjb25zdCBzdGF0dXMgPSBub3JtYWxpemVTdGF0dXMoZm0uc3RhdHVzKTtcbiAgY29uc3QgcHJpb3JpdHkgPSBmbS5wcmlvcml0eSA/PyBudWxsO1xuICBjb25zdCBkdWVEYXRlID0gZm0uY2xvc2VzID8/IGZtLmNsb3NlRGF0ZSA/PyBudWxsO1xuICBjb25zdCBkdWVUaW1lID0gZm0uY2xvc2VUaW1lID8/IG51bGw7XG4gIGNvbnN0IGNyZWF0ZWQgPSBmbS5jcmVhdGVkID8/IG51bGw7XG4gIGNvbnN0IG1vZHVsZSA9IGZtLm1vZHVsZSA/PyBudWxsO1xuICBjb25zdCBmcm9tID0gZm0uZnJvbSA/PyBudWxsO1xuICBjb25zdCB0YWdzID0gQXJyYXkuaXNBcnJheShmbS50YWdzKSA/IGZtLnRhZ3MgOiBmbS50YWdzID8gW2ZtLnRhZ3NdIDogW107XG5cbiAgcmV0dXJuIHsgZmlsZSwgdGl0bGUsIHN0YXR1cywgcHJpb3JpdHksIGR1ZURhdGUsIGR1ZVRpbWUsIGNyZWF0ZWQsIG1vZHVsZSwgZnJvbSwgdGFncywgc291cmNlIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVN0YXR1cyhyYXc6IHVua25vd24pOiBzdHJpbmcge1xuICBpZiAoIXJhdyB8fCB0eXBlb2YgcmF3ICE9PSBcInN0cmluZ1wiKSByZXR1cm4gXCJpbmNvbXBsZXRlXCI7XG4gIGNvbnN0IGxvd2VyID0gcmF3LnRvTG93ZXJDYXNlKCkudHJpbSgpO1xuICBpZiAobG93ZXIgPT09IFwiYXJjaGl2ZWRcIikgcmV0dXJuIFwiYXJjaGl2ZWRcIjtcbiAgaWYgKGxvd2VyID09PSBcImNvbXBsZXRlZFwiIHx8IGxvd2VyID09PSBcImRvbmVcIiB8fCBsb3dlciA9PT0gXCJzdWJtaXR0ZWRcIikgcmV0dXJuIFwiY29tcGxldGVkXCI7XG4gIGlmIChsb3dlciA9PT0gXCJpbi1wcm9ncmVzc1wiIHx8IGxvd2VyID09PSBcImluIHByb2dyZXNzXCIgfHwgbG93ZXIgPT09IFwid29ya2luZ1wiKSByZXR1cm4gXCJpbi1wcm9ncmVzc1wiO1xuICByZXR1cm4gXCJpbmNvbXBsZXRlXCI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzb3J0VGFza3ModGFza3M6IFRhc2tbXSwga2V5OiBTb3J0S2V5KTogVGFza1tdIHtcbiAgcmV0dXJuIFsuLi50YXNrc10uc29ydCgoYSwgYikgPT4ge1xuICAgIHN3aXRjaCAoa2V5KSB7XG4gICAgICBjYXNlIFwiZHVlRGF0ZVwiOiB7XG4gICAgICAgIGlmIChhLmR1ZURhdGUgJiYgYi5kdWVEYXRlKSByZXR1cm4gYS5kdWVEYXRlLmxvY2FsZUNvbXBhcmUoYi5kdWVEYXRlKTtcbiAgICAgICAgaWYgKGEuZHVlRGF0ZSkgcmV0dXJuIC0xO1xuICAgICAgICBpZiAoYi5kdWVEYXRlKSByZXR1cm4gMTtcbiAgICAgICAgcmV0dXJuIDA7XG4gICAgICB9XG4gICAgICBjYXNlIFwicHJpb3JpdHlcIjoge1xuICAgICAgICBjb25zdCBwYSA9IGEucHJpb3JpdHkgPyAoUFJJT1JJVFlfT1JERVJbYS5wcmlvcml0eV0gPz8gMykgOiAzO1xuICAgICAgICBjb25zdCBwYiA9IGIucHJpb3JpdHkgPyAoUFJJT1JJVFlfT1JERVJbYi5wcmlvcml0eV0gPz8gMykgOiAzO1xuICAgICAgICByZXR1cm4gcGEgLSBwYjtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjcmVhdGVkXCI6IHtcbiAgICAgICAgaWYgKGEuY3JlYXRlZCAmJiBiLmNyZWF0ZWQpIHJldHVybiBiLmNyZWF0ZWQubG9jYWxlQ29tcGFyZShhLmNyZWF0ZWQpO1xuICAgICAgICBpZiAoYS5jcmVhdGVkKSByZXR1cm4gLTE7XG4gICAgICAgIGlmIChiLmNyZWF0ZWQpIHJldHVybiAxO1xuICAgICAgICByZXR1cm4gMDtcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJ0aXRsZVwiOlxuICAgICAgICByZXR1cm4gYS50aXRsZS5sb2NhbGVDb21wYXJlKGIudGl0bGUpO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzT3ZlcmR1ZSh0YXNrOiBUYXNrKTogYm9vbGVhbiB7XG4gIGlmICghdGFzay5kdWVEYXRlIHx8IHRhc2suc3RhdHVzID09PSBcImNvbXBsZXRlZFwiKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHRvZGF5ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDEwKTtcbiAgcmV0dXJuIHRhc2suZHVlRGF0ZSA8IHRvZGF5O1xufVxuIiwgImltcG9ydCB7IEFwcCwgUGx1Z2luU2V0dGluZ1RhYiwgU2V0dGluZyB9IGZyb20gXCJvYnNpZGlhblwiO1xuaW1wb3J0IHR5cGUgSXJpc1Rhc2tzUGx1Z2luIGZyb20gXCIuL21haW5cIjtcblxuZXhwb3J0IGludGVyZmFjZSBJcmlzVGFza3NTZXR0aW5ncyB7XG4gIGZvbGRlcnM6IHN0cmluZ1tdO1xufVxuXG5leHBvcnQgY29uc3QgREVGQVVMVF9TRVRUSU5HUzogSXJpc1Rhc2tzU2V0dGluZ3MgPSB7XG4gIGZvbGRlcnM6IFtcIlRhc2tzXCIsIFwiSXJpcy9UYWJ1bGEvQXNzaWdubWVudHNcIl0sXG59O1xuXG5leHBvcnQgY2xhc3MgSXJpc1Rhc2tzU2V0dGluZ1RhYiBleHRlbmRzIFBsdWdpblNldHRpbmdUYWIge1xuICBwbHVnaW46IElyaXNUYXNrc1BsdWdpbjtcblxuICBjb25zdHJ1Y3RvcihhcHA6IEFwcCwgcGx1Z2luOiBJcmlzVGFza3NQbHVnaW4pIHtcbiAgICBzdXBlcihhcHAsIHBsdWdpbik7XG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gIH1cblxuICBkaXNwbGF5KCk6IHZvaWQge1xuICAgIGNvbnN0IHsgY29udGFpbmVyRWwgfSA9IHRoaXM7XG4gICAgY29udGFpbmVyRWwuZW1wdHkoKTtcblxuICAgIGNvbnRhaW5lckVsLmNyZWF0ZUVsKFwiaDJcIiwgeyB0ZXh0OiBcIklyaXMgVGFza3NcIiB9KTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJUYXNrIGZvbGRlcnNcIilcbiAgICAgIC5zZXREZXNjKFwiQ29tbWEtc2VwYXJhdGVkIGxpc3Qgb2YgdmF1bHQgZm9sZGVycyB0byBzY2FuIGZvciB0YXNrcy5cIilcbiAgICAgIC5hZGRUZXh0KCh0ZXh0KSA9PlxuICAgICAgICB0ZXh0XG4gICAgICAgICAgLnNldFBsYWNlaG9sZGVyKFwiVGFza3MsIElyaXMvVGFidWxhL0Fzc2lnbm1lbnRzXCIpXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmZvbGRlcnMuam9pbihcIiwgXCIpKVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmZvbGRlcnMgPSB2YWx1ZVxuICAgICAgICAgICAgICAuc3BsaXQoXCIsXCIpXG4gICAgICAgICAgICAgIC5tYXAoKHMpID0+IHMudHJpbSgpKVxuICAgICAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSksXG4gICAgICApO1xuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBQUFBLG1CQUFzQzs7O0FDQXRDLElBQUFDLG1CQUF1RDs7O0FDQXZELHNCQUFvQztBQWdCcEMsSUFBTSxpQkFBeUMsRUFBRSxNQUFNLEdBQUcs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QUNwQixRQUFRLGNBQWMsRUFDdEIsUUFBUSwwREFBMEQsRUFDbEU7QUFBQSxNQUFRLENBQUMsU0FDUixLQUNHLGVBQWUsZ0NBQWdDLEVBQy9DLFNBQVMsS0FBSyxPQUFPLFNBQVMsUUFBUSxLQUFLLElBQUksQ0FBQyxFQUNoRCxTQUFTLE9BQU8sVUFBVTtBQUN6QixhQUFLLE9BQU8sU0FBUyxVQUFVLE1BQzVCLE1BQU0sR0FBRyxFQUNULElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLEVBQ25CLE9BQU8sT0FBTztBQUNqQixjQUFNLEtBQUssT0FBTyxhQUFhO0FBQUEsTUFDakMsQ0FBQztBQUFBLElBQ0w7QUFBQSxFQUNKO0FBQ0Y7OztBSHJDQSxJQUFxQixrQkFBckIsY0FBNkMsd0JBQU87QUFBQSxFQUdsRCxNQUFNLFNBQXdCO0FBQzVCLFVBQU0sS0FBSyxhQUFhO0FBRXhCLFNBQUssYUFBYSxpQkFBaUIsQ0FBQyxTQUFTLElBQUksU0FBUyxNQUFNLElBQUksQ0FBQztBQUVyRSxTQUFLLGNBQWMsZUFBZSxtQkFBbUIsTUFBTTtBQUN6RCxXQUFLLGFBQWE7QUFBQSxJQUNwQixDQUFDO0FBRUQsU0FBSyxXQUFXO0FBQUEsTUFDZCxJQUFJO0FBQUEsTUFDSixNQUFNO0FBQUEsTUFDTixVQUFVLE1BQU0sS0FBSyxhQUFhO0FBQUEsSUFDcEMsQ0FBQztBQUVELFNBQUssY0FBYyxJQUFJLG9CQUFvQixLQUFLLEtBQUssSUFBSSxDQUFDO0FBQUEsRUFDNUQ7QUFBQSxFQUVBLE1BQU0sV0FBMEI7QUFDOUIsU0FBSyxJQUFJLFVBQVUsbUJBQW1CLGVBQWU7QUFBQSxFQUN2RDtBQUFBLEVBRUEsTUFBTSxlQUE4QjtBQUNsQyxVQUFNLE9BQU8sTUFBTSxLQUFLLFNBQVM7QUFDakMsU0FBSyxXQUFXLE9BQU8sT0FBTyxDQUFDLEdBQUcsa0JBQWtCLElBQUk7QUFBQSxFQUMxRDtBQUFBLEVBRUEsTUFBTSxlQUE4QjtBQUNsQyxVQUFNLEtBQUssU0FBUyxLQUFLLFFBQVE7QUFBQSxFQUNuQztBQUFBLEVBRUEsTUFBYyxlQUE4QjtBQUMxQyxVQUFNLFdBQVcsS0FBSyxJQUFJLFVBQVUsZ0JBQWdCLGVBQWU7QUFDbkUsUUFBSSxTQUFTLFNBQVMsR0FBRztBQUN2QixXQUFLLElBQUksVUFBVSxXQUFXLFNBQVMsQ0FBQyxDQUFDO0FBQ3pDO0FBQUEsSUFDRjtBQUNBLFVBQU0sT0FBTyxLQUFLLElBQUksVUFBVSxRQUFRLEtBQUs7QUFDN0MsVUFBTSxLQUFLLGFBQWEsRUFBRSxNQUFNLGlCQUFpQixRQUFRLEtBQUssQ0FBQztBQUMvRCxTQUFLLElBQUksVUFBVSxXQUFXLElBQUk7QUFBQSxFQUNwQztBQUNGOyIsCiAgIm5hbWVzIjogWyJpbXBvcnRfb2JzaWRpYW4iLCAiaW1wb3J0X29ic2lkaWFuIiwgIm1vZHVsZSIsICJpdGVtIiwgIm1vbnRocyIsICJ5ZWFycyIsICJpbXBvcnRfb2JzaWRpYW4iXQp9Cg==
