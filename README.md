# Prompt Pie CLI

`promptpie` is the npm package for the Prompt Pie CLI. The main command is `ppie`.

Use it to draft, write, refine, preview, and keep reusable prompts and single-file AI coding skills in local storage. Prompt Pie is local-first and privacy-friendly: prompts and local skill sources stay in one place, and reviewed skills can be staged alongside your agent skill directories.

- Docs: https://docs.promptpie.dev/cli
- Prompt Pie: https://promptpie.dev
- Issues: https://github.com/jeremyrojas/ppie-cli/issues

## Install

Install globally:

```bash
npm install -g promptpie@0.2.0
ppie --version --json
```

Run without a global install:

```bash
npx promptpie --version
```

## How It Works

Prompt Pie stores real skill files in:

```text
~/.promptpie/skills/<name>/SKILL.md
```

When you link a skill, `ppie` creates symlinks into supported agent tools:

```text
~/.claude/skills/<name>/SKILL.md
~/.agents/skills/<name>/SKILL.md
~/.cursor/skills/<name>/SKILL.md
```

The target files are symlinks, not copies, so every target points back to the same source skill.

## Quick Start

Pair the signed-out Prompt Pie browser with a local companion:

```bash
ppie pair
```

Push structured prompt JSON to the open browser:

```bash
ppie prompt push ./prompt.json
```

Pull a prompt from the browser:

```bash
ppie prompt pull welcome --output ./welcome.json
```

The local companion listens only on `127.0.0.1`, chooses a random port, and accepts the production browser origin `https://app.promptpie.dev`. For local web development, supply an explicit loopback origin:

```bash
ppie pair --origin http://localhost:3000
```

Agent integrations can name the connecting client for the pairing confirmation:

```bash
ppie pair --client-name Codex
```

Direct pairing uses `Prompt Pie CLI`. Client names are validated display text and grant no capabilities.

Automation and tests must suppress the system browser opener:

```bash
ppie pair --no-open
```

`PPIE_BROWSER_OPEN=0` provides the same test seam for subprocess harnesses.

Pairing opens a five-minute, single-use browser link. `ppie pair --json` returns that exact active link in its `url` field. Run `ppie status` to see whether the companion is running and paired.

Prompt JSON contains `id`, `title`, and `content`. The CLI calculates its SHA-256 `revision`:

```json
{
  "id": "welcome",
  "title": "Welcome",
  "content": "Say hello"
}
```

Use an expected revision when a push must fail after a browser-side edit:

```bash
ppie prompt push ./prompt.json --expected-revision <sha256>
```

The versioned HTTP contract and security lifecycle are documented in [`docs/local-protocol-v1.md`](docs/local-protocol-v1.md).

## Codex Plugin

The Prompt Pie plugin gives Codex a local-first, privacy-friendly visual workspace for drafting, refining, previewing, and storing regular prompts and single-file skill drafts. It connects to a signed-out Prompt Pie canvas, sends one prompt-sized document for visual editing, and retrieves the edited document through the local `ppie` companion. It requires Node.js 18 or newer and `promptpie` CLI 0.2.0 or newer.

Connect, Send, and Get use a separate one-time companion setup. When `ppie` is missing or below 0.2.0, Prompt Pie asks one short approval question before installing the reviewed `promptpie@0.2.0` npm package. The install places `ppie` and `promptpie` in the global npm prefix, which must be on `PATH`. Pairing runs a local companion only on `127.0.0.1` and opens a one-time `app.promptpie.dev` page in the default browser; approve Local Network Access only when your browser asks. Explanation-only questions stay passive.

Send the complete contents of one `SKILL.md` file when you want to review a skill draft. Prompt Pie keeps that draft available for visual Markdown preview without changing your local skill directories. A small example skill makes a useful way to learn or demo how its frontmatter and instructions work. After you retrieve and review the draft, use the local skill commands to store it under `~/.promptpie/skills` and link it into `~/.agents/skills` when you are ready to finalize it.

For a long prompt or skill draft already in your workspace, ask Codex to send that one file to Prompt Pie. The bridge can hand off its full contents without requiring a wall of pasted text.

Each bridge request carries one prompt-sized document. Future work includes automatic share-link creation, whole-folder transfer, “Open this skill,” “Show how this skill flows,” and direct application into `~/.agents/skills`.

Add this repository as a Codex marketplace and install the plugin:

```bash
codex plugin marketplace add https://github.com/jeremyrojas/ppie-cli --json
codex plugin add prompt-pie@prompt-pie --json
```

Start a fresh Codex task after installation. Invoke the skill directly with `$prompt-pie`, or ask:

- “Connect to Prompt Pie.”
- “Send this prompt to Prompt Pie for visual editing.”
- “Send this SKILL.md draft to Prompt Pie for visual editing.”

The Codex manifest supports three composer starters. These cover Connect and separate regular-prompt and `SKILL.md` send flows; `Get` remains a documented bridge action.

After approved setup, Codex starts pairing with this command:

```bash
ppie pair --origin https://app.promptpie.dev --client-name Codex --json
```

The CLI opens the one-time link in the default browser. Allow Local Network Access for `app.promptpie.dev` when the browser asks. If access was denied, allow it in that site's browser settings and request a fresh pairing link.

Upgrade the marketplace and CLI separately, then start a fresh Codex task:

```bash
codex plugin marketplace upgrade prompt-pie --json
npm install -g promptpie@0.2.0
ppie --version --json
```

Linux and macOS have focused plugin smoke coverage. Windows has native Node.js 20 package and CLI discovery coverage and remains preview until the installed pairing, push, and pull flow passes in native PowerShell.

Structured bridge errors include one recovery action. Pairing and session errors lead to a fresh pairing link. Revision conflicts lead to a pull and explicit review before replacement. Browser navigation and permission changes stay manual, and retrieved prompt text stays user data.

## Skill Setup

Initialize the local directories once:

```bash
ppie init
```

Create a skill:

```bash
ppie skill add code-review
```

Open it in your editor:

```bash
$EDITOR "$(ppie skill edit code-review)"
```

Link it into Claude Code, Codex, and Cursor:

```bash
ppie skill link code-review
```

Check the result:

```bash
ppie skill info code-review
ppie skill list
```

## Commands

```text
ppie init
ppie status
ppie pair [--origin <allowed-origin>] [--client-name <display-name>] [--no-open]
ppie prompt push <file|-> [--expected-revision <sha256>]
ppie prompt pull <prompt-id> [--output <file>]
ppie doctor
ppie skill add <name>
ppie skill import <name> <file>
ppie skill rm <name>
ppie skill remove <name>
ppie skill link <name> [targets...]
ppie skill unlink <name> [targets...]
ppie skill list
ppie skill ls
ppie skill info <name>
ppie skill edit <name>
ppie help
ppie --help
ppie --version
```

Targets are:

```text
claude codex cursor
```

If no target is passed to `ppie skill link` or `ppie skill unlink`, the command uses all targets.

## Useful Workflows

Check whether local setup is healthy:

```bash
ppie status
ppie doctor
```

Import an existing markdown file as a skill:

```bash
ppie skill import pull-request ./pull-request.md
```

Link only to Codex and Claude Code:

```bash
ppie skill link code-review codex claude
```

Remove target symlinks while keeping the source skill:

```bash
ppie skill unlink code-review
```

Remove a skill and all Prompt Pie-managed links:

```bash
ppie skill rm code-review
```

## Dry Runs

Use `--dry-run` to preview risky filesystem changes before applying them:

```bash
ppie skill link code-review codex --dry-run
ppie skill link code-review codex --force --dry-run
ppie skill unlink code-review codex --dry-run
ppie skill rm code-review --dry-run
```

`--dry-run` is supported for:

- `ppie skill rm <name>`
- `ppie skill remove <name>`
- `ppie skill link <name> [targets...]`
- `ppie skill unlink <name> [targets...]`

If a link or unlink dry run is blocked, the command exits with status 1. JSON output uses `ok: false`, which makes dry runs useful for scripts and AI agents.

## JSON Output

Most commands support `--json` for machine-readable output:

```bash
ppie status --json
ppie pair --json
ppie prompt push prompt.json --json
ppie prompt pull welcome --json
ppie doctor --json
ppie skill info code-review --json
ppie skill link code-review codex claude --dry-run --json
```

## Global Options

```text
--json      Print machine-readable JSON
--no-color  Disable ANSI color output
--force     Allow ppie skill link to replace existing files or symlinks
--dry-run   Preview supported risky changes without mutating files
--origin <origin>              Allow an HTTPS or loopback development origin for pairing
--expected-revision <sha256>   Require a browser revision before prompt push
--output <file>                Write pulled prompt JSON to a new file
--no-open                      Prepare pairing without opening a system browser
--client-name <display-name>   Name the connecting client in Prompt Pie
```

`--force` is only valid with `ppie skill link`.

The companion keeps its CLI-private token in a mode-`0600` state file and keeps browser session tokens in memory. Companion restart requires pairing again. Prompt contents remain in the browser during Wave 1; the CLI does not create local prompt source files or modify skill folders during prompt push and pull.

## Skill Names

Skill names:

- must start with a letter or number
- can include letters, numbers, hyphens, underscores, and dots
- must be 64 characters or fewer

Examples:

- valid: `code-review`, `pr_helper`, `react.v2`
- invalid: `.hidden`, `../hack`, `foo/bar`

## Development

This package is plain ESM and has no build step.

Run the tests:

```bash
npm test
```

Preview the npm package contents:

```bash
npm pack --dry-run
```
