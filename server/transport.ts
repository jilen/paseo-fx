import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ModelCatalog } from "./models.js";

const activeLogs = new Set<string>();
function pruneLogs(directory: string, keep: number) {
  let names: string[];
  try { names = readdirSync(directory); } catch { return; }
  const files = names.filter(name => /^acp-.*\.log$/.test(name) && !activeLogs.has(join(directory, name)))
    .flatMap(name => {
      try { return [{ name, time: statSync(join(directory, name)).mtimeMs }]; } catch { return []; }
    }).sort((a, b) => b.time - a.time);
  for (const file of files.slice(keep)) {
    try { unlinkSync(join(directory, file.name)); } catch { /* Another connection may have cleaned it. */ }
  }
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface TransportOptions {
  command: readonly [string, ...string[]];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logDirectory: string;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  streamWindowMs: number;
  models: ModelCatalog;
}

export interface FxTransport extends AcpStream {
  readonly diagnosticPath: string;
  readonly failure: Error | undefined;
  toolFailureMessage(toolCallId: string): string | undefined;
  steer(prompt: readonly ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]): Promise<void>;
  close(): Promise<void>;
}

// Discovery, config snapshots and rollback all use fx's authoritative model.
async function normalizeConfig(message: AcpStreamMessage, options: TransportOptions): Promise<AcpStreamMessage> {
  const payload = "result" in message ? message.result : "params" in message && record(message.params)
    ? message.params.update : undefined;
  if (!record(payload) || !Array.isArray(payload.configOptions)) return message;
  const config = payload.configOptions.filter(record);
  const provider = config.find(option => option.id === "provider")?.currentValue;
  const env = typeof provider === "string" ? { ...options.env, FX_PROVIDER: provider } : options.env;
  const ids = await options.models.read(options.cwd, env);
  payload.configOptions = config.map(option => {
    if (option.id === "provider") return { ...option, category: "fx_provider" };
    if (option.id === "mode") {
      // fx uses "auto" for its Code permission mode; Paseo exposes it as "code".
      const rawOptions = Array.isArray(option.options) ? option.options : [];
      const mappedOptions = rawOptions.map((opt: RecordValue) => opt?.value === "auto" ? { ...opt, value: "code" } : opt);
      const currentValue = option.currentValue === "auto" ? "code" : option.currentValue;
      return { ...option, name: "Permission mode", category: "fx_permission", options: mappedOptions, currentValue };
    }
    if (option.id !== "model") return option;
    const values = new Set(ids);
    if (typeof option.currentValue === "string") values.add(option.currentValue);
    return { ...option, category: "model", options: [...values].map(value => ({ value, name: value })) };
  });
  return message;
}

export function createFxTransport(options: TransportOptions): FxTransport {
  mkdirSync(options.logDirectory, { recursive: true, mode: 0o700 });
  pruneLogs(options.logDirectory, 20);
  const logPath = join(options.logDirectory, `acp-${Date.now()}-${randomUUID()}.log`);
  activeLogs.add(logPath);
  let logBytes = 0;
  const log = (message: string) => {
    const remaining = 256 * 1024 - logBytes;
    if (remaining <= 0) return;
    const line = Buffer.from(`${new Date().toISOString()} ${message}\n`);
    const data = line.subarray(0, remaining);
    try { appendFileSync(logPath, data, { mode: 0o600 }); } catch { return; }
    logBytes += data.length;
  };
  const [executable, ...args] = options.command;
  const child = spawn(executable, [...args, "acp"], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
  // fx reports command failures (non-zero exit, timeout, ...) through
  // tool_call_update.command_result plus prior content chunks; rawOutput is
  // null, so the ACP adapter maps them to a null error. Remember the details
  // here so the provider can surface a real message instead of a placeholder.
  const toolCalls = new Map<string, { name?: string; commandResult?: RecordValue; content: string }>();
  const trackToolUpdate = (message: AcpStreamMessage) => {
    if (!("method" in message) || message.method !== "session/update" || !record(message.params)) return;
    const update = message.params.update;
    if (!record(update) || (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") || typeof update.toolCallId !== "string") return;
    const entry = toolCalls.get(update.toolCallId) ?? { content: "" };
    if (typeof update.name === "string") entry.name = update.name;
    if (record(update.command_result)) entry.commandResult = update.command_result;
    if (Array.isArray(update.content)) {
      for (const block of update.content) {
        if (!record(block) || block.type !== "content" || !record(block.content)
          || block.content.type !== "text" || typeof block.content.text !== "string") continue;
        const text = block.content.text;
        // The terminal update embeds fx's replay metadata JSON, not process
        // output; stdout/stderr already streamed through earlier chunks.
        if (text.startsWith('{"session_id"')) continue;
        entry.content += text;
      }
      if (entry.content.length > 8192) entry.content = entry.content.slice(-8192);
    }
    toolCalls.set(update.toolCallId, entry);
  };
  const toolFailureMessage = (toolCallId: string): string | undefined => {
    const entry = toolCalls.get(toolCallId);
    if (!entry) return undefined;
    const name = entry.name ?? "tool";
    const result = entry.commandResult;
    let summary: string | undefined;
    if (result) {
      if (result.timed_out === true) summary = "timed out";
      else if (typeof result.signal === "string" && result.signal.length > 0) summary = `terminated by signal ${result.signal}`;
      else if (typeof result.exit_code === "number") summary = `exited with code ${result.exit_code}`;
    }
    const output = entry.content.trim();
    if (summary && output) return `${name} ${summary}:\n${output.length > 2000 ? `...${output.slice(-2000)}` : output}`;
    if (summary) return `${name} ${summary}`;
    return output || undefined;
  };
  log(`started pid=${child.pid ?? "pending"} cwd=${options.cwd}`);
  const pending = new Map<string | number | null, ReturnType<typeof setTimeout>>();
  const steerRequests = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let steerSequence = 0;
  let peerSessionId: string | undefined;
  let loading: { requestId: string | number | null; sessionId: string; updates: AcpStreamMessage[]; bytes: number } | undefined;
  let stopped = false;
  let failure: Error | undefined;
  let closePromise: Promise<void> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let buffered: AcpStreamMessage | undefined;
  let bufferedBytes = 0;
  let stderrTail = "";
  const exited = new Promise<void>(resolve => child.once("close", (code, signal) => {
    log(`exited code=${code} signal=${signal}`);
    if (logBytes >= 256 * 1024 && stderrTail) {
      try { appendFileSync(logPath, `\n[log limit reached; last stderr]\n${stderrTail}\n`); } catch { /* Logging must not crash the provider. */ }
    }
    activeLogs.delete(logPath);
    pruneLogs(options.logDirectory, 20);
    resolve();
  }));
  const clearRequests = () => {
    for (const timer of pending.values()) clearTimeout(timer); pending.clear();
    for (const { reject, timer } of steerRequests.values()) { clearTimeout(timer); reject(new Error("fx ACP transport closed")); }
    steerRequests.clear();
  };
  const fail = (reason: Error) => {
    if (stopped || failure) return;
    failure = new Error(`${reason.message}; diagnostics: ${logPath}`, { cause: reason });
    log(`failure: ${reason.message}`);
    child.stdout.destroy(failure);
    void close();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  // Spawn can fail before the SDK starts reading. Keep pipe errors handled
  // throughout startup; the reader still receives the stored failure.
  child.stdout.on("error", fail);
  child.stderr.on("error", fail);
  child.stderr.on("data", chunk => {
    stderrTail = (stderrTail + String(chunk)).slice(-8192);
    log(`stderr: ${String(chunk)}`);
  });
  async function close() {
    if (closePromise) return closePromise;
    stopped = true;
    log("closing transport");
    clearRequests();
    loading = undefined;
    if (flushTimer) clearTimeout(flushTimer);
    closePromise = (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited, new Promise<void>(resolve => {
        timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, options.shutdownTimeoutMs);
      })]).finally(() => clearTimeout(timer));
      // Release readers even if a descendant inherited stdout/stderr, then
      // reap the killed child before callers remove its diagnostic directory.
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, options.shutdownTimeoutMs); })])
        .finally(() => clearTimeout(timer));
    })();
    return closePromise;
  }
  async function* messages(): AsyncGenerator<AcpStreamMessage> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let parts: Buffer[] = [];
    let pendingBytes = 0;
    try {
      for await (const bytes of child.stdout) {
        const buffer = Buffer.from(bytes);
        let offset = 0;
        while (offset < buffer.length) {
          const newline = buffer.indexOf(10, offset);
          const part = buffer.subarray(offset, newline === -1 ? buffer.length : newline);
          pendingBytes += part.length;
          if (pendingBytes > 64 * 1024 * 1024) throw new Error("fx ACP message exceeds 64 MiB");
          parts.push(part);
          if (newline === -1) break;
          const line = decoder.decode(parts.length === 1 ? part : Buffer.concat(parts, pendingBytes));
          parts = []; pendingBytes = 0; offset = newline + 1;
          if (!line.trim()) continue;
          const parsed: unknown = JSON.parse(line);
          if (!record(parsed) || parsed.jsonrpc !== "2.0") throw new Error("fx ACP sent an invalid JSON-RPC message");
          trackToolUpdate(parsed as AcpStreamMessage);
          if ("id" in parsed && !("method" in parsed) && typeof parsed.id === "string" && steerRequests.has(parsed.id)) {
            // Swallow raw steer responses so the ACP adapter never sees a
            // request it did not issue.
            const pendingSteer = steerRequests.get(parsed.id)!;
            steerRequests.delete(parsed.id);
            clearTimeout(pendingSteer.timer);
            if ("error" in parsed && parsed.error) {
              const errorPayload = parsed.error as { message?: unknown };
              pendingSteer.reject(new Error(typeof errorPayload.message === "string" ? errorPayload.message : "fx rejected the steering prompt"));
            } else pendingSteer.resolve();
            continue;
          }
          const message = parsed as AcpStreamMessage;
          // fx replays history before session/load resolves. The ACP adapter
          // sets its native session ID only after that response and otherwise
          // silently discards the replay. Deliver it once the session is bound.
          if (loading && "method" in message && message.method === "session/update"
            && record(message.params) && message.params.sessionId === loading.sessionId) {
            loading.bytes += Buffer.byteLength(line);
            if (loading.bytes > 64 * 1024 * 1024) throw new Error("fx ACP history replay exceeds 64 MiB");
            loading.updates.push(message);
            continue;
          }
          let replay: AcpStreamMessage[] = [];
          if ("id" in message && !("method" in message)) {
            clearTimeout(pending.get(message.id)); pending.delete(message.id);
            if ("error" in message) log(`rpc error ${message.error.code}: ${message.error.message}`);
            if (loading?.requestId === message.id) {
              log(`session/load replay: ${loading.updates.length} updates`);
              if ("result" in message) replay = loading.updates;
              loading = undefined;
            }
          }
          yield await normalizeConfig(message, options);
          // Let the adapter bind the load response before replay notifications.
          if (replay.length) await new Promise<void>(resolve => setTimeout(resolve, 0));
          let userSequence = 0;
          let userMessage: { id: string; text: string } | undefined;
          for (const message of replay) {
            yield await normalizeConfig(message, options);
            const update = "params" in message && record(message.params) ? message.params.update : undefined;
            if (record(update) && update.sessionUpdate === "user_message_chunk"
              && record(update.content) && update.content.type === "text" && typeof update.content.text === "string") {
              const id = typeof update.messageId === "string" ? update.messageId : userMessage?.id ?? `fx-replay-user:${++userSequence}`;
              userMessage = { id, text: (userMessage?.id === id ? userMessage.text : "") + update.content.text };
              yield { jsonrpc: "2.0", method: "paseo-fx/replay_user_message", params: userMessage } as AcpStreamMessage;
            } else userMessage = undefined;
          }
        }
      }
      if (!stopped && pendingBytes) throw new Error("fx ACP ended with an incomplete message");
      if (failure) throw failure;
    } catch (error) {
      if (!stopped) fail(error instanceof Error ? error : new Error(String(error)));
      if (failure) throw failure;
      if (!stopped) throw error;
    } finally { clearRequests(); }
  }
  const iterator = messages();
  const source = new ReadableStream<AcpStreamMessage>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await close(); await iterator.return(undefined); },
  });
  const chunk = (message: AcpStreamMessage) => {
    if (!("method" in message) || message.method !== "session/update" || "id" in message || !record(message.params)) return;
    const update = message.params.update;
    if (!record(update) || !["agent_message_chunk", "agent_thought_chunk"].includes(String(update.sessionUpdate)) || !record(update.content) || update.content.type !== "text" || typeof update.content.text !== "string") return;
    return { params: message.params, update, content: update.content, text: update.content.text };
  };
  const readable = source.pipeThrough(new TransformStream<AcpStreamMessage, AcpStreamMessage>({
    transform(message, controller) {
      const flush = () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = undefined;
        if (buffered) controller.enqueue(buffered);
        buffered = undefined; bufferedBytes = 0;
      };
      const next = chunk(message), current = buffered && chunk(buffered);
      if (!next) { flush(); controller.enqueue(message); return; }
      if (current && (current.params.sessionId !== next.params.sessionId || current.update.messageId !== next.update.messageId || current.update.sessionUpdate !== next.update.sessionUpdate)) flush();
      if (buffered && chunk(buffered)) {
        const content = chunk(buffered)!.content;
        content.text = String(content.text) + next.text;
      } else buffered = message;
      bufferedBytes += Buffer.byteLength(next.text);
      if (bufferedBytes >= 64 * 1024) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, options.streamWindowMs);
    },
    flush(controller) {
      if (flushTimer) clearTimeout(flushTimer);
      if (buffered) controller.enqueue(buffered);
      buffered = undefined;
    },
  }));
  const steer: FxTransport["steer"] = (prompt) => {
    if (stopped) throw failure ?? new Error("fx ACP transport is closed");
    if (!peerSessionId) throw new Error("fx ACP session is not bound");
    const id = `paseo-fx-steer:${++steerSequence}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Keep the id registered so a late response is still swallowed.
        reject(new Error(`fx ACP steering prompt timed out after ${options.requestTimeoutMs}ms`));
      }, options.requestTimeoutMs);
      steerRequests.set(id, { resolve, reject, timer });
      log(`request: session/prompt (steer)`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: peerSessionId, prompt, _meta: { fx: { steer: true } } } })}\n`, error => {
        if (error) { clearTimeout(timer); steerRequests.delete(id); reject(error); }
      });
    });
  };
  return {
    diagnosticPath: logPath,
    get failure() { return failure; },
    toolFailureMessage,
    steer,
    readable,
    writable: new WritableStream<AcpStreamMessage>({
      write(message) {
        if (stopped) throw failure ?? new Error("fx ACP transport is closed");
        if ("method" in message && "id" in message) log(`request: ${message.method}`);
        if ("method" in message && record(message.params) && typeof message.params.sessionId === "string"
          && (message.method === "session/prompt" || message.method === "session/cancel" || message.method === "session/load" || message.method === "session/close")) {
          peerSessionId = message.params.sessionId;
        }
        if ("method" in message && "id" in message && message.method === "session/load"
          && record(message.params) && typeof message.params.sessionId === "string") {
          loading = { requestId: message.id, sessionId: message.params.sessionId, updates: [], bytes: 0 };
        }
        if ("method" in message && "id" in message && message.method !== "session/prompt") {
          const method = (message as { method: string }).method;
          pending.set(message.id, setTimeout(() => fail(new Error(`fx ACP ${method} timed out after ${options.requestTimeoutMs}ms`)), options.requestTimeoutMs));
        }
        // Paseo exposes fx's "auto" mode as "code"; translate back for fx.
        if ("method" in message && message.method === "session/set_config_option" && record(message.params)
          && message.params.configId === "mode" && message.params.value === "code") {
          message = { ...message, params: { ...message.params, value: "auto" } } as AcpStreamMessage;
        }
        return new Promise<void>((resolve, reject) => {
          child.stdin.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve());
        });
      },
      close, abort: close,
    }),
    close,
  };
}
