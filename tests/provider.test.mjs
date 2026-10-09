import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider } from "../.test-build/server/provider.js";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";

const fixture = fileURLToPath(new URL("./fixtures/fx.mjs", import.meta.url));
const capabilities = ["prompt.message", "prompt.image", "prompt.steer", "session.configure", "session.persistence", "session.list", "permission"];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("missing executable rejects startup without crashing the plugin process", { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "paseo-fx-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = createProvider({ command: [join(root, "missing-fx")], logDirectory: join(root, "logs"), requestTimeoutMs: 500, shutdownTimeoutMs: 100 });
  await assert.rejects(provider.connect({ versions: [1], capabilities }), /ENOENT.*diagnostics/);
});

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "paseo-fx-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const control = join(root, "control.json");
  await writeFile(control, JSON.stringify({}));
  const provider = createProvider({ command: [process.execPath, fixture, root], logDirectory: join(root, "logs"), requestTimeoutMs: 1000, modelsTimeoutMs: 500, shutdownTimeoutMs: 100, ...options });
  const connection = await provider.connect({ versions: [1], capabilities });
  const events = [];
  connection.onEvent(event => events.push(event));
  t.after(async () => { await connection.close(); await rm(root, { recursive: true, force: true }); });
  const wait = async predicate => {
    for (let i = 0; i < 500; i++) { const event = events.find(predicate); if (event) return event; await delay(10); }
    throw new Error(`missing event; received ${JSON.stringify(events)}`);
  };
  const sendRequest = async input => {
    const start = events.length;
    await connection.send(input);
    for (let i = 0; i < 500; i++) {
      const event = events.slice(start).find(event => event.requestId === input.requestId && ["catalog", "sessions", "session.ready", "request.completed", "request.failed"].includes(event.type));
      if (event) return event;
      await delay(10);
    }
    throw new Error(`request timed out: ${JSON.stringify(input)}`);
  };
  const open = (id = "session", extra = {}) => sendRequest({ type: "session.open", requestId: `open-${id}`, sessionId: id, config: { cwd: workspace, env: { FIXTURE_TOKEN: "workspace-env" }, mcpServers: {}, settings: {}, persist: true, ...extra }, history: "skip" });
  return { root, workspace, control, connection, events, wait, sendRequest, open };
}

test("session processes and model discovery use the selected workspace and environment", { timeout: 10000 }, async t => {
  const s = await setup(t);
  await writeFile(s.control, JSON.stringify({ workspaces: { [s.workspace]: { defaultModel: "workspace-model", models: ["workspace-model"] } } }));
  assert.equal((await s.open()).type, "session.ready");
  const config = s.events.find(event => event.type === "session.config").config;
  assert.equal(config.model, "workspace-model");
  assert.deepEqual(config.models.map(model => model.id), ["workspace-model"]);
  assert.equal(config.settings.find(setting => setting.id === "provider").value, "fixture");
  const processes = (await readFile(join(s.root, "processes.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(processes.filter(p => p.token === "workspace-env").every(p => p.cwd === s.workspace));
  assert.ok(processes.some(p => p.command === "models" && p.cwd === s.workspace && p.token === "workspace-env"));
});

test("permissions use a session setting without a duplicate main mode selector", { timeout: 10000 }, async t => {
  const s = await setup(t);
  const catalog = await s.sendRequest({ type: "catalog", requestId: "catalog", cwd: s.workspace });
  assert.deepEqual(catalog.catalog.modes, []);
  assert.equal(catalog.catalog.defaultMode, undefined);
  await s.open();
  const config = () => s.events.filter(event => event.type === "session.config").at(-1).config;
  assert.deepEqual(config().modes, []);
  assert.equal(config().mode, undefined);
  const permission = () => config().settings.find(setting => setting.id === "mode");
  assert.equal(permission().label, "Permission mode");
  assert.deepEqual(permission().options.map(option => option.label), ["Ask", "Code"]);
  assert.equal(permission().value, "code");
  for (const value of ["ask", "code"]) {
    const result = await s.sendRequest({ type: "session.configure", requestId: `permission-${value}`, sessionId: "session", changes: { settings: { mode: value } } });
    assert.equal(result.type, "request.completed");
    assert.equal(permission().value, value);
    assert.deepEqual(config().modes, []);
    assert.equal(config().mode, undefined);
  }
});

test("deleted workspace discovery fails independently while valid sessions keep working", { timeout: 10000 }, async t => {
  const s = await setup(t);
  const missing = join(s.root, "deleted-worktree");
  const results = await Promise.all([
    s.sendRequest({ type: "catalog", requestId: "missing-catalog", cwd: missing }),
    s.sendRequest({ type: "sessions", requestId: "missing-sessions", cwd: missing }),
    s.open("valid"),
  ]);
  assert.equal(results[0].type, "request.failed");
  assert.equal(results[1].type, "request.failed");
  assert.match(results[0].error.message, /Cannot access fx workspace.*deleted-worktree/);
  assert.equal(results[2].type, "session.ready");
  assert.equal((await s.open("missing", { cwd: missing })).type, "request.failed");
  assert.equal((await s.open("another-valid")).type, "session.ready");
});

test("loaded sessions and rolled back transactions preserve the actual model", { timeout: 10000 }, async t => {
  const s = await setup(t);
  assert.equal((await s.sendRequest({ type: "session.open", requestId: "load", sessionId: "session", config: { cwd: s.workspace, env: {}, mcpServers: {}, settings: {}, persist: true }, history: "replay", persistence: { version: 1, data: { sessionId: "native-session" } } })).type, "session.ready");
  assert.equal(s.events.filter(event => event.type === "session.config").at(-1).config.model, "restored-C");
  assert.equal((await s.sendRequest({ type: "session.configure", requestId: "change", sessionId: "session", changes: { model: "model-B", mode: "bad" } })).type, "request.failed");
  await s.sendRequest({ type: "session.configure", requestId: "refresh", sessionId: "session", changes: {} });
  assert.equal(s.events.filter(event => event.type === "session.config").at(-1).config.model, "restored-C");
});

test("catalog refresh and provider changes refresh model IDs", { timeout: 10000 }, async t => {
  const s = await setup(t);
  const first = await s.sendRequest({ type: "catalog", requestId: "catalog-1", cwd: s.workspace });
  assert.equal(first.catalog.defaultModel, "model-A");
  await writeFile(s.control, JSON.stringify({ workspaces: { [s.workspace]: { defaultModel: "new-model", models: ["new-model"] } } }));
  const second = await s.sendRequest({ type: "catalog", requestId: "catalog-2", cwd: s.workspace });
  assert.deepEqual(second.catalog.models.map(model => model.id), ["new-model"]);
  await s.open();
  await s.sendRequest({ type: "session.configure", requestId: "provider", sessionId: "session", changes: { settings: { provider: "alternate" } } });
  const config = s.events.filter(event => event.type === "session.config").at(-1).config;
  assert.equal(config.model, "alternate-model");
  assert.deepEqual(config.models.map(model => model.id), ["alternate-model"]);
});

test("stream bursts are merged without losing text or tool/turn ordering", { timeout: 10000 }, async t => {
  const s = await setup(t);
  await s.open();
  await s.connection.send({ type: "session.prompt", sessionId: "session", prompt: { clientMessageId: "storm", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "storm" }] } } });
  await s.wait(event => event.type === "session.turn" && event.state === "completed");
  const text = s.events.filter(event => event.type === "timeline.item" && event.item.type === "assistant_message");
  assert.equal(text.at(-1).item.text, "x".repeat(10000));
  assert.ok(text.length < 100, `too many updates: ${text.length}`);
  assert.ok(text.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0) < 1000000);
  const finalText = s.events.lastIndexOf(text.at(-1));
  const completedTool = s.events.findIndex(event => event.type === "timeline.item" && event.item.type === "tool_call" && event.item.status === "completed");
  const completedTurn = s.events.findIndex(event => event.type === "session.turn" && event.state === "completed");
  assert.ok(finalText < completedTool && completedTool < completedTurn);
});

test("control RPC timeout fails a session and releases its process", { timeout: 10000 }, async t => {
  const s = await setup(t, { requestTimeoutMs: 150 });
  await s.open();
  const result = await s.sendRequest({ type: "session.configure", requestId: "hang", sessionId: "session", changes: { model: "hang" } });
  assert.equal(result.type, "request.failed");
  await s.wait(event => event.type === "session.runtime_failed");
  const logs = await readdir(join(s.root, "logs"));
  const diagnostics = (await Promise.all(logs.map(name => readFile(join(s.root, "logs", name), "utf8")))).join("\n");
  assert.match(diagnostics, /session\/set_config_option timed out/);
});

test("close aborts unresponsive requests before waiting for SDK shutdown", { timeout: 10000 }, async t => {
  const s = await setup(t, { requestTimeoutMs: 60000 });
  await s.open();
  await s.connection.send({ type: "session.configure", requestId: "hang", sessionId: "session", changes: { model: "hang" } });
  await delay(100);
  const start = Date.now();
  await s.connection.close();
  assert.ok(Date.now() - start < 1500);
});

test("model lookup timeout does not leave a session open", { timeout: 10000 }, async t => {
  const s = await setup(t, { modelsTimeoutMs: 150 });
  await writeFile(s.control, JSON.stringify({ modelsHang: true }));
  assert.equal((await s.open()).type, "request.failed");
  const start = Date.now();
  await s.connection.close();
  assert.ok(Date.now() - start < 1500);
});

test("runtime errors retain stderr diagnostics", { timeout: 10000 }, async t => {
  const s = await setup(t);
  await s.open();
  await s.connection.send({ type: "session.prompt", sessionId: "session", prompt: { clientMessageId: "crash", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "crash" }] } } });
  await s.wait(event => event.type === "session.runtime_failed");
  const logs = await readdir(join(s.root, "logs"));
  const diagnostics = (await Promise.all(logs.map(name => readFile(join(s.root, "logs", name), "utf8")))).join("\n");
  assert.match(diagnostics, /fixture runtime exploded/);
});

test("parallel sessions keep their workspaces and model states isolated", { timeout: 10000 }, async t => {
  const s = await setup(t);
  const other = join(s.root, "other-workspace");
  await mkdir(other);
  await writeFile(s.control, JSON.stringify({ workspaces: {
    [s.workspace]: { defaultModel: "workspace-A", models: ["workspace-A"] },
    [other]: { defaultModel: "workspace-B", models: ["workspace-B"] },
  } }));
  const results = await Promise.all([s.open("A"), s.open("B", { cwd: other, env: { FIXTURE_TOKEN: "other-env" } })]);
  assert.ok(results.every(event => event.type === "session.ready"));
  for (const [id, model] of [["A", "workspace-A"], ["B", "workspace-B"]]) {
    assert.equal(s.events.find(event => event.type === "session.config" && event.sessionId === id).config.model, model);
  }
  const processes = (await readFile(join(s.root, "processes.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(processes.some(p => p.cwd === other && p.token === "other-env"));
});

test("shutdown escalates to SIGKILL when fx ignores SIGTERM", { timeout: 10000 }, async t => {
  const s = await setup(t);
  await writeFile(s.control, JSON.stringify({ ignoreTerm: true }));
  await s.open();
  const start = Date.now();
  await s.connection.close();
  assert.ok(Date.now() - start < 1500);
  const logs = await readdir(join(s.root, "logs"));
  const diagnostics = (await Promise.all(logs.map(name => readFile(join(s.root, "logs", name), "utf8")))).join("\n");
  assert.match(diagnostics, /signal=SIGKILL/);
});

test("closing cancels a pending model query without waiting for its deadline", { timeout: 10000 }, async t => {
  const s = await setup(t, { modelsTimeoutMs: 60000, requestTimeoutMs: 60000 });
  await writeFile(s.control, JSON.stringify({ modelsHang: true }));
  await s.connection.send({ type: "session.open", requestId: "opening", sessionId: "session", config: { cwd: s.workspace, env: {}, mcpServers: {}, settings: {}, persist: true }, history: "skip" });
  for (let i = 0; i < 100; i++) {
    const processes = await readFile(join(s.root, "processes.jsonl"), "utf8");
    if (processes.includes('"command":"models"')) break;
    await delay(10);
  }
  const start = Date.now();
  await s.connection.close();
  assert.ok(Date.now() - start < 1500);
});

test("diagnostic output is capped and retains the final stderr tail", { timeout: 10000 }, async t => {
  const s = await setup(t);
  await s.open();
  await s.connection.send({ type: "session.prompt", sessionId: "session", prompt: { clientMessageId: "log-flood", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "log-flood" }] } } });
  await s.wait(event => event.type === "session.turn" && event.state === "completed");
  await s.connection.close();
  const logs = await readdir(join(s.root, "logs"));
  const data = await Promise.all(logs.map(name => readFile(join(s.root, "logs", name))));
  assert.ok(data.every(bytes => bytes.length < 300 * 1024));
  assert.ok(data.some(bytes => bytes.toString().includes("terminal stderr marker")));
});

test("UTF-8 characters split across stdout buffers remain intact", { timeout: 10000 }, async t => {
  const s = await setup(t);
  await s.open();
  await s.connection.send({ type: "session.prompt", sessionId: "session", prompt: { clientMessageId: "utf8", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "utf8" }] } } });
  await s.wait(event => event.type === "session.turn" && event.state === "completed");
  assert.equal(s.events.find(event => event.type === "timeline.item" && event.item.type === "assistant_message").item.text, "你好，fx 🐈");
});

test("permission requests flush preceding text and remain answerable", { timeout: 10000 }, async t => {
  const s = await setup(t);
  await s.open();
  await s.connection.send({ type: "session.prompt", sessionId: "session", prompt: { clientMessageId: "permission", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "permission" }] } } });
  const permission = await s.wait(event => event.type === "session.permission");
  const textIndex = s.events.findIndex(event => event.type === "timeline.item" && event.item.type === "assistant_message");
  assert.ok(textIndex >= 0 && textIndex < s.events.indexOf(permission));
  await s.connection.send({ type: "session.permission", sessionId: "session", permissionId: permission.request.id, response: { behavior: "allow", selectedActionId: "allow" } });
  await s.wait(event => event.type === "session.turn" && event.state === "completed");
  assert.ok(s.events.some(event => event.type === "session.permission_resolved"));
});

for (const [prompt, response, expected] of [
  ["permission", { behavior: "deny", selectedActionId: "deny" }, { outcome: "selected", optionId: "deny" }],
  ["permission-no-deny", { behavior: "deny" }, { outcome: "cancelled" }],
]) {
  test(`denying ${prompt} reaches fx and leaves the session usable`, { timeout: 10000 }, async t => {
    const s = await setup(t);
    await s.open();
    await s.connection.send({ type: "session.prompt", sessionId: "session", prompt: { clientMessageId: "denied", delivery: "auto", input: { type: "message", content: [{ type: "text", text: prompt }] } } });
    const permission = await s.wait(event => event.type === "session.permission");
    await s.connection.send({ type: "session.permission", sessionId: "session", permissionId: permission.request.id, response });
    await s.wait(event => event.type === "session.turn" && event.turnId === "acp:denied" && event.state === "completed");
    const requests = (await readFile(join(s.root, "requests.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(requests.find(request => request.permissionOutcome)?.permissionOutcome, expected);
    assert.ok(s.events.some(event => event.type === "session.permission_resolved"));
    assert.ok(s.events.some(event => event.type === "timeline.item" && event.item.text === "after permission response"));
    await s.connection.send({ type: "session.prompt", sessionId: "session", prompt: { clientMessageId: "next", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "next" }] } } });
    await s.wait(event => event.type === "session.turn" && event.turnId === "acp:next" && event.state === "completed");
    assert.ok(!s.events.some(event => event.type === "session.runtime_failed"));
  });
}

test("session close completes its request and allows reopening the same session", { timeout: 10000 }, async t => {
  const s = await setup(t);
  await s.open();
  const result = await s.sendRequest({ type: "session.close", requestId: "close", sessionId: "session" });
  assert.equal(result.type, "request.completed");
  const closed = s.events.findIndex(event => event.type === "session.closed");
  assert.ok(closed >= 0 && closed < s.events.indexOf(result));
  assert.equal((await s.open()).type, "session.ready");
});

for (const content of [
  [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
  [{ type: "text", text: "inspect this" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
]) {
  test(`steering preserves ${content.length === 1 ? "image-only" : "mixed text and image"} prompts`, { timeout: 10000 }, async t => {
    const s = await setup(t);
    await s.open();
    await s.connection.send({ type: "session.prompt", sessionId: "session", prompt: { clientMessageId: "active", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "wait" }] } } });
    await s.wait(event => event.type === "session.turn" && event.state === "started");
    await s.connection.send({ type: "session.prompt", sessionId: "session", prompt: { clientMessageId: "image", delivery: "steer", input: { type: "message", content } } });
    const result = await s.wait(event => event.type === "session.prompt_result" && event.clientMessageId === "image");
    assert.equal(result.result.type, "steer");
    assert.equal(result.result.turnId, "acp:active");
    const requests = (await readFile(join(s.root, "requests.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(requests.find(request => request.steer).prompt, content);
    assert.ok(!s.events.some(event => event.type === "session.turn" && event.state !== "started"));
    await s.sendRequest({ type: "session.interrupt", requestId: "interrupt", sessionId: "session" });
    await s.wait(event => event.type === "session.turn" && event.turnId === "acp:active" && event.state === "canceled");
  });
}

test("steer admission forwards a steering prompt without touching the active turn", { timeout: 10000 }, async t => {
  const s = await setup(t);
  assert.ok(s.connection.capabilities.includes("prompt.steer"));
  await s.open();
  assert.ok(s.events.find(event => event.type === "session.opened").capabilities.includes("prompt.steer"));
  await s.connection.send({ type: "session.prompt", sessionId: "session", prompt: { clientMessageId: "active", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "permission" }] } } });
  const permission = await s.wait(event => event.type === "session.permission");
  const next = { type: "session.prompt", sessionId: "session", prompt: { clientMessageId: "replacement", delivery: "steer", clearPendingPermissions: true, input: { type: "message", content: [{ type: "text", text: "next" }] } } };
  await s.connection.send(next);
  const result = await s.wait(event => event.type === "session.prompt_result" && event.clientMessageId === "replacement");
  assert.equal(result.result.type, "steer");
  assert.equal(result.result.turnId, "acp:active");
  const requests = (await readFile(join(s.root, "requests.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(requests.filter(request => request.method === "session/prompt").length, 2);
  assert.equal(requests.filter(request => request.method === "session/prompt" && request.steer).length, 1);
  assert.ok(!requests.some(request => request.method === "session/cancel" || request.permissionOutcome));
  assert.ok(!s.events.some(event => event.type === "session.permission_resolved" || event.type === "session.runtime_failed"));
  assert.ok(!s.events.some(event => event.type === "session.turn" && event.state !== "started"));
  const steered = await s.wait(event => event.type === "timeline.item" && event.item.type === "assistant_message" && event.item.text.includes("steered:next"));
  assert.ok(steered);
  // The active turn and its permission remain intact; it can still be denied.
  await s.connection.send({ type: "session.permission", sessionId: "session", permissionId: permission.request.id, response: { behavior: "deny", selectedActionId: "deny" } });
  await s.wait(event => event.type === "session.turn" && event.turnId === "acp:active" && event.state === "completed");
});

for (const prompt of ["failed-tool", "failed-tool-details", "failed-shell", "wait-tool"]) {
  test(`${prompt} produces a failed tool compatible with Paseo history validation`, { timeout: 10000 }, async t => {
    const s = await setup(t);
    await s.open();
    await s.connection.send({ type: "session.prompt", sessionId: "session", prompt: { clientMessageId: prompt, delivery: "auto", input: { type: "message", content: [{ type: "text", text: prompt }] } } });
    if (prompt === "wait-tool") {
      await s.wait(event => event.type === "timeline.item" && event.item.type === "tool_call");
      await s.sendRequest({ type: "session.interrupt", requestId: "interrupt", sessionId: "session" });
    }
    await s.wait(event => event.type === "session.turn" && event.state !== "started");
    const failures = s.events.filter(event => event.type === "timeline.item" && event.item.type === "tool_call" && event.item.status === "failed");
    assert.ok(failures.length > 0);
    for (const { item } of failures) {
      assert.notEqual(item.error, null);
      AgentTimelineItemPayloadSchema.parse(item);
    }
    if (prompt === "failed-tool-details") assert.deepEqual(failures.at(-1).item.error, { message: "Permission denied by user" });
    if (prompt === "failed-shell") {
      assert.match(failures.at(-1).item.error.message, /exited with code 1/);
      assert.match(failures.at(-1).item.error.message, /boom/);
    }
  });
}

test("loaded history repairs null failed-tool errors before reaching Paseo", { timeout: 10000 }, async t => {
  const s = await setup(t);
  await writeFile(s.control, JSON.stringify({ replayFailedTool: true }));
  assert.equal((await s.sendRequest({ type: "session.open", requestId: "load", sessionId: "session", config: { cwd: s.workspace, env: {}, mcpServers: {}, settings: {}, persist: true }, history: "replay", persistence: { version: 1, data: { sessionId: "native-session" } } })).type, "session.ready");
  const event = await s.wait(event => event.type === "timeline.item" && event.item.type === "tool_call" && event.item.status === "failed");
  assert.notEqual(event.item.error, null);
  AgentTimelineItemPayloadSchema.parse(event.item);
  const users = s.events.filter(event => event.type === "timeline.item" && event.item.type === "user_message");
  assert.ok(users.some(event => event.item.text === "saved question"));
  assert.ok(users.some(event => event.item.text === "second question"));
  assert.notEqual(users[0].item.id, users.at(-1).item.id);
});
