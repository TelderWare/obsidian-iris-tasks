import { App, Component, MarkdownRenderer, Modal } from "obsidian";
import { getMailTodoBody, getRawMailTodos } from "./mail-source";

/**
 * Read-only display of the email(s) backing a task. Shows the same body text
 * iris-mail caches and that the AI composer sees — htmlToMarkdown'd, no inline
 * images, no reply UI. Stacks multiple sourceIds when a task groups several.
 */
export class MailMessageModal extends Modal {
  private title: string;
  private sourceIds: string[];
  private renderComponent = new Component();

  constructor(app: App, title: string, sourceIds: string[]) {
    super(app);
    this.title = title;
    this.sourceIds = sourceIds;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.title);
    contentEl.addClass("iris-tasks-mail-modal");
    this.renderComponent.load();

    const byId = new Map(getRawMailTodos(this.app).map((t) => [t.id, t]));

    for (let i = 0; i < this.sourceIds.length; i++) {
      const id = this.sourceIds[i];
      if (i > 0) contentEl.createEl("hr");
      const section = contentEl.createDiv({ cls: "iris-tasks-mail-section" });
      const meta = byId.get(id);

      section.createDiv({
        cls: "iris-tasks-mail-subject",
        text: meta?.subject || "(no subject)",
      });

      const fromLabel = meta?.from || meta?.fromAddress || "(unknown sender)";
      const received = meta?.receivedDateTime
        ? new Date(meta.receivedDateTime).toLocaleString()
        : "";
      section.createDiv({
        cls: "iris-tasks-mail-meta",
        text: received ? `${fromLabel} · ${received}` : fromLabel,
      });

      const bodyEl = section.createDiv({ cls: "iris-tasks-mail-body" });
      const body = getMailTodoBody(this.app, id);
      if (body) {
        void MarkdownRenderer.render(this.app, body, bodyEl, "", this.renderComponent);
      } else {
        bodyEl.setText("(body not cached yet — open the email in Iris Mail to fetch it)");
        bodyEl.addClass("iris-tasks-mail-empty");
      }
    }
  }

  onClose(): void {
    this.renderComponent.unload();
    this.contentEl.empty();
  }
}
