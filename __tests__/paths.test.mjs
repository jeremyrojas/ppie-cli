import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'os';
import { join } from 'path';

delete process.env.PPIE_HOME;

const {
  LEGACY_CODEX_SKILLS_DIR, PROMPTPIE_DIR, SKILLS_DIR, TARGETS, TARGET_NAMES,
  skillSourcePath, skillTargetPath,
} = await import('../lib/paths.mjs');

const HOME = homedir();

describe('paths', () => {
  it('PROMPTPIE_DIR is under home', () => {
    assert.equal(PROMPTPIE_DIR, join(HOME, '.promptpie'));
  });

  it('SKILLS_DIR is under PROMPTPIE_DIR', () => {
    assert.equal(SKILLS_DIR, join(HOME, '.promptpie', 'skills'));
  });

  it('legacy codex dir is still under home', () => {
    assert.equal(LEGACY_CODEX_SKILLS_DIR, join(HOME, '.codex', 'skills'));
  });

  it('TARGET_NAMES contains claude, codex, and cursor', () => {
    assert.deepEqual(TARGET_NAMES.sort(), ['claude', 'codex', 'cursor']);
  });

  it('each target has the expected skillsDir under home', () => {
    assert.equal(TARGETS.claude.skillsDir, join(HOME, '.claude', 'skills'));
    assert.equal(TARGETS.codex.skillsDir, join(HOME, '.agents', 'skills'));
    assert.equal(TARGETS.cursor.skillsDir, join(HOME, '.cursor', 'skills'));
  });
});

describe('skillSourcePath', () => {
  it('returns SKILL.md inside skills/<name>/', () => {
    assert.equal(
      skillSourcePath('code-review'),
      join(HOME, '.promptpie', 'skills', 'code-review', 'SKILL.md'),
    );
  });
});

describe('skillTargetPath', () => {
  it('returns correct path for claude target', () => {
    assert.equal(
      skillTargetPath('claude', 'my-skill'),
      join(HOME, '.claude', 'skills', 'my-skill', 'SKILL.md'),
    );
  });

  it('returns correct path for codex target', () => {
    assert.equal(
      skillTargetPath('codex', 'my-skill'),
      join(HOME, '.agents', 'skills', 'my-skill', 'SKILL.md'),
    );
  });

  it('returns correct path for cursor target', () => {
    assert.equal(
      skillTargetPath('cursor', 'my-skill'),
      join(HOME, '.cursor', 'skills', 'my-skill', 'SKILL.md'),
    );
  });

  it('throws on unknown target', () => {
    assert.throws(
      () => skillTargetPath('unknown', 'x'),
      /Unknown target/,
    );
  });
});
