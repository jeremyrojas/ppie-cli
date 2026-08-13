import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/ppie.mjs', import.meta.url));
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
    assert.equal(Object.hasOwn(pairBody, 'url'), false);
    assert.equal(statSync(join(home, '.promptpie', 'companion.json')).mode & 0o777, 0o600);

    const status = run(['status', '--json'], home);
    const statusBody = JSON.parse(status.stdout);
    assert.equal(status.status, 0);
    assert.equal(statusBody.companion.running, true);
    assert.equal(statusBody.companion.paired, false);
    assert.equal(Object.hasOwn(statusBody.companion, 'internalToken'), false);

    const pull = run(['prompt', 'pull', 'welcome', '--json'], home);
    const error = JSON.parse(pull.stderr);
    assert.equal(pull.status, 1);
    assert.equal(error.error.code, 'CLI_NOT_PAIRED');
    assert.match(error.error.message, /ppie pair/);
  });

  it('strictly validates command options and prompt files', () => {
    const home = makeHome();
    assert.equal(run(['pair', '--origin', 'https://example.com/path'], home).status, 1);
    assert.equal(run(['pair', '--output', 'x'], home).status, 1);
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
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, PPIE_HOME: home, PPIE_BROWSER_OPEN: '0' },
    encoding: 'utf8',
    input,
    timeout: 8_000,
  });
}
