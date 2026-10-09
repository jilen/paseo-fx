# Paseo fx provider

This plugin registers [fx](https://fx.sh) as a Paseo provider using fx's ACP server. Paseo's ACP adapter handles sessions, prompts, streaming output, permissions, cancellation, and history. The plugin runs each session in a separate fx process with the selected workspace and environment, and normalizes fx's provider/model selectors before passing them to Paseo.

## Requirements

- Paseo 0.11.0 or a compatible 0.11.x release
- fx 0.0.12 or newer, installed on the Paseo daemon host and available as `fx` on the daemon's `PATH`
- A model/provider configured in fx (`fx status --json` can check this)
- Plugins enabled in Paseo's Settings → Plugins

## Install

Choose either installation method below. Run the commands on the Paseo daemon host.

### Directly from GitHub

```sh
paseo plugin install https://github.com/jilen/paseo-fx.git
```

To install a specific branch, tag, or commit, append `--ref <ref>`.

### From a local checkout

Clone or download this repository, then run these commands from its directory:

```sh
npm install
paseo plugin install "$PWD"
```

The local source must be an absolute path on the daemon host. You can also use `paseo plugin install /absolute/path/to/paseo-fx`.

For local development, run `npm run typecheck` and `npm test` before installing.

After either method, confirm the plugin is installed:

```sh
paseo plugin ls
```

Select **fx** when creating a Paseo agent. If the provider does not appear, inspect `paseo plugin logs paseo-fx` and confirm the daemon can run `fx acp` from its environment. The plugin sets the fx process's working directory as well as the ACP session's `cwd`; fx 0.0.12 uses the process directory for its actual workspace.

## Runtime behavior and diagnostics

- Control requests have a 15-second deadline; model discovery has a 10-second deadline. Active model prompts have no fixed wall-clock deadline, so long turns and permission waits remain supported.
- Closing the provider stops its transports before waiting for pending SDK requests. Processes receive SIGTERM, followed by SIGKILL after one second when necessary.
- When a message arrives during an active turn, the daemon steers the turn. The plugin forwards it to fx as a raw `session/prompt` with `_meta.fx.steer: true` over the transport, so the active turn and pending permissions stay intact. The response is answered out-of-band and reported to Paseo as `{ type: "steer", turnId }`; a failure (e.g. the turn already ended) surfaces as a failed prompt result.
- Adjacent text/reasoning fragments are combined for up to 50 milliseconds or 64 KiB. Message changes, tool activity, permissions and RPC responses flush pending text to preserve event order.
- Model snapshots come from fx's current session configuration, including session restoration and transaction rollback. CLI model queries run in the session workspace with its environment, are deduplicated and cached for 30 seconds, and are refreshed during catalog discovery.
- Diagnostics are saved under `~/.paseo/plugin-logs/paseo-fx/` on the daemon host, including stderr, RPC errors, request timeouts and process exits. Each process log is capped at 256 KiB plus a bounded stderr tail. Active process logs and the most recent 20 completed process logs are retained. Errors include the diagnostic file path.
- Failed tool records with no error details receive a fallback message during live output and history replay. This avoids Paseo rejecting an entire history page because a failed tool has a null error. Existing affected agents need **Reload agent** after the updated plugin is loaded to rebuild their timeline from fx history.
- History notifications received before the load response are buffered until the ACP adapter binds the session. Replayed user prompts are preserved as timeline messages. If the first **Reload agent** after reloading the plugin restores the old timeline, reload the agent once more to rebuild it.

Existing fx sessions created by the earlier implementation may have been saved with an incorrect workspace, such as the daemon's home directory. The plugin does not rewrite those saved sessions. Create a new fx agent in the intended workspace to verify the fix.

fx's ACP endpoint supports model, mode, and effort selection, session load and replay, prompts, tool activity, permission requests, cancellation, images, and MCP servers. It requires an authenticated fx provider before starting a session. The plugin relies on the ACP data fx exposes, so fx features that are only available in its terminal UI may not appear in Paseo.
