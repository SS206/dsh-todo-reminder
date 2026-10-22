/**
 * todo-reminder — a DSH host plugin that keeps the model's todo list honest.
 *
 * The model-facing todo_write tool replaces the whole list on every call and
 * appends a todo/write session event. The conversation TodoPanel renders the
 * session projection of that event, so a model that stops calling todo_write
 * leaves the visible progress stale. This plugin watches the current turn's
 * session events and, after stepsBeforeReminder assistant messages without a
 * list update or a reminder, appends one notice-shaped user message to the
 * next request.
 *
 * Design notes:
 * - Host-only: no client bundle, no tool registration, no UI changes.
 * - One step is one successful assistant/message event; parallel tool calls in
 *   a single response still count as one step. This mirrors ZCode's
 *   TODO_REMINDER_CONFIG semantics.
 * - State follows the current turn: turn/start clears it, because the session
 *   todos projection is cleared at the same boundary.
 * - Reads use session.seq and session.eventAt(seq). Those read methods are
 *   deprecated by the host but remain the only synchronous event access
 *   available to out-of-repo plugins.
 * - No @deepseek-ai/* imports: external bundles cannot resolve host packages.
 * @module dsh-todo-reminder
 */

export const name = "todo-reminder";

const PLUGIN_NAME = "todo-reminder";
const SUMMARY_MAX_CHARS = 120;
const ITEM_MAX_CHARS = 200;

const DEFAULTS = Object.freeze({
  stepsBeforeReminder: 10,
  stepsBetweenReminders: 10,
  maxItems: 20,
  maxScanEvents: 20000,
});

const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULTS));

/** Freeze a value graph in place, mirroring the host's message construction. */
function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validate and detach plugin configuration.
 * Unknown keys and non-positive integer values fail loud at load time.
 * @param config - raw plugin config.
 * @returns frozen effective config.
 */
function resolveConfig(config) {
  if (config === undefined) return DEFAULTS;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("todo-reminder: config must be an object");
  }
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(`todo-reminder: unknown config key(s): ${unknown.join(", ")}`);
  }
  const resolved = { ...DEFAULTS, ...config };
  for (const key of CONFIG_KEYS) {
    const value = resolved[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`todo-reminder: ${key} must be a positive safe integer`);
    }
  }
  return Object.freeze(resolved);
}

/** Truncate a one-line summary to the host's context-summary bound. */
function boundSummary(summary) {
  return summary.length <= SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

/** Recognize a reminder injected by this plugin. */
function isReminderEvent(event) {
  if (event === null || typeof event !== "object" || event.type !== "user/message") return false;
  const source = event.data?.source;
  return source?.kind === "plugin" && source?.plugin === PLUGIN_NAME;
}

/** Render one bounded todo line for the reminder. */
function renderTodoLine(todo, index) {
  const status = typeof todo?.status === "string" ? todo.status : "pending";
  const raw = typeof todo?.content === "string" ? todo.content : "";
  const normalized = raw.replace(/\s+/g, " ").trim();
  const content =
    normalized.length <= ITEM_MAX_CHARS
      ? normalized
      : `${normalized.slice(0, ITEM_MAX_CHARS - 1)}…`;
  return `${index + 1}. [${status}] ${content}`;
}

/** Build the model-facing reminder text. */
function buildReminderText(todos, steps, maxItems) {
  const lines = [
    `The todo_write tool hasn't been used recently: it has been ${steps} model steps since the last todo list update.`,
    "If you are still working on tasks that would benefit from tracking progress, consider updating the todo list with todo_write so it stays accurate. Keep the user-visible task list consistent with actual progress, and clean it up if it has become stale. This is just a gentle reminder - ignore if not applicable.",
    "",
    "Here are the existing contents of your todo list:",
    "",
  ];
  const shown = todos.slice(0, maxItems).map(renderTodoLine);
  if (todos.length > maxItems) shown.push(`… (${todos.length - maxItems} more)`);
  lines.push(`[${shown.join("\n")}]`);
  return lines.join("\n");
}

/** Build the frozen user-role message carrying the notice-shaped reminder. */
function createReminderMessage(todos, steps, options) {
  const text = buildReminderText(todos, steps, options.maxItems);
  const summary = boundSummary(`Todo list reminder: ${steps} steps since last update`);
  return deepFreeze(
    structuredClone({
      id: globalThis.crypto.randomUUID(),
      role: "user",
      content: [{ type: "text", text }],
      source: {
        kind: "plugin",
        plugin: PLUGIN_NAME,
        form: "notice",
        summary,
      },
    }),
  );
}

/** Initialize per-session state at the current turn boundary. */
function createState(session, options) {
  const end = session.seq;
  let start = Math.max(0, end - options.maxScanEvents);
  for (let seq = end - 1; seq >= start; seq -= 1) {
    const event = session.eventAt(seq);
    if (event?.type === "turn/start") {
      start = seq;
      break;
    }
  }
  return { scannedSeq: start, todos: null, steps: 0 };
}

/** Apply one session event to the counter. */
function applyEvent(state, event) {
  switch (event.type) {
    case "turn/start":
      state.todos = null;
      state.steps = 0;
      break;
    case "assistant/message":
      state.steps += 1;
      break;
    case "todo/write":
      state.todos = Array.isArray(event.data?.todos) ? event.data.todos : null;
      state.steps = 0;
      break;
    case "user/message":
      if (isReminderEvent(event)) state.steps = 0;
      break;
    default:
      break;
  }
}

/** Consume newly appended session events. */
function advance(state, session) {
  const end = session.seq;
  for (let seq = state.scannedSeq; seq < end; seq += 1) {
    const event = session.eventAt(seq);
    if (event !== undefined && event !== null) applyEvent(state, event);
  }
  state.scannedSeq = end;
}

/** Whether the current list still needs attention. */
function shouldRemind(state, options) {
  if (!Array.isArray(state.todos) || state.todos.length === 0) return false;
  if (!state.todos.some((todo) => todo?.status !== "completed")) return false;
  return (
    state.steps >= options.stepsBeforeReminder &&
    state.steps >= options.stepsBetweenReminders
  );
}

/**
 * Register the pre-step listener.
 * @param ctx - cordis plugin context.
 * @param config - optional tuning overrides; invalid values fail loud.
 */
export function apply(ctx, config) {
  const options = resolveConfig(config);
  const states = new WeakMap();

  ctx.on(
    "agent/pre-step",
    async ({ agent, signal }, next) => {
      const decision = await next();
      if (decision === undefined || decision === null) return decision;
      if (decision.kind === "reject" || signal?.aborted === true) return decision;
      try {
        const session = agent?.session;
        if (session === undefined) return decision;
        let state = states.get(session);
        if (state === undefined) {
          state = createState(session, options);
          states.set(session, state);
        }
        advance(state, session);
        if (!shouldRemind(state, options)) return decision;
        const message = createReminderMessage(state.todos, state.steps, options);
        state.steps = 0;
        const messages = Array.isArray(decision.messages) ? decision.messages : [];
        return { ...decision, messages: [...messages, message] };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.logger?.warn?.(`todo-reminder: skipped a reminder: ${detail}`);
        return decision;
      }
    },
    { prepend: true },
  );
}
