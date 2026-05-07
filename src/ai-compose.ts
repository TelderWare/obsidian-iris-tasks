import { App, requestUrl } from "obsidian";
import type { RawMailTodo } from "./mail-source";
import type { Assignment, ComposedTask, Group } from "./task-cache";

const COMPOSE_MODEL = "claude-haiku-4-5-20251001";
const MERGE_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Bumped whenever the per-email compose prompt changes — invalidates
 * cached per-email entries (the version is in the cache key salt).
 */
export const COMPOSE_PROMPT_VERSION = 7;

/**
 * Bumped whenever the merge prompt changes. Not part of any cache key
 * directly (merges are not cached — the cache is the resulting groups
 * themselves), but exported for symmetry / future use.
 */
export const MERGE_PROMPT_VERSION = 1;

const PER_EMAIL_PROMPT = `You compose a to-do entry from a single flagged email.

You receive: id, subject, sender, received timestamp, today's date, and full body. Decide whether the email represents an actionable task for the user, and if so, produce one task with its deadline and priority.

Titles are memory jogs, not summaries. The user already knows what each thing is — the title only has to be enough to remind them. Be terse.

Rules:
- Title: imperative verb + the noun. 2–5 words. No adjectives, no qualifiers, no deadlines, no locations, no parenthetical detail. "Pay accommodation fees", not "Pay accommodation fees (student 5708725)". "Submit module choices", not "Attend SLS Module Fair and submit module choices by 26 May". "Collect Amazon package", not "Collect Amazon package from Westside T4 Top post room". Drop "FW:" / "RE:" / department prefixes / ticket boilerplate.
- Keep an identifier in the title only if without it the user genuinely couldn't tell which task it is (e.g. "LF130 problem set" when there are several modules). Default to omitting.
- Output exactly one task whose sourceIds is [<the input email's id>], OR an empty list if the email is purely informational/FYI/automated and asks nothing of the user.

For each emitted task, also infer:
- "priority" (required): one of "high" | "medium" | "low".
  - high: real consequence if missed within ~48h — money owed, hard deadlines, people actively blocked on you, anything irreversible.
  - medium: matters this week but not catastrophic if it slips a day.
  - low: housekeeping, FYI follow-ups, optional, nice-to-have.
- "dueDate" (optional): an ISO date "YYYY-MM-DD" if the email states or strongly implies one, otherwise one of:
  - "Immediately": do today, time-sensitive within hours.
  - "ASAP": this week, no fixed date but should not sit.
  - "Eventually": no deadline, can wait indefinitely.
  Omit "dueDate" entirely if genuinely unknown — don't guess.

Call the \`record_email_task\` tool with your decision. Emit zero or one task in the \`tasks\` array.`;

const MERGE_PROMPT = `You triage candidate task titles into user-facing groups.

You receive:
- "existing_groups": already-grouped tasks the user can see, each with an "id" and a "title".
- "candidates": new candidate tasks composed from individual emails, each with a "cid" and a "title".

For each candidate, decide whether it belongs to an existing group (because it represents the same underlying action — same thread, follow-up, duplicate reminder of the same item) or starts a new group.

Two candidates that belong together but neither matches an existing group should share the same "new" token so they form a single new group.

Be conservative: only merge when the underlying action is clearly the same. When in doubt, keep separate.

Call the \`assign_groups\` tool with one assignment per input candidate. Every input cid must appear in exactly one assignment. Use either "join" (an existing group id) or "new" (an arbitrary token), not both. Do not invent group ids.`;

const RECORD_EMAIL_TASK_TOOL = {
  name: "record_email_task",
  description: "Record the composed task for this email (or no task if the email is informational).",
  input_schema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        description: "Zero or one task derived from this email.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Imperative verb + noun, 2–5 words." },
            sourceIds: {
              type: "array",
              items: { type: "string" },
              description: "Must be exactly [<the input email's id>].",
            },
            priority: { type: "string", enum: ["high", "medium", "low"] },
            dueDate: {
              type: "string",
              description: "ISO date YYYY-MM-DD, or 'Immediately' | 'ASAP' | 'Eventually'. Omit if genuinely unknown.",
            },
          },
          required: ["title", "sourceIds", "priority"],
        },
      },
    },
    required: ["tasks"],
  },
} as const;

const ASSIGN_GROUPS_TOOL = {
  name: "assign_groups",
  description: "Assign each candidate to an existing group (join) or a new group (new token).",
  input_schema: {
    type: "object",
    properties: {
      assignments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            cid: { type: "string" },
            join: { type: "string", description: "An existing group id." },
            new: { type: "string", description: "An arbitrary token; candidates sharing a token form one new group." },
          },
          required: ["cid"],
        },
      },
    },
    required: ["assignments"],
  },
} as const;

export type AIErrorKind = "transient" | "permanent";

export class AIError extends Error {
  kind: AIErrorKind;
  constructor(message: string, kind: AIErrorKind) {
    super(message);
    this.name = "AIError";
    this.kind = kind;
  }
}

interface RelayApi {
  request(
    body: unknown,
    priority?: number,
    trivial?: boolean,
  ): Promise<ClaudeResponse>;
}

interface ClaudeResponse {
  content?: Array<
    | { type: "text"; text?: string }
    | { type: "tool_use"; name?: string; input?: unknown }
  >;
}

function getRelay(app: App): RelayApi | null {
  const relay = (app as unknown as { irisRelay?: RelayApi }).irisRelay;
  return relay ?? null;
}

export function hasAiAccess(app: App, localApiKey: string): boolean {
  return !!getRelay(app) || !!localApiKey;
}

/** True iff iris-router is available — meaning we can fan out without rate-limit risk. */
export function hasIrisRelay(app: App): boolean {
  return !!getRelay(app);
}

interface ComposeEmailInput {
  app: App;
  email: RawMailTodo;
  body: string;
  localApiKey: string;
}

/**
 * Per-email pass: compose 0 or 1 tasks for a single email, with deadline
 * and priority inferred from that email's body. Throws AIError on any
 * failure — caller distinguishes transient vs permanent via err.kind.
 */
export async function aiComposeEmail(
  input: ComposeEmailInput,
): Promise<ComposedTask[]> {
  const { app, email, body, localApiKey } = input;
  const payload = {
    today: new Date().toISOString().slice(0, 10),
    email: {
      id: email.id,
      subject: email.subject,
      from: email.from || email.fromAddress,
      received: email.receivedDateTime,
      body,
    },
  };
  const toolInput = await callClaude({
    app,
    model: COMPOSE_MODEL,
    systemPrompt: PER_EMAIL_PROMPT,
    userContent: JSON.stringify(payload),
    tool: RECORD_EMAIL_TASK_TOOL,
    localApiKey,
  });
  return parsePerEmailToolInput(toolInput, email.id);
}

interface MergeInput {
  app: App;
  candidates: { emailId: string; title: string }[];
  existingGroups: Pick<Group, "id" | "title">[];
  localApiKey: string;
}

/**
 * Title-only merge pass: assigns each candidate either to an existing
 * group (by id) or to a new group (keyed by an arbitrary token, so
 * candidates sharing a token form one new group). Throws AIError on
 * any failure — caller distinguishes transient vs permanent via err.kind.
 */
export async function aiAssignToGroups(input: MergeInput): Promise<Assignment[]> {
  const { app, candidates, existingGroups, localApiKey } = input;
  if (candidates.length === 0) return [];

  const cidByEmail = new Map<string, string>();
  const titleByCid = new Map<string, string>();
  const candidatePayload = candidates.map((c, i) => {
    const cid = `c${i + 1}`;
    cidByEmail.set(c.emailId, cid);
    titleByCid.set(cid, c.title);
    return { cid, title: c.title };
  });

  const payload = {
    existing_groups: existingGroups.map((g) => ({ id: g.id, title: g.title })),
    candidates: candidatePayload,
  };

  const toolInput = await callClaude({
    app,
    model: MERGE_MODEL,
    systemPrompt: MERGE_PROMPT,
    userContent: JSON.stringify(payload),
    tool: ASSIGN_GROUPS_TOOL,
    localApiKey,
  });
  const raw = parseAssignmentToolInput(toolInput);

  const knownGroupIds = new Set(existingGroups.map((g) => g.id));
  const cidToEmail = new Map<string, string>();
  for (const [emailId, cid] of cidByEmail) cidToEmail.set(cid, emailId);

  const seen = new Set<string>();
  const out: Assignment[] = [];
  for (const r of raw) {
    if (seen.has(r.cid)) {
      throw new AIError(`Merge response duplicated cid: ${r.cid}`, "permanent");
    }
    seen.add(r.cid);
    const emailId = cidToEmail.get(r.cid);
    const title = titleByCid.get(r.cid);
    if (!emailId || !title) {
      throw new AIError(`Merge response invented cid: ${r.cid}`, "permanent");
    }
    if (r.join) {
      if (!knownGroupIds.has(r.join)) {
        throw new AIError(`Merge response invented group id: ${r.join}`, "permanent");
      }
      out.push({ emailId, title, joinId: r.join });
    } else if (r.newToken) {
      out.push({ emailId, title, newToken: r.newToken });
    } else {
      throw new AIError(`Merge response missing join/new for cid ${r.cid}`, "permanent");
    }
  }

  if (seen.size !== cidByEmail.size) {
    const missing = [...cidByEmail.values()].filter((c) => !seen.has(c));
    throw new AIError(
      `Merge response omitted ${missing.length} cid(s): ${missing.slice(0, 3).join(", ")}`,
      "permanent",
    );
  }
  return out;
}

function parsePerEmailToolInput(input: unknown, expectedId: string): ComposedTask[] {
  if (!input || typeof input !== "object") {
    throw new AIError("Tool input is not an object", "permanent");
  }
  const tasks = (input as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) {
    throw new AIError("Tool input missing 'tasks' array", "permanent");
  }
  if (tasks.length === 0) return [];
  if (tasks.length > 1) {
    throw new AIError(
      `Per-email response returned ${tasks.length} tasks; expected 0 or 1`,
      "permanent",
    );
  }
  const t = tasks[0];
  if (!t || typeof t !== "object") throw new AIError("Task is not an object", "permanent");
  const title = (t as { title?: unknown }).title;
  const sourceIds = (t as { sourceIds?: unknown }).sourceIds;
  if (typeof title !== "string" || !title.trim()) {
    throw new AIError("Task has invalid title", "permanent");
  }
  if (!Array.isArray(sourceIds) || sourceIds.length !== 1 || sourceIds[0] !== expectedId) {
    throw new AIError(`Task sourceIds must be exactly ["${expectedId}"]`, "permanent");
  }
  const out: ComposedTask = { title: title.trim(), sourceIds: [expectedId] };
  const priority = (t as { priority?: unknown }).priority;
  if (priority === "high" || priority === "medium" || priority === "low") {
    out.priority = priority;
  }
  const dueDate = (t as { dueDate?: unknown }).dueDate;
  if (typeof dueDate === "string") {
    const d = dueDate.trim();
    if (d === "Immediately" || d === "ASAP" || d === "Eventually" || /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      out.dueDate = d;
    }
  }
  return [out];
}

interface RawAssignment {
  cid: string;
  join?: string;
  newToken?: string;
}

function parseAssignmentToolInput(input: unknown): RawAssignment[] {
  if (!input || typeof input !== "object") {
    throw new AIError("Tool input is not an object", "permanent");
  }
  const assignments = (input as { assignments?: unknown }).assignments;
  if (!Array.isArray(assignments)) {
    throw new AIError("Merge tool input missing 'assignments' array", "permanent");
  }
  const out: RawAssignment[] = [];
  for (let i = 0; i < assignments.length; i++) {
    const a = assignments[i];
    if (!a || typeof a !== "object") {
      throw new AIError(`Assignment ${i} is not an object`, "permanent");
    }
    const cid = (a as { cid?: unknown }).cid;
    if (typeof cid !== "string" || !cid.trim()) {
      throw new AIError(`Assignment ${i} has invalid cid`, "permanent");
    }
    const join = (a as { join?: unknown }).join;
    const newTok = (a as { new?: unknown }).new;
    const hasJoin = typeof join === "string" && !!join.trim();
    const hasNew = typeof newTok === "string" && !!newTok.trim();
    if (hasJoin && hasNew) {
      throw new AIError(`Assignment ${i} (${cid}) sets both join and new`, "permanent");
    }
    if (!hasJoin && !hasNew) {
      throw new AIError(`Assignment ${i} (${cid}) sets neither join nor new`, "permanent");
    }
    out.push({
      cid: cid.trim(),
      join: hasJoin ? (join as string).trim() : undefined,
      newToken: hasNew ? (newTok as string).trim() : undefined,
    });
  }
  return out;
}

interface CallInput {
  app: App;
  model: string;
  systemPrompt: string;
  userContent: string;
  tool: typeof RECORD_EMAIL_TASK_TOOL | typeof ASSIGN_GROUPS_TOOL;
  localApiKey: string;
}

async function callClaude(input: CallInput): Promise<unknown> {
  const { app, model, systemPrompt, userContent, tool, localApiKey } = input;
  const body = {
    model,
    max_tokens: 4096,
    temperature: 0,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: userContent }],
  };

  const relay = getRelay(app);
  let json: ClaudeResponse;
  if (relay) {
    try {
      json = await relay.request(body);
    } catch (err) {
      throw classifyError(err);
    }
  } else {
    if (!localApiKey) {
      throw new AIError("No relay and no local API key configured", "permanent");
    }
    let response: { status: number; json?: { error?: { message?: string }; content?: ClaudeResponse["content"] } };
    try {
      response = await Promise.race([
        requestUrl({
          url: ANTHROPIC_API_URL,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": localApiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          throw: false,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new AIError("Claude request timed out", "transient")), REQUEST_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      throw classifyError(err);
    }

    if (response.status !== 200) {
      const msg = response.json?.error?.message ?? `HTTP ${response.status}`;
      const kind: AIErrorKind =
        response.status === 429 || response.status >= 500 ? "transient" : "permanent";
      throw new AIError(`Claude API error: ${msg}`, kind);
    }
    json = { content: response.json?.content };
  }

  const block = json.content?.find((b): b is { type: "tool_use"; name?: string; input?: unknown } =>
    b.type === "tool_use" && b.name === tool.name,
  );
  if (!block) {
    throw new AIError(`Response missing expected tool_use block '${tool.name}'`, "permanent");
  }
  return block.input;
}

function classifyError(err: unknown): AIError {
  if (err instanceof AIError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  // Heuristic: relay errors don't expose status codes. Look for clear
  // transient signals; default unknown to permanent so retry loops are bounded.
  const lower = msg.toLowerCase();
  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("network") ||
    /\b5\d\d\b/.test(msg) ||
    lower.includes("overloaded")
  ) {
    return new AIError(msg, "transient");
  }
  return new AIError(msg, "permanent");
}
