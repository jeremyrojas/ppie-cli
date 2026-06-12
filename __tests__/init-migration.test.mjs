import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'ppie-init-migration-'));
process.env.PPIE_HOME = TEST_HOME;

const { init } = await import('../lib/skills.mjs');
const { LEGACY_CODEX_SKILLS_DIR, TARGETS, TARGET_NAMES, skillSourcePath } = await import('../lib/paths.mjs');

const BIN_PATH = fileURLToPath(new URL('../bin/ppie.mjs', import.meta.url));

describe('init legacy codex migration', () => {
  beforeEach(resetTestHome);
  afterEach(resetTestHome);

  it('migrates Prompt Pie-managed legacy codex symlinks into .agents', () => {
    const src = createSkillSource('code-review');
    const legacyLink = createLegacyCodexLink('code-review', src);

    const result = init();
    const dest = join(TARGETS.codex.skillsDir, 'code-review', 'SKILL.md');

    assert.equal(result.migration.foundLegacy, true);
    assert.equal(result.migration.migrated, 1);
    assert.equal(result.migration.skipped, 0);
    assert.ok(existsSync(dest));
    assert.ok(lstatSync(dest).isSymbolicLink());
    assert.equal(readlinkSync(dest), src);
    assert.ok(lstatSync(legacyLink).isSymbolicLink());
  });

  it('reports created directories on first run and existing directories on rerun', () => {
    const first = init();
    const second = init();

    assert.equal(first.directories.length, TARGET_NAMES.length + 1);
    assert.ok(first.directories.every(dir => dir.created));
    assert.equal(second.directories.length, TARGET_NAMES.length + 1);
    assert.ok(second.directories.every(dir => !dir.created));
  });

  it('skips legacy links that do not point to Prompt Pie skill sources', () => {
    const externalSource = createFile(join(TEST_HOME, 'other-skill.md'), '# external\n');
    createLegacyCodexLink('external', externalSource);

    const result = init();
    const dest = join(TARGETS.codex.skillsDir, 'external', 'SKILL.md');

    assert.equal(result.migration.migrated, 0);
    assert.equal(result.migration.skipped, 1);
    assert.ok(!existsSync(dest));
  });

  it('skips migration when the .agents destination already exists', () => {
    const src = createSkillSource('existing');
    createLegacyCodexLink('existing', src);
    const dest = join(TARGETS.codex.skillsDir, 'existing', 'SKILL.md');
    createFile(dest, 'keep me\n');

    const result = init();

    assert.equal(result.migration.migrated, 0);
    assert.equal(result.migration.skipped, 1);
    assert.equal(readFileSync(dest, 'utf8'), 'keep me\n');
  });

  it('ppie init reports legacy migration in CLI output', () => {
    const src = createSkillSource('cli-migrate');
    createLegacyCodexLink('cli-migrate', src);

    const result = spawnSync(process.execPath, [BIN_PATH, 'init'], {
      env: { ...process.env, PPIE_HOME: TEST_HOME },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /\.codex\/skills/);
    assert.match(result.stdout, /\.agents\/skills/);
    assert.match(result.stdout, /Migrated 1 legacy Codex link/);
  });

  it('ppie init reports created vs already exists in CLI output', () => {
    const first = spawnSync(process.execPath, [BIN_PATH, 'init'], {
      env: { ...process.env, PPIE_HOME: TEST_HOME },
      encoding: 'utf8',
    });
    const second = spawnSync(process.execPath, [BIN_PATH, 'init'], {
      env: { ...process.env, PPIE_HOME: TEST_HOME },
      encoding: 'utf8',
    });

    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.match(first.stdout, /Created .*\.promptpie\/skills/);
    for (const target of TARGET_NAMES) {
      const escaped = TARGETS[target].skillsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(first.stdout, new RegExp(`Created .*${escaped}`));
    }
    assert.match(second.stdout, /Already exists .*\.promptpie\/skills/);
    for (const target of TARGET_NAMES) {
      const escaped = TARGETS[target].skillsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(second.stdout, new RegExp(`Already exists .*${escaped}`));
    }
  });
});

function resetTestHome() {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
}

function createSkillSource(name) {
  const src = skillSourcePath(name);
  createFile(src, `# ${name}\n`);
  return src;
}

function createLegacyCodexLink(name, target) {
  const legacyLink = join(LEGACY_CODEX_SKILLS_DIR, name, 'SKILL.md');
  mkdirSync(dirname(legacyLink), { recursive: true });
  symlinkSync(target, legacyLink);
  return legacyLink;
}

function createFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}
