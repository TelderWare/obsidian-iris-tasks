import type IrisTasksPlugin from "./main";

export interface ParsedDue {
  date: string;
  time: string | null;
}

const IMMEDIATELY_PHRASES: Record<string, string> = Object.fromEntries(
  [
    "asap", "a.s.a.p", "immediately", "right away", "right now", "now",
    "urgent", "urgently", "high priority", "today", "tonight", "stat",
  ].map((p) => [p, "Immediately"]),
);

const EVENTUALLY_PHRASES: Record<string, string> = Object.fromEntries(
  [
    "eventually", "someday", "some day", "no rush", "low priority",
    "whenever", "when possible", "tba", "to be determined", "tbd",
  ].map((p) => [p, "Eventually"]),
);

const SPECIAL_PHRASES = { ...IMMEDIATELY_PHRASES, ...EVENTUALLY_PHRASES };

const CLAUDE_EXTRA_PROMPT =
  'If the input conveys immediate urgency, return {"date":"Immediately","time":null}. ' +
  'If the input conveys low priority or no rush, return {"date":"Eventually","time":null}.';

export async function parseDueDate(
  plugin: IrisTasksPlugin,
  input: string,
): Promise<ParsedDue | null> {
  const calendar = (plugin.app as any).plugins?.plugins?.["iris-calendar"];
  if (!calendar?.parseNLDateTime) return null;

  return calendar.parseNLDateTime(input, {
    specialPhrases: SPECIAL_PHRASES,
    claudeExtraPrompt: CLAUDE_EXTRA_PROMPT,
    callerId: "iris-tasks",
    anthropicApiKey: plugin.settings.anthropicApiKey || undefined,
  });
}
