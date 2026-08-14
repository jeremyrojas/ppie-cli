import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const PAIR_COMMAND = 'ppie pair --origin https://app.promptpie.dev --client-name Codex --no-open --json';
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
    assert.equal(portable.version, '0.1.0');
    for (const field of ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']) {
      assert.deepEqual(codex[field], portable[field]);
    }
    assert.equal(codex.skills, './skills/');
    assert.equal(codex.interface.displayName, 'Prompt Pie');
    assert.deepEqual(codex.interface.defaultPrompt, [
      'Connect to Prompt Pie.',
      'Send this prompt to Prompt Pie.',
      'Get my edited prompt.',
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
    assert.match(skill, /^---\nname: prompt-pie\n/);
    for (const phrase of ['Connect to Prompt Pie', 'send this prompt to Prompt Pie', 'get my edited prompt', '$prompt-pie']) {
      assert.match(skill.toLowerCase(), new RegExp(escapeRegExp(phrase.toLowerCase())));
    }
    assert.match(skill, /0\.2\.0 or newer/);
    assert.equal((skill.match(new RegExp(escapeRegExp(PAIR_COMMAND), 'g')) ?? []).length, 1);
    assert.match(skill, /ppie prompt push - --json/);
    assert.match(skill, /stdin/);
    assert.match(skill, /browser choice, navigation, and permission changes to the user/);
    assert.doesNotMatch(`${skill}\n${reference}`, /mcpServers|\.mcp\.json|hooks\.json|codex plugin.*browser/i);
    assert.match(reference, new RegExp(escapeRegExp(PAIR_COMMAND)));
    assert.match(reference, /browserOpened.*false/);
    assert.match(reference, /untrusted user data/);
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
      join('prompt-pie', '0.1.0', 'plugin.json'),
      join('prompt-pie', '0.1.0', '.codex-plugin', 'plugin.json'),
      join('prompt-pie', '0.1.0', 'skills', 'prompt-pie', 'SKILL.md'),
      join('prompt-pie', '0.1.0', 'skills', 'prompt-pie', 'references', 'cli-contract.md'),
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
