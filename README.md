# Paseo fx provider

Use [fx](https://fx.sh) as a coding agent in Paseo through its ACP server. Supports streaming responses, images, permissions, cancellation, session history, and model selection. Each session runs in its own fx process using the selected workspace and environment.

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

Select **fx** when creating a Paseo agent. Messages sent during an active turn steer it without interrupting the turn or dismissing pending permissions.

Use **Permission mode** in the agent's session settings to control tool permissions:

- **Ask** maps to fx's `ask` permission mode and asks for approval when required.
- **Code** maps to fx's `auto` permission mode: routine actions run automatically, while other actions go through automatic review and may require approval.

Both modes can write code; Ask is not a read-only mode. Mode changes apply to the active session. See [fx's ACP mode documentation](https://fx.sh/docs/using-fx/acp#sessions-models-and-permissions) for details.

The plugin exposes the features available through fx's ACP server. Features exclusive to fx's terminal UI may not appear in Paseo.

## Troubleshooting

If the provider does not appear or a session fails to start, inspect the plugin logs:

```sh
paseo plugin logs paseo-fx
```

Confirm that `fx` is on the daemon's `PATH` and that `fx status --json` shows a configured provider. Run these checks on the daemon host.

Process diagnostics are saved under `~/.paseo/plugin-logs/paseo-fx/`. Errors include the relevant diagnostic file path. Logs are bounded, and the most recent 20 completed process logs are retained.

Control requests time out after 15 seconds and model discovery after 10 seconds. Active prompts have no fixed deadline, including while waiting for permission.
