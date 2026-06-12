import { homedir } from 'os';
import { join } from 'path';
import { createError } from './errors.mjs';

const HOME = process.env.PPIE_HOME || homedir();

/** Central source of truth for all skills */
export const PROMPTPIE_DIR = join(HOME, '.promptpie');
export const SKILLS_DIR = join(PROMPTPIE_DIR, 'skills');
export const SOURCE_SKILLS_DIR_DISPLAY = '~/.promptpie/skills';

/** Supported link targets */
export const TARGETS = {
  claude: {
    name: 'claude',
    label: 'Claude Code',
    displaySkillsDir: '~/.claude/skills',
    skillsDir: join(HOME, '.claude', 'skills'),
  },
  codex: {
    name: 'codex',
    label: 'Codex',
    displaySkillsDir: '~/.agents/skills',
    skillsDir: join(HOME, '.agents', 'skills'),
    migration: {
      type: 'promptpie-managed-links',
      legacySkillsDir: join(HOME, '.codex', 'skills'),
      legacyDisplaySkillsDir: '~/.codex/skills',
    },
  },
  cursor: {
    name: 'cursor',
    label: 'Cursor',
    displaySkillsDir: '~/.cursor/skills',
    skillsDir: join(HOME, '.cursor', 'skills'),
  },
};

export const TARGET_ENTRIES = Object.values(TARGETS);
export const TARGET_NAMES = TARGET_ENTRIES.map(target => target.name);
export const LEGACY_CODEX_SKILLS_DIR = TARGETS.codex.migration.legacySkillsDir;

export function getTarget(targetName) {
  const target = TARGETS[targetName];
  if (!target) {
    throw createError('UNKNOWN_TARGET', `Unknown target: ${targetName}. Use: ${TARGET_NAMES.join(', ')}`, {
      target: targetName,
      available: TARGET_NAMES,
    });
  }
  return target;
}

export function formatList(items, conjunction = 'and') {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${conjunction} ${items.at(-1)}`;
}

export function formatTargetLabels(conjunction = 'and') {
  return formatList(TARGET_ENTRIES.map(target => target.label), conjunction);
}

export function formatManagedSkillsDirs({ includeSource = false, conjunction = 'and' } = {}) {
  const dirs = includeSource
    ? [SOURCE_SKILLS_DIR_DISPLAY, ...TARGET_ENTRIES.map(target => target.displaySkillsDir)]
    : TARGET_ENTRIES.map(target => target.displaySkillsDir);
  return formatList(dirs, conjunction);
}

export function formatTargetCommandArgs() {
  return TARGET_NAMES.join(' ');
}

export function targetHelpSummary() {
  return `Set up ${formatManagedSkillsDirs({ includeSource: true })}`;
}

/** Get the SKILL.md path inside ~/.promptpie/skills/<name>/ */
export function skillSourcePath(name) {
  return join(SKILLS_DIR, name, 'SKILL.md');
}

/** Get the SKILL.md symlink path for a target */
export function skillTargetPath(target, name) {
  const t = getTarget(target);
  return join(t.skillsDir, name, 'SKILL.md');
}
