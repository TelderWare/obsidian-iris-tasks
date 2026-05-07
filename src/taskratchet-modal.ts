import { Modal, Setting, type App } from "obsidian";

export interface StakeChoice {
  cents: number;
}

export class TaskRatchetStakeModal extends Modal {
  private dollars: string;
  private resolved = false;
  private resolve!: (choice: StakeChoice | null) => void;

  constructor(
    app: App,
    private readonly taskTitle: string,
    private readonly deadlineLabel: string,
    defaultCents: number,
  ) {
    super(app);
    this.dollars = (defaultCents / 100).toString();
  }

  open(): Promise<StakeChoice | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      super.open();
    });
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("TaskRatchet");
    contentEl.addClass("iris-taskratchet-modal");

    const summary = contentEl.createEl("p", { cls: "iris-taskratchet-modal-summary" });
    summary.appendText("If you don't complete ");
    summary.createEl("strong", { text: this.taskTitle });
    summary.appendText(` by ${this.deadlineLabel}, your card will be charged.`);

    let inputEl: HTMLInputElement | null = null;
    const submit = (): void => {
      const dollars = Number(this.dollars);
      if (!Number.isFinite(dollars) || dollars < 1) return;
      const cents = Math.round(dollars * 100);
      if (cents < 100) return;
      this.resolved = true;
      this.close();
      this.resolve({ cents });
    };

    new Setting(contentEl)
      .setName("Stake (USD)")
      .setDesc("Minimum $1.")
      .addText((text) => {
        text
          .setPlaceholder("5")
          .setValue(this.dollars)
          .onChange((v) => {
            this.dollars = v;
          });
        inputEl = text.inputEl;
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.step = "1";
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        });
      });

    const btnRow = contentEl.createDiv({ cls: "iris-taskratchet-modal-buttons" });
    const stakeBtn = btnRow.createEl("button", {
      text: "Stake",
      cls: "mod-cta",
    });
    stakeBtn.addEventListener("click", submit);

    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    setTimeout(() => inputEl?.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}

export class TaskRatchetApiKeyModal extends Modal {
  private apiKey = "";
  private resolved = false;
  private resolve!: (key: string | null) => void;

  open(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      super.open();
    });
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Connect TaskRatchet");
    contentEl.addClass("iris-taskratchet-modal");

    const helpEl = contentEl.createEl("p", { cls: "iris-taskratchet-modal-help" });
    helpEl.appendText("Paste your TaskRatchet API v2 token. To request one, email ");
    helpEl.createEl("a", {
      text: "support@taskratchet.com",
      href: "mailto:support@taskratchet.com?subject=API%20v2%20token%20request",
    });
    helpEl.appendText(".");

    let inputEl: HTMLInputElement | null = null;
    const submit = (): void => {
      const trimmed = this.apiKey.trim();
      if (!trimmed) return;
      this.resolved = true;
      this.close();
      this.resolve(trimmed);
    };

    new Setting(contentEl)
      .setName("API token")
      .addText((text) => {
        text
          .setPlaceholder("...")
          .setValue(this.apiKey)
          .onChange((v) => {
            this.apiKey = v;
          });
        inputEl = text.inputEl;
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        });
      });

    const btnRow = contentEl.createDiv({ cls: "iris-taskratchet-modal-buttons" });
    const saveBtn = btnRow.createEl("button", {
      text: "Save & continue",
      cls: "mod-cta",
    });
    saveBtn.addEventListener("click", submit);

    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    setTimeout(() => inputEl?.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}
