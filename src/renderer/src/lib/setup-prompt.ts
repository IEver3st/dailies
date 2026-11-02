import type { SetupState } from "./api";

type Paths = { bun: string; mcp: string };

const INSTRUCTIONS = `   ## Dailies
   When you make or revise a Tesseract (.tsrct) video for me, review it with me in Dailies: call dailies_open on the .tsrct when you start, dailies_publish after each save with a one-line summary and the ids of the notes you addressed, and read my notes with dailies_feedback. The dailies MCP server explains the rest.`;

const REFRESH_PATH = `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`;

function tesseractInstall(version: string) {
  const zip = `tesseract-${version}-windows-x86_64.zip`;
  return `download ${zip} and ${zip}.sha256 from https://github.com/mirage-hq/tesseract/releases/tag/v${version}. The .sha256 file holds the hash followed by the file name, so compare its first word with (Get-FileHash ${zip} -Algorithm SHA256).Hash (the case differs, -eq ignores it). Then Expand-Archive the zip and run the install.ps1 inside it with powershell -ExecutionPolicy Bypass -File`;
}

function connectSteps(p: Paths, owner: string | undefined, first: number) {
  const n = (i: number) => `${first + i}.`;
  const ownerArg = owner ? "" : ` --owner "<my first name>"`;
  const ownerNote = owner ? "" : " Ask me my first name if you don't know it; agents will call me by it.";
  return `${n(0)} Register the Dailies MCP server as "dailies" in every agent app I use on this PC (look for Claude Code and Codex):
   - Claude Code: claude mcp add --scope user dailies -- "${p.bun}" "${p.mcp}"
   - Codex: add this to %USERPROFILE%\\.codex\\config.toml:
       [mcp_servers.dailies]
       command = '${p.bun}'
       args = ['${p.mcp}']
       env_vars = ["T3CODE_THREAD_ID"]
       tool_timeout_sec = 70
   - Any other MCP client: a stdio server with the same command and argument.
   If a "dailies" entry already exists, update it instead of adding a second one.
${n(1)} Run & "${p.bun}" "${p.mcp}" --check${ownerArg}.${ownerNote} It lists what Dailies sees on this PC and gives a fix for anything missing. Apply the fixes and run it again until it says Ready.
${n(2)} Add this to my global agent instructions (%USERPROFILE%\\.claude\\CLAUDE.md for Claude Code, %USERPROFILE%\\.codex\\AGENTS.md for Codex) unless something equivalent is already there:

${INSTRUCTIONS}

${n(3)} Tell me what you registered and what the check reported. The dailies_* tools load in new sessions: remind me to start one. Dailies shows the agent as connected once that session calls a dailies tool.`;
}

export function connectPrompt(s: SetupState) {
  const p = { bun: s.bun.path, mcp: s.mcp.entry };
  const fixes: string[] = [];
  if (!s.tsrct.found) fixes.push(`Install the Tesseract CLI ${s.tsrct.wanted}, which Dailies renders with: ${tesseractInstall(s.tsrct.wanted)}.`);
  if (!s.ffmpeg.found) fixes.push("Install ffmpeg: winget install --id Gyan.FFmpeg -e");
  const pre = fixes.map((f, i) => `${i + 1}. ${f}`).join("\n");
  return `Connect yourself to Dailies, my review room for the Tesseract videos you make for me. You publish each revision of a cut to it, I leave notes and drawings on the frame there, and you pick them up and publish the fix.

Dailies is installed on this PC. Its MCP server runs as:
  command  ${p.bun}
  args     ${p.mcp}

Run the commands below in PowerShell. Work through the steps in order, skip anything already done, and stop to tell me if one fails.

${pre ? `${pre}\n` : ""}${connectSteps(p, s.owner, fixes.length + 1)}`;
}

export function invitePrompt(s: SetupState) {
  const repo = s.repo.replace(/\/$/, "");
  const ownerAccount = /github\.com\/([^/]+)/.exec(repo)?.[1];
  const v = s.tsrct.wanted;
  const p = { bun: "<bun.exe>", mcp: "<mcp.mjs>" };
  return `Set up Dailies on this PC for me, then connect yourself to it.

Dailies is a review room for the videos agents make with Tesseract. You publish each revision of a .tsrct cut to it, I watch it with proper playback and leave notes and drawings on the frame, and you pick the notes up and publish the fix. It runs on 64-bit Windows 10 or 11.

Run the commands below in PowerShell. Work through the steps in order, skip anything already done, and stop to tell me if one fails.

1. Check these tools and install what is missing:
   - Git: git --version. Install: winget install --id Git.Git -e
   - Bun: bun --version. Install: powershell -c "irm bun.sh/install.ps1 | iex". From here on call Bun by its full path, "$env:USERPROFILE\\.bun\\bin\\bun.exe".
   - ffmpeg: ffmpeg -version. Install: winget install --id Gyan.FFmpeg -e
   - Tesseract CLI ${v}: & "$env:LOCALAPPDATA\\Tesseract\\bin\\tsrct.cmd" --version. Install: ${tesseractInstall(v)}.
   Your shell keeps the PATH it started with, so after installing anything run this before re-checking and before every later step:
     ${REFRESH_PATH}
   If you will be making Tesseract videos for me and don't have the Tesseract agent skills, install them too: & "$env:USERPROFILE\\.bun\\bin\\bun.exe" x skills add mirage-hq/Tesseract
2. Clone Dailies: git clone ${repo}.git "$env:USERPROFILE\\Dailies". If git refuses with a permission or "not found" error, the repository is private: stop and tell me to ask ${ownerAccount ?? "its owner"} on GitHub for access for my account.
3. In the clone run bun install, then bun scripts/install-windows.ts --launch (with Bun's full path). That installs Dailies to %LOCALAPPDATA%\\Programs\\Dailies, builds it from GitHub (a few minutes), adds it to the Start menu and opens it. It keeps itself up to date after that.

In the next steps, <bun.exe> is the full path of bun.exe (usually C:\\Users\\<name>\\.bun\\bin\\bun.exe) and <mcp.mjs> is the full path of %LOCALAPPDATA%\\Dailies\\mcp.mjs. Write both out in full, without environment variables.

${connectSteps(p, undefined, 4)}`;
}
