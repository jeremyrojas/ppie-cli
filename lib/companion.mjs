import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createError } from './errors.mjs';
import { COMPANION_STARTUP_FILE, COMPANION_STATE_FILE } from './paths.mjs';
import {
  MAX_JSON_BYTES, PROTOCOL, REQUEST_TIMEOUT_MS, errorEnvelope, protocolError, readJson,
  requestEnvelope, responseEnvelope, sanitizeError, validateEnvelope,
} from './protocol.mjs';
import {
  DEFAULT_CLIENT_DISPLAY_NAME, consumeNonce, createPairingState, createSession,
  isAllowedRequestOrigin, validateAllowedOrigin, validateClientDisplayName, validateSession,
} from './pairing.mjs';
import { validatePrompt, validateRevision } from './revision.mjs';

const LOOPBACK = '127.0.0.1';
const START_TIMEOUT_MS = 5_000;
const STATUS_TIMEOUT_MS = 750;
const MAX_POLL_MS = 25_000;
const DEDUPE_TTL_MS = 10 * 60_000;
export const COMPANION_API_VERSION = 2;

export async function pairCompanion({ origin, executable, version, clientName = DEFAULT_CLIENT_DISPLAY_NAME }) {
  const allowedOrigin = validateAllowedOrigin(origin);
  const displayName = validateClientDisplayName(clientName);
  const current = await readHealthyCompanion();
  const reusable = isCompatibleCompanion(current, allowedOrigin);
  let challenge;
  if (reusable) {
    challenge = await privateRequest(current.state, '/v1/cli/operations', requestEnvelope('cli.pair', {
      client: { displayName },
    }));
  } else {
    if (current) await replaceCompanion(current.state);
    challenge = await spawnCompanion({ allowedOrigin, executable, version, displayName });
  }
  return {
    origin: allowedOrigin,
    port: challenge.port,
    url: pairUrl(allowedOrigin, challenge.port, challenge.nonce),
    expiresAt: challenge.expiresAt,
    reused: reusable,
  };
}

export async function getCompanionStatus() {
  const state = readState();
  if (!state) return { running: false, paired: false, protocol: PROTOCOL };
  try {
    const payload = await privateGet(state, '/v1/cli/status');
    return { running: true, ...payload };
  } catch {
    return {
      running: false,
      paired: false,
      protocol: state.protocol ?? PROTOCOL,
      stale: true,
      origin: state.origin,
      startedAt: state.startedAt,
    };
  }
}

export async function submitCompanionOperation(operation, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const current = await readHealthyCompanion();
  if (!current) throw createError('CLI_NOT_PAIRED', 'Local companion is unavailable. Run "ppie pair".');
  if (!isCompatibleCompanion(current, current.state.origin)) {
    throw createError('CLI_INCOMPATIBLE', 'Local companion belongs to another CLI release. Run "ppie pair" to restart it safely.');
  }
  const envelope = requestEnvelope('cli.operation', { operation, timeoutMs });
  const response = await privateRequest(current.state, '/v1/cli/operations', envelope, timeoutMs + 1_000);
  return response;
}

export async function runCompanion({ origin, version, clientName = DEFAULT_CLIENT_DISPLAY_NAME }) {
  const allowedOrigin = validateAllowedOrigin(origin);
  const internalToken = randomBytes(32).toString('base64url');
  let pairing = createPairingState(Date.now(), clientName);
  let session = null;
  let closing = false;
  const queue = [];
  const pending = new Map();
  const expiredOperations = new Map();
  const dedupe = new Map();
  let pollWaiter = null;

  const server = createServer(async (req, res) => {
    const browserPath = req.url === '/v1/pair' || req.url === '/v1/browser/poll' || req.url === '/v1/browser/result';
    let requestId = null;
    try {
      if (browserPath) {
        enforceOrigin(req, allowedOrigin);
        setCors(res, allowedOrigin);
      } else if (req.headers.origin) {
        throw protocolError('CLI_ORIGIN_REJECTED', 'CLI-private endpoints reject browser origins.', {}, 403);
      }

      if (req.method === 'OPTIONS' && browserPath) {
        res.writeHead(204, preflightHeaders(req));
        res.end();
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/cli/status') {
        authorizeInternal(req, internalToken);
        writeJson(res, 200, {
          protocol: PROTOCOL,
          companionApiVersion: COMPANION_API_VERSION,
          version,
          origin: allowedOrigin,
          port: server.address().port,
          pid: process.pid,
          paired: isSessionActive(session),
          sessionExpiresAt: isSessionActive(session) ? new Date(session.expiresAt).toISOString() : null,
          startedAt,
        });
        return;
      }

      if (req.method !== 'POST') throw protocolError('CLI_NOT_FOUND', 'Endpoint not found.', {}, 404);
      const body = await readJson(req, MAX_JSON_BYTES);
      if (typeof body?.requestId === 'string') requestId = body.requestId;

      if (req.url === '/v1/pair') {
        const envelope = validateEnvelope(body, ['browser.pair']);
        const result = await idempotent(dedupe, `pair:${envelope.idempotencyKey}`, envelope, async () => {
          validatePairPayload(envelope.payload);
          consumeNonce(pairing, envelope.payload.nonce);
          if (isSessionActive(session)) rejectPending(createError('CLI_NOT_PAIRED', 'Prompt Pie browser session was replaced. Run the command again.'));
          session = createSession();
          return responseEnvelope(envelope, {
            session: { id: session.id, token: session.token, expiresAt: new Date(session.expiresAt).toISOString() },
            companion: { protocol: PROTOCOL, version },
            client: pairing.client,
          });
        });
        writeJson(res, 200, result);
        return;
      }

      if (req.url === '/v1/browser/poll') {
        const activeSession = authorizeBrowser(req, session);
        const envelope = validateEnvelope(body, ['browser.poll']);
        const result = await idempotent(dedupe, `${activeSession.id}:${envelope.idempotencyKey}`, envelope, async () => {
          const waitMs = validatePollPayload(envelope.payload);
          const operation = await nextOperation(waitMs);
          return responseEnvelope(envelope, { operation });
        });
        writeJson(res, 200, result);
        return;
      }

      if (req.url === '/v1/browser/result') {
        const activeSession = authorizeBrowser(req, session);
        const envelope = validateEnvelope(body, ['browser.result']);
        const result = await idempotent(dedupe, `${activeSession.id}:${envelope.idempotencyKey}`, envelope, async () => {
          acceptBrowserResult(envelope.payload);
          return responseEnvelope(envelope, { accepted: true });
        });
        writeJson(res, 200, result);
        return;
      }

      if (req.url === '/v1/cli/operations') {
        authorizeInternal(req, internalToken);
        const envelope = validateEnvelope(body, ['cli.pair', 'cli.operation', 'cli.shutdown']);
        const result = await idempotent(dedupe, `cli:${envelope.idempotencyKey}`, envelope, async () => {
          if (envelope.type === 'cli.pair') {
            const displayName = validatePairChallengePayload(envelope.payload);
            pairing = createPairingState(Date.now(), displayName);
            return responseEnvelope(envelope, {
              port: server.address().port,
              nonce: pairing.nonce,
              expiresAt: new Date(pairing.expiresAt).toISOString(),
            });
          }
          if (envelope.type === 'cli.shutdown') {
            setImmediate(shutdown);
            return responseEnvelope(envelope, { shuttingDown: true });
          }
          const operation = validateCliOperation(envelope.payload);
          if (!isSessionActive(session)) throw protocolError('CLI_NOT_PAIRED', 'Prompt Pie browser is disconnected. Run "ppie pair".', {}, 409);
          const operationResult = await enqueueOperation(operation, envelope.payload.timeoutMs);
          return responseEnvelope(envelope, operationResult);
        });
        writeJson(res, 200, result);
        return;
      }

      throw protocolError('CLI_NOT_FOUND', 'Endpoint not found.', {}, 404);
    } catch (error) {
      const status = error.statusCode ?? statusForError(error.code);
      writeJson(res, status, errorEnvelope(error, requestId));
    }
  });

  const startedAt = new Date().toISOString();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, resolve);
  });
  const port = server.address().port;
  const state = {
    protocol: PROTOCOL,
    companionApiVersion: COMPANION_API_VERSION,
    version,
    origin: allowedOrigin,
    host: LOOPBACK,
    port,
    pid: process.pid,
    startedAt,
    internalToken,
  };
  writePrivateJson(COMPANION_STATE_FILE, state);
  writePrivateJson(COMPANION_STARTUP_FILE, {
    pid: process.pid,
    port,
    nonce: pairing.nonce,
    expiresAt: new Date(pairing.expiresAt).toISOString(),
  });

  const cleanupTimer = setInterval(cleanup, 30_000);
  cleanupTimer.unref();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  function nextOperation(waitMs) {
    if (queue.length > 0) return Promise.resolve(queue.shift().wire);
    if (pollWaiter) {
      clearTimeout(pollWaiter.timer);
      pollWaiter.resolve(null);
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (pollWaiter?.timer === timer) pollWaiter = null;
        resolve(null);
      }, waitMs);
      pollWaiter = { resolve, timer };
    });
  }

  function enqueueOperation(operation, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (pending.has(operation.operationId) || expiredOperations.has(operation.operationId)) {
        reject(protocolError('CLI_IDEMPOTENCY_CONFLICT', 'operationId has already been used.', {}, 409));
        return;
      }
      const record = { wire: operation, resolve, reject, timer: null };
      record.timer = setTimeout(() => {
        pending.delete(operation.operationId);
        const index = queue.indexOf(record);
        if (index >= 0) queue.splice(index, 1);
        expiredOperations.set(operation.operationId, Date.now() + DEDUPE_TTL_MS);
        reject(protocolError('CLI_OPERATION_TIMEOUT', 'Prompt Pie browser did not respond before the operation timed out.', {}, 504));
      }, timeoutMs);
      pending.set(operation.operationId, record);
      if (pollWaiter) {
        const waiter = pollWaiter;
        pollWaiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve(operation);
      } else {
        queue.push(record);
      }
    });
  }

  function acceptBrowserResult(payload) {
    validateResultPayload(payload);
    const record = pending.get(payload.operationId);
    if (!record) {
      if (expiredOperations.has(payload.operationId)) {
        throw protocolError('CLI_OPERATION_EXPIRED', 'CLI operation has expired.', {}, 410);
      }
      throw protocolError('CLI_MALFORMED_REQUEST', 'Unknown operationId.');
    }
    pending.delete(payload.operationId);
    clearTimeout(record.timer);
    if (payload.error) {
      const remote = createError(payload.error.code, payload.error.message, payload.error.details ?? {});
      record.reject(remote);
    } else {
      record.resolve({ prompt: validatePrompt(payload.result.prompt, { requireRevision: true }) });
    }
  }

  function cleanup() {
    const now = Date.now();
    for (const [key, entry] of dedupe) if (entry.expiresAt < now) dedupe.delete(key);
    for (const [key, expiresAt] of expiredOperations) if (expiresAt < now) expiredOperations.delete(key);
    if (session && session.expiresAt < now) {
      session = null;
      rejectPending(createError('CLI_NOT_PAIRED', 'Prompt Pie browser session expired. Run "ppie pair".'));
    }
  }

  function rejectPending(error) {
    for (const record of pending.values()) {
      clearTimeout(record.timer);
      record.reject(error);
    }
    pending.clear();
    queue.length = 0;
  }

  function shutdown() {
    if (closing) return;
    closing = true;
    removeOwnedState(process.pid);
    clearInterval(cleanupTimer);
    if (pollWaiter) {
      clearTimeout(pollWaiter.timer);
      pollWaiter.resolve(null);
      pollWaiter = null;
    }
    rejectPending(createError('CLI_NOT_PAIRED', 'Local companion stopped. Run "ppie pair".'));
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1_000).unref();
  }
}

function validatePairPayload(payload) {
  assertExactObject(payload, ['nonce', 'client']);
  if (typeof payload.nonce !== 'string' || payload.nonce.length > 64) throw protocolError('CLI_MALFORMED_REQUEST', 'Invalid pairing nonce.');
  assertExactObject(payload.client, ['name', 'version']);
  if (payload.client.name !== 'promptpie-web' || typeof payload.client.version !== 'string' || payload.client.version.length > 64) {
    throw protocolError('CLI_MALFORMED_REQUEST', 'Invalid browser client identity.');
  }
}

function validatePairChallengePayload(payload) {
  assertExactObject(payload, ['client']);
  assertExactObject(payload.client, ['displayName']);
  return validateClientDisplayName(payload.client.displayName);
}

function validatePollPayload(payload) {
  assertExactObject(payload, ['waitMs']);
  if (!Number.isInteger(payload.waitMs) || payload.waitMs < 0 || payload.waitMs > MAX_POLL_MS) {
    throw protocolError('CLI_MALFORMED_REQUEST', `waitMs must be an integer from 0 to ${MAX_POLL_MS}.`);
  }
  return payload.waitMs;
}

function validateCliOperation(payload) {
  assertExactObject(payload, ['operation', 'timeoutMs']);
  if (!Number.isInteger(payload.timeoutMs) || payload.timeoutMs < 100 || payload.timeoutMs > REQUEST_TIMEOUT_MS) {
    throw protocolError('CLI_MALFORMED_REQUEST', `timeoutMs must be an integer from 100 to ${REQUEST_TIMEOUT_MS}.`);
  }
  const op = payload.operation;
  if (!op || typeof op !== 'object' || Array.isArray(op)) throw protocolError('CLI_MALFORMED_REQUEST', 'operation must be an object.');
  if (typeof op.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(op.operationId)) throw protocolError('CLI_MALFORMED_REQUEST', 'Invalid operationId.');
  if (op.kind === 'prompt.push') {
    assertExactObject(op, ['operationId', 'kind', 'prompt', 'expectedRevision']);
    return { ...op, prompt: validatePrompt(op.prompt, { requireRevision: true }), expectedRevision: op.expectedRevision === null ? null : validateRevision(op.expectedRevision, 'expectedRevision') };
  }
  if (op.kind === 'prompt.pull') {
    assertExactObject(op, ['operationId', 'kind', 'promptId']);
    if (typeof op.promptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(op.promptId)) throw protocolError('CLI_MALFORMED_REQUEST', 'Invalid promptId.');
    return op;
  }
  throw protocolError('CLI_MALFORMED_REQUEST', `Unsupported operation kind: ${op.kind}.`);
}

function validateResultPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw protocolError('CLI_MALFORMED_REQUEST', 'Result payload must be a JSON object.');
  const hasResult = Object.hasOwn(payload, 'result');
  const hasError = Object.hasOwn(payload, 'error');
  assertExactObject(payload, hasResult ? ['operationId', 'result'] : ['operationId', 'error']);
  if (hasResult === hasError || typeof payload.operationId !== 'string') throw protocolError('CLI_MALFORMED_REQUEST', 'Result must include operationId and exactly one of result or error.');
  if (hasResult) {
    assertExactObject(payload.result, ['prompt']);
    validatePrompt(payload.result.prompt, { requireRevision: true });
  } else {
    assertExactObject(payload.error, ['code', 'message', 'details'], ['code', 'message']);
    if (typeof payload.error.code !== 'string' || !/^CLI_[A-Z0-9_]+$/.test(payload.error.code) || typeof payload.error.message !== 'string') {
      throw protocolError('CLI_MALFORMED_REQUEST', 'Invalid operation error.');
    }
    if (payload.error.message.length > 4_096 || (payload.error.details !== undefined && (!payload.error.details || typeof payload.error.details !== 'object' || Array.isArray(payload.error.details)))) {
      throw protocolError('CLI_MALFORMED_REQUEST', 'Invalid operation error details.');
    }
  }
}

async function idempotent(cache, key, envelope, handler) {
  const fingerprint = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
  const requestKey = `request:${envelope.requestId}`;
  const existing = cache.get(key) ?? cache.get(requestKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw protocolError('CLI_IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with different request content.', {}, 409);
    return existing.promise;
  }
  const promise = Promise.resolve().then(handler);
  const entry = { fingerprint, promise, expiresAt: Date.now() + DEDUPE_TTL_MS };
  cache.set(key, entry);
  cache.set(requestKey, entry);
  return promise;
}

function enforceOrigin(req, allowedOrigin) {
  if (!isAllowedRequestOrigin(req.headers.origin, allowedOrigin)) {
    throw protocolError('CLI_ORIGIN_REJECTED', 'Browser origin is not allowed.', {}, 403);
  }
}

function authorizeInternal(req, expected) {
  if (req.headers['x-promptpie-token'] !== expected) throw protocolError('CLI_UNAUTHORIZED', 'Invalid CLI authorization.', {}, 401);
}

function authorizeBrowser(req, session) {
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  try { return validateSession(session, token); } catch (error) { error.statusCode = 401; throw error; }
}

function isSessionActive(session) {
  return Boolean(session && session.expiresAt >= Date.now());
}

function setCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
}

function preflightHeaders(req) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
  };
  if (req.headers['access-control-request-private-network'] === 'true') headers['Access-Control-Allow-Private-Network'] = 'true';
  return headers;
}

function writeJson(res, status, value) {
  if (res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function statusForError(code) {
  if (code === 'CLI_UNAUTHORIZED' || code === 'CLI_NOT_PAIRED') return 401;
  if (code === 'CLI_ORIGIN_REJECTED') return 403;
  if (code === 'CLI_NOT_FOUND') return 404;
  if (code === 'CLI_OPERATION_EXPIRED') return 410;
  if (code === 'CLI_PAYLOAD_TOO_LARGE') return 413;
  if (code === 'CLI_OPERATION_TIMEOUT') return 504;
  if (code === 'CLI_IDEMPOTENCY_CONFLICT') return 409;
  if (code === 'CLI_REVISION_CONFLICT') return 409;
  return 400;
}

function assertExactObject(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError('CLI_MALFORMED_REQUEST', 'Payload must be a JSON object.');
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw protocolError('CLI_MALFORMED_REQUEST', `Unknown payload field: ${extra}.`);
  const missing = required.find(key => !Object.hasOwn(value, key));
  if (missing) throw protocolError('CLI_MALFORMED_REQUEST', `Missing payload field: ${missing}.`);
}

async function spawnCompanion({ allowedOrigin, executable, version, displayName }) {
  rmSync(COMPANION_STARTUP_FILE, { force: true });
  const child = spawn(process.execPath, [executable, '__companion'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PPIE_COMPANION_ORIGIN: allowedOrigin,
      PPIE_COMPANION_VERSION: version,
      PPIE_COMPANION_CLIENT_NAME: displayName,
    },
  });
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const startup = JSON.parse(readFileSync(COMPANION_STARTUP_FILE, 'utf8'));
      if (startup.pid === child.pid) {
        rmSync(COMPANION_STARTUP_FILE, { force: true });
        return startup;
      }
    } catch {}
    await delay(40);
  }
  child.kill('SIGTERM');
  removeOwnedState(child.pid);
  throw createError('CLI_COMPANION_START_FAILED', 'Local companion did not start.');
}

async function readHealthyCompanion() {
  const state = readState();
  if (!state) return null;
  try {
    const status = await privateGet(state, '/v1/cli/status');
    return { state, status };
  } catch {
    return null;
  }
}

function isCompatibleCompanion(current, allowedOrigin) {
  return Boolean(
    current &&
    current.state.origin === allowedOrigin &&
    current.status.origin === allowedOrigin &&
    current.status.protocol === PROTOCOL &&
    current.status.companionApiVersion === COMPANION_API_VERSION
  );
}

function readState() {
  try {
    const state = JSON.parse(readFileSync(COMPANION_STATE_FILE, 'utf8'));
    if (state.host !== LOOPBACK || !Number.isInteger(state.port) || typeof state.internalToken !== 'string') return null;
    return state;
  } catch { return null; }
}

async function privateGet(state, path) {
  const response = await fetchWithTimeout(`http://${LOOPBACK}:${state.port}${path}`, {
    headers: { 'X-PromptPie-Token': state.internalToken },
  }, STATUS_TIMEOUT_MS);
  return parseResponse(response);
}

async function privateRequest(state, path, envelope, timeoutMs = STATUS_TIMEOUT_MS) {
  const response = await fetchWithTimeout(`http://${LOOPBACK}:${state.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PromptPie-Token': state.internalToken },
    body: JSON.stringify(envelope),
  }, timeoutMs);
  const payload = await parseResponse(response);
  return payload.payload;
}

async function replaceCompanion(state) {
  try {
    await privateRequest(state, '/v1/cli/operations', requestEnvelope('cli.shutdown', {}));
  } catch {}
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await privateGet(state, '/v1/cli/status');
    } catch {
      return;
    }
    await delay(40);
  }
  throw createError(
    'CLI_COMPANION_RESTART_FAILED',
    'Existing local companion did not stop cleanly. Stop it and run "ppie pair" again.',
  );
}

async function fetchWithTimeout(url, options, timeoutMs) {
  try { return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw createError('CLI_NOT_PAIRED', 'Local companion is unavailable. Run "ppie pair".'); }
}

async function parseResponse(response) {
  let payload;
  try { payload = await response.json(); } catch { throw createError('CLI_INCOMPATIBLE', 'Local companion returned an invalid response. Run "ppie pair".'); }
  if (payload.protocol && payload.protocol !== PROTOCOL) throw createError('CLI_INCOMPATIBLE', `Local companion uses unsupported protocol ${payload.protocol}.`);
  if (!response.ok || payload.ok === false) {
    const safe = sanitizeError(payload.error);
    throw createError(safe.code, safe.message, safe.details);
  }
  return payload;
}

function pairUrl(origin, port, nonce) {
  const fragment = new URLSearchParams({ protocol: PROTOCOL, port: String(port), nonce });
  return `${origin}/pair#${fragment}`;
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
}

function removeOwnedState(pid) {
  try {
    const state = JSON.parse(readFileSync(COMPANION_STATE_FILE, 'utf8'));
    if (state.pid === pid) rmSync(COMPANION_STATE_FILE, { force: true });
  } catch {}
  try {
    const startup = JSON.parse(readFileSync(COMPANION_STARTUP_FILE, 'utf8'));
    if (startup.pid === pid) rmSync(COMPANION_STARTUP_FILE, { force: true });
  } catch {}
}
