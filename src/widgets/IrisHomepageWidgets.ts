import {
  Component,
  Notice,
  WorkspaceLeaf,
  setIcon,
  type View,
} from "obsidian";
import type IrisTasksPlugin from "../main";
import { TaskView } from "../task-view";
import { parseDueDate } from "../date-parse";
import type { ManualTask } from "../settings";

/**
 * Contract consumed by Iris Homepage. Each widget is created inside
 * `IrisHomepageContext.containerEl` and returns a handle the host uses for
 * teardown / resize / config-change callbacks.
 */
export interface IrisHomepageContext {
  containerEl: HTMLElement;
  config?: unknown;
}

export interface IrisHomepageWidgetHandle {
  destroy(): void;
  onResize?(): void;
  onConfigChange?(config: unknown): void;
}

export interface IrisHomepageWidgetDescriptor {
  type: string;
  label: string;
  icon: string;
  defaultSizePx: { width: number; height: number };
  minSizePx?: { width: number; height: number };
  create(ctx: IrisHomepageContext): IrisHomepageWidgetHandle;
}

/**
 * Embeds a live TaskView inside the homepage card. Mirrors the homepage's
 * generic ViewEmbedWidget (synthetic leaf + onOpen/unload), but specialised
 * to TaskView so we avoid the view-registry indirection.
 */
class TaskListWidget {
  private view: View | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(plugin: IrisTasksPlugin, container: HTMLElement) {
    container.addClass("iris-hp-view-embed-body");
    const leaf = new (WorkspaceLeaf as unknown as new (app: unknown) => WorkspaceLeaf)(plugin.app);
    const view = new TaskView(leaf, plugin, { isWidget: true });
    (leaf as unknown as { view: View }).view = view;
    this.view = view;

    container.appendChild(view.containerEl);
    view.containerEl.addClass("iris-hp-embedded-leaf");

    void (view as unknown as { onOpen?: () => Promise<void> }).onOpen?.();

    this.resizeObserver = new ResizeObserver(() => {
      const v = view as unknown as { onResize?: () => void };
      v.onResize?.();
    });
    this.resizeObserver.observe(container);
  }

  destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.view) {
      try {
        (this.view as Component).unload();
      } catch {
        // already torn down
      }
      this.view.containerEl.remove();
      this.view = null;
    }
  }
}

/**
 * Pop-over "New task" button. Parses the due-date input via chrono-node, with
 * a Claude fallback through the iris-router relay or the plugin's local
 * Anthropic key. Persists a `ManualTask` into `settings.manualTasks` — the
 * same store `NewPrerequisiteModal` writes to — so the new task shows up
 * immediately in any open `TaskView` (sibling widget or standalone tab).
 */
class CreateTaskWidget {
  private root: HTMLElement;
  private popover: HTMLElement | null = null;
  private submitting = false;
  private onDocClick = (e: MouseEvent) => this.handleOutsideClick(e);

  constructor(private readonly plugin: IrisTasksPlugin, container: HTMLElement) {
    this.root = container;
    this.render();
  }

  private render(): void {
    const btn = this.root.createDiv({ cls: "iris-hp-create-task" });

    const icon = btn.createDiv({ cls: "iris-hp-create-task-icon" });
    setIcon(icon, "check-square");

    btn.createDiv({ cls: "iris-hp-create-task-label", text: "New task" });

    btn.addEventListener("click", () => this.togglePopover());
  }

  private togglePopover(): void {
    if (this.popover) {
      this.closePopover();
      return;
    }
    this.openPopover();
  }

  private openPopover(): void {
    const pop = this.root.createDiv({ cls: "iris-hp-task-popover" });
    this.popover = pop;

    const titleInput = this.addField(pop, "", "Task name…");
    const dueInput = this.addField(pop, "Due", "tomorrow 3pm, next Friday…");

    const btn = pop.createEl("button", { cls: "iris-hp-task-submit", text: "Create" });
    btn.disabled = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.submit(titleInput, dueInput, btn);
    });

    titleInput.addEventListener("input", () => {
      btn.disabled = titleInput.value.trim().length === 0;
    });

    const handleEnter = (e: KeyboardEvent, next: HTMLInputElement | null) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (next) next.focus();
      else if (!btn.disabled) this.submit(titleInput, dueInput, btn);
    };
    titleInput.addEventListener("keydown", (e) => handleEnter(e, dueInput));
    dueInput.addEventListener("keydown", (e) => handleEnter(e, null));

    pop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closePopover();
      }
    });

    pop.addEventListener("mousedown", (e) => e.stopPropagation());
    pop.addEventListener("click", (e) => e.stopPropagation());

    // Flip popover upward if it would overflow the viewport.
    requestAnimationFrame(() => {
      const popRect = pop.getBoundingClientRect();
      if (popRect.bottom > window.innerHeight) {
        pop.addClass("iris-hp-task-popover-above");
      }
    });

    setTimeout(() => document.addEventListener("click", this.onDocClick), 0);
    titleInput.focus();
  }

  private addField(parent: HTMLElement, label: string, placeholder: string): HTMLInputElement {
    const row = parent.createDiv({ cls: "iris-hp-task-field" });
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
      new Notice("Task title is required");
      return;
    }

    this.submitting = true;
    const originalText = btn.textContent ?? "Create";
    btn.disabled = true;
    btn.setText("Creating…");
    titleInput.disabled = true;
    dueInput.disabled = true;

    try {
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
          return;
        }
        dueDate = due.date;
        dueTime = due.time;
      }

      const id =
        "m-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const newTask: ManualTask = {
        id,
        title,
        dueDate,
        dueTime,
        createdAt: new Date().toISOString(),
        completedAt: null,
      };
      this.plugin.settings.manualTasks.push(newTask);
      await this.plugin.saveSettings();
      TaskView.refreshAll();

      new Notice(`Task "${title}" created`);
      this.closePopover();
    } finally {
      this.submitting = false;
    }
  }

  private closePopover(): void {
    document.removeEventListener("click", this.onDocClick);
    if (this.popover) {
      this.popover.remove();
      this.popover = null;
    }
  }

  private handleOutsideClick(e: MouseEvent): void {
    if (this.popover && !this.popover.contains(e.target as Node)) {
      this.closePopover();
    }
  }

  destroy(): void {
    this.closePopover();
    this.root.empty();
  }
}

/**
 * Build the descriptors Iris Homepage consumes. iris-tasks owns two widgets:
 * the embedded task list and the create-task popover.
 */
export function buildIrisHomepageWidgets(
  plugin: IrisTasksPlugin,
): IrisHomepageWidgetDescriptor[] {
  return [
    {
      type: "iris-tasks:list",
      label: "Tasks (Iris Tasks)",
      icon: "list-checks",
      defaultSizePx: { width: 380, height: 460 },
      create(ctx) {
        const widget = new TaskListWidget(plugin, ctx.containerEl);
        return { destroy: () => widget.destroy() };
      },
    },
    {
      type: "iris-tasks:create",
      label: "New task (Iris Tasks)",
      icon: "check-square",
      defaultSizePx: { width: 200, height: 160 },
      create(ctx) {
        const widget = new CreateTaskWidget(plugin, ctx.containerEl);
        return { destroy: () => widget.destroy() };
      },
    },
  ];
}
