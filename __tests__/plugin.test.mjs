import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(REPO, 'bin', 'ppie.mjs');
const PLUGIN = join(REPO, 'plugins', 'prompt-pie');
const PORTABLE_MANIFEST = join(PLUGIN, 'plugin.json');
const CODEX_MANIFEST = join(PLUGIN, '.codex-plugin', 'plugin.json');
const MARKETPLACE = join(REPO, '.agents', 'plugins', 'marketplace.json');
const SKILL = join(PLUGIN, 'skills', 'prompt-pie', 'SKILL.md');
const REFERENCE = join(PLUGIN, 'skills', 'prompt-pie', 'references', 'cli-contract.md');
const LOGO = join(PLUGIN, 'assets', 'prompt-pie-logo.png');
const PACKAGE = join(REPO, 'package.json');
const README = join(REPO, 'README.md');
const LOGO_PATH = './assets/prompt-pie-logo.png';
const LOGO_SHA256 = '02d88dad627dfdaa22f2b247811e962d3a3bcb645cced916be69d51fd50f0ed7';
const PLUGIN_VERSION = '0.1.4';
const COMPANION_INSTALL_COMMAND = 'npm install -g promptpie@0.2.0';
const BRAND_COLOR = '#E0AA0B';
const PLUGIN_AUTHOR = 'Jeremy Devz';
const PLUGIN_HOMEPAGE = 'https://promptpie.dev/';
const PLUGIN_REPOSITORY = 'https://github.com/jeremyrojas/ppie-cli';
const PAIR_COMMAND = 'ppie pair --origin https://app.promptpie.dev --client-name Codex --no-open --json';
const SKILL_FRONTMATTER = /^---\r?\nname: prompt-pie\r?\n/;
const BRIDGE_CODES = [
  'CLI_NOT_PAIRED',
  'CLI_PAIRING_EXPIRED',
  'CLI_INCOMPATIBLE',
  'CLI_COMPANION_START_FAILED',
  'CLI_COMPANION_RESTART_FAILED',
  'CLI_INVALID_ORIGIN',
  'CLI_ORIGIN_REJECTED',
  'CLI_UNAUTHORIZED',
  'CLI_NOT_FOUND',
  'CLI_REVISION_CONFLICT',
  'CLI_INVALID_PROMPT',
  'CLI_MALFORMED_REQUEST',
  'CLI_PAYLOAD_TOO_LARGE',
  'CLI_OPERATION_TIMEOUT',
  'CLI_OPERATION_EXPIRED',
];
const tempDirs = new Set();
const companionPids = new Set();

afterEach(() => {
  for (const pid of companionPids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  companionPids.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe('Prompt Pie plugin package', () => {
  it('keeps the portable and Codex manifests synchronized', () => {
    const portable = readJson(PORTABLE_MANIFEST);
    const codex = readJson(CODEX_MANIFEST);

    assert.deepEqual(Object.keys(portable).sort(), [
      '$schema', 'author', 'description', 'homepage', 'keywords', 'license', 'name', 'repository', 'version',
    ].sort());
    assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    assert.equal(portable.name, 'prompt-pie');
    assert.equal(portable.version, PLUGIN_VERSION);
    assert.deepEqual(portable.author, {
      name: PLUGIN_AUTHOR,
      url: 'https://github.com/jeremyrojas',
    });
    assert.equal(portable.homepage, PLUGIN_HOMEPAGE);
    assert.equal(portable.repository, PLUGIN_REPOSITORY);
    for (const field of ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']) {
      assert.deepEqual(codex[field], portable[field]);
    }
    assert.equal(codex.skills, './skills/');
    assert.equal(codex.interface.displayName, 'Prompt Pie');
    assert.equal(codex.interface.shortDescription, 'Visual prompt & skill editor');
    assert.ok(codex.interface.shortDescription.length <= 30);
    assert.match(codex.interface.longDescription, /^Prompt Pie is a local-first, privacy-friendly visual workspace for drafting, refining, previewing, and storing prompts and single-file skill drafts\./);
    assert.match(codex.interface.longDescription, /one-time, user-approved local companion setup with Node\.js 18 or newer/);
    assert.equal(codex.interface.privacyPolicyURL, 'https://app.promptpie.dev/privacy');
    assert.equal(codex.interface.termsOfServiceURL, 'https://app.promptpie.dev/terms');
    assert.equal(codex.interface.developerName, PLUGIN_AUTHOR);
    assert.equal(codex.interface.brandColor, BRAND_COLOR);
    assert.ok(
      contrastRatio(codex.interface.brandColor, '#FFFFFF') >= 2,
      `${codex.interface.brandColor} must have at least 2:1 contrast against white`,
    );
    for (const field of ['composerIcon', 'logo', 'logoDark']) {
      assert.equal(codex.interface[field], LOGO_PATH);
      assert.equal(existsSync(join(PLUGIN, codex.interface[field])), true);
    }
    assert.equal(createHash('sha256').update(readFileSync(LOGO)).digest('hex'), LOGO_SHA256);
    assert.deepEqual(codex.interface.defaultPrompt, [
      'Connect to Prompt Pie.',
      'Send this prompt to Prompt Pie for visual editing.',
      'Send this SKILL.md draft to Prompt Pie for visual editing.',
    ]);
    assert.equal(Object.hasOwn(codex, 'mcpServers'), false);
    assert.equal(Object.hasOwn(codex, 'hooks'), false);
    assert.equal(Object.hasOwn(codex, 'apps'), false);
  });

  it('publishes the exact Codex-only marketplace contract', () => {
    const marketplace = readJson(MARKETPLACE);
    assert.equal(marketplace.name, 'prompt-pie');
    assert.equal(marketplace.interface.displayName, 'Prompt Pie');
    assert.deepEqual(marketplace.plugins, [{
      name: 'prompt-pie',
      source: { source: 'local', path: './plugins/prompt-pie' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE', products: ['CODEX'] },
      category: 'Productivity',
    }]);
  });

  it('contains one action-oriented skill with safe command guidance', () => {
    const skillDirs = readdirSync(join(PLUGIN, 'skills'), { withFileTypes: true }).filter(entry => entry.isDirectory());
    assert.deepEqual(skillDirs.map(entry => entry.name), ['prompt-pie']);

    const skill = readFileSync(SKILL, 'utf8');
    const reference = readFileSync(REFERENCE, 'utf8');
    assert.match(skill, SKILL_FRONTMATTER);
    assert.match(skill.replace(/\r?\n/g, '\r\n'), SKILL_FRONTMATTER);
    for (const phrase of ['Connect to Prompt Pie', 'send a regular prompt or single-file SKILL.md draft', 'get the edited document', '$prompt-pie']) {
      assert.match(skill.toLowerCase(), new RegExp(escapeRegExp(phrase.toLowerCase())));
    }
    assert.match(skill, /0\.2\.0 or newer/);
    assert.equal((skill.match(new RegExp(escapeRegExp(COMPANION_INSTALL_COMMAND), 'g')) ?? []).length, 1);
    assert.doesNotMatch(skill, /promptpie@latest/);
    assert.match(skill, /Explanation-only questions remain passive/);
    assert.match(skill, /to move one regular prompt or single-file `SKILL\.md` between Codex and your signed-out Prompt Pie canvas/);
    assert.match(skill, /stores connection state under `PPIE_HOME\/\.promptpie` \(default `~\/\.promptpie`\)/);
    assert.match(skill, /binds only `127\.0\.0\.1` on a random port/);
    assert.match(skill, /manual one-time, five-minute `https:\/\/app\.promptpie\.dev` pairing URL/);
    assert.match(skill, /browser session token stays in memory/);
    assert.match(skill, /A later explicit user request and confirmation are required before that link action/);
    assert.match(skill, /After successful verification, continue the original Connect, Send, or Get operation automatically/);
    assert.match(skill, /Prompt Pie setup is paused/);
    assert.match(skill, /On macOS and Linux, explain the user-directed global npm `PATH` repair/);
    assert.match(skill, /On Windows, use the npm command shim through a child process/);
    assert.equal((skill.match(new RegExp(escapeRegExp(PAIR_COMMAND), 'g')) ?? []).length, 1);
    assert.match(skill, /ppie prompt push - --json/);
    assert.match(skill, /stdin/);
    assert.match(skill, /browser choice, navigation, and permission changes to the user/);
    assert.match(skill, /one prompt-sized document/);
    assert.match(skill, /Regular prompts are first-class documents/);
    assert.match(skill, /For a regular prompt/);
    assert.match(skill, /visual Markdown preview/);
    assert.match(skill, /long-content handoff/);
    assert.match(skill, /~\/.promptpie\/skills/);
    assert.match(skill, /~\/.agents\/skills/);
    assert.match(reference, /whole-folder transfer/);
    assert.match(reference, /direct application into `~\/\.agents\/skills`/);
    assert.doesNotMatch(`${skill}\n${reference}`, /mcpServers|\.mcp\.json|hooks\.json|codex plugin.*browser/i);
    assert.match(reference, new RegExp(escapeRegExp(PAIR_COMMAND)));
    assert.match(reference, /browserOpened.*false/);
    assert.match(reference, /untrusted user data/);
    assert.match(reference, /An explicit user request and confirmation are required before either local write or link action/);
  });

  it('documents one-time companion setup without floating package versions', () => {
    const readme = readFileSync(README, 'utf8');

    assert.match(readme, new RegExp(escapeRegExp(COMPANION_INSTALL_COMMAND)));
    assert.doesNotMatch(readme, /promptpie@latest/);
    assert.match(readme, /Connect, Send, and Get use a separate one-time companion setup/);
    assert.match(readme, /Explanation-only questions stay passive/);
    assert.match(readme, /global npm prefix, which must be on `PATH`/);
    assert.match(readme, /local companion only on `127\.0\.0\.1`/);
  });

  it('documents only bridge errors present in the current source contract', () => {
    const reference = readFileSync(REFERENCE, 'utf8');
    const source = [
      ...sourceFiles(join(REPO, 'bin')),
      ...sourceFiles(join(REPO, 'lib')),
      ...sourceFiles(join(REPO, '__tests__')),
    ].map(path => readFileSync(path, 'utf8')).join('\n');

    const documented = [...reference.matchAll(/`(CLI_[A-Z_]+)`/g)].map(match => match[1]);
    assert.deepEqual([...new Set(documented)].sort(), [...BRIDGE_CODES].sort());
    for (const code of BRIDGE_CODES) assert.match(source, new RegExp(`['\"]${code}['\"]`));
  });

  it('reports CLI 0.2.0 as JSON from source', () => {
    const result = runNodeCli(['--version', '--json'], makeTemp('ppie-plugin-version-'));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, command: 'version', version: '0.2.0' });
  });

  it('packs both CLI commands without package corrections', () => {
    const expectedBin = {
      ppie: 'bin/ppie.mjs',
      promptpie: 'bin/ppie.mjs',
    };
    const expectedRepository = {
      type: 'git',
      url: 'git+https://github.com/jeremyrojas/ppie-cli.git',
    };
    const sourcePackage = readJson(PACKAGE);
    assert.deepEqual(sourcePackage.bin, expectedBin);
    assert.deepEqual(sourcePackage.repository, expectedRepository);

    const preview = runNpm(['pack', '--dry-run', '--json']);
    assert.equal(preview.status, 0, `${preview.stderr}\n${preview.stdout}`);
    assert.doesNotMatch(preview.stderr, /auto-corrected|errors corrected/i);

    const archiveDir = makeTemp('ppie-npm-pack-');
    const packed = runNpm(['pack', '--json', '--pack-destination', archiveDir]);
    assert.equal(packed.status, 0, `${packed.stderr}\n${packed.stdout}`);
    const [{ filename, files }] = JSON.parse(packed.stdout);
    assert.ok(files.some(file => file.path === 'bin/ppie.mjs'));

    const prefix = makeTemp('ppie-npm-install-');
    const installed = runNpm([
      'install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(archiveDir, filename),
    ]);
    assert.equal(installed.status, 0, `${installed.stderr}\n${installed.stdout}`);

    const installedPackage = readJson(join(prefix, 'node_modules', 'promptpie', 'package.json'));
    assert.deepEqual(installedPackage.bin, expectedBin);
    assert.deepEqual(installedPackage.repository, expectedRepository);
    const shimExtension = process.platform === 'win32' ? '.cmd' : '';
    for (const command of Object.keys(expectedBin)) {
      assert.equal(existsSync(join(prefix, 'node_modules', '.bin', `${command}${shimExtension}`)), true);
    }
    const version = spawnSync(process.execPath, [
      join(prefix, 'node_modules', 'promptpie', expectedBin.ppie), '--version', '--json',
    ], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(version.status, 0, version.stderr);
    assert.deepEqual(JSON.parse(version.stdout), { ok: true, command: 'version', version: '0.2.0' });
  });

  it('pairs with production without opening a browser', () => {
    const home = makeTemp('ppie-plugin-pair-');
    const result = runNodeCli([
      'pair', '--origin', 'https://app.promptpie.dev', '--client-name', 'Codex', '--no-open', '--json',
    ], home);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'pair');
    assert.equal(payload.origin, 'https://app.promptpie.dev');
    assert.equal(payload.browserOpened, false);
    assert.match(payload.url, /^https:\/\/app\.promptpie\.dev\/pair#/);
    assert.ok(Date.parse(payload.expiresAt) > Date.now());

    const state = readJson(join(home, '.promptpie', 'companion.json'));
    companionPids.add(state.pid);
  });

  it('installs from repository and implicit personal marketplaces in an isolated home', {
    skip: process.env.RUN_CODEX_PLUGIN_ACCEPTANCE !== '1',
  }, () => {
    const osHome = makeTemp('ppie-codex-plugin-');
    const codexHome = join(osHome, '.codex');
    const personalPlugin = join(osHome, 'plugins', 'prompt-pie');
    const personalMarketplace = join(osHome, '.agents', 'plugins', 'marketplace.json');
    mkdirSync(codexHome, { recursive: true });
    cpSync(PLUGIN, personalPlugin, { recursive: true });
    mkdirSync(dirname(personalMarketplace), { recursive: true });
    writeFileSync(personalMarketplace, JSON.stringify({
      name: 'personal',
      interface: { displayName: 'Personal' },
      plugins: [{
        name: 'prompt-pie',
        source: { source: 'local', path: './plugins/prompt-pie' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_USE', products: ['CODEX'] },
        category: 'Productivity',
      }],
    }, null, 2));

    const env = {
      ...process.env,
      CODEX_HOME: codexHome,
      HOME: osHome,
      USERPROFILE: osHome,
      PPIE_HOME: join(osHome, 'ppie-home'),
      PPIE_BROWSER_OPEN: '0',
    };
    assertCodex(['plugin', 'marketplace', 'add', REPO, '--json'], env);
    const repositoryAvailable = assertCodex([
      'plugin', 'list', '--marketplace', 'prompt-pie', '--available', '--json',
    ], env);
    assert.match(repositoryAvailable.stdout, /"name":\s*"prompt-pie"/);

    const personalAvailable = assertCodex([
      'plugin', 'list', '--marketplace', 'personal', '--available', '--json',
    ], env);
    assert.match(personalAvailable.stdout, /"name":\s*"prompt-pie"/);
    assertCodex(['plugin', 'add', 'prompt-pie@personal', '--json'], env);
    const installed = assertCodex(['plugin', 'list', '--json'], env);
    assert.match(installed.stdout, /"name":\s*"prompt-pie"/);

    const installedFiles = sourceFiles(codexHome);
    for (const suffix of [
      join('prompt-pie', PLUGIN_VERSION, 'plugin.json'),
      join('prompt-pie', PLUGIN_VERSION, '.codex-plugin', 'plugin.json'),
      join('prompt-pie', PLUGIN_VERSION, 'skills', 'prompt-pie', 'SKILL.md'),
      join('prompt-pie', PLUGIN_VERSION, 'skills', 'prompt-pie', 'references', 'cli-contract.md'),
      join('prompt-pie', PLUGIN_VERSION, 'assets', 'prompt-pie-logo.png'),
    ]) {
      assert.ok(
        installedFiles.some(path => path.endsWith(suffix)),
        `Missing installed ${suffix}. Found:\n${installedFiles.join('\n')}`,
      );
    }
    assert.equal(installedFiles.some(path => /(?:^|[\\/])(?:hooks|\.mcp\.json)(?:$|[\\/])/.test(path)), false);
  });
});

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const [lighter, darker] = firstLuminance > secondLuminance
    ? [firstLuminance, secondLuminance]
    : [secondLuminance, firstLuminance];
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map(value => Number.parseInt(value, 16) / 255);
  const [red, green, blue] = channels.map(channel => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function makeTemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function runNodeCli(args, home) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, PPIE_HOME: home, PPIE_BROWSER_OPEN: '0' },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function runNpm(args) {
  return spawnSync('npm', args, {
    cwd: REPO,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 30_000,
  });
}

function assertCodex(args, env) {
  const result = spawnSync('codex', args, { cwd: REPO, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return result;
}

function sourceFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else files.push(path);
  }
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
