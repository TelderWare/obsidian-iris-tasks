export interface Task {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  dueDate: string | null;
  dueTime: string | null;
  created: string | null;
  source: "mail" | "manual";
  sourceIds: string[];
  /** AI-assigned id from the composition (Obsidian Tasks 🆔). Local to one compose. */
  composedId?: string;
  /** Internal Task ids that must complete before this task (Obsidian Tasks ⛔). */
  dependsOn: string[];
  /** AI-assigned ordering rank (1 = do first). Null if not provided. */
  aiRank: number | null;
  /** Date-only prerequisite ("wait until X"); has no checkbox and auto-completes by date. */
  isWait?: boolean;
  /** Task auto-completes when a frontmatter condition is met; has no checkbox. */
  autoCompletes?: boolean;
  /** If this task belongs to a series, the series id. */
  seriesId?: string;
  /** 1-based index of this member within the series. */
  seriesIndex?: number;
  /** Total number of members in the series. */
  seriesTotal?: number;
  /** If set, clicking the task title opens this vault file. */
  linkedFilePath?: string;
  /** If set, clicking the task title executes this Obsidian command. */
  onClickCommand?: string;
  /** For word-count auto-complete tasks: the target word count. */
  wordCountTarget?: number;
  /** For word-count auto-complete tasks: the file being tracked. */
  wordCountFilePath?: string;
}

const SPECIAL_DUE = new Set(["Immediately", "ASAP", "Eventually"]);

export function isSpecialDueDate(d: string | null): boolean {
  return d !== null && SPECIAL_DUE.has(d);
}

