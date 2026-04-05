import { Plugin, WorkspaceLeaf } from "obsidian";
import { TaskView, VIEW_TYPE_TASKS } from "./task-view";
import { IrisTasksSettings, IrisTasksSettingTab, DEFAULT_SETTINGS } from "./settings";

export default class IrisTasksPlugin extends Plugin {
  settings!: IrisTasksSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_TASKS, (leaf) => new TaskView(leaf, this));

    this.addRibbonIcon("list-checks", "Open Iris Tasks", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-iris-tasks",
      name: "Open Iris Tasks",
      callback: () => this.activateView(),
    });

    this.addSettingTab(new IrisTasksSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TASKS);
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_TASKS, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}
