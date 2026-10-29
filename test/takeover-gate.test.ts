/**
 * Service-level takeover gate tests (v24 §16, §2.5).
 *
 * The fixture is the shared kernel from `test/helpers.ts` plus a real
 * `TakeoverModule` and `SessionModule`, so the rows these tests inspect are the
 * same rows the HTTP routes and the Client would use. Handler entry points are
 * called directly (`handleApproval` / `handleQuestion`) because the waterfall
 * itself belongs to DSH; `install()` is exercised through a minimal fake Cordis
 * context that records listener registrations and honours its disposers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHost } from "./helpers.js";
import { SessionModule } from "../src/host/session.js";
import { TakeoverModule } from "../src/host/takeover.js";
import { TakeoverGate } from "../src/host/takeover-gate.js";
import type {
  PendingTakeoverView,
  TakeoverGateAnswer,
} from "../src/host/takeover-gate.js";

/* ------------------------------------------------------------------------- *
 * Harness
 * ------------------------------------------------------------------------- */

interface HarnessOptions {
  takeover?: boolean;
  clarifyTimeout?: number;
  clock?: { now(): number };
  /** Records AMP observer calls; the gate must behave identically without one. */
  observed?: {
    requested: Array<{ handle: string; type: string; at: number }>;
    settled: Array<{ handle: string; outcome: string; at: number }>;
  };
}

interface Harness {
  fixture: ReturnType<typeof createTestHost>;
  takeover: TakeoverModule;
  sessions: SessionModule;
  gate: TakeoverGate;
  events: Array<{ type: string; payload: unknown }>;
  close(): void;
}

function harness(options: HarnessOptions = {}): Harness {
  const fixture = createTestHost();
  fixture.host.config.ui.takeover = options.takeover ?? false;
  if (options.clarifyTimeout !== undefined)
    fixture.host.config.clarifyTimeout = options.clarifyTimeout;

  const takeover = new TakeoverModule(fixture.host);
  const sessions = new SessionModule(
    fixture.host.executionStore!,
    fixture.host.config,
    fixture.host.clock,
  );
  const events: Harness["events"] = [];
  fixture.host.events.on("takeover/pending", (payload) => {
    events.push({ type: "takeover/pending", payload });
  });
  const gate = new TakeoverGate({
    takeover,
    sessions,
    config: fixture.host.config,
    events: fixture.host.events,
    clock: options.clock,
    ...(options.observed === undefined
      ? {}
      : {
          observer: {
            requested: (view: PendingTakeoverView, at: number) => {
              options.observed?.requested.push({ handle: view.handle, type: view.type, at });
            },
            settled: (
              view: PendingTakeoverView,
              outcome: string,
              at: number,
            ) => {
              options.observed?.settled.push({ handle: view.handle, outcome, at });
            },
          },
        }),
  });
  return {
    fixture,
    takeover,
    sessions,
    gate,
    events,
    close: () => fixture.close(),
  };
}

/** Run one test body with a fixture that is always closed. */
async function withHarness(
  options: HarnessOptions,
  run: (context: Harness) => Promise<void>,
): Promise<void> {
  const context = harness(options);
  try {
    await run(context);
  } finally {
    context.close();
  }
}

function approvalRequest(agent = "approval-session"): Record<string, unknown> {
  return {
    agent: { id: agent },
    toolName: "bash",
    callId: "call-1",
    reason: "run the test suite",
    displayReason: { en: "Run the test suite?", "zh-CN": "运行测试？" },
  };
}

function questionRequest(agent = "question-session"): Record<string, unknown> {
  return {
    agent: { id: agent },
    questions: [
      {
        id: "route",
        question: "Which route should run?",
        header: "Route",
        options: [
          { label: "fast", description: "take the shortcut" },
          { label: "safe", description: "verify every step" },
        ],
        multiSelect: false,
      },
      { id: "note", question: "Anything else to add?" },
    ],
    wait: { callId: "call-9" },
  };
}

function approvalDelegate(): {
  next: () => Promise<string>;
  calls: () => number;
} {
  let calls = 0;
  return {
    next: async () => {
      calls += 1;
      return "unavailable";
    },
    calls: () => calls,
  };
}

function questionDelegate(): {
  next: () => Promise<unknown>;
  calls: () => number;
} {
  let calls = 0;
  return {
    next: async () => {
      calls += 1;
      return { answers: [] };
    },
    calls: () => calls,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/* ------------------------------------------------------------------------- *
 * Disabled
 * ------------------------------------------------------------------------- */

test("disabled takeover delegates both waterfalls without recording anything", async () => {
  await withHarness({}, async (context) => {
    const approval = approvalDelegate();
    assert.equal(
      await context.gate.handleApproval(approvalRequest(), approval.next),
      "unavailable",
    );
    assert.equal(approval.calls(), 1);

    const question = questionDelegate();
    assert.deepEqual(
      await context.gate.handleQuestion(questionRequest(), question.next),
      { answers: [] },
    );
    assert.equal(question.calls(), 1);

    assert.deepEqual(context.gate.list(), []);
    assert.equal(context.events.length, 0);
    assert.equal(context.fixture.db.count("takeover"), 0);
    assert.equal(context.fixture.db.count("session"), 0);
  });
});

/* ------------------------------------------------------------------------- *
 * Approval
 * ------------------------------------------------------------------------- */

test("an approval stays pending until a human answer resolves it", async () => {
  await withHarness({ takeover: true }, async (context) => {
    const approval = approvalDelegate();
    const promise = context.gate.handleApproval(
      approvalRequest(),
      approval.next,
    );

    const views = context.gate.list();
    assert.equal(views.length, 1);
    const view: PendingTakeoverView = views[0]!;
    assert.equal(view.type, "approval");
    assert.equal(view.handle.length > 0, true);
    assert.equal(
      view.session,
      context.sessions.ensure("approval-session").identity,
    );
    assert.equal(typeof view.created, "number");
    assert.deepEqual(view.payload, {
      toolName: "bash",
      callId: "call-1",
      reason: "run the test suite",
      displayReason: { en: "Run the test suite?", "zh-CN": "运行测试？" },
    });

    assert.equal(context.events.length, 1);
    assert.equal(context.events[0]?.type, "takeover/pending");
    assert.deepEqual(context.events[0]?.payload, view);
    assert.equal(
      approval.calls(),
      0,
      "nothing may answer while the dialog is open",
    );

    assert.equal(
      context.gate.answer(view.handle, {
        kind: "approval",
        outcome: "allowed-once",
      }),
      true,
    );
    assert.equal(await promise, "allowed-once");
    assert.equal(approval.calls(), 0, "a human answer never also delegates");

    const row = context.takeover.get(view.handle);
    assert.equal(row.status, "resolved");
    assert.deepEqual(JSON.parse(row.result ?? "{}"), {
      accepted: true,
      value: { outcome: "allowed-once" },
    });
    assert.deepEqual(context.gate.list(), []);
    assert.equal(
      context.gate.answer(view.handle, {
        kind: "approval",
        outcome: "rejected",
      }),
      false,
      "answering twice is refused",
    );
  });
});

test("an approval accepts only the three human outcomes", async () => {
  await withHarness({ takeover: true }, async (context) => {
    const approval = approvalDelegate();
    const promise = context.gate.handleApproval(
      approvalRequest(),
      approval.next,
    );
    const view = context.gate.list()[0]!;

    const invalid = [
      { kind: "approval", outcome: "unavailable" },
      { kind: "approval", outcome: "auto-approve" },
      { kind: "approval" },
      { kind: "question", answers: [] },
      "allowed-once",
      undefined,
    ];
    for (const answer of invalid) {
      assert.equal(
        context.gate.answer(
          view.handle,
          answer as unknown as TakeoverGateAnswer,
        ),
        false,
        `${JSON.stringify(answer)} must be refused`,
      );
      assert.equal(
        context.gate.list().length,
        1,
        "an invalid answer keeps the window open",
      );
      assert.equal(context.takeover.get(view.handle).status, "pending");
    }

    assert.equal(
      context.gate.answer(view.handle, {
        kind: "approval",
        outcome: "cancelled",
      }),
      true,
    );
    assert.equal(await promise, "cancelled");
    assert.deepEqual(
      JSON.parse(context.takeover.get(view.handle).result ?? "{}"),
      {
        accepted: true,
        value: { outcome: "cancelled" },
      },
    );
  });
});

test("a timeout cancels the window and delegates without auto-allowing", async () => {
  await withHarness({ takeover: true, clarifyTimeout: 20 }, async (context) => {
    const approval = approvalDelegate();
    const promise = context.gate.handleApproval(
      approvalRequest(),
      approval.next,
    );
    const view = context.gate.list()[0]!;

    assert.equal(await promise, "unavailable");
    assert.equal(approval.calls(), 1);
    assert.notEqual(await promise, "allowed-once");
    assert.equal(context.takeover.get(view.handle).status, "cancelled");
    assert.deepEqual(context.gate.list(), []);
    assert.equal(
      context.gate.answer(view.handle, {
        kind: "approval",
        outcome: "allowed-once",
      }),
      false,
    );
  });
});

test("an abort signal cancels the window and delegates", async () => {
  await withHarness(
    { takeover: true, clarifyTimeout: 10000 },
    async (context) => {
      const controller = new AbortController();
      const approval = approvalDelegate();
      const promise = context.gate.handleApproval(
        approvalRequest(),
        approval.next,
        controller.signal,
      );
      const view = context.gate.list()[0]!;

      controller.abort();
      assert.equal(await promise, "unavailable");
      assert.equal(approval.calls(), 1);
      assert.equal(context.takeover.get(view.handle).status, "cancelled");
      assert.deepEqual(context.gate.list(), []);

      const preAborted = new AbortController();
      preAborted.abort();
      assert.equal(
        await context.gate.handleApproval(
          approvalRequest(),
          approval.next,
          preAborted.signal,
        ),
        "unavailable",
      );
      assert.equal(approval.calls(), 2);
      assert.deepEqual(context.gate.list(), []);
      assert.equal(
        context.events.length,
        1,
        "a pre-aborted request never becomes pending",
      );
    },
  );
});

/* ------------------------------------------------------------------------- *
 * Questions
 * ------------------------------------------------------------------------- */

test("a question answer validates question ids, option labels and custom text", async () => {
  await withHarness({ takeover: true }, async (context) => {
    const question = questionDelegate();
    const promise = context.gate.handleQuestion(
      questionRequest(),
      question.next,
    );
    const view = context.gate.list()[0]!;

    assert.equal(view.type, "question");
    assert.deepEqual(view.payload, {
      questions: [
        {
          id: "route",
          question: "Which route should run?",
          header: "Route",
          options: [
            { label: "fast", description: "take the shortcut" },
            { label: "safe", description: "verify every step" },
          ],
          multiSelect: false,
        },
        { id: "note", question: "Anything else to add?" },
      ],
      wait: { callId: "call-9" },
    });
    assert.equal(context.events.length, 1);
    assert.equal(question.calls(), 0);

    const invalidAnswers: unknown[] = [
      { kind: "question" },
      { kind: "question", answers: "fast" },
      { kind: "approval", outcome: "allowed-once" },
      // An option that was never offered.
      { kind: "question", answers: [{ id: "route", selected: ["turbo"] }] },
      // A question id that is not part of this window.
      { kind: "question", answers: [{ id: "other", selected: [] }] },
      // A missing second question.
      { kind: "question", answers: [{ id: "route", selected: ["fast"] }] },
      // The same question twice.
      {
        kind: "question",
        answers: [
          { id: "route", selected: ["fast"] },
          { id: "route", selected: ["safe"] },
          { id: "note", selected: [] },
        ],
      },
      // Custom text next to a selected offered option.
      {
        kind: "question",
        answers: [
          { id: "route", selected: ["fast"], custom: "shortcut" },
          { id: "note", selected: [] },
        ],
      },
      // A selection for an optionless question.
      {
        kind: "question",
        answers: [
          { id: "route", selected: ["fast"] },
          { id: "note", selected: ["typed"] },
        ],
      },
    ];
    for (const answer of invalidAnswers) {
      assert.equal(
        context.gate.answer(view.handle, answer as TakeoverGateAnswer),
        false,
        `${JSON.stringify(answer)} must be refused`,
      );
      assert.equal(
        context.gate.list().length,
        1,
        "an invalid answer keeps the window open",
      );
      assert.equal(context.takeover.get(view.handle).status, "pending");
    }

    const answers = [
      { id: "route", selected: ["fast"] },
      { id: "note", selected: [], custom: "typed answer" },
    ];
    assert.equal(
      context.gate.answer(view.handle, { kind: "question", answers }),
      true,
    );
    assert.deepEqual(await promise, { answers });
    assert.equal(question.calls(), 0);
    assert.deepEqual(
      JSON.parse(context.takeover.get(view.handle).result ?? "{}"),
      {
        accepted: true,
        value: { answers },
      },
    );
    assert.deepEqual(context.gate.list(), []);
  });
});

test("a multi-select question accepts every offered label once", async () => {
  await withHarness({ takeover: true }, async (context) => {
    const question = questionDelegate();
    const promise = context.gate.handleQuestion(
      {
        agent: { id: "multi-session" },
        questions: [
          {
            id: "pick",
            question: "Pick any",
            options: [{ label: "a" }, { label: "b" }],
            multiSelect: true,
          },
        ],
      },
      question.next,
    );
    const view = context.gate.list()[0]!;
    const answers = [{ id: "pick", selected: ["a", "b"] }];

    assert.equal(
      context.gate.answer(view.handle, { kind: "question", answers }),
      true,
    );
    assert.deepEqual(await promise, { answers });
    assert.equal(context.takeover.get(view.handle).status, "resolved");
  });
});

test("a question timeout cancels the window and delegates", async () => {
  await withHarness({ takeover: true, clarifyTimeout: 15 }, async (context) => {
    const question = questionDelegate();
    const promise = context.gate.handleQuestion(
      questionRequest(),
      question.next,
    );
    const view = context.gate.list()[0]!;

    assert.deepEqual(await promise, { answers: [] });
    assert.equal(question.calls(), 1);
    assert.equal(context.takeover.get(view.handle).status, "cancelled");
    assert.deepEqual(context.gate.list(), []);
  });
});

/* ------------------------------------------------------------------------- *
 * Cancel, list and settlement hygiene
 * ------------------------------------------------------------------------- */

test("cancel closes the window, delegates and is idempotent", async () => {
  await withHarness({ takeover: true }, async (context) => {
    const question = questionDelegate();
    const promise = context.gate.handleQuestion(
      questionRequest(),
      question.next,
    );
    const view = context.gate.list()[0]!;

    assert.equal(context.gate.cancel(view.handle), true);
    assert.deepEqual(await promise, { answers: [] });
    assert.equal(question.calls(), 1);
    assert.equal(context.takeover.get(view.handle).status, "cancelled");
    assert.equal(
      context.gate.cancel(view.handle),
      false,
      "cancelling twice is refused",
    );
    assert.deepEqual(context.gate.list(), []);
    assert.equal(
      context.gate.answer(view.handle, { kind: "question", answers: [] }),
      false,
    );
  });
});

test("list filters one session and sorts by creation time", async () => {
  let tick = 1000;
  const clock = {
    now: () => {
      tick += 1;
      return tick;
    },
  };
  await withHarness({ takeover: true, clock }, async (context) => {
    const first = approvalDelegate();
    const second = approvalDelegate();
    const firstPromise = context.gate.handleApproval(
      approvalRequest("first"),
      first.next,
    );
    const secondPromise = context.gate.handleApproval(
      approvalRequest("second"),
      second.next,
    );

    const all = context.gate.list();
    assert.equal(all.length, 2);
    assert.equal(all[0]!.created < all[1]!.created, true);

    const firstSession = context.sessions.ensure("first").identity;
    const secondSession = context.sessions.ensure("second").identity;
    assert.deepEqual(
      context.gate.list(firstSession).map((view) => view.handle),
      [all[0]!.handle],
    );
    assert.deepEqual(
      context.gate.list(secondSession).map((view) => view.handle),
      [all[1]!.handle],
    );
    assert.deepEqual(context.gate.list(999), []);

    assert.equal(context.gate.cancel(all[0]!.handle), true);
    assert.equal(context.gate.cancel(all[1]!.handle), true);
    await Promise.all([firstPromise, secondPromise]);
    assert.deepEqual(context.gate.list(), []);
  });
});

test("settling removes the abort listener and the pending timer", async () => {
  await withHarness({ takeover: true, clarifyTimeout: 25 }, async (context) => {
    const controller = new AbortController();
    const approval = approvalDelegate();
    const promise = context.gate.handleApproval(
      approvalRequest(),
      approval.next,
      controller.signal,
    );
    const view = context.gate.list()[0]!;

    assert.equal(
      context.gate.answer(view.handle, {
        kind: "approval",
        outcome: "rejected",
      }),
      true,
    );
    assert.equal(await promise, "rejected");

    // Neither the abort listener nor the timeout may fire after settlement.
    controller.abort();
    await delay(40);
    assert.equal(approval.calls(), 0);
    assert.equal(context.gate.list().length, 0);
    assert.equal(context.takeover.get(view.handle).status, "resolved");
    assert.equal(context.events.length, 1);
  });
});

test("a synchronous pending listener may answer the new window", async () => {
  await withHarness({ takeover: true, clarifyTimeout: 25 }, async (context) => {
    let answered = "";
    context.fixture.host.events.on("takeover/pending", (payload) => {
      const view = payload as PendingTakeoverView;
      answered = view.handle;
      assert.equal(
        context.gate.answer(view.handle, {
          kind: "approval",
          outcome: "allowed-once",
        }),
        true,
      );
    });

    const approval = approvalDelegate();
    const promise = context.gate.handleApproval(
      approvalRequest("sync-session"),
      approval.next,
    );
    assert.equal(await promise, "allowed-once");
    assert.equal(approval.calls(), 0);
    assert.equal(context.takeover.get(answered).status, "resolved");
    assert.deepEqual(context.gate.list(), []);

    await delay(35);
    assert.equal(
      approval.calls(),
      0,
      "the timeout armed before the announcement must be cleared",
    );
  });
});

test("a non-object waterfall event delegates", async () => {
  await withHarness({ takeover: true }, async (context) => {
    const approval = approvalDelegate();
    assert.equal(
      await context.gate.handleApproval(null, approval.next),
      "unavailable",
    );
    assert.equal(approval.calls(), 1);

    const question = questionDelegate();
    assert.deepEqual(
      await context.gate.handleQuestion("not an event", question.next),
      { answers: [] },
    );
    assert.equal(question.calls(), 1);
    assert.deepEqual(context.gate.list(), []);
    assert.equal(context.events.length, 0);
  });
});

/* ------------------------------------------------------------------------- *
 * Cordis installation
 * ------------------------------------------------------------------------- */

interface FakeContext {
  listeners: Map<
    string,
    (request: unknown, next: () => Promise<unknown>) => unknown
  >;
  removed: string[];
  on(
    name: string,
    listener: (request: unknown, next: () => Promise<unknown>) => unknown,
  ): () => void;
}

function fakeContext(): FakeContext {
  const listeners = new Map<
    string,
    (request: unknown, next: () => Promise<unknown>) => unknown
  >();
  const removed: string[] = [];
  return {
    listeners,
    removed,
    on(name, listener) {
      listeners.set(name, listener);
      return () => {
        removed.push(name);
        listeners.delete(name);
      };
    },
  };
}

test("install registers both waterfalls and its disposer delegates open windows", async () => {
  await withHarness({ takeover: true }, async (context) => {
    const cordis = fakeContext();
    const dispose = context.gate.install(cordis);
    assert.deepEqual([...cordis.listeners.keys()].sort(), [
      "approval/request",
      "user-questions/request",
    ]);

    const approval = approvalDelegate();
    const pending = cordis.listeners.get("approval/request")!(
      approvalRequest("install-session"),
      approval.next,
    );
    const view = context.gate.list()[0]!;
    assert.equal(approval.calls(), 0);

    dispose();
    assert.deepEqual(cordis.removed.sort(), [
      "approval/request",
      "user-questions/request",
    ]);
    assert.equal(await pending, "unavailable");
    assert.equal(approval.calls(), 1);
    assert.equal(context.takeover.get(view.handle).status, "cancelled");
    assert.deepEqual(context.gate.list(), []);

    dispose();
    assert.equal(cordis.removed.length, 2, "a second disposal is harmless");
  });
});

test("install honours the abort signal carried by the event", async () => {
  await withHarness(
    { takeover: true, clarifyTimeout: 10000 },
    async (context) => {
      const cordis = fakeContext();
      const dispose = context.gate.install(cordis);

      const controller = new AbortController();
      const question = questionDelegate();
      const pending = cordis.listeners.get("user-questions/request")!(
        { ...questionRequest("install-abort"), signal: controller.signal },
        question.next,
      );
      assert.equal(context.gate.list().length, 1);

      controller.abort();
      assert.deepEqual(await pending, { answers: [] });
      assert.equal(question.calls(), 1);
      assert.deepEqual(context.gate.list(), []);
      dispose();
    },
  );
});

/* ------------------------------------------------------------------------- *
 * AMP observer
 * ------------------------------------------------------------------------- */

function observedRecorder(): {
  requested: Array<{ handle: string; type: string; at: number }>;
  settled: Array<{ handle: string; outcome: string; at: number }>;
} {
  return { requested: [], settled: [] };
}

test('an answered window reports one request and one granted settlement', async () => {
  const observed = observedRecorder();
  await withHarness({ takeover: true, observed }, async (context) => {
    const approval = approvalDelegate();
    const pending = context.gate.handleApproval(
      approvalRequest('observer-session'),
      approval.next,
    );
    const handle = context.gate.list()[0]?.handle;
    assert.ok(handle !== undefined);
    assert.deepEqual(observed.requested.map((entry) => entry.type), ['approval']);
    assert.equal(observed.requested[0].handle, handle);

    assert.equal(
      context.gate.answer(handle, { kind: 'approval', outcome: 'allowed-once' }),
      true,
    );
    assert.equal(await pending, 'allowed-once');
    assert.deepEqual(observed.settled.map((entry) => entry.outcome), ['granted']);
    assert.equal(observed.settled[0].handle, handle);
    // The observer is called once per window, not once per call site.
    assert.equal(observed.settled.length, 1);
  });
});

test('a rejected approval and a cancelled window settle differently', async () => {
  const observed = observedRecorder();
  await withHarness({ takeover: true, observed }, async (context) => {
    const first = approvalDelegate();
    const pendingReject = context.gate.handleApproval(
      approvalRequest('observer-reject'),
      first.next,
    );
    const rejectHandle = context.gate.list()[0]?.handle as string;
    assert.equal(
      context.gate.answer(rejectHandle, { kind: 'approval', outcome: 'rejected' }),
      true,
    );
    assert.equal(await pendingReject, 'rejected');

    const second = approvalDelegate();
    const pendingCancel = context.gate.handleApproval(
      approvalRequest('observer-cancel'),
      second.next,
    );
    const cancelHandle = context.gate.list()[0]?.handle as string;
    assert.equal(context.gate.cancel(cancelHandle), true);
    assert.equal(await pendingCancel, 'unavailable');

    assert.deepEqual(observed.settled.map((entry) => entry.outcome), [
      'denied',
      'withdrawn',
    ]);
  });
});

test('a window that times out settles as expired', async () => {
  const observed = observedRecorder();
  await withHarness(
    { takeover: true, clarifyTimeout: 10, observed },
    async (context) => {
      const approval = approvalDelegate();
      const value = await context.gate.handleApproval(
        approvalRequest('observer-timeout'),
        approval.next,
      );
      assert.equal(value, 'unavailable');
      assert.equal(approval.calls(), 1);
      assert.deepEqual(observed.settled.map((entry) => entry.outcome), ['expired']);
    },
  );
});
