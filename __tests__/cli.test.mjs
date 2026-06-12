import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const BIN_PATH = fileURLToPath(new URL('../bin/ppie.mjs', import.meta.url));
const testHomes = new Set();
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

afterEach(() => {
  for (const dir of testHomes) {
    rmSync(dir, { recursive: true, force: true });
  }
  testHomes.clear();
});

describe('cli functional behavior', () => {
  it('help alias exits 0', () => {
    const result = runCli(['help']);

    assert.equal(result.status, 0);
    assert.match(stripAnsi(result.stdout), /USAGE/);
  });

  it('no args shows help', () => {
    const result = runCli([]);

    assert.equal(result.status, 0);
    assert.match(stripAnsi(result.stdout), /USAGE/);
  });

  it('--version and -v print semver', () => {
    assert.match(stripAnsi(runCli(['--version']).stdout), /^\d+\.\d+\.\d+/);
    assert.match(stripAnsi(runCli(['-v']).stdout), /^\d+\.\d+\.\d+/);
  });

  it('unknown command exits 1', () => {
    const result = runCli(['unknown']);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(stripAnsi(result.stderr), /Unknown command/);
  });

  it('init creates the expected directories', () => {
    const home = makeHome();
    const result = runCli(['init'], home);

    assert.equal(result.status, 0);
    assert.ok(existsSync(join(home, '.promptpie', 'skills')));
    assert.ok(existsSync(join(home, '.claude', 'skills')));
    assert.ok(existsSync(join(home, '.agents', 'skills')));
    assert.ok(existsSync(join(home, '.cursor', 'skills')));
    assert.ok(!existsSync(join(home, '.codex', 'skills')));
  });

  it('status exits 0 without creating directories', () => {
    const home = makeHome();
    const result = runCli(['status'], home);

    assert.equal(result.status, 0);
    assert.match(stripAnsi(result.stdout), /setup is incomplete/);
    assert.ok(!existsSync(join(home, '.promptpie', 'skills')));
  });

  it('status --json reports setup gaps', () => {
    const home = makeHome();
    const result = runCli(['status', '--json'], home);
    const payload = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'status');
    assert.equal(payload.initialized, false);
    assert.equal(payload.issueCount, 4);
    assert.equal(payload.suggestedCommand, 'ppie doctor');
  });

  it('doctor exits 1 and reports missing setup on stdout', () => {
    const home = makeHome();
    const result = runCli(['doctor', '--json'], home);
    const payload = JSON.parse(result.stdout);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, false);
    assert.equal(payload.command, 'doctor');
    assert.equal(payload.summary.errorCount, 4);
  });

  it('doctor exits 0 after init', () => {
    const home = makeHome();
    runCli(['init'], home);

    const result = runCli(['doctor'], home);

    assert.equal(result.status, 0);
    assert.match(stripAnsi(result.stdout), /setup looks healthy/);
  });

  it('skill add creates a skill', () => {
    const home = makeHome();
    runCli(['init'], home);

    const result = runCli(['skill', 'add', 'code-review'], home);

    assert.equal(result.status, 0);
    assert.ok(existsSync(join(home, '.promptpie', 'skills', 'code-review', 'SKILL.md')));
  });

  it('skill add without a name exits 1', () => {
    const result = runCli(['skill', 'add']);

    assert.equal(result.status, 1);
    assert.match(stripAnsi(result.stderr), /Usage: ppie skill add <name>/);
  });

  it('skill import copies the source file', () => {
    const home = makeHome();
    const source = join(home, 'source.md');
    writeFileSync(source, '# imported\n', 'utf8');
    runCli(['init'], home);

    const result = runCli(['skill', 'import', 'imported', source], home);

    assert.equal(result.status, 0);
    assert.equal(readSkill(home, 'imported'), '# imported\n');
  });

  it('skill import without args exits 1', () => {
    const result = runCli(['skill', 'import', 'imported']);

    assert.equal(result.status, 1);
    assert.match(stripAnsi(result.stderr), /Usage: ppie skill import <name> <file>/);
  });

  it('skill import missing source file exits 1', () => {
    const home = makeHome();
    runCli(['init'], home);

    const result = runCli(['skill', 'import', 'imported', join(home, 'missing.md')], home);

    assert.equal(result.status, 1);
    assert.match(stripAnsi(result.stderr), /Source file not found/);
  });

  it('skill import duplicate name exits 1', () => {
    const home = makeHome();
    const source = join(home, 'source.md');
    writeFileSync(source, '# imported\n', 'utf8');
    runCli(['init'], home);
    runCli(['skill', 'import', 'imported', source], home);

    const result = runCli(['skill', 'import', 'imported', source], home);

    assert.equal(result.status, 1);
    assert.match(stripAnsi(result.stderr), /already exists/);
  });

  it('skill rm removes a skill and its links', () => {
    const home = makeHome();
    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    runCli(['skill', 'link', 'code-review'], home);

    const result = runCli(['skill', 'rm', 'code-review'], home);

    assert.equal(result.status, 0);
    assert.ok(!existsSync(join(home, '.promptpie', 'skills', 'code-review', 'SKILL.md')));
    assert.ok(!existsSync(join(home, '.claude', 'skills', 'code-review', 'SKILL.md')));
    assert.ok(!existsSync(join(home, '.agents', 'skills', 'code-review', 'SKILL.md')));
    assert.ok(!existsSync(join(home, '.cursor', 'skills', 'code-review', 'SKILL.md')));
  });

  it('skill remove alias works', () => {
    const home = makeHome();
    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);

    const result = runCli(['skill', 'remove', 'code-review'], home);

    assert.equal(result.status, 0);
    assert.ok(!existsSync(join(home, '.promptpie', 'skills', 'code-review', 'SKILL.md')));
  });

  it('skill link defaults to all targets', () => {
    const home = makeHome();
    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);

    const result = runCli(['skill', 'link', 'code-review'], home);

    assert.equal(result.status, 0);
    assert.ok(existsSync(join(home, '.claude', 'skills', 'code-review', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.agents', 'skills', 'code-review', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.cursor', 'skills', 'code-review', 'SKILL.md')));
  });

  it('skill link invalid target exits 1', () => {
    const home = makeHome();
    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);

    const result = runCli(['skill', 'link', 'code-review', 'bogus'], home);

    assert.equal(result.status, 1);
    assert.match(stripAnsi(result.stderr), /Unknown target/);
  });

  it('skill unlink removes only the selected target link', () => {
    const home = makeHome();
    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    runCli(['skill', 'link', 'code-review'], home);

    const result = runCli(['skill', 'unlink', 'code-review', 'codex'], home);

    assert.equal(result.status, 0);
    assert.ok(existsSync(join(home, '.claude', 'skills', 'code-review', 'SKILL.md')));
    assert.ok(!existsSync(join(home, '.agents', 'skills', 'code-review', 'SKILL.md')));
  });

  it('skill unlink when not linked warns and exits 0', () => {
    const home = makeHome();
    runCli(['init'], home);

    const result = runCli(['skill', 'unlink', 'missing', 'claude'], home);

    assert.equal(result.status, 0);
    assert.match(stripAnsi(result.stdout), /was not linked/);
  });

  it('skill list shows no skills when empty', () => {
    const home = makeHome();
    runCli(['init'], home);

    const result = runCli(['skill', 'list'], home);

    assert.equal(result.status, 0);
    assert.match(stripAnsi(result.stdout), /No skills found/);
  });

  it('skill list and ls show skills when present', () => {
    const home = makeHome();
    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    runCli(['skill', 'link', 'code-review', 'claude'], home);

    const list = runCli(['skill', 'list'], home);
    const ls = runCli(['skill', 'ls'], home);

    assert.equal(list.status, 0);
    assert.equal(ls.status, 0);
    assert.match(stripAnsi(list.stdout), /code-review/);
    assert.match(stripAnsi(ls.stdout), /code-review/);
  });

  it('skill info shows one skill target state', () => {
    const home = makeHome();
    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    runCli(['skill', 'link', 'code-review', 'claude'], home);

    const result = runCli(['skill', 'info', 'code-review'], home);

    assert.equal(result.status, 0);
    assert.match(stripAnsi(result.stdout), /code-review/);
    assert.match(stripAnsi(result.stdout), /claude\s+linked/);
    assert.match(stripAnsi(result.stdout), /codex\s+not linked/);
  });

  it('skill info --json returns target state', () => {
    const home = makeHome();
    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);

    const result = runCli(['skill', 'info', 'code-review', '--json'], home);
    const payload = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'skill.info');
    assert.equal(payload.name, 'code-review');
    assert.deepEqual(payload.targets.map(target => target.status), ['not_linked', 'not_linked', 'not_linked']);
  });

  it('skill info missing skill exits 1', () => {
    const home = makeHome();
    runCli(['init'], home);

    const result = runCli(['skill', 'info', 'missing'], home);

    assert.equal(result.status, 1);
    assert.match(stripAnsi(result.stderr), /not found/);
  });

  it('skill edit missing skill exits 1', () => {
    const home = makeHome();
    runCli(['init'], home);

    const result = runCli(['skill', 'edit', 'missing'], home);

    assert.equal(result.status, 1);
    assert.match(stripAnsi(result.stderr), /not found/);
  });

  it('skill edit invalid name exits 1', () => {
    const result = runCli(['skill', 'edit', '../hack']);

    assert.equal(result.status, 1);
    assert.match(stripAnsi(result.stderr), /Invalid skill name/);
  });

  it('unknown skill action exits 1', () => {
    const result = runCli(['skill', 'nope']);

    assert.equal(result.status, 1);
    assert.match(stripAnsi(result.stderr), /Unknown skill action/);
  });

  it('invalid skill name exits 1', () => {
    const result = runCli(['skill', 'add', '.hidden']);

    assert.equal(result.status, 1);
    assert.match(stripAnsi(result.stderr), /Invalid skill name/);
  });

  it('path-like skill name exits 1', () => {
    const result = runCli(['skill', 'add', '../hack']);

    assert.equal(result.status, 1);
    assert.match(stripAnsi(result.stderr), /Invalid skill name/);
  });

  it('name too long exits 1', () => {
    const result = runCli(['skill', 'add', 'a'.repeat(65)]);

    assert.equal(result.status, 1);
    assert.match(stripAnsi(result.stderr), /too long/);
  });

  it('--force errors outside skill link', () => {
    const result = runCli(['init', '--force']);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(stripAnsi(result.stderr), /--force can only be used/);
  });

  it('--dry-run errors outside supported commands', () => {
    const result = runCli(['status', '--dry-run']);

    assert.equal(result.status, 1);
    assert.match(stripAnsi(result.stderr), /--dry-run can only be used/);
  });

  it('skill link --dry-run does not create links', () => {
    const home = makeHome();
    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);

    const result = runCli(['skill', 'link', 'code-review', 'codex', '--dry-run'], home);

    assert.equal(result.status, 0);
    assert.match(stripAnsi(result.stdout), /Would link codex/);
    assert.ok(!existsSync(join(home, '.agents', 'skills', 'code-review', 'SKILL.md')));
  });

  it('skill link --dry-run exits 1 when the plan is blocked', () => {
    const home = makeHome();
    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    const dest = createFile(join(home, '.agents', 'skills', 'code-review', 'SKILL.md'), 'keep\n');

    const result = runCli(['skill', 'link', 'code-review', 'codex', '--dry-run', '--json'], home);
    const payload = JSON.parse(result.stdout);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, false);
    assert.equal(payload.results[0].status, 'blocked');
    assert.equal(readFileSync(dest, 'utf8'), 'keep\n');
  });

  it('skill link --force --dry-run does not replace files', () => {
    const home = makeHome();
    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    const dest = createFile(join(home, '.agents', 'skills', 'code-review', 'SKILL.md'), 'keep\n');

    const result = runCli(['skill', 'link', 'code-review', 'codex', '--force', '--dry-run'], home);

    assert.equal(result.status, 0);
    assert.match(stripAnsi(result.stdout), /Would replace codex/);
    assert.equal(readFileSync(dest, 'utf8'), 'keep\n');
  });

  it('skill unlink --dry-run does not remove links', () => {
    const home = makeHome();
    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    runCli(['skill', 'link', 'code-review', 'codex'], home);
    const dest = join(home, '.agents', 'skills', 'code-review', 'SKILL.md');

    const result = runCli(['skill', 'unlink', 'code-review', 'codex', '--dry-run'], home);

    assert.equal(result.status, 0);
    assert.match(stripAnsi(result.stdout), /Would unlink codex/);
    assert.ok(existsSync(dest));
    assert.equal(readlinkSync(dest), join(home, '.promptpie', 'skills', 'code-review', 'SKILL.md'));
  });

  it('skill rm --dry-run does not remove the skill', () => {
    const home = makeHome();
    runCli(['init'], home);
    runCli(['skill', 'add', 'code-review'], home);
    runCli(['skill', 'link', 'code-review', 'codex'], home);

    const result = runCli(['skill', 'rm', 'code-review', '--dry-run'], home);

    assert.equal(result.status, 0);
    assert.match(stripAnsi(result.stdout), /would remove skill/i);
    assert.ok(existsSync(join(home, '.promptpie', 'skills', 'code-review', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.agents', 'skills', 'code-review', 'SKILL.md')));
  });

  it('--json emits structured success output', () => {
    const home = makeHome();
    runCli(['init'], home);

    const result = runCli(['skill', 'add', 'code-review', '--json'], home);
    const payload = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'skill.add');
    assert.equal(payload.name, 'code-review');
    assert.equal(payload.path, join(home, '.promptpie', 'skills', 'code-review', 'SKILL.md'));
  });

  it('--json emits structured errors on stderr', () => {
    const result = runCli(['skill', 'add', '.hidden', '--json']);
    const payload = JSON.parse(result.stderr);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'INVALID_SKILL_NAME');
    assert.match(payload.error.message, /Invalid skill name/);
  });
});

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'ppie-cli-'));
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

function readSkill(home, name) {
  return readFileSync(join(home, '.promptpie', 'skills', name, 'SKILL.md'), 'utf8');
}

function createFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}
