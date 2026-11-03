/**
 * Host-side file-access gate tests (`ui.takeoverFiles`).
 *
 * The policy is a pure function (`decideFileAccess`), so the containment cases
 * are direct table tests. The gate itself is driven through the same
 * `tools/pre-execute` listener the host registers: `next()` is a spy standing in
 * for DSH's allow delegate, and a fake Cordis context records the registration
 * and honours its disposer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  FILE_GATE_READ_TOOLS,
  FILE_GATE_WRITE_TOOLS,
  FileGate,
  decideFileAccess,
} from "../src/host/fileGate.js";
import type { FileGateRecord, FileGateVerdict } from "../src/host/fileGate.js";
import { SETTINGS_CONTROLS, isEditableControl } from "../src/shared/selection.js";

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

/** A workspace root that does not have to exist: the gate is lexical only. */
const ROOT = resolve("file-gate-workspace");

function insideWorkspace(...segments: string[]): string {
  return join(ROOT, ...segments);
}

function outsideWorkspace(...segments: string[]): string {
  return resolve(ROOT, "..", "file-gate-outside", ...segments);
}

/** DSH's terminal "allow" delegate, with a call counter. */
function nextSpy(): { next: () => Promise<FileGateVerdict>; calls: () => number } {
  let calls = 0;
  return {
    next: async () => {
      calls += 1;
      return { kind: "allow" };
    },
    calls: () => calls,
  };
}

/** Read the refusal out of an unknown waterfall answer. */
function denialReasonOf(value: unknown): string {
  const record = value as { kind?: unknown; reason?: unknown };
  assert.equal(record.kind, "deny", "the waterfall answer must be a denial");
  assert.equal(typeof record.reason, "string", "a denial must carry a reason");
  return record.reason as string;
}

interface GateHarness {
  gate: FileGate;
  records: FileGateRecord[];
  /** Mutable on purpose: the settings page flips this on the live config object. */
  config: { ui: { takeoverFiles: boolean } };
}

function gateHarness(options: {
  enabled?: boolean;
  unknownRoot?: boolean;
  root?: string;
} = {}): GateHarness {
  const config = { ui: { takeoverFiles: options.enabled ?? true } };
  const records: FileGateRecord[] = [];
  const gate = new FileGate({
    config,
    workspaceRootFor: () =>
      options.unknownRoot === true ? undefined : options.root ?? ROOT,
    record: (record) => {
      records.push(record);
    },
  });
  return { gate, records, config };
}

interface FakeContext {
  listeners: Map<
    string,
    (exec: unknown, next: () => Promise<unknown>) => unknown
  >;
  removed: string[];
  on(
    name: string,
    listener: (exec: unknown, next: () => Promise<unknown>) => unknown,
  ): () => void;
}

function fakeContext(): FakeContext {
  const listeners = new Map<
    string,
    (exec: unknown, next: () => Promise<unknown>) => unknown
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

/* ------------------------------------------------------------------------- *
 * Pure decision
 * ------------------------------------------------------------------------- */

test("the gate names exactly the file tools it knows", () => {
  assert.deepEqual([...FILE_GATE_READ_TOOLS], ["read"]);
  assert.deepEqual([...FILE_GATE_WRITE_TOOLS], ["write", "edit"]);
});

test("a relative file_path inside the workspace is allowed", () => {
  const decision = decideFileAccess({
    tool: "write",
    args: { file_path: join("src", "index.ts") },
    workspaceRoot: ROOT,
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.code, "inside-workspace");
  assert.equal(decision.kind, "write");
});

test("a nested '..' that stays inside the workspace is allowed", () => {
  const decision = decideFileAccess({
    tool: "edit",
    args: { file_path: join("src", "nested", "..", "index.ts") },
    workspaceRoot: ROOT,
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.code, "inside-workspace");
});

test("an absolute path outside the workspace is denied with a readable reason", () => {
  const target = outsideWorkspace("secret.txt");
  const decision = decideFileAccess({
    tool: "write",
    args: { file_path: target },
    workspaceRoot: ROOT,
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.code, "outside-workspace");
  assert.equal(decision.path, target);
  assert.match(decision.reason ?? "", /outside the workspace root/);
  assert.ok((decision.reason ?? "").includes(target), "the reason names the target");
  assert.ok((decision.reason ?? "").includes(ROOT), "the reason names the workspace root");
});

test("a relative path that climbs out with '..' is denied", () => {
  const decision = decideFileAccess({
    tool: "edit",
    args: { file_path: join("..", "..", "etc", "passwd") },
    workspaceRoot: ROOT,
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.code, "outside-workspace");
});

test("a path the gate cannot read is allowed (fail-open)", () => {
  for (const args of [undefined, null, {}, { file_path: "" }, { file_path: 42 }, "not-an-object"]) {
    const decision = decideFileAccess({ tool: "write", args, workspaceRoot: ROOT });
    assert.equal(decision.decision, "allow", `args ${JSON.stringify(args)}`);
    assert.equal(decision.code, "unknown-path");
  }
});

test("an unknown workspace root is allowed even for an absolute target (fail-open)", () => {
  for (const workspaceRoot of [undefined, "", "   "]) {
    const decision = decideFileAccess({
      tool: "write",
      args: { file_path: outsideWorkspace("secret.txt") },
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    });
    assert.equal(decision.decision, "allow", `root ${JSON.stringify(workspaceRoot)}`);
    assert.equal(decision.code, "unknown-workspace");
  }
});

test("a tool the gate does not know is never a file decision", () => {
  const decision = decideFileAccess({
    tool: "bash",
    args: { file_path: outsideWorkspace("secret.txt") },
    workspaceRoot: ROOT,
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.kind, "other");
  assert.equal(decision.code, "not-a-file-tool");
});

/* ------------------------------------------------------------------------- *
 * Listener behaviour
 * ------------------------------------------------------------------------- */

test("a read is recorded and never blocked, even outside the workspace", async () => {
  const harness = gateHarness();
  const next = nextSpy();
  const target = outsideWorkspace("notes.txt");

  const verdict = await harness.gate.handle(
    { name: "read", arguments: { file_path: target } },
    next.next,
  );

  assert.deepEqual(verdict, { kind: "allow" });
  assert.equal(next.calls(), 1);
  assert.deepEqual(harness.records, [
    { kind: "read", tool: "read", path: target },
  ]);
});

test("a write outside the workspace is denied and never reaches next()", async () => {
  const harness = gateHarness();
  const next = nextSpy();
  const target = outsideWorkspace("token.txt");

  const verdict = await harness.gate.handle(
    { name: "write", arguments: { file_path: target } },
    next.next,
  );

  const reason = denialReasonOf(verdict);
  assert.match(reason, /outside the workspace root/);
  assert.ok(reason.includes(target), "the reason names the target");
  assert.equal(next.calls(), 0);
  assert.equal(harness.records.length, 1);
  assert.equal(harness.records[0]?.kind, "deny");
  assert.equal(harness.records[0]?.reason, reason);
});

test("a write and an edit inside the workspace are allowed without a record", async () => {
  const harness = gateHarness();
  const next = nextSpy();

  for (const tool of ["write", "edit"]) {
    const verdict = await harness.gate.handle(
      { name: tool, arguments: { file_path: insideWorkspace("src", "a.ts") } },
      next.next,
    );
    assert.deepEqual(verdict, { kind: "allow" }, tool);
  }

  assert.equal(next.calls(), 2);
  assert.deepEqual(harness.records, [], "allowed writes are not audited");
});

test("a call the gate cannot evaluate is passed through (fail-open)", async () => {
  const harness = gateHarness({ unknownRoot: true });
  const next = nextSpy();

  const withoutPath = await harness.gate.handle({ name: "write", arguments: {} }, next.next);
  assert.deepEqual(withoutPath, { kind: "allow" });
  assert.equal(next.calls(), 1);

  const unknownRoot = await harness.gate.handle(
    { name: "write", arguments: { file_path: outsideWorkspace("secret.txt") } },
    next.next,
  );
  assert.deepEqual(unknownRoot, { kind: "allow" });
  assert.equal(next.calls(), 2);

  const malformed = await harness.gate.handle(undefined, next.next);
  assert.deepEqual(malformed, { kind: "allow" });
  assert.equal(next.calls(), 3);
  assert.deepEqual(harness.records, []);
});

test("the gate is inert while the switch is off", async () => {
  const harness = gateHarness({ enabled: false });
  const next = nextSpy();

  const verdict = await harness.gate.handle(
    { name: "write", arguments: { file_path: outsideWorkspace("secret.txt") } },
    next.next,
  );

  assert.deepEqual(verdict, { kind: "allow" });
  assert.equal(next.calls(), 1);
  assert.deepEqual(harness.records, []);
});

/* ------------------------------------------------------------------------- *
 * Cordis installation
 * ------------------------------------------------------------------------- */

test("install registers nothing while the switch is off", () => {
  const harness = gateHarness({ enabled: false });
  const context = fakeContext();
  const dispose = harness.gate.install(context);

  assert.equal(context.listeners.size, 0, "a disabled gate must not register a listener");
  dispose();
  assert.deepEqual(context.removed, []);
});

test("install registers one tools/pre-execute listener and its disposer removes it", () => {
  const harness = gateHarness();
  const context = fakeContext();
  const dispose = harness.gate.install(context);

  assert.deepEqual([...context.listeners.keys()], ["tools/pre-execute"]);

  dispose();
  assert.deepEqual(context.removed, ["tools/pre-execute"]);
  assert.equal(context.listeners.size, 0);

  dispose();
  assert.equal(context.removed.length, 1, "a second disposal is harmless");
});

test("the registered listener denies through the waterfall", async () => {
  const harness = gateHarness();
  const context = fakeContext();
  const dispose = harness.gate.install(context);
  const listener = context.listeners.get("tools/pre-execute");
  assert.ok(listener !== undefined);
  const next = nextSpy();

  const verdict = await listener(
    {
      name: "edit",
      arguments: { file_path: outsideWorkspace("secret.txt") },
      agent: { id: "session-1" },
    },
    next.next,
  );

  const reason = denialReasonOf(verdict);
  assert.match(reason, /outside the workspace root/);
  assert.equal(next.calls(), 0);
  assert.equal(harness.records[0]?.agent, "session-1");
  dispose();
});

test("a live toggle installs and removes the listener", () => {
  const harness = gateHarness({ enabled: false });
  const context = fakeContext();
  const dispose = harness.gate.install(context);
  assert.equal(context.listeners.size, 0);

  // The settings page writes `ui.takeoverFiles` and then calls `sync()`.
  harness.config.ui.takeoverFiles = true;
  harness.gate.sync();
  assert.equal(context.listeners.size, 1);

  harness.config.ui.takeoverFiles = false;
  harness.gate.sync();
  assert.equal(context.listeners.size, 0);
  assert.deepEqual(context.removed, ["tools/pre-execute"]);

  // `sync()` without an installed context is a no-op, not a crash.
  dispose();
  harness.config.ui.takeoverFiles = true;
  harness.gate.sync();
  assert.equal(context.listeners.size, 0);
});

/* ------------------------------------------------------------------------- *
 * Settings catalog
 * ------------------------------------------------------------------------- */

test("the settings row writes the host config key ui.takeoverFiles", () => {
  const row = SETTINGS_CONTROLS.find((control) => control.id === "setting:ui.takeoverFiles");
  assert.ok(row !== undefined, "the catalog must expose setting:ui.takeoverFiles");
  assert.deepEqual([...row.keys], ["ui.takeoverFiles"]);
  assert.equal(row.group, "ui");
  assert.equal(row.kind, "boolean");
  assert.equal(row.chip, "host", "this is a host config switch");
  assert.equal(row.local, undefined, "not a browser preference");
  assert.equal(row.wired, true);
  assert.equal(isEditableControl(row), true);
});
