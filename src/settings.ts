import { App, PluginSettingTab, Setting } from "obsidian";
import type IrisTasksPlugin from "./main";

export interface IrisTasksSettings {
  folders: string[];
}

export const DEFAULT_SETTINGS: IrisTasksSettings = {
  folders: ["Tasks", "Iris/Tabula/Assignments"],
};

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
      .setName("Task folders")
      .setDesc("Comma-separated list of vault folders to scan for tasks.")
      .addText((text) =>
        text
          .setPlaceholder("Tasks, Iris/Tabula/Assignments")
          .setValue(this.plugin.settings.folders.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.folders = value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          }),
      );
  }
}
