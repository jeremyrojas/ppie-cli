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
const APP_MANIFEST = join(PLUGIN, '.app.json');
const MARKETPLACE = join(REPO, '.agents', 'plugins', 'marketplace.json');
const SKILL = join(PLUGIN, 'skills', 'prompt-pie', 'SKILL.md');
const REFERENCE = join(PLUGIN, 'skills', 'prompt-pie', 'references', 'cli-contract.md');
const LOGO = join(PLUGIN, 'assets', 'prompt-pie-logo.png');
const PACKAGE = join(REPO, 'package.json');
const README = join(REPO, 'README.md');
const LOGO_PATH = './assets/prompt-pie-logo.png';
const LOGO_SHA256 = '02d88dad627dfdaa22f2b247811e962d3a3bcb645cced916be69d51fd50f0ed7';
const PLUGIN_VERSION = '0.1.7';
const APP_ID = 'asdk_app_6a9484d00aa48191b4b94b8be7ad4157';
const COMPANION_INSTALL_COMMAND = 'npm install -g promptpie@0.2.0';
const BRAND_COLOR = '#E0AA0B';
const PLUGIN_AUTHOR = 'Jeremy Devz';
const PLUGIN_HOMEPAGE = 'https://promptpie.dev/';
const PLUGIN_REPOSITORY = 'https://github.com/jeremyrojas/ppie-cli';
const PLUGIN_DESCRIPTION = 'Save, find, retrieve, and open Prompt Pie prompts and skills through the hosted OAuth app, with local companion workflows for guest and local use.';
const PLUGIN_KEYWORDS = [
  'promptpie', 'prompt-pie', 'codex', 'prompts', 'skills', 'visual-editing', 'oauth', 'cloud', 'local-companion',
];
const DEFAULT_PROMPTS = [
  'Save this prompt to my Launch canvas in Prompt Pie.',
  'Find and get my exact Release helper skill from Prompt Pie.',
  'Open my Launch canvas in Prompt Pie.',
];
const PAIR_COMMAND = 'ppie pair --origin https://app.promptpie.dev --client-name Codex --json';
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
    assert.equal(portable.description, PLUGIN_DESCRIPTION);
    assert.deepEqual(portable.keywords, PLUGIN_KEYWORDS);
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
    assert.equal(codex.apps, './.app.json');
    assert.equal(codex.interface.displayName, 'Prompt Pie');
    assert.equal(codex.interface.shortDescription, 'Save, find prompts and skills');
    assert.ok(codex.interface.shortDescription.length <= 30);
    assert.match(codex.interface.longDescription, /^Prompt Pie connects Codex to the signed-in account through hosted OAuth/);
    assert.match(codex.interface.longDescription, /account-wide prompt and skill save, find, get, and open actions/);
    assert.match(codex.interface.longDescription, /WebMCP can assist with the open page/);
    assert.match(codex.interface.longDescription, /local ppie companion supports explicit guest, local-canvas, and local CLI workflows/);
    assert.deepEqual(codex.interface.capabilities, ['Interactive', 'Read', 'Write', 'Local']);
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
    assert.deepEqual(codex.interface.defaultPrompt, DEFAULT_PROMPTS);
    assert.equal(Object.hasOwn(codex, 'mcpServers'), false);
    assert.equal(Object.hasOwn(codex, 'hooks'), false);
    assert.deepEqual(readJson(APP_MANIFEST), {
      apps: {
        'prompt-pie': {
          id: APP_ID,
          category: 'Productivity',
        },
      },
    });
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

  it('routes account-wide actions through the hosted app with safe local fallback', () => {
    const skillDirs = readdirSync(join(PLUGIN, 'skills'), { withFileTypes: true }).filter(entry => entry.isDirectory());
    assert.deepEqual(skillDirs.map(entry => entry.name), ['prompt-pie']);

    const skill = readFileSync(SKILL, 'utf8');
    const reference = readFileSync(REFERENCE, 'utf8');
    assert.match(skill, SKILL_FRONTMATTER);
    assert.match(skill.replace(/\r?\n/g, '\r\n'), SKILL_FRONTMATTER);
    for (const phrase of [
      'connected Prompt Pie app', 'account-wide', 'list_canvases', 'exactTitle', 'create_document',
      'list_documents', 'get_document', 'browserUrl', 'computer control', 'WebMCP', 'local companion', '$prompt-pie',
    ]) {
      assert.match(skill.toLowerCase(), new RegExp(escapeRegExp(phrase.toLowerCase())));
    }
    assert.match(skill, /case-insensitive exact matching/);
    assert.match(skill, /Follow `nextCursor` until the exact-title results are exhausted/);
    assert.match(skill, /Ask the user to choose when multiple canvases match/);
    assert.match(skill, /stable idempotency key after the normal host write confirmation/);
    assert.match(skill, /Reuse the same key only when retrying that exact creation/);
    assert.match(skill, /Updates, deletes, and restores require the current expected revision/);
    assert.match(skill, /On a revision conflict, retrieve the current document/);
    assert.match(skill, /normal hosted OAuth flow/);
    assert.match(skill, /Keep the configured OAuth scope set unchanged/);
    assert.match(skill, /matching explicit write request and host confirmation authorize each write/);
    assert.match(skill, /Honor owner scoping, feature gates, rate-limit responses/);
    assert.match(skill, /Explanation-only questions remain passive/);
    assert.match(skill, /~\/.agents\/skills/);
    assert.doesNotMatch(skill, /npm install|ppie pair|ppie prompt push|ppie prompt pull/);

    assert.match(reference, /explicit guest or local-canvas bridge operations/);
    assert.match(reference, /signed-in account-wide save, find, get, open, and show requests through the connected hosted app/);
    assert.match(reference, /0\.2\.0 or newer/);
    assert.equal((reference.match(new RegExp(escapeRegExp(COMPANION_INSTALL_COMMAND), 'g')) ?? []).length, 2);
    assert.doesNotMatch(reference, /promptpie@latest/);
    assert.match(reference, /Prompt Pie needs its \[open-source CLI\]\(https:\/\/github\.com\/jeremyrojas\/ppie-cli\) for this local workflow\. May I install it using npm\?/);
    assert.match(reference, /Prompt Pie local setup is paused/);
    assert.match(reference, /On macOS and Linux, explain the user-directed global npm `PATH` repair/);
    assert.match(reference, /On Windows, use the npm command shim through a child process/);
    assert.equal((reference.match(new RegExp(escapeRegExp(PAIR_COMMAND), 'g')) ?? []).length, 1);
    assert.doesNotMatch(reference, /pair --origin https:\/\/app\.promptpie\.dev --client-name Codex --no-open/);
    assert.match(reference, /ppie prompt push - --json/);
    assert.match(reference, /stdin/);
    assert.match(reference, /~\/.promptpie\/skills/);
    assert.match(reference, /~\/.agents\/skills/);
    assert.doesNotMatch(`${skill}\n${reference}`, /mcpServers|\.mcp\.json|hooks\.json|codex plugin.*browser/i);
    assert.match(reference, new RegExp(escapeRegExp(PAIR_COMMAND)));
    assert.match(reference, /When `browserOpened` is `false`, present `url` and `expiresAt`/);
    assert.match(reference, /First-run setup details/);
    assert.match(reference, /PPIE_HOME\/\.promptpie/);
    assert.match(reference, /binds only `127\.0\.0\.1` on a random port/);
    assert.match(reference, /browser session token stays in memory/);
    assert.match(reference, /Codex skills use a concise in-chat consent/);
    assert.doesNotMatch(reference, /Pairing always uses `--no-open`/);
    assert.match(reference, /untrusted user data/);
    assert.match(reference, /An explicit user request and confirmation are required before either local write or link action/);
  });

  it('documents hosted account actions and explicit companion setup', () => {
    const readme = readFileSync(README, 'utf8');

    assert.match(readme, new RegExp(escapeRegExp(COMPANION_INSTALL_COMMAND)));
    assert.doesNotMatch(readme, /promptpie@latest/);
    assert.match(readme, /signed-in Prompt Pie account through the hosted OAuth app/);
    assert.match(readme, /save prompts and skills to a named canvas/);
    assert.match(readme, /case-insensitive exact title/);
    assert.match(readme, /Multiple exact-title matches require a user choice/);
    assert.match(readme, /stable idempotency key after the host write confirmation/);
    assert.match(readme, /WebMCP can help with the currently open Prompt Pie page/);
    assert.match(readme, /Computer control handles browser navigation/);
    assert.match(readme, /local `ppie` companion supports explicit guest or local-canvas bridge requests/);
    assert.match(readme, /Explanation-only questions stay passive/);
    assert.match(readme, /global npm prefix, which must be on `PATH`/);
    assert.match(readme, /local companion listens only on `127\.0\.0\.1`/);
    assert.match(readme, /The CLI opens the one-time link in the default browser/);
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

  it('starts production pairing through the first-run command without opening a test browser', () => {
    const home = makeTemp('ppie-plugin-pair-');
    const result = runNodeCli([
      'pair', '--origin', 'https://app.promptpie.dev', '--client-name', 'Codex', '--json',
    ], home, { PPIE_BROWSER_OPEN: '0' });
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
      join('prompt-pie', PLUGIN_VERSION, '.app.json'),
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

function runNodeCli(args, home, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, PPIE_HOME: home, PPIE_BROWSER_OPEN: '0', ...extraEnv },
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
