import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync,
  readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const TEST_HOME = join(tmpdir(), `ppie-skills-${process.pid}`);
process.env.PPIE_HOME = TEST_HOME;

const {
  init, addSkill, importSkill, removeSkill,
  linkSkill, unlinkSkill, listSkills, inspectSkill,
  getStatus, runDoctor, planRemoveSkill, planLinkSkill, planUnlinkSkill,
} = await import('../lib/skills.mjs');
const {
  LEGACY_CODEX_SKILLS_DIR, SKILLS_DIR, TARGETS, TARGET_NAMES,
  skillSourcePath, skillTargetPath,
} = await import('../lib/paths.mjs');

describe('init', () => {
  beforeEach(resetTestHome);
  afterEach(resetTestHome);

  it('creates the source and target directories', () => {
    const result = init();

    assert.equal(result.promptpie, SKILLS_DIR);
    assert.ok(existsSync(SKILLS_DIR));
    for (const target of TARGET_NAMES) {
      assert.ok(existsSync(TARGETS[target].skillsDir));
    }
  });

  it('returns the expected paths and no legacy migration by default', () => {
    const result = init();

    assert.deepEqual(result.targets.sort(), TARGET_NAMES.map(t => TARGETS[t].skillsDir).sort());
    assert.equal(result.directories.length, TARGET_NAMES.length + 1);
    assert.equal(result.migrations.length, 1);
    assert.equal(result.migration.foundLegacy, false);
    assert.equal(result.migration.legacyDir, LEGACY_CODEX_SKILLS_DIR);
    assert.equal(result.migration.currentDir, TARGETS.codex.skillsDir);
  });

  it('is idempotent', () => {
    init();

    assert.doesNotThrow(() => init());
  });
});

describe('addSkill', () => {
  beforeEach(resetTestHome);
  afterEach(resetTestHome);

  it('creates SKILL.md with the template frontmatter', () => {
    const path = addSkill('code-review');

    assert.equal(path, skillSourcePath('code-review'));
    assert.ok(existsSync(path));
    const content = readFileSync(path, 'utf8');
    assert.match(content, /^---\nname: "code-review"\ndescription: ""\n---/);
    assert.match(content, /# code-review/);
  });

  it('throws on duplicate name', () => {
    addSkill('code-review');

    assert.throws(() => addSkill('code-review'), /already exists/);
  });

  it('preserves existing sibling skills when adding another skill', () => {
    const first = addSkill('alpha');
    const second = addSkill('beta');

    assert.ok(existsSync(first));
    assert.ok(existsSync(second));
    assert.deepEqual(readdirSync(SKILLS_DIR).sort(), ['alpha', 'beta']);
  });

  it('rejects empty names', () => {
    assert.throws(() => addSkill(''), /required/);
  });

  it('rejects names longer than 64 characters', () => {
    assert.throws(() => addSkill('a'.repeat(65)), /too long/);
  });

  it('rejects names with invalid characters or path separators', () => {
    assert.throws(() => addSkill('foo/bar'), /Invalid skill name/);
    assert.throws(() => addSkill('a@b'), /Invalid skill name/);
  });

  it('rejects traversal-like names', () => {
    assert.throws(() => addSkill('../hack'), /Invalid skill name/);
    assert.throws(() => addSkill('..'), /Invalid skill name/);
  });

  it('rejects names starting with non-alphanumeric characters', () => {
    assert.throws(() => addSkill('.hidden'), /Invalid skill name/);
    assert.throws(() => addSkill('-dash'), /Invalid skill name/);
  });
});

describe('importSkill', () => {
  beforeEach(resetTestHome);
  afterEach(resetTestHome);

  it('copies file content and preserves the original file', () => {
    const source = createFile(join(TEST_HOME, 'source.md'), '# imported\n');
    const path = importSkill('imported', source);

    assert.equal(path, skillSourcePath('imported'));
    assert.equal(readFileSync(path, 'utf8'), '# imported\n');
    assert.equal(readFileSync(source, 'utf8'), '# imported\n');
  });

  it('throws on duplicate name', () => {
    const source = createFile(join(TEST_HOME, 'source.md'), '# imported\n');
    importSkill('imported', source);

    assert.throws(() => importSkill('imported', source), /already exists/);
  });

  it('throws on missing source file', () => {
    assert.throws(() => importSkill('imported', join(TEST_HOME, 'missing.md')), /Source file not found/);
  });

  it('rejects invalid names', () => {
    const source = createFile(join(TEST_HOME, 'source.md'), '# imported\n');

    assert.throws(() => importSkill('../hack', source), /Invalid skill name/);
  });
});

describe('removeSkill', () => {
  beforeEach(resetTestHome);
  afterEach(resetTestHome);

  it('removes the skill directory and all links across targets', () => {
    addSkill('review');
    init();
    linkSkill('review', TARGET_NAMES);

    removeSkill('review');

    assert.ok(!existsSync(skillSourcePath('review')));
    for (const target of TARGET_NAMES) {
      assert.ok(!existsSync(skillTargetPath(target, 'review')));
    }
  });

  it('throws on nonexistent skill', () => {
    assert.throws(() => removeSkill('missing'), /not found/);
  });

  it('rejects invalid names', () => {
    assert.throws(() => removeSkill('../hack'), /Invalid skill name/);
  });
});

describe('linkSkill', () => {
  beforeEach(resetTestHome);
  afterEach(resetTestHome);

  it('creates a symlink for each target', () => {
    addSkill('review');
    init();
    const results = linkSkill('review', TARGET_NAMES);

    assert.equal(results.length, TARGET_NAMES.length);
    assert.ok(results.every(result => result.status === 'linked'));
    for (const target of TARGET_NAMES) {
      assert.ok(existsSync(skillTargetPath(target, 'review')));
    }
  });

  it('creates symlinks that point to the source and are readable', () => {
    const src = addSkill('review');
    init();

    linkSkill('review', ['claude']);

    const dest = skillTargetPath('claude', 'review');
    assert.equal(readlinkSync(dest), src);
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(src, 'utf8'));
  });

  it('leaves an existing managed symlink unchanged', () => {
    const src = addSkill('review');
    init();
    linkSkill('review', ['claude']);

    const results = linkSkill('review', ['claude']);

    assert.equal(results[0].status, 'unchanged');
    assert.equal(readlinkSync(skillTargetPath('claude', 'review')), src);
  });

  it('refuses to replace an existing broken foreign symlink without force', () => {
    addSkill('review');
    init();
    const dest = skillTargetPath('claude', 'review');
    mkdirSync(join(TARGETS.claude.skillsDir, 'review'), { recursive: true });
    symlinkSync(join(TEST_HOME, 'missing.md'), dest);

    assert.throws(() => linkSkill('review', ['claude']), /Refusing to replace existing broken symlink/);
    assert.equal(readlinkSync(dest), join(TEST_HOME, 'missing.md'));
  });

  it('replaces an existing broken foreign symlink with force', () => {
    addSkill('review');
    init();
    const dest = skillTargetPath('claude', 'review');
    mkdirSync(join(TARGETS.claude.skillsDir, 'review'), { recursive: true });
    symlinkSync(join(TEST_HOME, 'missing.md'), dest);

    const results = linkSkill('review', ['claude'], { force: true });

    assert.equal(results[0].status, 'replaced');
    assert.equal(readlinkSync(dest), skillSourcePath('review'));
  });

  it('refuses to replace an existing file without force', () => {
    addSkill('review');
    init();
    const dest = createFile(skillTargetPath('claude', 'review'), 'keep\n');

    assert.throws(() => linkSkill('review', ['claude']), /Refusing to replace existing file/);
    assert.equal(readFileSync(dest, 'utf8'), 'keep\n');
  });

  it('replaces an existing file with force', () => {
    addSkill('review');
    init();
    const dest = createFile(skillTargetPath('claude', 'review'), 'keep\n');

    const results = linkSkill('review', ['claude'], { force: true });

    assert.equal(results[0].status, 'replaced');
    assert.equal(readlinkSync(dest), skillSourcePath('review'));
  });

  it('refuses to replace a foreign symlink without force', () => {
    addSkill('review');
    init();
    const dest = skillTargetPath('claude', 'review');
    mkdirSync(dirname(dest), { recursive: true });
    const external = createFile(join(TEST_HOME, 'external.md'), '# external\n');
    symlinkSync(external, dest);

    assert.throws(() => linkSkill('review', ['claude']), /Refusing to replace existing symlink/);
    assert.equal(readlinkSync(dest), external);
  });

  it('replaces a foreign symlink with force', () => {
    addSkill('review');
    init();
    const dest = skillTargetPath('claude', 'review');
    mkdirSync(dirname(dest), { recursive: true });
    const external = createFile(join(TEST_HOME, 'external.md'), '# external\n');
    symlinkSync(external, dest);

    const results = linkSkill('review', ['claude'], { force: true });

    assert.equal(results[0].status, 'replaced');
    assert.equal(readlinkSync(dest), skillSourcePath('review'));
  });

  it('throws on nonexistent skill', () => {
    init();

    assert.throws(() => linkSkill('missing', ['claude']), /not found/);
  });

  it('rejects invalid names', () => {
    assert.throws(() => linkSkill('../hack', ['claude']), /Invalid skill name/);
  });

  it('throws on invalid targets', () => {
    addSkill('review');
    init();

    assert.throws(() => linkSkill('review', ['bogus']), /Unknown target/);
  });
});

describe('unlinkSkill', () => {
  beforeEach(resetTestHome);
  afterEach(resetTestHome);

  it('removes the symlink and cleans up an empty target directory', () => {
    addSkill('review');
    init();
    linkSkill('review', ['claude']);

    unlinkSkill('review', 'claude');

    assert.ok(!existsSync(skillTargetPath('claude', 'review')));
    assert.ok(!existsSync(join(TARGETS.claude.skillsDir, 'review')));
  });

  it('does not remove the target directory if other files remain', () => {
    addSkill('review');
    init();
    linkSkill('review', ['claude']);
    createFile(join(TARGETS.claude.skillsDir, 'review', 'notes.txt'), 'keep\n');

    unlinkSkill('review', 'claude');

    assert.ok(existsSync(join(TARGETS.claude.skillsDir, 'review')));
    assert.equal(readFileSync(join(TARGETS.claude.skillsDir, 'review', 'notes.txt'), 'utf8'), 'keep\n');
  });

  it('throws if the skill is not linked', () => {
    init();

    assert.throws(() => unlinkSkill('review', 'claude'), /not linked/);
  });

  it('refuses to remove a foreign symlink', () => {
    addSkill('review');
    init();
    const dest = skillTargetPath('claude', 'review');
    mkdirSync(dirname(dest), { recursive: true });
    const external = createFile(join(TEST_HOME, 'external.md'), '# external\n');
    symlinkSync(external, dest);

    assert.throws(() => unlinkSkill('review', 'claude'), /not a Prompt Pie-managed symlink/);
    assert.equal(readlinkSync(dest), external);
  });

  it('refuses to remove a regular file', () => {
    addSkill('review');
    init();
    const dest = createFile(skillTargetPath('claude', 'review'), 'keep\n');

    assert.throws(() => unlinkSkill('review', 'claude'), /not a Prompt Pie-managed symlink/);
    assert.equal(readFileSync(dest, 'utf8'), 'keep\n');
  });

  it('rejects invalid names', () => {
    assert.throws(() => unlinkSkill('../hack', 'claude'), /Invalid skill name/);
  });
});

describe('listSkills', () => {
  beforeEach(resetTestHome);
  afterEach(resetTestHome);

  it('returns [] when the skills directory does not exist', () => {
    assert.deepEqual(listSkills(), []);
  });

  it('returns [] when the skills directory exists but is empty', () => {
    init();

    assert.deepEqual(listSkills(), []);
  });

  it('lists skills with the correct link status', () => {
    addSkill('alpha');
    addSkill('beta');
    init();
    linkSkill('alpha', ['claude']);

    const skills = listSkills();

    assert.deepEqual(skills.map(skill => skill.name), ['alpha', 'beta']);
    assert.deepEqual(skills[0].linkedTo, [{ target: 'claude', valid: true }]);
    assert.deepEqual(skills[1].linkedTo, []);
  });

  it('sorts skills alphabetically', () => {
    addSkill('zeta');
    addSkill('alpha');

    assert.deepEqual(listSkills().map(skill => skill.name), ['alpha', 'zeta']);
  });

  it('detects invalid symlink targets', () => {
    addSkill('review');
    init();
    const dest = skillTargetPath('claude', 'review');
    mkdirSync(join(TARGETS.claude.skillsDir, 'review'), { recursive: true });
    const external = createFile(join(TEST_HOME, 'external.md'), '# external\n');
    symlinkSync(external, dest);

    const skills = listSkills();

    assert.deepEqual(skills[0].linkedTo, [{ target: 'claude', valid: false }]);
  });
});

describe('inspectSkill', () => {
  beforeEach(resetTestHome);
  afterEach(resetTestHome);

  it('returns one skill with normalized target statuses', () => {
    addSkill('review');
    init();
    linkSkill('review', ['claude']);
    const cursorDest = createFile(skillTargetPath('cursor', 'review'), 'keep\n');
    const codexDest = skillTargetPath('codex', 'review');
    mkdirSync(dirname(codexDest), { recursive: true });
    const external = createFile(join(TEST_HOME, 'external.md'), '# external\n');
    symlinkSync(external, codexDest);

    const skill = inspectSkill('review');

    assert.equal(skill.name, 'review');
    assert.equal(skill.path, skillSourcePath('review'));
    assert.deepEqual(
      skill.targets.map(target => [target.target, target.status]),
      [
        ['claude', 'linked'],
        ['codex', 'foreign_symlink'],
        ['cursor', 'file'],
      ],
    );
    assert.equal(skill.targets.find(target => target.target === 'cursor').path, cursorDest);
  });

  it('throws for a missing skill', () => {
    assert.throws(() => inspectSkill('missing'), /not found/);
  });
});

describe('getStatus', () => {
  beforeEach(resetTestHome);
  afterEach(resetTestHome);

  it('reports incomplete setup without mutating files', () => {
    const status = getStatus();

    assert.equal(status.initialized, false);
    assert.equal(status.skillCount, 0);
    assert.equal(status.issueCount, 4);
    assert.equal(status.suggestedCommand, 'ppie doctor');
    assert.ok(!existsSync(SKILLS_DIR));
  });

  it('reports linked counts after setup', () => {
    init();
    addSkill('review');
    linkSkill('review', ['claude', 'codex']);

    const status = getStatus();

    assert.equal(status.initialized, true);
    assert.equal(status.skillCount, 1);
    assert.equal(status.issueCount, 0);
    assert.deepEqual(
      status.targets.map(target => [target.target, target.linkedCount]),
      [
        ['claude', 1],
        ['codex', 1],
        ['cursor', 0],
      ],
    );
  });
});

describe('runDoctor', () => {
  beforeEach(resetTestHome);
  afterEach(resetTestHome);

  it('reports missing setup as errors', () => {
    const result = runDoctor();

    assert.equal(result.summary.ok, false);
    assert.equal(result.summary.errorCount, 4);
    assert.deepEqual(result.issues.map(issue => issue.code), [
      'MISSING_SOURCE_DIR',
      'MISSING_TARGET_DIR',
      'MISSING_TARGET_DIR',
      'MISSING_TARGET_DIR',
    ]);
  });

  it('passes for a clean initialized setup', () => {
    init();

    const result = runDoctor();

    assert.equal(result.summary.ok, true);
    assert.deepEqual(result.issues, []);
  });

  it('reports target path blockers with suggested commands', () => {
    init();
    addSkill('review');
    const dest = createFile(skillTargetPath('claude', 'review'), 'keep\n');

    const result = runDoctor();

    assert.equal(result.summary.ok, false);
    assert.deepEqual(result.issues[0], {
      code: 'TARGET_PATH_BLOCKED',
      severity: 'error',
      message: 'Claude Code path for "review" is blocked by an existing file.',
      target: 'claude',
      path: dest,
      suggestedCommand: 'ppie skill link review claude --force --dry-run',
    });
  });

  it('reports invalid skill directory names without shell commands', () => {
    init();
    const invalidName = 'evil; touch SHOULD_NOT_RUN';
    const invalidDir = join(SKILLS_DIR, invalidName);
    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(join(invalidDir, 'SKILL.md'), '# unsafe\n', 'utf8');

    const result = runDoctor();
    const issue = result.issues.find(issue => issue.code === 'INVALID_SKILL_DIR_NAME');

    assert.equal(result.summary.ok, false);
    assert.equal(issue.path, invalidDir);
    assert.equal(issue.suggestedCommand, undefined);
    assert.ok(result.issues.every(issue => !issue.suggestedCommand?.includes(invalidName)));
  });

  it('reports invalid target skill directory names without shell commands', () => {
    init();
    const invalidName = 'evil; touch SHOULD_NOT_RUN';
    const invalidDir = join(TARGETS.claude.skillsDir, invalidName);
    mkdirSync(invalidDir, { recursive: true });

    const result = runDoctor();
    const issue = result.issues.find(issue => issue.code === 'INVALID_TARGET_SKILL_DIR_NAME');

    assert.equal(result.summary.ok, false);
    assert.equal(issue.path, invalidDir);
    assert.equal(issue.suggestedCommand, undefined);
    assert.ok(result.issues.every(issue => !issue.suggestedCommand?.includes(invalidName)));
  });

  it('reports expected paths that are files instead of directories', () => {
    mkdirSync(dirname(SKILLS_DIR), { recursive: true });
    writeFileSync(SKILLS_DIR, 'not a directory\n', 'utf8');

    const result = runDoctor();

    assert.equal(result.summary.ok, false);
    assert.ok(result.issues.some(issue => issue.code === 'SOURCE_DIR_NOT_DIRECTORY' && issue.path === SKILLS_DIR));
  });

  it('reports target paths that are files instead of directories', () => {
    init();
    rmSync(TARGETS.claude.skillsDir, { recursive: true });
    writeFileSync(TARGETS.claude.skillsDir, 'not a directory\n', 'utf8');

    const result = runDoctor();

    assert.equal(result.summary.ok, false);
    assert.ok(result.issues.some(issue =>
      issue.code === 'TARGET_DIR_NOT_DIRECTORY' &&
      issue.path === TARGETS.claude.skillsDir &&
      issue.target === 'claude',
    ));
  });

  it('reports directories that cannot be traversed', () => {
    init();
    chmodSync(TARGETS.codex.skillsDir, 0o600);

    try {
      const result = runDoctor();
      const issue = result.issues.find(issue =>
        issue.code === 'TARGET_DIR_NOT_ACCESSIBLE' && issue.target === 'codex',
      );

      assert.equal(result.summary.ok, false);
      assert.equal(issue.path, TARGETS.codex.skillsDir);
    } finally {
      chmodSync(TARGETS.codex.skillsDir, 0o700);
    }
  });
});

describe('dry-run planning helpers', () => {
  beforeEach(resetTestHome);
  afterEach(resetTestHome);

  it('plans link operations without creating target links', () => {
    init();
    addSkill('review');

    const plan = planLinkSkill('review', ['claude']);

    assert.equal(plan.results[0].status, 'would_link');
    assert.ok(!existsSync(skillTargetPath('claude', 'review')));
  });

  it('plans forced replacements without touching existing files', () => {
    init();
    addSkill('review');
    const dest = createFile(skillTargetPath('claude', 'review'), 'keep\n');

    const blocked = planLinkSkill('review', ['claude']);
    const forced = planLinkSkill('review', ['claude'], { force: true });

    assert.equal(blocked.results[0].status, 'blocked');
    assert.equal(forced.results[0].status, 'would_replace');
    assert.equal(readFileSync(dest, 'utf8'), 'keep\n');
  });

  it('blocks broken foreign symlink replacement without force', () => {
    init();
    addSkill('review');
    const dest = skillTargetPath('claude', 'review');
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(join(TEST_HOME, 'missing.md'), dest);

    const plan = planLinkSkill('review', ['claude']);

    assert.equal(plan.results[0].status, 'blocked');
    assert.equal(readlinkSync(dest), join(TEST_HOME, 'missing.md'));
  });

  it('plans forced broken foreign symlink replacement without touching it', () => {
    init();
    addSkill('review');
    const dest = skillTargetPath('claude', 'review');
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(join(TEST_HOME, 'missing.md'), dest);

    const plan = planLinkSkill('review', ['claude'], { force: true });

    assert.equal(plan.results[0].status, 'would_replace');
    assert.equal(readlinkSync(dest), join(TEST_HOME, 'missing.md'));
  });

  it('plans unlink operations without removing target links', () => {
    init();
    addSkill('review');
    linkSkill('review', ['claude']);

    const plan = planUnlinkSkill('review', ['claude']);

    assert.equal(plan.results[0].status, 'would_unlink');
    assert.ok(existsSync(skillTargetPath('claude', 'review')));
  });

  it('plans remove operations without deleting the skill or links', () => {
    init();
    addSkill('review');
    linkSkill('review', ['claude']);

    const plan = planRemoveSkill('review');

    assert.equal(plan.results.find(result => result.target === 'claude').status, 'would_unlink');
    assert.ok(existsSync(skillSourcePath('review')));
    assert.ok(existsSync(skillTargetPath('claude', 'review')));
  });
});

function resetTestHome() {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
}

function createFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}
