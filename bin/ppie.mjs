#!/usr/bin/env node

import {
  init,
  addSkill,
  importSkill,
  removeSkill,
  linkSkill,
  unlinkSkill,
  listSkills,
  inspectSkill,
  getStatus,
  runDoctor,
  planRemoveSkill,
  planLinkSkill,
  planUnlinkSkill,
} from '../lib/skills.mjs';
import {
  TARGET_ENTRIES,
  TARGET_NAMES,
  SKILLS_DIR,
  formatTargetCommandArgs,
  formatTargetLabels,
  getTarget,
  skillSourcePath,
  skillTargetPath,
  targetHelpSummary,
} from '../lib/paths.mjs';
import { createError } from '../lib/errors.mjs';
import { validateName } from '../lib/validate.mjs';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const RESET = '\x1b[0m';
const PACKAGE = loadPackage();
const { flags: FLAGS, args } = parseArgv(process.argv.slice(2));
const cmd = args[0];
const sub = args[1];

if (cmd === '--version' || cmd === '-v' || cmd === '-V') {
  handleVersion();
  process.exit(0);
}

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  handleHelp();
  process.exit(0);
}

if (FLAGS.force && !(cmd === 'skill' && sub === 'link')) {
  fail(createError('INVALID_OPTION', '--force can only be used with "ppie skill link".'));
}

if (FLAGS.dryRun && !supportsDryRun(cmd, sub)) {
  fail(createError('INVALID_OPTION', '--dry-run can only be used with "ppie skill rm", "ppie skill remove", "ppie skill link", or "ppie skill unlink".'));
}

try {
  switch (cmd) {
    case 'init':
      handleInit();
      break;

    case 'status':
      handleStatus();
      break;

    case 'doctor':
      handleDoctor();
      break;

    case 'skill':
      handleSkill(sub, args.slice(2));
      break;

    default:
      throw createError('UNKNOWN_COMMAND', `Unknown command: ${cmd}. Run "ppie help" for usage.`, { command: cmd });
  }
} catch (error) {
  fail(error);
}

function handleVersion() {
  if (FLAGS.json) {
    writeJson(process.stdout, { ok: true, command: 'version', version: PACKAGE.version });
    return;
  }
  out(PACKAGE.version);
}

function handleHelp() {
  if (FLAGS.json) {
    writeJson(process.stdout, {
      ok: true,
      command: 'help',
      description: 'Prompt Pie skill manager',
      sourceOfTruth: SKILLS_DIR,
      targets: TARGET_ENTRIES.map(target => ({
        name: target.name,
        label: target.label,
        skillsDir: target.skillsDir,
      })),
      commands: [
        'ppie init',
        'ppie status',
        'ppie doctor',
        'ppie skill add <name>',
        'ppie skill import <name> <file>',
        'ppie skill rm <name>',
        'ppie skill remove <name>',
        'ppie skill link <name> [targets...]',
        'ppie skill unlink <name> [targets...]',
        'ppie skill list',
        'ppie skill ls',
        'ppie skill info <name>',
        'ppie skill edit <name>',
        'ppie help',
        'ppie --help',
        'ppie --version',
      ],
      options: {
        json: '--json',
        noColor: '--no-color',
        force: '--force',
        dryRun: '--dry-run',
      },
    });
    return;
  }

  out(usageText());
}

function handleInit() {
  const result = init();

  if (FLAGS.json) {
    writeJson(process.stdout, {
      ok: true,
      command: 'init',
      sourceOfTruth: SKILLS_DIR,
      directories: result.directories,
      migration: result.migration,
      migrations: result.migrations,
      nextSteps: {
        add: 'ppie skill add <name>',
      },
    });
    return;
  }

  for (const dir of result.directories) {
    if (dir.created) {
      ok(`Created ${CYAN(dir.path)}`);
    } else {
      info(`Already exists ${DIM(dir.path)}`);
    }
  }

  for (const migration of result.migrations) {
    if (!migration.foundLegacy) continue;

    out();
    warn(`${migration.legacyDir} is legacy. ${migration.label} now uses ${migration.currentDir}.`);
    if (migration.migrated > 0) {
      ok(`Migrated ${migration.migrated} legacy ${migration.label} link${migration.migrated === 1 ? '' : 's'}`);
    }
    if (migration.skipped > 0) {
      warn(`Skipped ${migration.skipped} legacy entr${migration.skipped === 1 ? 'y' : 'ies'}; existing or non-Prompt Pie links were left untouched.`);
    }
  }

  out();
  out(`Run ${BOLD('ppie skill add <name>')} to create your first skill.`);
}

function handleStatus() {
  const status = getStatus();

  if (FLAGS.json) {
    writeJson(process.stdout, { ok: true, command: 'status', ...status });
    return;
  }

  out();
  if (status.initialized) {
    ok('Prompt Pie is initialized');
  } else {
    warn('Prompt Pie setup is incomplete');
  }
  out(`  Source: ${DIM(status.sourceOfTruth)}`);
  out(`  Skills: ${status.skillCount}`);
  out();
  out(`${BOLD('TARGET'.padEnd(14))}${BOLD('DIR'.padEnd(10))}${BOLD('LINKED')}`);

  for (const target of status.targets) {
    const dirState = target.exists ? GREEN('exists') : YELLOW('missing');
    out(`${target.target.padEnd(14)}${padAnsi(dirState, 10)}${target.linkedCount}${target.invalidCount > 0 ? ` (${target.invalidCount} invalid)` : ''}`);
  }

  out();
  if (status.issueCount > 0) {
    warn(`${status.issueCount} setup issue${status.issueCount === 1 ? '' : 's'} found. Run ${BOLD('ppie doctor')} for details.`);
  } else {
    ok('No setup issues found');
  }
}

function handleDoctor() {
  const result = runDoctor();
  const hasErrors = result.summary.errorCount > 0;

  if (FLAGS.json) {
    writeJson(process.stdout, {
      ok: !hasErrors,
      command: 'doctor',
      issues: result.issues,
      summary: result.summary,
    });
    process.exit(hasErrors ? 1 : 0);
  }

  out();
  if (hasErrors) {
    warn(`Found ${result.summary.errorCount} error${result.summary.errorCount === 1 ? '' : 's'}${result.summary.warningCount > 0 ? ` and ${result.summary.warningCount} warning${result.summary.warningCount === 1 ? '' : 's'}` : ''}.`);
  } else if (result.summary.warningCount > 0) {
    warn(`Found ${result.summary.warningCount} warning${result.summary.warningCount === 1 ? '' : 's'}.`);
  } else {
    ok('Prompt Pie setup looks healthy');
  }

  for (const issue of result.issues) {
    const prefix = issue.severity === 'error' ? RED('error') : YELLOW('warning');
    out(`  ${prefix} ${issue.code}: ${issue.message}`);
    if (issue.path) out(`    ${DIM(issue.path)}`);
    if (issue.suggestedCommand) out(`    Try: ${BOLD(issue.suggestedCommand)}`);
  }

  process.exit(hasErrors ? 1 : 0);
}

function handleSkill(action, rest) {
  if (!action) throw createError('MISSING_SKILL_ACTION', 'Missing skill action. Run "ppie help" for usage.');

  switch (action) {
    case 'add': {
      const name = rest[0];
      if (!name) throw createError('INVALID_USAGE', 'Usage: ppie skill add <name>');
      validateName(name);
      const path = addSkill(name);

      if (FLAGS.json) {
        writeJson(process.stdout, {
          ok: true,
          command: 'skill.add',
          name,
          path,
          nextSteps: buildNextSteps(name),
        });
        return;
      }

      ok(`Created skill ${BOLD(name)}`);
      out(`  ${DIM(path)}`);
      printSkillNextSteps(name);
      return;
    }

    case 'import': {
      const name = rest[0];
      const file = rest[1];
      if (!name || !file) throw createError('INVALID_USAGE', 'Usage: ppie skill import <name> <file>');
      validateName(name);
      const path = importSkill(name, file);

      if (FLAGS.json) {
        writeJson(process.stdout, {
          ok: true,
          command: 'skill.import',
          name,
          sourceFile: file,
          path,
          nextSteps: buildNextSteps(name),
        });
        return;
      }

      ok(`Imported skill ${BOLD(name)} from ${file}`);
      out(`  ${DIM(path)}`);
      printSkillNextSteps(name);
      return;
    }

    case 'rm':
    case 'remove': {
      const name = rest[0];
      if (!name) throw createError('INVALID_USAGE', 'Usage: ppie skill rm <name>');
      validateName(name);
      if (FLAGS.dryRun) {
        const plan = planRemoveSkill(name);

        if (FLAGS.json) {
          writeJson(process.stdout, { ok: true, command: 'skill.remove', dryRun: true, ...plan });
          return;
        }

        warn(`Dry run: would remove skill ${BOLD(name)}`);
        out(`  Would remove ${DIM(plan.sourceDirectory)}`);
        for (const result of plan.results) {
          printDryRunResult(result);
        }
        return;
      }

      removeSkill(name);

      if (FLAGS.json) {
        writeJson(process.stdout, { ok: true, command: 'skill.remove', name });
        return;
      }

      ok(`Removed skill ${BOLD(name)} and all links`);
      return;
    }

    case 'link': {
      const name = rest[0];
      if (!name) throw createError('INVALID_USAGE', 'Usage: ppie skill link <name> [targets...]');
      validateName(name);
      const targets = rest.length > 1 ? rest.slice(1) : TARGET_NAMES;
      validateTargets(targets);
      if (FLAGS.dryRun) {
        const plan = planLinkSkill(name, targets, { force: FLAGS.force });
        const hasBlocked = hasBlockedResults(plan.results);

        if (FLAGS.json) {
          writeJson(process.stdout, {
            ok: !hasBlocked,
            command: 'skill.link',
            dryRun: true,
            ...plan,
          });
          process.exit(hasBlocked ? 1 : 0);
          return;
        }

        warn(`Dry run: would link ${BOLD(name)}${FLAGS.force ? ' with --force' : ''}`);
        for (const result of plan.results) {
          printDryRunResult(result);
        }
        if (hasBlocked) process.exit(1);
        return;
      }

      const results = linkSkill(name, targets, { force: FLAGS.force });

      if (FLAGS.json) {
        writeJson(process.stdout, {
          ok: true,
          command: 'skill.link',
          name,
          force: FLAGS.force,
          sourceOfTruth: skillSourcePath(name),
          results,
        });
        return;
      }

      for (const result of results) {
        printLinkResult(name, result);
      }
      info(`These target files are symlinks to the source skill in ${SKILLS_DIR}.`);
      return;
    }

    case 'unlink': {
      const name = rest[0];
      if (!name) throw createError('INVALID_USAGE', 'Usage: ppie skill unlink <name> [targets...]');
      validateName(name);
      const targets = rest.length > 1 ? rest.slice(1) : TARGET_NAMES;
      validateTargets(targets);

      if (FLAGS.dryRun) {
        const plan = planUnlinkSkill(name, targets);
        const hasBlocked = hasBlockedResults(plan.results);

        if (FLAGS.json) {
          writeJson(process.stdout, {
            ok: !hasBlocked,
            command: 'skill.unlink',
            dryRun: true,
            ...plan,
          });
          process.exit(hasBlocked ? 1 : 0);
          return;
        }

        warn(`Dry run: would unlink ${BOLD(name)}`);
        for (const result of plan.results) {
          printDryRunResult(result);
        }
        if (hasBlocked) process.exit(1);
        return;
      }

      const results = [];
      for (const target of targets) {
        try {
          results.push(unlinkSkill(name, target));
        } catch (error) {
          if (error.code === 'SKILL_NOT_LINKED') {
            results.push({ target, path: skillTargetPath(target, name), status: 'not_linked' });
            continue;
          }
          throw error;
        }
      }

      if (FLAGS.json) {
        writeJson(process.stdout, {
          ok: true,
          command: 'skill.unlink',
          name,
          results,
        });
        return;
      }

      for (const result of results) {
        if (result.status === 'unlinked') {
          ok(`Unlinked ${BOLD(name)} from ${CYAN(result.target)}`);
        } else {
          warn(`${name} was not linked to ${result.target}`);
        }
      }
      return;
    }

    case 'list':
    case 'ls': {
      const skills = listSkills();

      if (FLAGS.json) {
        writeJson(process.stdout, { ok: true, command: 'skill.list', skills });
        return;
      }

      if (skills.length === 0) {
        out(`No skills found. Run ${BOLD('ppie skill add <name>')} to get started.`);
        return;
      }

      const nameWidth = Math.max(20, ...skills.map(skill => skill.name.length + 2));
      out();
      out(`${BOLD('NAME'.padEnd(nameWidth))}LINKED TO`);
      out(`${'─'.repeat(nameWidth)}${'─'.repeat(30)}`);

      for (const skill of skills) {
        const links = skill.linkedTo.length > 0
          ? skill.linkedTo.map(link => `${link.valid ? GREEN('●') : RED('○')} ${link.target}`).join('  ')
          : DIM('(none)');
        out(`${skill.name.padEnd(nameWidth)}${links}`);
      }
      out();
      return;
    }

    case 'info': {
      const name = rest[0];
      if (!name) throw createError('INVALID_USAGE', 'Usage: ppie skill info <name>');
      const skill = inspectSkill(name);

      if (FLAGS.json) {
        writeJson(process.stdout, { ok: true, command: 'skill.info', ...skill });
        return;
      }

      out();
      out(`${BOLD(skill.name)}`);
      out(`  Source: ${DIM(skill.path)}`);
      out();
      out(`${BOLD('TARGET'.padEnd(14))}${BOLD('STATUS'.padEnd(16))}PATH`);
      for (const target of skill.targets) {
        out(`${target.target.padEnd(14)}${formatSkillStatus(target).padEnd(16)}${DIM(target.path)}`);
      }
      out();
      return;
    }

    case 'edit': {
      const name = rest[0];
      if (!name) throw createError('INVALID_USAGE', 'Usage: ppie skill edit <name>');
      validateName(name);
      const path = skillSourcePath(name);
      if (!existsSync(path)) {
        throw createError('SKILL_NOT_FOUND', `Skill "${name}" not found`, { name, path });
      }

      if (FLAGS.json) {
        writeJson(process.stdout, { ok: true, command: 'skill.edit', name, path });
        return;
      }

      process.stdout.write(path);
      return;
    }

    default:
      throw createError('UNKNOWN_SKILL_ACTION', `Unknown skill action: ${action}. Run "ppie help" for usage.`, {
        action,
      });
  }
}

function printLinkResult(name, result) {
  switch (result.status) {
    case 'linked':
      ok(`Linked ${BOLD(name)} -> ${CYAN(result.target)}`);
      break;
    case 'unchanged':
      info(`Already linked ${BOLD(name)} -> ${CYAN(result.target)}`);
      break;
    case 'relinked':
      ok(`Re-linked ${BOLD(name)} -> ${CYAN(result.target)}`);
      break;
    case 'replaced':
      ok(`Replaced existing entry and linked ${BOLD(name)} -> ${CYAN(result.target)}`);
      break;
    default:
      ok(`Linked ${BOLD(name)} -> ${CYAN(result.target)}`);
      break;
  }

  out(`  ${DIM(result.path)}`);
}

function printDryRunResult(result) {
  const target = result.target ? `${result.target}: ` : '';
  switch (result.status) {
    case 'would_link':
      ok(`Would link ${target}${DIM(result.path)}`);
      break;
    case 'would_relink':
      ok(`Would re-link ${target}${DIM(result.path)}`);
      break;
    case 'would_replace':
      ok(`Would replace ${target}${DIM(result.path)}`);
      break;
    case 'would_unlink':
      ok(`Would unlink ${target}${DIM(result.path)}`);
      break;
    case 'unchanged':
      info(`Already linked ${target}${DIM(result.path)}`);
      break;
    case 'not_linked':
      info(`Not linked ${target}${DIM(result.path)}`);
      break;
    case 'skipped':
      info(`Would skip ${target}${DIM(result.path)}`);
      break;
    case 'blocked':
      warn(`Blocked ${target}${DIM(result.path)}${result.message ? ` - ${result.message}` : ''}`);
      break;
    default:
      info(`${result.status} ${target}${DIM(result.path)}`);
      break;
  }
}

function formatSkillStatus(target) {
  switch (target.status) {
    case 'linked':
      return 'linked';
    case 'not_linked':
      return 'not linked';
    case 'broken':
      return 'broken';
    case 'foreign_symlink':
      return 'foreign link';
    case 'broken_symlink':
      return 'broken link';
    case 'file':
      return 'file';
    case 'directory':
      return 'directory';
    default:
      return target.status;
  }
}

function validateTargets(targets) {
  for (const target of targets) {
    getTarget(target);
  }
}

function buildNextSteps(name) {
  return {
    edit: `ppie skill edit ${name}`,
    link: `ppie skill link ${name}`,
    info: `ppie skill info ${name}`,
  };
}

function printSkillNextSteps(name) {
  out();
  out(`Next: edit with ${BOLD(`$EDITOR $(ppie skill edit ${name})`)}`);
  out(`Then: link with ${BOLD(`ppie skill link ${name}`)} to ${formatTargetLabels('or')}.`);
}

function usageText() {
  return `
${BOLD('ppie')} - Prompt Pie skill manager

${BOLD('HOW IT WORKS')}
  Skills live in ${SKILLS_DIR}. ${formatTargetLabels()} paths are symlinks to that source file.

${BOLD('USAGE')}
  ppie init                              ${targetHelpSummary()}
  ppie status                            Show a quick local setup summary
  ppie doctor                            Diagnose local Prompt Pie setup issues
  ppie skill add <name>                  Create a new skill from template
  ppie skill import <name> <file>        Import an existing .md file as a skill
  ppie skill rm <name>                   Remove a skill and all its links
  ppie skill link <name> [targets...]    Symlink skill to targets (default: all)
  ppie skill unlink <name> [targets...]  Remove Prompt Pie symlinks from targets
  ppie skill list                        List all skills and their link status
  ppie skill info <name>                 Show one skill's source and target status
  ppie skill edit <name>                 Print the SKILL.md path (pipe to $EDITOR)
  ppie help | --help | -h                Show usage
  ppie --version | -v | -V               Print version

${BOLD('GLOBAL OPTIONS')}
  --json                                 Print machine-readable JSON
  --no-color                             Disable ANSI color output
  --force                                Allow ppie skill link to replace existing files or symlinks
  --dry-run                              Preview supported risky changes without mutating files

${BOLD('TARGETS')}
  ${TARGET_NAMES.join(', ')}

${BOLD('EXAMPLES')}
  ppie init
  ppie skill add code-review
  ppie skill info code-review
  ppie skill link code-review ${formatTargetCommandArgs()}
  ppie skill rm code-review --dry-run
  ppie skill list
  ppie skill edit code-review              # prints path, use: $EDITOR $(ppie skill edit code-review)
`;
}

function supportsDryRun(command, action) {
  return command === 'skill' && ['rm', 'remove', 'link', 'unlink'].includes(action);
}

function hasBlockedResults(results) {
  return results.some(result => result.status === 'blocked');
}

function fail(errorLike) {
  const error = normalizeError(errorLike);

  if (FLAGS.json) {
    writeJson(process.stderr, {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  } else {
    err(`${error.message}`);
  }

  process.exit(error.exitCode ?? 1);
}

function normalizeError(errorLike) {
  if (errorLike instanceof Error) {
    if (!errorLike.code) errorLike.code = 'CLI_ERROR';
    if (!errorLike.details) errorLike.details = {};
    return errorLike;
  }

  return createError('CLI_ERROR', String(errorLike));
}

function parseArgv(argv) {
  const flags = { json: false, noColor: false, force: false, dryRun: false };
  const args = [];
  let parsingFlags = true;

  for (const arg of argv) {
    if (parsingFlags && arg === '--') {
      parsingFlags = false;
      continue;
    }

    if (parsingFlags && arg === '--json') {
      flags.json = true;
      continue;
    }

    if (parsingFlags && arg === '--no-color') {
      flags.noColor = true;
      continue;
    }

    if (parsingFlags && arg === '--force') {
      flags.force = true;
      continue;
    }

    if (parsingFlags && arg === '--dry-run') {
      flags.dryRun = true;
      continue;
    }

    args.push(arg);
  }

  return { flags, args };
}

function loadPackage() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
}

function style(text, code) {
  if (FLAGS.noColor || FLAGS.json) return text;
  return `${code}${text}${RESET}`;
}

function BOLD(text) { return style(text, '\x1b[1m'); }
function DIM(text) { return style(text, '\x1b[2m'); }
function GREEN(text) { return style(text, '\x1b[32m'); }
function RED(text) { return style(text, '\x1b[31m'); }
function YELLOW(text) { return style(text, '\x1b[33m'); }
function CYAN(text) { return style(text, '\x1b[36m'); }

function stripAnsiForWidth(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function padAnsi(text, width) {
  return `${text}${' '.repeat(Math.max(0, width - stripAnsiForWidth(text).length))}`;
}

function write(stream, msg = '') {
  stream.write(`${msg}\n`);
}

function writeJson(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function out(msg = '') {
  write(process.stdout, msg);
}

function ok(msg) {
  out(`${GREEN('✓')} ${msg}`);
}

function warn(msg) {
  out(`${YELLOW('!')} ${msg}`);
}

function info(msg) {
  out(`${DIM('•')} ${msg}`);
}

function err(msg) {
  write(process.stderr, `${RED('✗')} ${msg}`);
}
