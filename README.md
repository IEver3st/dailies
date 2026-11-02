# Dailies

Review room for agent-made Tesseract videos: an Electron app, a Bun render daemon, and an MCP server agents use to publish revisions and read notes.

## Production follows `main`

The installed Dailies never runs from this working tree. It runs from a release built from GitHub `main`:

1. Every 2 minutes the app fetches `main` from GitHub.
2. A new commit is exported to `%LOCALAPPDATA%\Dailies\releases\<sha>`, installed, typechecked and built there. If any step fails, production stays on the current release and the tray shows the failure.
3. A good build becomes current. If the window is hidden, Dailies restarts into it at once. If it is open, an amber "ready" pill appears in the Library header and a notification offers the restart. It also restarts the next time the window is hidden.

Pushing to `main` deploys. Work in progress on other branches or uncommitted changes never reaches production.

The Dailies MCP server for Claude Code and Codex runs `%LOCALAPPDATA%\Dailies\mcp.mjs`, which always loads the current release.

## Setup and sharing

**Connect agent** in the Library header (it also opens on first launch) shows what Dailies sees on this PC, asks the reviewer's name and gives a prompt that connects Claude Code, Codex or T3 Code to Dailies. **Copy invite prompt** gives a prompt for someone else's Windows PC: their agent installs Git, Bun, ffmpeg and the Tesseract CLI, clones this repo, runs the installer and connects itself. They need read access to the repo.

`bun "%LOCALAPPDATA%\Dailies\mcp.mjs" --check [--owner <name>]` runs the same check from a shell and reports how to fix anything missing. The reviewer's name is stored in `%LOCALAPPDATA%\Dailies\settings.json`; agents see it in the MCP instructions and in note deliveries. Dailies starts without the Tesseract CLI or ffmpeg and restarts its render service once they are installed.

## Commands

| | |
| --- | --- |
| `bun run dev` | Run the app from this tree with hot reload |
| `bun run deploy` | Build and activate GitHub `main` now instead of waiting for the next check |
| `bun run deploy:status` | Show the current release and any failed builds |
| `bun run deploy:rollback` | Go back to the previous release and skip the bad commit until a newer one lands |
| `bun run install:windows` | Reinstall the app shell (Start menu entry, icon, Electron runtime) |
| `bun run typecheck` | Typecheck the daemon, main process and renderer |

Electron upgrades are handled too: when a release ships a different Electron version, the restart swaps the app shell before relaunching.

Logs: `%LOCALAPPDATA%\Dailies\updates.log` (releases) and `daemon.log` (render service). The tray menu shows the running version and has Check for updates and Roll back.
