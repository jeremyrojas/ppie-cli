import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'ppie-paths-override-'));
process.env.PPIE_HOME = TEST_HOME;

const {
  LEGACY_CODEX_SKILLS_DIR, PROMPTPIE_DIR, SKILLS_DIR, TARGETS,
  skillSourcePath, skillTargetPath,
} = await import('../lib/paths.mjs');

after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('paths override', () => {
  it('uses PPIE_HOME for Prompt Pie directories', () => {
    assert.equal(PROMPTPIE_DIR, join(TEST_HOME, '.promptpie'));
    assert.equal(SKILLS_DIR, join(TEST_HOME, '.promptpie', 'skills'));
  });

  it('uses PPIE_HOME for target directories', () => {
    assert.equal(TARGETS.claude.skillsDir, join(TEST_HOME, '.claude', 'skills'));
    assert.equal(TARGETS.codex.skillsDir, join(TEST_HOME, '.agents', 'skills'));
    assert.equal(TARGETS.cursor.skillsDir, join(TEST_HOME, '.cursor', 'skills'));
    assert.equal(LEGACY_CODEX_SKILLS_DIR, join(TEST_HOME, '.codex', 'skills'));
  });

  it('uses PPIE_HOME in skillSourcePath', () => {
    assert.equal(
      skillSourcePath('code-review'),
      join(TEST_HOME, '.promptpie', 'skills', 'code-review', 'SKILL.md'),
    );
  });

  it('uses PPIE_HOME in skillTargetPath', () => {
    assert.equal(
      skillTargetPath('codex', 'code-review'),
      join(TEST_HOME, '.agents', 'skills', 'code-review', 'SKILL.md'),
    );
    assert.equal(
      skillTargetPath('cursor', 'code-review'),
      join(TEST_HOME, '.cursor', 'skills', 'code-review', 'SKILL.md'),
    );
  });
});
