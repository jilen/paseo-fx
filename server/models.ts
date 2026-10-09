import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class ModelCatalog {
  private readonly entries = new Map<string, { expires: number; value: Promise<string[]> }>();

  constructor(
    private readonly command: readonly [string, ...string[]],
    private readonly timeoutMs: number,
    private readonly signal: AbortSignal,
  ) {}

  clear() { this.entries.clear(); }

  async read(cwd: string, env: NodeJS.ProcessEnv, force = false): Promise<string[]> {
    const key = createHash("sha256").update(JSON.stringify([cwd, Object.entries(env).sort()])).digest("hex");
    const cached = this.entries.get(key);
    if (!force && cached && cached.expires > Date.now()) return cached.value;
    if (this.entries.size >= 32) this.entries.delete(this.entries.keys().next().value!);
    const entry = { expires: Date.now() + 30_000, value: this.load(cwd, env) };
    this.entries.set(key, entry);
    try {
      return await entry.value;
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }

  private async load(cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
    try {
      const [executable, ...args] = this.command;
      const { stdout } = await execFileAsync(executable, [...args, "models", "--json"], {
        cwd, env, timeout: this.timeoutMs, killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024, signal: this.signal,
      });
      const response: unknown = JSON.parse(stdout);
      if (!response || typeof response !== "object" || !("ids" in response) || !Array.isArray(response.ids)) {
        throw new Error("response did not contain model IDs");
      }
      return [...new Set(response.ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
    } catch (error) {
      throw new Error(`fx models failed in ${cwd}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}
