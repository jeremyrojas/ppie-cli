import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/ppie.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const PR1_MERGE_COMMIT = 'e51babd2f36acf544c45f25d594ec0d60d2ae783';
const API_V2_COMMIT = '3af904f3972ba3f04468bf17c67a2851d365e362';
const homes = new Set();

afterEach(() => {
  for (const home of homes) {
    try {
      const state = JSON.parse(readFileSync(join(home, '.promptpie', 'companion.json'), 'utf8'));
      process.kill(state.pid, 'SIGTERM');
    } catch {}
    rmSync(home, { recursive: true, force: true });
  }
  homes.clear();
});

describe('real CLI companion commands', () => {
  it('starts pair, reports status, and returns typed unpaired prompt errors', () => {
    const home = makeHome();
    const pair = run(['pair', '--origin', 'http://localhost:3000', '--no-open', '--json'], home);
    assert.equal(pair.status, 0);
    const pairBody = JSON.parse(pair.stdout);
    assert.equal(pairBody.protocol, 'promptpie.local/v1');
    assert.equal(pairBody.origin, 'http://localhost:3000');
    assert.equal(pairBody.browserOpened, false);
    assert.match(pairBody.url, /^http:\/\/localhost:3000\/pair#protocol=promptpie\.local%2Fv1&port=\d+&nonce=/);
    assert.equal(statSync(join(home, '.promptpie', 'companion.json')).mode & 0o777, 0o600);

    const status = run(['status', '--json'], home);
    const statusBody = JSON.parse(status.stdout);
    assert.equal(status.status, 0);
    assert.equal(statusBody.companion.running, true);
    assert.equal(statusBody.companion.paired, false);
    assert.equal(statusBody.companion.companionApiVersion, 3);
    assert.equal(Object.hasOwn(statusBody.companion, 'internalToken'), false);

    const pull = run(['prompt', 'pull', 'welcome', '--json'], home);
    const error = JSON.parse(pull.stderr);
    assert.equal(pull.status, 1);
    assert.equal(error.error.code, 'CLI_NOT_PAIRED');
    assert.match(error.error.message, /ppie pair/);
  });

  it('returns the exact active pair URL and caller identity in JSON', async () => {
    const home = makeHome();
    const initial = run(['pair', '--origin', 'http://localhost:3000', '--no-open', '--json'], home);
    assert.equal(initial.status, 0);
    const pair = run(['pair', '--origin', 'http://localhost:3000', '--client-name', 'Codex', '--no-open', '--json'], home);
    assert.equal(pair.status, 0);
    const pairBody = JSON.parse(pair.stdout);
    const pairUrl = new URL(pairBody.url);
    const port = pairUrl.hash.slice(1) && new URLSearchParams(pairUrl.hash.slice(1)).get('port');
    const nonce = new URLSearchParams(pairUrl.hash.slice(1)).get('nonce');
    assert.equal(pairBody.browserOpened, false);
    assert.equal(pairBody.port, Number(port));
    assert.ok(nonce);

    const response = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: 'promptpie.local/v1',
        requestId: 'pair-json-request-1',
        idempotencyKey: 'pair-json-idempotency-1',
        type: 'browser.pair',
        payload: { nonce, client: { name: 'promptpie-web', version: 'test' } },
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.payload.client, { displayName: 'Codex' });
  });

  it('replaces the merged PR 1 companion before creating a current challenge', async () => {
    const home = makeHome();
    const oldCli = materializeCliRevision(PR1_MERGE_COMMIT, home);
    const oldPair = runWithBin(oldCli, ['pair', '--origin', 'http://localhost:3000', '--no-open', '--json'], home);
    assert.equal(oldPair.status, 0, oldPair.stderr);
    const oldState = readCompanionState(home);
    assert.equal(oldState.protocol, 'promptpie.local/v1');
    assert.equal(oldState.version, '0.1.0');
    assert.equal(Object.hasOwn(oldState, 'companionApiVersion'), false);

    const startedAt = Date.now();
    const currentPair = run([
      'pair', '--origin', 'http://localhost:3000', '--client-name', 'Codex', '--no-open', '--json',
    ], home);
    assert.equal(currentPair.status, 0, currentPair.stderr);
    const pairBody = JSON.parse(currentPair.stdout);
    const currentState = readCompanionState(home);
    assert.notEqual(currentState.pid, oldState.pid);
    assert.notEqual(currentState.port, oldState.port);
    assert.equal(currentState.companionApiVersion, 3);
    assert.equal(pairBody.browserOpened, false);
    assert.equal(pairBody.port, currentState.port);
    assert.ok(Date.parse(pairBody.expiresAt) - startedAt >= 295_000);
    assert.ok(Date.parse(pairBody.expiresAt) - startedAt <= 305_000);
    assertProcessStopped(oldState.pid);

    const pairUrl = new URL(pairBody.url);
    const fragment = new URLSearchParams(pairUrl.hash.slice(1));
    assert.equal(fragment.get('port'), String(currentState.port));
    const response = await fetch(`http://127.0.0.1:${currentState.port}/v1/pair`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: 'promptpie.local/v1',
        requestId: 'cross-version-pair-request',
        idempotencyKey: 'cross-version-pair-key',
        type: 'browser.pair',
        payload: {
          nonce: fragment.get('nonce'),
          client: { name: 'promptpie-web', version: 'test' },
        },
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.payload.client, { displayName: 'Codex' });
    assert.equal(payload.payload.companion.protocol, 'promptpie.local/v1');
  });

  it('replaces a companion from the prior private API revision', () => {
    const home = makeHome();
    const oldCli = materializeCliRevision(API_V2_COMMIT, home);
    const oldPair = runWithBin(oldCli, ['pair', '--origin', 'http://localhost:3000', '--no-open', '--json'], home);
    assert.equal(oldPair.status, 0, oldPair.stderr);
    const oldState = readCompanionState(home);
    assert.equal(oldState.companionApiVersion, 2);

    const currentPair = run(['pair', '--origin', 'http://localhost:3000', '--no-open', '--json'], home);
    assert.equal(currentPair.status, 0, currentPair.stderr);
    const currentState = readCompanionState(home);
    assert.equal(currentState.companionApiVersion, 3);
    assert.notEqual(currentState.pid, oldState.pid);
    assertProcessStopped(oldState.pid);
    assert.equal(JSON.parse(currentPair.stdout).browserOpened, false);
  });

  it('strictly validates command options and prompt files', () => {
    const home = makeHome();
    assert.equal(run(['pair', '--origin', 'https://example.com/path'], home).status, 1);
    assert.equal(run(['pair', '--output', 'x'], home).status, 1);
    assert.equal(run(['pair', '--client-name', '<Codex>'], home).status, 1);
    assert.equal(run(['status', '--client-name', 'Codex'], home).status, 1);
    assert.equal(run(['prompt', 'push'], home).status, 1);
    assert.equal(run(['prompt', 'pull', '../bad'], home).status, 1);
    assert.equal(run(['status', '--unknown'], home).status, 1);

    const malformed = join(home, 'bad.json');
    writeFileSync(malformed, '{bad', 'utf8');
    const result = run(['prompt', 'push', malformed, '--json'], home);
    assert.equal(JSON.parse(result.stderr).error.code, 'CLI_INVALID_PROMPT');

    const oversized = join(home, 'oversized.json');
    writeFileSync(oversized, 'x'.repeat(1024 * 1024 + 32 * 1024), 'utf8');
    const oversizedResult = run(['prompt', 'push', oversized, '--json'], home);
    assert.equal(JSON.parse(oversizedResult.stderr).error.code, 'CLI_PAYLOAD_TOO_LARGE');
  });

  it('reads push JSON from stdin and computes its revision before connection checks', () => {
    const home = makeHome();
    const input = JSON.stringify({ id: 'welcome', title: 'Welcome', content: 'Say hello' });
    const result = run(['prompt', 'push', '-', '--json'], home, input);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'CLI_NOT_PAIRED');
  });

  it('detects a crashed companion and replaces stale state on pair', () => {
    const home = makeHome();
    assert.equal(run(['pair', '--origin', 'http://localhost:3000', '--no-open', '--json'], home).status, 0);
    const first = JSON.parse(readFileSync(join(home, '.promptpie', 'companion.json'), 'utf8'));
    process.kill(first.pid, 'SIGKILL');

    let statusBody;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      statusBody = JSON.parse(run(['status', '--json'], home).stdout).companion;
      if (!statusBody.running) break;
    }
    assert.equal(statusBody.running, false);
    assert.equal(statusBody.stale, true);

    assert.equal(run(['pair', '--origin', 'http://localhost:3000', '--no-open', '--json'], home).status, 0);
    const second = JSON.parse(readFileSync(join(home, '.promptpie', 'companion.json'), 'utf8'));
    assert.notEqual(second.pid, first.pid);
  });

  it('never invokes the system browser across repeated automated pairs', () => {
    const home = makeHome();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = run(['pair', '--origin', 'http://localhost:3000', '--no-open', '--json'], home);
      assert.equal(result.status, 0);
      assert.equal(JSON.parse(result.stdout).browserOpened, false);
    }
  });
});

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'ppie-cli-companion-'));
  homes.add(home);
  return home;
}

function run(args, home, input) {
  return runWithBin(BIN, args, home, input);
}

function runWithBin(bin, args, home, input) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, PPIE_HOME: home, PPIE_BROWSER_OPEN: '0' },
    encoding: 'utf8',
    input,
    timeout: 8_000,
  });
}

function readCompanionState(home) {
  return JSON.parse(readFileSync(join(home, '.promptpie', 'companion.json'), 'utf8'));
}

function materializeCliRevision(revision, home) {
  const destination = join(home, 'pr1-cli');
  const listing = spawnSync('git', ['ls-tree', '-r', '--name-only', revision, '--', 'bin', 'lib', 'package.json'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  assert.equal(listing.status, 0, `Unable to read ${revision}. CI must fetch full history.\n${listing.stderr}`);
  for (const path of listing.stdout.trim().split('\n')) {
    if (!path) continue;
    const content = spawnSync('git', ['show', `${revision}:${path}`], { cwd: REPO, encoding: null });
    assert.equal(content.status, 0, content.stderr?.toString('utf8'));
    const target = join(destination, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content.stdout);
  }
  return join(destination, 'bin', 'ppie.mjs');
}

function assertProcessStopped(pid) {
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
}
