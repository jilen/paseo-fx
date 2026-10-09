import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { ProviderInputSchema, requireProviderCapabilities, type ProviderRegistration, type ProviderConnection, type ProviderEvent, type ProviderInput } from "@getpaseo/plugin/server/provider";
import { ModelCatalog } from "./models.js";
import { createFxTransport, type FxTransport } from "./transport.js";

export interface FxProviderOptions {
  command?: readonly [string, ...string[]];
  logDirectory?: string;
  requestTimeoutMs?: number;
  modelsTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  streamWindowMs?: number;
}

export function createProvider(options: FxProviderOptions = {}): ProviderRegistration {
  const command = options.command ?? ["fx"];
  const logDirectory = options.logDirectory ?? join(homedir(), ".paseo", "plugin-logs", "paseo-fx");
  return {
    id: "fx", label: "fx", description: "fx coding agent", icon: "icon.svg",
    async connect(request) {
      const abort = new AbortController();
      const models = new ModelCatalog(command, options.modelsTimeoutMs ?? 10_000, abort.signal);
      const transports = new Set<FxTransport>();
      const channels = new Set<ProviderConnection>();
      const sessions = new Map<string, ProviderConnection>();
      const activeTurns = new Map<string, string>();
      const opening = new Set<string>();
      const requests = new Map<ProviderConnection, Set<string>>();
      const diagnostics = new Map<ProviderConnection, () => FxTransport | undefined>();
      const operations = new Set<Promise<void>>();
      const listeners = new Set<(event: ProviderEvent) => void>();
      // Steering is handled by this provider outside the ACP adapter.
      const admissionCapabilities = (values: readonly string[]) =>
        request.capabilities.includes("prompt.steer") && !values.includes("prompt.steer")
          ? [...values, "prompt.steer"] : values;
      let closed = false;
      let closePromise: Promise<void> | undefined;
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      const createChannel = async (cwd: string, env: Readonly<Record<string, string>> = {}) => {
        const directory = await stat(cwd).catch(error => {
          throw new Error(`Cannot access fx workspace ${cwd}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        });
        if (!directory.isDirectory()) throw new Error(`fx workspace is not a directory: ${cwd}`);
        const effectiveEnv = { ...process.env, ...env };
        let latestTransport: FxTransport | undefined;
        const adapter = runAcpProvider({
          id: "fx", label: "fx",
          acpOptions: { startupTimeoutMs: options.requestTimeoutMs ?? 15_000 },
          // The SDK ignores standard user_message_chunk updates. Preserve
          // replayed prompts through a private notification from our transport.
          transformers: [{ notification: notification => {
            if (notification.method !== "paseo-fx/replay_user_message") return null;
            const params = notification.params;
            if (!params || typeof params !== "object" || Array.isArray(params)
              || typeof params.id !== "string" || typeof params.text !== "string") return null;
            return { type: "timeline", item: { type: "user_message", id: params.id, text: params.text } };
          } }],
          connector: () => {
            if (closed) throw new Error("fx provider connection is closed");
            const transport = createFxTransport({
              command, cwd, env: effectiveEnv, logDirectory, models,
              requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
              shutdownTimeoutMs: options.shutdownTimeoutMs ?? 1_000,
              streamWindowMs: options.streamWindowMs ?? 50,
            });
            transports.add(transport);
            latestTransport = transport;
            const writer = transport.writable.getWriter();
            return {
              readable: transport.readable,
              writable: new WritableStream({
                write: message => writer.write(message),
                async close() { try { await writer.close(); } finally { transports.delete(transport); } },
                async abort(reason) { try { await writer.abort(reason); } finally { transports.delete(transport); } },
              }),
            };
          },
        });
        let channel: ProviderConnection;
        try { channel = await adapter.connect(request); }
        catch (error) {
          await latestTransport?.close();
          if (latestTransport) transports.delete(latestTransport);
          const message = latestTransport?.failure?.message ?? (error instanceof Error ? error.message : String(error));
          throw new Error(`${message}; diagnostics: ${latestTransport?.diagnosticPath ?? logDirectory}`, { cause: error });
        }
        channels.add(channel);
        requests.set(channel, new Set());
        diagnostics.set(channel, () => latestTransport);
        if (closed) { await channel.close(); throw new Error("fx provider connection is closed"); }
        return channel;
      };
      // initialize does not open a session or discover a workspace.
      const probe = await createChannel(process.cwd());
      const capabilities = admissionCapabilities(probe.capabilities);
      await probe.close(); channels.delete(probe); requests.delete(probe); diagnostics.delete(probe);
      const release = async (channel: ProviderConnection) => {
        await channel.close();
        channels.delete(channel); requests.delete(channel); diagnostics.delete(channel);
      };
      const withDiagnostics = (event: ProviderEvent, channel: ProviderConnection): ProviderEvent => {
        // The ACP adapter permits a failed tool with null output/error (for
        // example a denied tool or one terminalized by cancellation). Paseo's
        // client protocol requires a non-null error and rejects the whole
        // history page otherwise. Apply this to live events and load replay.
        if (event.type === "timeline.item" && event.item.type === "tool_call"
          && event.item.status === "failed" && event.item.error === null) {
          // fx reports shell failures via tool_call_update.command_result and
          // content chunks rather than rawOutput, which leaves the ACP
          // adapter's error null. Recover the streamed details from the
          // transport instead of showing a bare placeholder.
          const transport = diagnostics.get(channel)?.();
          const message = transport?.toolFailureMessage(event.item.callId) ?? `${event.item.name} failed without error details`;
          event = { ...event, item: { ...event.item, error: { message } } };
        }
        if (!("error" in event) || !event.error) return event;
        const transport = diagnostics.get(channel)?.();
        return transport ? { ...event, error: { ...event.error, message: transport.failure?.message ?? event.error.message, diagnostic: transport.diagnosticPath } } : event;
      };
      const send = async (channel: ProviderConnection, input: ProviderInput) => {
        if ("requestId" in input) requests.get(channel)?.add(input.requestId);
        try { await channel.send(input); }
        catch (error) {
          if ("requestId" in input) requests.get(channel)?.delete(input.requestId);
          throw error;
        }
      };
      const dispatch = async (input: ProviderInput) => {
        if (input.type === "session.open") {
          const channel = await createChannel(resolve(input.config.cwd), input.config.env);
          if (closed) { await release(channel); return; }
          sessions.set(input.sessionId, channel);
          channel.onEvent(event => {
            if ("requestId" in event && event.requestId && ["request.completed", "request.failed", "session.ready"].includes(event.type)) requests.get(channel)?.delete(event.requestId);
            if (event.type === "session.turn") {
              if (event.state === "started") activeTurns.set(input.sessionId, event.turnId);
              else activeTurns.delete(input.sessionId);
            }
            emit(withDiagnostics(event.type === "session.opened"
              ? { ...event, capabilities: admissionCapabilities(event.capabilities) } : event, channel));
            if (event.type === "session.runtime_failed") {
              for (const requestId of requests.get(channel) ?? []) emit(withDiagnostics({ type: "request.failed", requestId, error: event.error }, channel));
              requests.get(channel)?.clear();
            }
            if (event.type === "session.closed" || event.type === "session.runtime_failed" || (event.type === "request.failed" && event.requestId === input.requestId)) {
              sessions.delete(input.sessionId);
              activeTurns.delete(input.sessionId);
              // The SDK emits request.completed synchronously after session.closed.
              // Let that event reach the caller before closing the connection.
              queueMicrotask(() => { void release(channel).catch(() => undefined); });
            }
          });
          try { await send(channel, input); } finally { opening.delete(input.sessionId); }
          return;
        }
        if ("sessionId" in input) {
          const channel = sessions.get(input.sessionId);
          if (!channel) throw new Error(`Unknown fx session: ${input.sessionId}`);
          if (input.type === "session.prompt" && input.prompt.delivery === "steer") {
            // Forward to fx's native steering instead of interrupting the
            // active turn. The steer request is answered out-of-band over the
            // raw transport so the ACP adapter keeps only the original turn.
            const transport = diagnostics.get(channel)?.();
            const prompt = input.prompt.input.type === "command"
              ? [{ type: "text" as const, text: `/${input.prompt.input.name}${input.prompt.input.arguments ? ` ${input.prompt.input.arguments}` : ""}` }]
              : input.prompt.input.content.map(part => part.type === "text" || part.type === "image"
                ? part : { type: "text" as const, text: JSON.stringify(part) });
            try {
              if (!transport) throw new Error("fx ACP transport is not ready");
              await transport.steer(prompt);
              emit({ type: "session.prompt_result", sessionId: input.sessionId,
                clientMessageId: input.prompt.clientMessageId,
                result: { type: "steer", turnId: activeTurns.get(input.sessionId) ?? `acp:${input.prompt.clientMessageId}` } });
            } catch (error) {
              emit({ type: "session.prompt_result", sessionId: input.sessionId,
                clientMessageId: input.prompt.clientMessageId,
                result: { type: "failed", error: { message: error instanceof Error ? error.message : String(error) } } });
            }
            return;
          }
          await send(channel, input);
          return;
        }
        const cwd = resolve("cwd" in input && input.cwd ? input.cwd : process.cwd());
        if (input.type === "catalog") models.clear();
        const channel = await createChannel(cwd);
        channel.onEvent(event => {
          // Discovery's synthetic session events belong to its temporary runtime.
          if ("sessionId" in event) return;
          emit(withDiagnostics(event, channel));
          if ("requestId" in event && event.requestId === input.requestId) void release(channel).catch(() => undefined);
        });
        await send(channel, input);
      };
      return {
        version: probe.version, capabilities,
        async send(rawInput) {
          if (closed) throw new Error("fx provider connection is closed");
          const input = ProviderInputSchema.parse(rawInput);
          requireProviderCapabilities(capabilities, input);
          if (input.type === "session.open") {
            if (sessions.has(input.sessionId) || opening.has(input.sessionId)) throw new Error(`Session already exists: ${input.sessionId}`);
            opening.add(input.sessionId);
          }
          const operation = dispatch(input).catch(error => {
            if (input.type === "session.open") opening.delete(input.sessionId);
            const failure = { message: error instanceof Error ? error.message : String(error) };
            if ("requestId" in input) emit({ type: "request.failed", requestId: input.requestId, error: failure });
            else if (input.type === "session.prompt") emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "failed", error: failure } });
            else if ("sessionId" in input) emit({ type: "session.runtime_failed", sessionId: input.sessionId, error: failure });
          });
          operations.add(operation);
          void operation.finally(() => operations.delete(operation));
        },
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        close() {
          if (closePromise) return closePromise;
          closed = true;
          abort.abort();
          closePromise = (async () => {
            // Release blocked RPCs before the SDK waits for in-flight requests.
            await Promise.all([...transports].map(transport => transport.close()));
            await Promise.all(operations);
            await Promise.all([...channels].map(channel => channel.close()));
            transports.clear(); channels.clear(); sessions.clear(); activeTurns.clear(); opening.clear(); requests.clear(); diagnostics.clear(); listeners.clear(); models.clear();
          })();
          return closePromise;
        },
      };
    },
  };
}
