import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { requestEnvelope } from '../lib/protocol.mjs';
import { promptRevision } from '../lib/revision.mjs';

const HOME = mkdtempSync(join(tmpdir(), 'ppie-companion-'));
const BIN = fileURLToPath(new URL('../bin/ppie.mjs', import.meta.url));
const ORIGIN = 'http://localhost:3000';
const STATE = join(HOME, '.promptpie', 'companion.json');
const STARTUP = join(HOME, '.promptpie', 'companion-startup.json');
let child;
let state;
let startup;
let sessionToken;

before(async () => {
  child = spawn(process.execPath, [BIN, '__companion'], {
    env: { ...process.env, PPIE_HOME: HOME, PPIE_COMPANION_ORIGIN: ORIGIN, PPIE_COMPANION_VERSION: '0.1.0-test' },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      startup = JSON.parse(readFileSync(STARTUP, 'utf8'));
      state = JSON.parse(readFileSync(STATE, 'utf8'));
      return;
    } catch {}
    await delay(25);
  }
  throw new Error('companion failed to start');
});

after(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1_000)]);
  }
  rmSync(HOME, { recursive: true, force: true });
});

describe('local companion HTTP bridge', () => {
  it('binds loopback, reports unpaired status, and keeps secrets out of status', async () => {
    assert.equal(state.host, '127.0.0.1');
    const response = await fetch(url('/v1/cli/status'), { headers: internalHeaders() });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.paired, false);
    assert.equal(body.protocol, 'promptpie.local/v1');
    assert.equal(Object.hasOwn(body, 'internalToken'), false);
  });

  it('handles allowed private-network preflight and rejects a wrong origin', async () => {
    const allowed = await fetch(url('/v1/browser/poll'), {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Private-Network': 'true' },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(allowed.headers.get('access-control-allow-private-network'), 'true');
    assert.equal(allowed.headers.get('vary'), 'Origin');

    const rejected = await post('/v1/pair', requestEnvelope('browser.pair', { nonce: startup.nonce, client: { name: 'promptpie-web', version: 'test' } }), { origin: 'https://evil.example' });
    assert.equal(rejected.response.status, 403);
    assert.equal(rejected.body.error.code, 'CLI_ORIGIN_REJECTED');
    assert.equal(rejected.response.headers.get('access-control-allow-origin'), null);
  });

  it('rejects unsupported protocol and malformed JSON without consuming the nonce', async () => {
    const incompatible = requestEnvelope('browser.pair', { nonce: startup.nonce, client: { name: 'promptpie-web', version: 'test' } });
    incompatible.protocol = 'promptpie.local/v2';
    const versionResult = await post('/v1/pair', incompatible);
    assert.equal(versionResult.body.error.code, 'CLI_INCOMPATIBLE');

    const response = await fetch(url('/v1/pair'), { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{bad' });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'CLI_MALFORMED_REQUEST');
  });

  it('pairs once and replays an identical request', async () => {
    const envelope = requestEnvelope('browser.pair', { nonce: startup.nonce, client: { name: 'promptpie-web', version: 'test' } });
    const first = await post('/v1/pair', envelope);
    const replay = await post('/v1/pair', envelope);
    assert.equal(first.response.status, 200);
    assert.deepEqual(replay.body, first.body);
    sessionToken = first.body.payload.session.token;
    assert.equal(typeof sessionToken, 'string');
  });

  it('rejects nonce replay and idempotency conflicts', async () => {
    const nonceReplay = await post('/v1/pair', requestEnvelope('browser.pair', { nonce: startup.nonce, client: { name: 'promptpie-web', version: 'test' } }));
    assert.equal(nonceReplay.body.error.code, 'CLI_PAIRING_REPLAY');

    const original = requestEnvelope('browser.poll', { waitMs: 0 }, 'fixed-idempotency-key');
    const first = await post('/v1/browser/poll', original, { bearer: sessionToken });
    assert.equal(first.response.status, 200);
    const changed = { ...original, payload: { waitMs: 1 } };
    const conflict = await post('/v1/browser/poll', changed, { bearer: sessionToken });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, 'CLI_IDEMPOTENCY_CONFLICT');
  });

  it('returns actionable disconnect errors for an invalid browser session', async () => {
    const result = await post('/v1/browser/poll', requestEnvelope('browser.poll', { waitMs: 0 }), { bearer: 'expired-or-disconnected' });
    assert.equal(result.response.status, 401);
    assert.equal(result.body.error.code, 'CLI_NOT_PAIRED');
    assert.match(result.body.error.message, /ppie pair/);
  });

  it('delivers a push and accepts the browser result', async () => {
    const prompt = validPrompt();
    const cli = post('/v1/cli/operations', requestEnvelope('cli.operation', {
      operation: { operationId: 'push-operation-0001', kind: 'prompt.push', prompt, expectedRevision: null },
      timeoutMs: 2_000,
    }), { internal: true });
    const poll = await post('/v1/browser/poll', requestEnvelope('browser.poll', { waitMs: 1_000 }), { bearer: sessionToken });
    assert.equal(poll.body.payload.operation.kind, 'prompt.push');
    assert.deepEqual(poll.body.payload.operation.prompt, prompt);
    const resultEnvelope = requestEnvelope('browser.result', { operationId: 'push-operation-0001', result: { prompt } });
    const accepted = await post('/v1/browser/result', resultEnvelope, { bearer: sessionToken });
    const duplicate = await post('/v1/browser/result', resultEnvelope, { bearer: sessionToken });
    assert.equal(accepted.body.payload.accepted, true);
    assert.deepEqual(duplicate.body, accepted.body);
    assert.deepEqual((await cli).body.payload.prompt, prompt);
  });

  it('delivers a pull and returns structured prompt content', async () => {
    const prompt = validPrompt();
    const cli = post('/v1/cli/operations', requestEnvelope('cli.operation', {
      operation: { operationId: 'pull-operation-0001', kind: 'prompt.pull', promptId: prompt.id },
      timeoutMs: 2_000,
    }), { internal: true });
    const poll = await post('/v1/browser/poll', requestEnvelope('browser.poll', { waitMs: 1_000 }), { bearer: sessionToken });
    assert.deepEqual(poll.body.payload.operation, { operationId: 'pull-operation-0001', kind: 'prompt.pull', promptId: prompt.id });
    await post('/v1/browser/result', requestEnvelope('browser.result', { operationId: 'pull-operation-0001', result: { prompt } }), { bearer: sessionToken });
    assert.deepEqual((await cli).body.payload.prompt, prompt);
  });

  it('runs real prompt push and pull executable commands', async () => {
    const prompt = validPrompt();
    const inputPath = join(HOME, 'push.json');
    const outputPath = join(HOME, 'pull.json');
    writeFileSync(inputPath, JSON.stringify({ id: prompt.id, title: prompt.title, content: prompt.content }), 'utf8');

    const push = runCliAsync(['prompt', 'push', inputPath, '--expected-revision', '0'.repeat(64), '--json']);
    const pushPoll = await post('/v1/browser/poll', requestEnvelope('browser.poll', { waitMs: 1_000 }), { bearer: sessionToken });
    assert.equal(pushPoll.body.payload.operation.expectedRevision, '0'.repeat(64));
    await post('/v1/browser/result', requestEnvelope('browser.result', { operationId: pushPoll.body.payload.operation.operationId, result: { prompt } }), { bearer: sessionToken });
    const pushed = await push;
    assert.equal(pushed.code, 0);
    assert.deepEqual(JSON.parse(pushed.stdout).prompt, prompt);

    const pull = runCliAsync(['prompt', 'pull', prompt.id, '--output', outputPath, '--json']);
    const pullPoll = await post('/v1/browser/poll', requestEnvelope('browser.poll', { waitMs: 1_000 }), { bearer: sessionToken });
    assert.equal(pullPoll.body.payload.operation.kind, 'prompt.pull');
    await post('/v1/browser/result', requestEnvelope('browser.result', { operationId: pullPoll.body.payload.operation.operationId, result: { prompt } }), { bearer: sessionToken });
    const pulled = await pull;
    assert.equal(pulled.code, 0);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), prompt);
  });

  it('passes through revision conflicts after redacting secrets', async () => {
    const prompt = validPrompt();
    const cli = post('/v1/cli/operations', requestEnvelope('cli.operation', {
      operation: { operationId: 'conflict-operation-1', kind: 'prompt.push', prompt, expectedRevision: '0'.repeat(64) },
      timeoutMs: 2_000,
    }), { internal: true });
    await post('/v1/browser/poll', requestEnvelope('browser.poll', { waitMs: 1_000 }), { bearer: sessionToken });
    await post('/v1/browser/result', requestEnvelope('browser.result', {
      operationId: 'conflict-operation-1',
      error: { code: 'CLI_REVISION_CONFLICT', message: 'token=hidden changed', details: { token: 'hidden' } },
    }), { bearer: sessionToken });
    const result = await cli;
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error.code, 'CLI_REVISION_CONFLICT');
    assert.doesNotMatch(JSON.stringify(result.body), /hidden/);
  });

  it('expires timed-out operations and rejects late results', async () => {
    const cli = await post('/v1/cli/operations', requestEnvelope('cli.operation', {
      operation: { operationId: 'timeout-operation-1', kind: 'prompt.pull', promptId: 'welcome' },
      timeoutMs: 100,
    }), { internal: true });
    assert.equal(cli.response.status, 504);
    assert.equal(cli.body.error.code, 'CLI_OPERATION_TIMEOUT');
    const late = await post('/v1/browser/result', requestEnvelope('browser.result', { operationId: 'timeout-operation-1', result: { prompt: validPrompt() } }), { bearer: sessionToken });
    assert.equal(late.response.status, 410);
    assert.equal(late.body.error.code, 'CLI_OPERATION_EXPIRED');
  });

  it('rejects oversized JSON before parsing', async () => {
    const response = await fetch(url('/v1/browser/poll'), {
      method: 'POST',
      headers: { Origin: ORIGIN, Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 20 * 1024) }),
    });
    const body = await response.json();
    assert.equal(response.status, 413);
    assert.equal(body.error.code, 'CLI_PAYLOAD_TOO_LARGE');
  });
});

function validPrompt() {
  const prompt = { id: 'welcome', title: 'Welcome', content: 'Say hello' };
  return { ...prompt, revision: promptRevision(prompt) };
}

function url(path) {
  return `http://127.0.0.1:${state.port}${path}`;
}

function internalHeaders() {
  return { 'X-PromptPie-Token': state.internalToken };
}

async function post(path, envelope, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.origin !== false && !options.internal) headers.Origin = options.origin ?? ORIGIN;
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
  if (options.internal) Object.assign(headers, internalHeaders());
  const response = await fetch(url(path), { method: 'POST', headers, body: JSON.stringify(envelope) });
  return { response, body: await response.json() };
}

function runCliAsync(args) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, PPIE_HOME: HOME, PPIE_BROWSER_OPEN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    processHandle.stdout.setEncoding('utf8');
    processHandle.stderr.setEncoding('utf8');
    processHandle.stdout.on('data', chunk => { stdout += chunk; });
    processHandle.stderr.on('data', chunk => { stderr += chunk; });
    processHandle.once('error', reject);
    processHandle.once('exit', code => resolve({ code, stdout, stderr }));
  });
}
