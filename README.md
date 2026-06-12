# Prompt Pie CLI

`promptpie` is the npm package for the Prompt Pie CLI. The main command is `ppie`.

Use it to keep AI coding skills in one local source of truth and link them into Claude Code, Codex, and Cursor.

- Docs: https://docs.promptpie.dev/cli
- Prompt Pie: https://promptpie.dev
- Issues: https://github.com/jeremyrojas/ppie-cli/issues

## Install

Install globally:

```bash
npm i -g promptpie
ppie --version
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
```

`--force` is only valid with `ppie skill link`.

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
