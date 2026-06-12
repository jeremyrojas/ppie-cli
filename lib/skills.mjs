import {
  mkdirSync, readFileSync, writeFileSync, readdirSync,
  lstatSync, symlinkSync, unlinkSync, rmSync, existsSync, readlinkSync,
  accessSync, constants, statSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import {
  SKILLS_DIR, TARGET_ENTRIES, TARGET_NAMES, TARGETS,
  skillSourcePath, skillTargetPath,
} from './paths.mjs';
import { createError } from './errors.mjs';
import { validateName } from './validate.mjs';

const SKILL_TEMPLATE = (name) => `---
name: "${name}"
description: ""
---

# ${name}

<!-- Write your skill instructions here -->
`;

// ─── Init ────────────────────────────────────────────────────────────

export function init() {
  const promptpie = ensureDir(SKILLS_DIR);
  const targets = TARGET_ENTRIES.map(target => ({
    target: target.name,
    ...ensureDir(target.skillsDir),
  }));
  const migrationTargets = TARGET_ENTRIES.filter(target => target.migration);
  const migrations = migrationTargets.map(target => migrateLegacyTargetLinks(target));
  const migration = migrations[0] ?? emptyMigrationResult(migrationTargets[0]);
  return {
    promptpie: promptpie.path,
    targets: targets.map(t => t.path),
    directories: [
      { name: 'promptpie', ...promptpie },
      ...targets.map(({ target, path, created }) => ({ name: target, path, created })),
    ],
    migrations,
    migration,
  };
}

// ─── Add ─────────────────────────────────────────────────────────────

export function addSkill(name) {
  validateName(name);
  const src = skillSourcePath(name);
  if (existsSync(src)) {
    throw createError('SKILL_ALREADY_EXISTS', `Skill "${name}" already exists at ${src}`, { name, path: src });
  }
  mkdirSync(dirname(src), { recursive: true });
  writeFileSync(src, SKILL_TEMPLATE(name), 'utf8');
  return src;
}

/** Import an existing SKILL.md file as a new skill */
export function importSkill(name, filePath) {
  validateName(name);
  const src = skillSourcePath(name);
  if (existsSync(src)) {
    throw createError('SKILL_ALREADY_EXISTS', `Skill "${name}" already exists at ${src}`, { name, path: src });
  }
  if (!existsSync(filePath)) {
    throw createError('SOURCE_FILE_NOT_FOUND', `Source file not found: ${filePath}`, { filePath });
  }
  mkdirSync(dirname(src), { recursive: true });
  writeFileSync(src, readFileSync(filePath, 'utf8'), 'utf8');
  return src;
}

// ─── Remove ──────────────────────────────────────────────────────────

export function removeSkill(name) {
  validateName(name);
  const src = skillSourcePath(name);
  if (!existsSync(src)) {
    throw createError('SKILL_NOT_FOUND', `Skill "${name}" not found`, { name, path: src });
  }
  // Remove all symlinks first
  for (const target of TARGET_NAMES) {
    try {
      unlinkSkill(name, target);
    } catch (error) {
      if (error.code === 'SKILL_NOT_LINKED' || error.code === 'LINK_NOT_MANAGED') continue;
      throw error;
    }
  }
  // Remove the skill directory
  rmSync(dirname(src), { recursive: true });
}

export function planRemoveSkill(name) {
  validateName(name);
  const src = skillSourcePath(name);
  if (!existsSync(src)) {
    throw createError('SKILL_NOT_FOUND', `Skill "${name}" not found`, { name, path: src });
  }

  return {
    name,
    sourceOfTruth: src,
    sourceDirectory: dirname(src),
    results: TARGET_NAMES.map(target => {
      const dest = skillTargetPath(target, name);
      const state = inspectTargetPath(dest, src);

      if (state.type === 'managed_symlink') {
        return { target, path: dest, status: 'would_unlink' };
      }

      if (state.type === 'missing') {
        return { target, path: dest, status: 'not_linked' };
      }

      return {
        target,
        path: dest,
        status: 'skipped',
        existingType: state.type,
        resolvedTarget: state.resolvedTarget,
      };
    }),
  };
}

// ─── Link ────────────────────────────────────────────────────────────

export function linkSkill(name, targets, options = {}) {
  const { force = false } = options;
  validateName(name);
  const src = skillSourcePath(name);
  if (!existsSync(src)) {
    throw createError('SKILL_NOT_FOUND', `Skill "${name}" not found. Run: ppie skill add ${name}`, { name, path: src });
  }

  const plans = targets.map(target => {
    const dest = skillTargetPath(target, name);
    return { target, path: dest, ...planLinkTarget(dest, src, force) };
  });

  const results = [];
  for (const plan of plans) {
    mkdirSync(dirname(plan.path), { recursive: true });

    if (plan.status === 'unchanged') {
      results.push({ target: plan.target, path: plan.path, status: plan.status });
      continue;
    }

    if (plan.replaceExisting) {
      unlinkSync(plan.path);
    }

    symlinkSync(src, plan.path);
    results.push({ target: plan.target, path: plan.path, status: plan.status });
  }
  return results;
}

export function planLinkSkill(name, targets, options = {}) {
  const { force = false } = options;
  validateName(name);
  const src = skillSourcePath(name);
  if (!existsSync(src)) {
    throw createError('SKILL_NOT_FOUND', `Skill "${name}" not found. Run: ppie skill add ${name}`, { name, path: src });
  }

  return {
    name,
    force,
    sourceOfTruth: src,
    results: targets.map(target => planLinkTargetAction(target, name, force)),
  };
}

// ─── Unlink ──────────────────────────────────────────────────────────

export function unlinkSkill(name, target) {
  validateName(name);
  const dest = skillTargetPath(target, name);
  const src = skillSourcePath(name);
  const state = inspectTargetPath(dest, src);

  if (state.type !== 'managed_symlink') {
    throw unlinkError(name, target, dest, state);
  }

  unlinkSync(dest);

  // Clean up empty directory in target
  const dir = dirname(dest);
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  } catch { /* ignore */ }

  return { target, path: dest, status: 'unlinked' };
}

export function planUnlinkSkill(name, targets) {
  validateName(name);
  const src = skillSourcePath(name);

  return {
    name,
    sourceOfTruth: src,
    results: targets.map(target => {
      const dest = skillTargetPath(target, name);
      const state = inspectTargetPath(dest, src);

      if (state.type === 'managed_symlink') {
        return { target, path: dest, status: 'would_unlink' };
      }

      if (state.type === 'missing') {
        return { target, path: dest, status: 'not_linked' };
      }

      return {
        target,
        path: dest,
        status: 'blocked',
        existingType: state.type,
        resolvedTarget: state.resolvedTarget,
        message: 'Target path is not a Prompt Pie-managed symlink.',
      };
    }),
  };
}

// ─── List ────────────────────────────────────────────────────────────

export function listSkills() {
  if (!isReadableDirectoryPath(SKILLS_DIR)) return [];

  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .filter(e => isValidSkillName(e.name))
    .map(e => {
      const name = e.name;
      const src = skillSourcePath(name);
      const linkedTo = [];

      for (const target of TARGET_NAMES) {
        if (!isReadableDirectoryPath(TARGETS[target].skillsDir)) continue;
        const dest = skillTargetPath(target, name);
        const state = inspectTargetPath(dest, src);
        if (state.type === 'managed_symlink') {
          linkedTo.push({ target, valid: !state.broken });
        } else if (state.type === 'foreign_symlink' || state.type === 'broken_symlink') {
          linkedTo.push({ target, valid: false });
        }
      }

      return { name, path: src, linkedTo };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function inspectSkill(name) {
  validateName(name);
  const src = skillSourcePath(name);
  if (!existsSync(src)) {
    throw createError('SKILL_NOT_FOUND', `Skill "${name}" not found`, { name, path: src });
  }

  return buildSkillInfo(name, src);
}

export function getStatus() {
  const skills = listSkills();
  const targetStatuses = TARGET_ENTRIES.map(target => {
    const linkedCount = skills.filter(skill =>
      skill.linkedTo.some(link => link.target === target.name && link.valid),
    ).length;
    const invalidCount = skills.filter(skill =>
      skill.linkedTo.some(link => link.target === target.name && !link.valid),
    ).length;
    const exists = existsSync(target.skillsDir);
    const isDirectory = isDirectoryPath(target.skillsDir);

    return {
      target: target.name,
      label: target.label,
      path: target.skillsDir,
      exists,
      isDirectory,
      linkedCount,
      invalidCount,
    };
  });
  const issues = collectDoctorIssues();

  return {
    initialized: isDirectoryPath(SKILLS_DIR) && targetStatuses.every(target => target.isDirectory),
    sourceOfTruth: SKILLS_DIR,
    sourceExists: existsSync(SKILLS_DIR),
    sourceIsDirectory: isDirectoryPath(SKILLS_DIR),
    skillCount: skills.length,
    targets: targetStatuses,
    issueCount: issues.length,
    suggestedCommand: issues.length > 0 ? 'ppie doctor' : null,
  };
}

export function runDoctor() {
  const issues = collectDoctorIssues();
  const errorCount = issues.filter(issue => issue.severity === 'error').length;
  const warningCount = issues.filter(issue => issue.severity === 'warning').length;

  return {
    issues,
    summary: {
      ok: errorCount === 0,
      errorCount,
      warningCount,
      issueCount: issues.length,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function buildSkillInfo(name, src) {
  return {
    name,
    path: src,
    exists: existsSync(src),
    targets: TARGET_ENTRIES.map(target => {
      const dest = skillTargetPath(target.name, name);
      const state = inspectTargetPath(dest, src);
      return normalizeTargetState(target, dest, state);
    }),
  };
}

function normalizeTargetState(target, path, state) {
  const status = state.type === 'managed_symlink'
    ? (state.broken ? 'broken' : 'linked')
    : state.type === 'missing'
      ? 'not_linked'
      : state.type;

  return {
    target: target.name,
    label: target.label,
    path,
    status,
    valid: state.type === 'managed_symlink' && !state.broken,
    existingType: state.type,
    rawTarget: state.rawTarget,
    resolvedTarget: state.resolvedTarget,
  };
}

function collectDoctorIssues() {
  const issues = [];

  if (!existsSync(SKILLS_DIR)) {
    issues.push({
      code: 'MISSING_SOURCE_DIR',
      severity: 'error',
      message: `Prompt Pie skills directory is missing: ${SKILLS_DIR}`,
      path: SKILLS_DIR,
      suggestedCommand: 'ppie init',
    });
  } else if (!isDirectoryPath(SKILLS_DIR)) {
    issues.push({
      code: 'SOURCE_DIR_NOT_DIRECTORY',
      severity: 'error',
      message: `Prompt Pie skills path exists but is not a directory: ${SKILLS_DIR}`,
      path: SKILLS_DIR,
    });
  } else {
    addAccessIssues(issues, 'SOURCE_DIR', SKILLS_DIR);
  }

  for (const target of TARGET_ENTRIES) {
    if (!existsSync(target.skillsDir)) {
      issues.push({
        code: 'MISSING_TARGET_DIR',
        severity: 'error',
        message: `${target.label} skills directory is missing: ${target.skillsDir}`,
        target: target.name,
        path: target.skillsDir,
        suggestedCommand: 'ppie init',
      });
    } else if (!isDirectoryPath(target.skillsDir)) {
      issues.push({
        code: 'TARGET_DIR_NOT_DIRECTORY',
        severity: 'error',
        message: `${target.label} skills path exists but is not a directory: ${target.skillsDir}`,
        target: target.name,
        path: target.skillsDir,
      });
    } else {
      addAccessIssues(issues, 'TARGET_DIR', target.skillsDir, target.name);
    }
  }

  for (const name of sourceSkillNames()) {
    if (!isValidSkillName(name)) {
      issues.push({
        code: 'INVALID_SKILL_DIR_NAME',
        severity: 'error',
        message: `Prompt Pie skill directory has an invalid name: ${name}`,
        path: join(SKILLS_DIR, name),
      });
      continue;
    }

    const src = skillSourcePath(name);
    if (!existsSync(src)) {
      issues.push({
        code: 'MISSING_SKILL_FILE',
        severity: 'error',
        message: `Skill "${name}" is missing SKILL.md in ${dirname(src)}`,
        path: src,
      });
      continue;
    }

    for (const target of TARGET_ENTRIES) {
      if (!isDirectoryPath(target.skillsDir)) continue;
      addTargetStateIssue(issues, target, name, src);
    }
  }

  for (const target of TARGET_ENTRIES) {
    addTargetOnlyIssues(issues, target);
  }

  for (const target of TARGET_ENTRIES.filter(target => target.migration)) {
    addLegacyIssues(issues, target);
  }

  return dedupeIssues(issues);
}

function addAccessIssues(issues, codePrefix, path, target = undefined) {
  try {
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    issues.push({
      code: `${codePrefix}_NOT_ACCESSIBLE`,
      severity: 'error',
      message: `Directory is not readable, writable, and traversable: ${path}`,
      target,
      path,
    });
  }
}

function sourceSkillNames() {
  if (!isReadableDirectoryPath(SKILLS_DIR)) return [];

  try {
    return readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function targetSkillNames(target) {
  if (!isReadableDirectoryPath(target.skillsDir)) return [];

  try {
    return readdirSync(target.skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function addTargetStateIssue(issues, target, name, src) {
  const dest = skillTargetPath(target.name, name);
  const state = inspectTargetPath(dest, src);

  switch (state.type) {
    case 'managed_symlink':
      if (state.broken) {
        issues.push({
          code: 'BROKEN_MANAGED_LINK',
          severity: 'error',
          message: `${target.label} link for "${name}" points to a missing Prompt Pie source file.`,
          target: target.name,
          path: dest,
          suggestedCommand: `ppie skill link ${name} ${target.name}`,
        });
      }
      break;

    case 'foreign_symlink':
      issues.push({
        code: 'FOREIGN_TARGET_LINK',
        severity: 'error',
        message: `${target.label} path for "${name}" is a symlink not managed by Prompt Pie.`,
        target: target.name,
        path: dest,
        suggestedCommand: `ppie skill link ${name} ${target.name} --force --dry-run`,
      });
      break;

    case 'broken_symlink':
      issues.push({
        code: 'BROKEN_FOREIGN_LINK',
        severity: 'error',
        message: `${target.label} path for "${name}" is a broken symlink not managed by Prompt Pie.`,
        target: target.name,
        path: dest,
        suggestedCommand: `ppie skill link ${name} ${target.name} --force --dry-run`,
      });
      break;

    case 'file':
    case 'directory':
    case 'other':
      issues.push({
        code: 'TARGET_PATH_BLOCKED',
        severity: 'error',
        message: `${target.label} path for "${name}" is blocked by an existing ${state.type}.`,
        target: target.name,
        path: dest,
        suggestedCommand: state.type === 'file' ? `ppie skill link ${name} ${target.name} --force --dry-run` : undefined,
      });
      break;

    default:
      break;
  }
}

function addTargetOnlyIssues(issues, target) {
  for (const name of targetSkillNames(target)) {
    if (!isValidSkillName(name)) {
      issues.push({
        code: 'INVALID_TARGET_SKILL_DIR_NAME',
        severity: 'error',
        message: `${target.label} skill directory has an invalid name: ${name}`,
        target: target.name,
        path: join(target.skillsDir, name),
      });
      continue;
    }

    const src = skillSourcePath(name);
    const dest = skillTargetPath(target.name, name);
    const state = inspectTargetPath(dest, src);

    if (state.type === 'managed_symlink' && state.broken) {
      issues.push({
        code: 'ORPHANED_TARGET_LINK',
        severity: 'error',
        message: `${target.label} has a Prompt Pie-managed link for missing skill "${name}".`,
        target: target.name,
        path: dest,
        suggestedCommand: `ppie skill unlink ${name} ${target.name}`,
      });
    }
  }
}

function addLegacyIssues(issues, target) {
  const legacyDir = target.migration.legacySkillsDir;
  if (!isDirectoryPath(legacyDir)) return;

  for (const name of targetSkillNames({ skillsDir: legacyDir })) {
    const legacyLink = join(legacyDir, name, 'SKILL.md');
    const src = skillSourcePath(name);
    const state = inspectTargetPath(legacyLink, src);

    if (state.type === 'managed_symlink') {
      issues.push({
        code: 'LEGACY_TARGET_LINK',
        severity: 'warning',
        message: `${target.label} has a legacy Prompt Pie-managed link under ${legacyDir}.`,
        target: target.name,
        path: legacyLink,
        suggestedCommand: 'ppie init',
      });
    }
  }
}

function dedupeIssues(issues) {
  const seen = new Set();
  const deduped = [];
  for (const issue of issues) {
    const key = `${issue.code}:${issue.path}:${issue.target ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }
  return deduped;
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirectoryPath(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isReadableDirectoryPath(path) {
  try {
    accessSync(path, constants.R_OK | constants.X_OK);
    return isDirectoryPath(path);
  } catch {
    return false;
  }
}

function isValidSkillName(name) {
  try {
    validateName(name);
    return true;
  } catch {
    return false;
  }
}

function inspectTargetPath(dest, expectedSrc) {
  try {
    const entry = lstatSync(dest);

    if (entry.isSymbolicLink()) {
      const rawTarget = readlinkSync(dest);
      const resolvedTarget = resolve(dirname(dest), rawTarget);

      if (resolvedTarget === expectedSrc) {
        return {
          type: 'managed_symlink',
          rawTarget,
          resolvedTarget,
          broken: !existsSync(resolvedTarget),
        };
      }

      if (!existsSync(resolvedTarget)) {
        return { type: 'broken_symlink', rawTarget, resolvedTarget };
      }

      return { type: 'foreign_symlink', rawTarget, resolvedTarget };
    }

    if (entry.isFile()) return { type: 'file' };
    if (entry.isDirectory()) return { type: 'directory' };
    return { type: 'other' };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { type: 'missing' };
    }
    throw error;
  }
}

function planLinkTarget(dest, src, force) {
  const state = inspectTargetPath(dest, src);

  switch (state.type) {
    case 'missing':
      return { replaceExisting: false, status: 'linked' };

    case 'managed_symlink':
      return { replaceExisting: state.broken, status: state.broken ? 'relinked' : 'unchanged' };

    case 'broken_symlink':
      if (!force) {
        throw createError(
          'LINK_TARGET_EXISTS',
          `Refusing to replace existing broken symlink at ${dest}. Re-run with --force to replace it.`,
          { path: dest, existingType: state.type, rawTarget: state.rawTarget, resolvedTarget: state.resolvedTarget },
        );
      }
      return { replaceExisting: true, status: 'replaced' };

    case 'foreign_symlink':
      if (!force) {
        throw createError(
          'LINK_TARGET_EXISTS',
          `Refusing to replace existing symlink at ${dest}; it points to ${state.resolvedTarget}. Re-run with --force to replace it.`,
          { path: dest, existingType: state.type, resolvedTarget: state.resolvedTarget },
        );
      }
      return { replaceExisting: true, status: 'replaced' };

    case 'file':
      if (!force) {
        throw createError(
          'LINK_TARGET_EXISTS',
          `Refusing to replace existing file at ${dest}. Re-run with --force to replace it.`,
          { path: dest, existingType: state.type },
        );
      }
      return { replaceExisting: true, status: 'replaced' };

    case 'directory':
      throw createError(
        'LINK_TARGET_IS_DIRECTORY',
        `Refusing to replace existing directory at ${dest}. Remove it manually and re-run.`,
        { path: dest, existingType: state.type },
      );

    default:
      throw createError(
        'LINK_TARGET_UNSAFE',
        `Refusing to replace existing entry at ${dest}. Remove it manually and re-run.`,
        { path: dest, existingType: state.type },
      );
  }
}

function planLinkTargetAction(target, name, force) {
  const src = skillSourcePath(name);
  const dest = skillTargetPath(target, name);
  const state = inspectTargetPath(dest, src);

  switch (state.type) {
    case 'missing':
      return { target, path: dest, status: 'would_link' };

    case 'managed_symlink':
      return { target, path: dest, status: state.broken ? 'would_relink' : 'unchanged' };

    case 'broken_symlink':
      return force
        ? { target, path: dest, status: 'would_replace', existingType: state.type, rawTarget: state.rawTarget, resolvedTarget: state.resolvedTarget }
        : { target, path: dest, status: 'blocked', existingType: state.type, rawTarget: state.rawTarget, resolvedTarget: state.resolvedTarget, message: 'Re-run with --force to replace this broken symlink.' };

    case 'foreign_symlink':
      return force
        ? { target, path: dest, status: 'would_replace', existingType: state.type, resolvedTarget: state.resolvedTarget }
        : { target, path: dest, status: 'blocked', existingType: state.type, resolvedTarget: state.resolvedTarget, message: 'Re-run with --force to replace this symlink.' };

    case 'file':
      return force
        ? { target, path: dest, status: 'would_replace', existingType: state.type }
        : { target, path: dest, status: 'blocked', existingType: state.type, message: 'Re-run with --force to replace this file.' };

    case 'directory':
      return { target, path: dest, status: 'blocked', existingType: state.type, message: 'Remove this directory manually and re-run.' };

    default:
      return { target, path: dest, status: 'blocked', existingType: state.type, message: 'Remove this entry manually and re-run.' };
  }
}

function unlinkError(name, target, dest, state) {
  if (state.type === 'missing') {
    return createError('SKILL_NOT_LINKED', `Skill "${name}" is not linked to ${target}`, {
      name,
      target,
      path: dest,
    });
  }

  if (state.type === 'foreign_symlink' || state.type === 'broken_symlink') {
    return createError(
      'LINK_NOT_MANAGED',
      `Refusing to unlink ${dest} because it is not a Prompt Pie-managed symlink.`,
      { name, target, path: dest, existingType: state.type, resolvedTarget: state.resolvedTarget },
    );
  }

  return createError(
    'LINK_NOT_MANAGED',
    `Refusing to unlink ${dest} because it is not a Prompt Pie-managed symlink.`,
    { name, target, path: dest, existingType: state.type },
  );
}

function ensureDir(path) {
  const created = !existsSync(path);
  mkdirSync(path, { recursive: true });
  return { path, created };
}

function emptyMigrationResult(target) {
  if (!target?.migration) {
    return {
      target: null,
      label: null,
      foundLegacy: false,
      legacyDir: null,
      currentDir: null,
      migrated: 0,
      skipped: 0,
    };
  }

  return {
    target: target.name,
    label: target.label,
    foundLegacy: false,
    legacyDir: target.migration.legacySkillsDir,
    currentDir: target.skillsDir,
    migrated: 0,
    skipped: 0,
  };
}

function migrateLegacyTargetLinks(target) {
  switch (target.migration.type) {
    case 'promptpie-managed-links':
      return migratePromptPieManagedLinks(target);
    default:
      throw createError(
        'UNKNOWN_MIGRATION_TYPE',
        `Unknown migration type "${target.migration.type}" for target "${target.name}"`,
        { target: target.name, migrationType: target.migration.type },
      );
  }
}

function migratePromptPieManagedLinks(target) {
  const { legacySkillsDir } = target.migration;
  const migration = {
    target: target.name,
    label: target.label,
    foundLegacy: existsSync(legacySkillsDir),
    legacyDir: legacySkillsDir,
    currentDir: target.skillsDir,
    migrated: 0,
    skipped: 0,
  };

  if (!migration.foundLegacy) return migration;

  for (const entry of readdirSync(legacySkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      migration.skipped += 1;
      continue;
    }

    const name = entry.name;
    const legacyLink = join(legacySkillsDir, name, 'SKILL.md');
    const src = skillSourcePath(name);
    const dest = skillTargetPath(target.name, name);

    if (!isSymlink(legacyLink)) {
      migration.skipped += 1;
      continue;
    }

    const legacyTarget = resolveSymlinkTarget(legacyLink);
    if (!legacyTarget || !existsSync(src) || legacyTarget !== src) {
      migration.skipped += 1;
      continue;
    }

    if (existsSync(dest) || isSymlink(dest)) {
      migration.skipped += 1;
      continue;
    }

    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(src, dest);
    migration.migrated += 1;
  }

  return migration;
}

function resolveSymlinkTarget(p) {
  try {
    return resolve(dirname(p), readlinkSync(p));
  } catch {
    return null;
  }
}
