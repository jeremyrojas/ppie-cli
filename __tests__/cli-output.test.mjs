import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const BIN_PATH = fileURLToPath(new URL('../bin/ppie.mjs', import.meta.url));
const { formatTargetLabels, targetHelpSummary } = await import('../lib/paths.mjs');
const testHomes = new Set();
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

afterEach(() => {
  for (const dir of testHomes) {
    rmSync(dir, { recursive: true, force: true });
  }
  testHomes.clear();
});

describe('cli output', () => {
  it('help shows usage and version commands', () => {
    const result = runCli(['--help']);
    const stdout = stripAnsi(result.stdout);

    assert.equal(result.status, 0);
    assert.match(stdout, /ppie help \| --help \| -h/);
    assert.match(stdout, /ppie --version \| -v \| -V/);
    assert.match(stdout, /ppie status/);
    assert.match(stdout, /ppie doctor/);
    assert.match(stdout, /ppie skill info <name>/);
    assert.match(stdout, /--dry-run/);
    assert.match(stdout, new RegExp(escapeRegExp(targetHelpSummary())));
    assert.match(stdout, new RegExp(`${escapeRegExp(formatTargetLabels())} paths are symlinks to that source file`));
  });

  it('skill add shows the created path and clear next steps', () => {
    const home = makeHome();

    runCli(['init'], home);
    const result = runCli(['skill', 'add', 'code-review'], home);
    const stdout = stripAnsi(result.stdout);

    assert.equal(result.status, 0);
    assert.match(stdout, /Created skill/);
    assert.match(stdout, /\.promptpie\/skills\/code-review\/SKILL\.md/);
    assert.match(stdout, /Next: edit with .*ppie skill edit code-review/);
    assert.match(stdout, new RegExp(`Then: link with .*ppie skill link code-review.*${escapeRegExp(formatTargetLabels('or'))}`));
  });

  it('skill import shows the imported path and clear next steps', () => {
    const home = makeHome();
    const importFile = join(home, 'import.md');
    writeFileSync(importFile, '# imported\n', 'utf8');

    runCli(['init'], home);
    const result = runCli(['skill', 'import', 'imported', importFile], home);
    const stdout = stripAnsi(result.stdout);

    assert.equal(result.status, 0);
    assert.match(stdout, /Imported skill/);
    assert.match(stdout, /\.promptpie\/skills\/imported\/SKILL\.md/);
    assert.match(stdout, /Next: edit with .*ppie skill edit imported/);
    assert.match(stdout, new RegExp(`Then: link with .*ppie skill link imported.*${escapeRegExp(formatTargetLabels('or'))}`));
  });

  it('skill link explains that target files are symlinks', () => {
    const home = makeHome();

    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    const result = runCli(['skill', 'link', 'code-review'], home);
    const stdout = stripAnsi(result.stdout);

    assert.equal(result.status, 0);
    assert.match(stdout, /Linked/);
    assert.match(stdout, /These target files are symlinks to the source skill/);
  });

  it('skill edit remains path-only for shell usage', () => {
    const home = makeHome();

    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    const result = runCli(['skill', 'edit', 'code-review'], home);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, join(home, '.promptpie', 'skills', 'code-review', 'SKILL.md'));
    assert.equal(result.stderr, '');
  });

  it('--no-color removes ANSI escape codes', () => {
    const result = runCli(['--help', '--no-color']);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, stripAnsi(result.stdout));
  });

  it('list --json returns structured output', () => {
    const home = makeHome();

    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    runCli(['skill', 'link', 'code-review', 'claude'], home);
    const result = runCli(['skill', 'list', '--json'], home);
    const payload = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'skill.list');
    assert.deepEqual(payload.skills[0].linkedTo, [{ target: 'claude', valid: true }]);
  });

  it('status shows a concise setup dashboard', () => {
    const home = makeHome();

    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    runCli(['skill', 'link', 'code-review', 'claude'], home);
    const result = runCli(['status', '--no-color'], home);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Prompt Pie is initialized/);
    assert.match(result.stdout, /Skills: 1/);
    assert.match(result.stdout, /claude\s+exists\s+1/);
    assert.match(result.stdout, /No setup issues found/);
  });

  it('status --json returns structured dashboard data', () => {
    const home = makeHome();

    runCli(['init'], home);
    const result = runCli(['status', '--json'], home);
    const payload = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'status');
    assert.equal(payload.initialized, true);
    assert.equal(payload.issueCount, 0);
    assert.equal(payload.targets.length, 3);
  });

  it('doctor --json returns diagnostic data on stdout when unhealthy', () => {
    const home = makeHome();

    const result = runCli(['doctor', '--json'], home);
    const payload = JSON.parse(result.stdout);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, false);
    assert.equal(payload.command, 'doctor');
    assert.equal(payload.issues[0].code, 'MISSING_SOURCE_DIR');
    assert.equal(payload.issues[0].suggestedCommand, 'ppie init');
  });

  it('skill info shows source and target statuses', () => {
    const home = makeHome();

    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    const result = runCli(['skill', 'info', 'code-review', '--no-color'], home);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Source: .*\.promptpie\/skills\/code-review\/SKILL\.md/);
    assert.match(result.stdout, /claude\s+not linked/);
  });

  it('skill info --json returns inspectable target data', () => {
    const home = makeHome();

    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    const result = runCli(['skill', 'info', 'code-review', '--json'], home);
    const payload = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'skill.info');
    assert.equal(payload.targets[0].target, 'claude');
    assert.equal(payload.targets[0].status, 'not_linked');
  });

  it('dry-run link uses preview language and JSON shape', () => {
    const home = makeHome();

    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    const human = runCli(['skill', 'link', 'code-review', 'codex', '--dry-run', '--no-color'], home);
    const json = runCli(['skill', 'link', 'code-review', 'codex', '--dry-run', '--json'], home);
    const payload = JSON.parse(json.stdout);

    assert.equal(human.status, 0);
    assert.match(human.stdout, /Dry run/);
    assert.match(human.stdout, /Would link codex/);
    assert.equal(json.status, 0);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'skill.link');
    assert.equal(payload.dryRun, true);
    assert.equal(payload.results[0].status, 'would_link');
  });

  it('edit --json returns a path object instead of raw path text', () => {
    const home = makeHome();

    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    const result = runCli(['skill', 'edit', 'code-review', '--json'], home);
    const payload = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'skill.edit');
    assert.equal(payload.path, join(home, '.promptpie', 'skills', 'code-review', 'SKILL.md'));
  });
});

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'ppie-cli-output-'));
  testHomes.add(dir);
  return dir;
}

function runCli(args, home = makeHome()) {
  return spawnSync(process.execPath, [BIN_PATH, ...args], {
    env: { ...process.env, PPIE_HOME: home },
    encoding: 'utf8',
  });
}

function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
