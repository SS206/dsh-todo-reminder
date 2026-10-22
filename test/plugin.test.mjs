/**
 * Unit tests for dsh-todo-reminder.
 *
 * The plugin deliberately imports nothing from @deepseek-ai/*; these tests use
 * a fake Cordis context and a fake Session with the two read methods the
 * plugin consumes (seq and eventAt). They run with plain Node:
 *
 *   node --test test/plugin.test.mjs
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { apply, name } from "../lib/index.js";

/** Build a fake session whose append order matches session event seqs. */
function makeSession() {
  const events = [];
  return {
    events,
    get seq() {
      return events.length;
    },
    eventAt(seq) {
      return events[seq];
    },
    push(type, data = {}) {
      events.push({ type, data, seq: events.length, time: 0 });
    },
  };
}

/** Build a fake ctx and capture the registered pre-step listener. */
function harness(config) {
  const listeners = [];
  const warnings = [];
  const ctx = {
    on(event, listener, options) {
      listeners.push({ event, listener, options });
    },
    logger: {
      warn(message) {
        warnings.push(String(message));
      },
    },
  };
  apply(ctx, config);
  assert.equal(listeners.length, 1, "one pre-step listener is registered");
  assert.equal(listeners[0].event, "agent/pre-step");
  assert.deepEqual(listeners[0].options, { prepend: true });
  return { handler: listeners[0].listener, warnings };
}

/** Run one pre-step through the plugin. */
async function runStep(handler, session, options = {}) {
  const decision = options.decision ?? { kind: "enter", messages: [] };
  return handler(
    {
      agent: { session },
      turn: 1,
      step: 1,
      signal: { aborted: options.aborted === true },
    },
    async () => decision,
  );
}

/** Seed a turn with an optional todo list and assistant messages. */
function seed(session, { todos, assistantsBefore = 0, assistantsAfter = 0, turn = 1 } = {}) {
  session.push("turn/start", { turn });
  for (let index = 0; index < assistantsBefore; index += 1) {
    session.push("assistant/message");
  }
  if (todos !== undefined) session.push("todo/write", { todos });
  for (let index = 0; index < assistantsAfter; index += 1) {
    session.push("assistant/message");
  }
}

const UNFINISHED = [
  { content: "Write tests", status: "in_progress" },
  { content: "Update docs", status: "pending" },
];

test("exports the plugin name", () => {
  assert.equal(name, "todo-reminder");
});

test("does nothing without a todo list", async () => {
  const session = makeSession();
  seed(session, { assistantsAfter: 15 });
  const { handler } = harness();
  const result = await runStep(handler, session);
  assert.equal(result.messages.length, 0);
});

test("reminds after ten assistant steps with an unfinished list", async () => {
  const session = makeSession();
  seed(session, { todos: UNFINISHED, assistantsAfter: 10 });
  const { handler } = harness();
  const result = await runStep(handler, session);

  assert.equal(result.messages.length, 1);
  const message = result.messages[0];
  assert.equal(message.role, "user");
  assert.equal(message.source.kind, "plugin");
  assert.equal(message.source.plugin, "todo-reminder");
  assert.equal(message.source.form, "notice");
  assert.equal(message.source.summary, "Todo list reminder: 10 steps since last update");
  assert.ok(message.source.summary.length <= 120);
  assert.match(message.content[0].text, /todo_write/);
  assert.match(message.content[0].text, /1\. \[in_progress\] Write tests/);
  assert.match(message.content[0].text, /2\. \[pending\] Update docs/);
});

test("does not remind before the threshold", async () => {
  const session = makeSession();
  seed(session, { todos: UNFINISHED, assistantsAfter: 9 });
  const { handler } = harness();

  let result = await runStep(handler, session);
  assert.equal(result.messages.length, 0);

  session.push("assistant/message");
  result = await runStep(handler, session);
  assert.equal(result.messages.length, 1);
});

test("resets after a todo_write update", async () => {
  const session = makeSession();
  seed(session, { todos: UNFINISHED, assistantsAfter: 10 });
  const { handler } = harness();

  let result = await runStep(handler, session);
  assert.equal(result.messages.length, 1);

  // Simulate the host appending the injected notice as a session event.
  session.push("user/message", result.messages[0]);
  session.push("todo/write", {
    todos: [{ content: "New task", status: "in_progress" }],
  });
  for (let index = 0; index < 9; index += 1) session.push("assistant/message");

  result = await runStep(handler, session);
  assert.equal(result.messages.length, 0, "counter was reset by todo/write");

  session.push("assistant/message");
  result = await runStep(handler, session);
  assert.equal(result.messages.length, 1);
});

test("does not remind for completed or empty lists", async () => {
  const completed = makeSession();
  seed(completed, {
    todos: [{ content: "Done", status: "completed" }],
    assistantsAfter: 15,
  });
  const completedHandler = harness().handler;
  assert.equal((await runStep(completedHandler, completed)).messages.length, 0);

  const empty = makeSession();
  seed(empty, { todos: [], assistantsAfter: 15 });
  const emptyHandler = harness().handler;
  assert.equal((await runStep(emptyHandler, empty)).messages.length, 0);
});

test("a new turn clears the previous list", async () => {
  const session = makeSession();
  seed(session, { todos: UNFINISHED, assistantsAfter: 12 });
  const { handler } = harness();

  let result = await runStep(handler, session);
  assert.equal(result.messages.length, 1);

  session.push("user/message", result.messages[0]);
  session.push("turn/start", { turn: 2 });
  result = await runStep(handler, session);
  assert.equal(result.messages.length, 0, "turn/start cleared the stale list");

  session.push("todo/write", {
    todos: [{ content: "Fresh task", status: "in_progress" }],
  });
  for (let index = 0; index < 9; index += 1) session.push("assistant/message");
  result = await runStep(handler, session);
  assert.equal(result.messages.length, 0);

  session.push("assistant/message");
  result = await runStep(handler, session);
  assert.equal(result.messages.length, 1);
});

test("initialization ignores events before the current turn", async () => {
  const session = makeSession();
  session.push("turn/start", { turn: 1 });
  session.push("todo/write", { todos: UNFINISHED });
  for (let index = 0; index < 20; index += 1) session.push("assistant/message");
  session.push("turn/start", { turn: 2 });
  session.push("todo/write", {
    todos: [{ content: "Fresh task", status: "pending" }],
  });
  for (let index = 0; index < 2; index += 1) session.push("assistant/message");

  const { handler } = harness();
  const result = await runStep(handler, session);
  assert.equal(result.messages.length, 0);
});

test("skips rejected and aborted steps", async () => {
  const rejectedSession = makeSession();
  seed(rejectedSession, { todos: UNFINISHED, assistantsAfter: 10 });
  const rejectedHandler = harness().handler;
  const rejected = await runStep(rejectedHandler, rejectedSession, {
    decision: { kind: "reject" },
  });
  assert.equal(rejected.kind, "reject");
  assert.equal(rejected.messages, undefined);

  const abortedSession = makeSession();
  seed(abortedSession, { todos: UNFINISHED, assistantsAfter: 10 });
  const abortedHandler = harness().handler;
  const aborted = await runStep(abortedHandler, abortedSession, { aborted: true });
  assert.equal(aborted.messages.length, 0);
});

test("rejects invalid configuration at load time", () => {
  assert.throws(() => harness({ stepsBeforeReminder: 0 }), /positive safe integer/);
  assert.throws(() => harness({ maxItems: 1.5 }), /positive safe integer/);
  assert.throws(() => harness({ unknown: 1 }), /unknown config key/);
  assert.throws(() => harness("nope"), /config must be an object/);
});

test("truncates long lists and long item text", async () => {
  const session = makeSession();
  const todos = Array.from({ length: 25 }, (_, index) => ({
    content: index === 0 ? "x".repeat(500) : `task-${index}`,
    status: "pending",
  }));
  seed(session, { todos, assistantsAfter: 10 });
  const { handler } = harness({ maxItems: 3 });
  const result = await runStep(handler, session);
  const text = result.messages[0].content[0].text;

  assert.match(text, /1\. \[pending\] x+/);
  assert.match(text, /2\. \[pending\] task-1/);
  assert.match(text, /3\. \[pending\] task-2/);
  assert.doesNotMatch(text, /4\. \[pending\]/);
  assert.match(text, /… \(22 more\)/);
  assert.equal(text.includes("x".repeat(500)), false);
  assert.equal(text.includes("x".repeat(201)), false);
});

test("normalizes whitespace in todo content", async () => {
  const session = makeSession();
  seed(session, {
    todos: [{ content: "line one\nline two", status: "in_progress" }],
    assistantsAfter: 10,
  });
  const { handler } = harness();
  const result = await runStep(handler, session);
  const text = result.messages[0].content[0].text;
  assert.match(text, /1\. \[in_progress\] line one line two/);
  assert.doesNotMatch(text, /line one\nline two/);
});

test("keeps the request intact when event reads fail", async () => {
  const session = {
    seq: 3,
    eventAt() {
      throw new Error("boom");
    },
  };
  const { handler, warnings } = harness();
  const result = await runStep(handler, session);
  assert.equal(result.kind, "enter");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /skipped a reminder/);
  assert.match(warnings[0], /boom/);
});

test("the reminder itself resets the counter", async () => {
  const session = makeSession();
  seed(session, { todos: UNFINISHED, assistantsAfter: 10 });
  const { handler } = harness();

  let result = await runStep(handler, session);
  assert.equal(result.messages.length, 1);
  session.push("user/message", result.messages[0]);

  for (let index = 0; index < 9; index += 1) session.push("assistant/message");
  result = await runStep(handler, session);
  assert.equal(result.messages.length, 0);

  session.push("assistant/message");
  result = await runStep(handler, session);
  assert.equal(result.messages.length, 1);
});
