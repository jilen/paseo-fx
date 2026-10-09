import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const command = process.argv[3];
const settings = () => JSON.parse(readFileSync(join(root, "control.json"), "utf8"));
const info = () => settings().workspaces?.[process.cwd()] ?? {};
appendFileSync(join(root, "processes.jsonl"), `${JSON.stringify({ pid: process.pid, command, cwd: process.cwd(), provider: process.env.FX_PROVIDER, token: process.env.FIXTURE_TOKEN })}\n`);
if (command === "models") {
  if (settings().modelsHang) setInterval(() => {}, 1000);
  else {
    const ids = process.env.FX_PROVIDER === "alternate" ? ["alternate-model"] : info().models ?? ["model-A", "model-B", "restored-C"];
    console.log(JSON.stringify({ ids: [...ids, ...ids] }));
  }
} else {
  if (settings().ignoreTerm) process.on("SIGTERM", () => {});
  let model = info().defaultModel ?? "model-A";
  let provider = process.env.FX_PROVIDER ?? "fixture";
  let mode = "auto";
  const sessionId = "native-session";
  let permissionPrompt;
  let activePrompt;
  const modes = () => ({ currentModeId: mode, availableModes: [{ id: "auto", name: "Code" }, { id: "ask", name: "Ask" }] });
  const configOptions = () => [
    { id: "provider", name: "Provider", category: "model", type: "select", currentValue: provider, options: ["fixture", "alternate"].map(value => ({ value, name: value })) },
    { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [] },
    { id: "mode", name: "Session mode", category: "mode", type: "select", currentValue: mode, options: [{ value: "ask", name: "Ask" }, { value: "auto", name: "Code" }] },
  ];
  const reply = (id, result) => {
    if (id === activePrompt) activePrompt = undefined;
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
  };
  const notify = update => console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }));
  const handle = line => {
    const { id, method, params, result } = JSON.parse(line);
    appendFileSync(join(root, "requests.jsonl"), `${JSON.stringify({ pid: process.pid, method, value: params?.value, permissionOutcome: result?.outcome, prompt: params?.prompt, steer: params?._meta?.fx?.steer === true })}\n`);
    if (!method && id === "permission-request") {
      if (permissionPrompt !== undefined) {
        notify({ sessionUpdate: "agent_message_chunk", messageId: "after-permission", content: { type: "text", text: "after permission response" } });
        reply(permissionPrompt, { stopReason: "end_turn" });
        permissionPrompt = undefined;
      }
    }
    else if (method === "initialize") reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} }, promptCapabilities: { image: true } } });
    else if (method === "session/new" || method === "session/load") {
      if (settings().openHang) return;
      if (method === "session/load") model = "restored-C";
      if (method === "session/load" && settings().replayFailedTool) {
        notify({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "saved " } });
        notify({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "question" } });
        notify({ sessionUpdate: "tool_call", toolCallId: "replayed-failure", title: "Shell", name: "shell", kind: "execute", status: "failed", rawInput: {}, rawOutput: null });
        notify({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "second question" } });
      }
      reply(id, { sessionId, configOptions: configOptions(), modes: modes() });
    } else if (method === "session/set_config_option") {
      if (params.value === "hang") return;
      if (params.configId === "provider") { provider = params.value; model = provider === "alternate" ? "alternate-model" : "model-A"; }
      else if (params.configId === "mode") mode = params.value;
      else model = params.value;
      notify({ sessionUpdate: "config_option_update", configOptions: configOptions() });
      reply(id, { configOptions: configOptions() });
    } else if (method === "session/set_mode") {
      if (params.modeId === "bad") console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "mode rejected" } }));
      else { mode = params.modeId; notify({ sessionUpdate: "current_mode_update", currentModeId: mode }); reply(id, {}); }
    } else if (method === "session/prompt") {
      const text = params.prompt.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (params._meta?.fx?.steer) {
        notify({ sessionUpdate: "agent_message_chunk", messageId: "steered", content: { type: "text", text: `steered:${text}` } });
        reply(id, { stopReason: "end_turn" });
        return;
      }
      activePrompt = id;
      if (text === "utf8") {
        const data = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "utf8", content: { type: "text", text: "你好，fx 🐈" } } } }) + "\n");
        const split = data.indexOf(Buffer.from("你")) + 1;
        process.stdout.write(data.subarray(0, split));
        setTimeout(() => { process.stdout.write(data.subarray(split)); reply(id, { stopReason: "end_turn" }); }, 10);
        return;
      }
      if (text === "permission" || text === "permission-no-deny") {
        permissionPrompt = id;
        notify({ sessionUpdate: "agent_message_chunk", messageId: "permission-text", content: { type: "text", text: "before approval" } });
        const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }];
        if (text !== "permission-no-deny") options.push({ optionId: "deny", name: "Deny", kind: "reject_once" });
        console.log(JSON.stringify({ jsonrpc: "2.0", id: "permission-request", method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "permission-tool", title: "Read", kind: "read", status: "pending", rawInput: {} }, options } }));
        return;
      }
      if (text === "log-flood") {
        process.stderr.write("z".repeat(1024 * 1024), () => {
          console.error("terminal stderr marker");
          reply(id, { stopReason: "end_turn" });
        });
        return;
      }
      if (text === "crash") { console.error("fixture runtime exploded"); process.exit(7); }
      if (text === "wait") return;
      notify({ sessionUpdate: "agent_thought_chunk", messageId: "thought", content: { type: "text", text: "thinking" } });
      notify({ sessionUpdate: "tool_call", toolCallId: "tool", title: "Read", name: "read_file", kind: "read", status: "in_progress", rawInput: {} });
      if (text === "wait-tool") return;
      if (text === "failed-tool" || text === "failed-tool-details") {
        notify({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "failed", rawOutput: text === "failed-tool" ? null : { message: "Permission denied by user" } });
        reply(id, { stopReason: "end_turn" });
        return;
      }
      if (text === "failed-shell") {
        notify({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "boom\n" } }] });
        notify({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "failed", command_result: { kind: "command", command: "false", cwd: "/tmp", exit_code: 1, signal: null, timed_out: false, duration_ms: 5, truncated: false }, content: [{ type: "content", content: { type: "text", text: '{"session_id":null,"state":"completed"}' } }] });
        reply(id, { stopReason: "end_turn" });
        return;
      }
      const count = text === "storm" ? 10_000 : 2;
      for (let i = 0; i < count; i++) notify({ sessionUpdate: "agent_message_chunk", messageId: "reply", content: { type: "text", text: "x" } });
      notify({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed", rawOutput: "done" });
      reply(id, { stopReason: "end_turn" });
    } else if (method === "session/cancel") {
      if (activePrompt !== undefined) reply(activePrompt, { stopReason: "cancelled" });
      permissionPrompt = undefined;
    } else if (method === "session/list") reply(id, { sessions: [] });
    else if (method === "session/close") reply(id, {});
  };
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", data => {
    pending += data;
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      handle(line);
    }
  });
}
