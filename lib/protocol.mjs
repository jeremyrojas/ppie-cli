import { randomUUID } from 'node:crypto';
import { createError } from './errors.mjs';

export const PROTOCOL = 'promptpie.local/v1';
export const PRODUCTION_ORIGIN = 'https://app.promptpie.dev';
export const MAX_JSON_BYTES = 1024 * 1024 + 16 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function requestEnvelope(type, payload, idempotencyKey = randomUUID()) {
  return { protocol: PROTOCOL, requestId: randomUUID(), idempotencyKey, type, payload };
}

export function validateEnvelope(value, expectedTypes) {
  if (!isRecord(value)) throw protocolError('CLI_MALFORMED_REQUEST', 'Request body must be a JSON object.');
  assertKeys(value, ['protocol', 'requestId', 'idempotencyKey', 'type', 'payload']);
  if (value.protocol !== PROTOCOL) {
    throw protocolError('CLI_INCOMPATIBLE', `Unsupported protocol. Expected ${PROTOCOL}.`, { received: value.protocol });
  }
  if (!ID_PATTERN.test(value.requestId ?? '')) throw protocolError('CLI_MALFORMED_REQUEST', 'Invalid requestId.');
  if (!ID_PATTERN.test(value.idempotencyKey ?? '')) throw protocolError('CLI_MALFORMED_REQUEST', 'Invalid idempotencyKey.');
  if (!expectedTypes.includes(value.type)) throw protocolError('CLI_MALFORMED_REQUEST', `Unsupported request type: ${value.type}.`);
  if (!isRecord(value.payload)) throw protocolError('CLI_MALFORMED_REQUEST', 'Request payload must be a JSON object.');
  return value;
}

export function responseEnvelope(request, payload) {
  return { protocol: PROTOCOL, requestId: request.requestId, ok: true, type: request.type, payload };
}

export function errorEnvelope(error, requestId = null) {
  const safe = sanitizeError(error);
  return { protocol: PROTOCOL, requestId, ok: false, error: safe };
}

export async function readJson(req, limit = MAX_JSON_BYTES) {
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw protocolError('CLI_MALFORMED_REQUEST', 'Content-Type must be application/json.');
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw protocolError('CLI_PAYLOAD_TOO_LARGE', `JSON body exceeds ${limit} bytes.`, {}, 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw protocolError('CLI_MALFORMED_REQUEST', 'Request body contains malformed JSON.');
  }
}

export function protocolError(code, message, details = {}, statusCode = 400) {
  const error = createError(code, message, details);
  error.statusCode = statusCode;
  return error;
}

export function sanitizeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'CLI_ERROR',
    message: redactSecrets(typeof error?.message === 'string' ? error.message : 'Unexpected companion error.'),
    details: redactValue(error?.details ?? {}),
  };
}

export function redactSecrets(text) {
  return String(text)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:token|nonce|secret|sessionToken)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function redactValue(value, key = '') {
  if (/token|nonce|secret|authorization/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(item => redactValue(item));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, k)]));
  return value;
}

function assertKeys(value, allowed) {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw protocolError('CLI_MALFORMED_REQUEST', `Unknown envelope field: ${extra}.`);
  const missing = allowed.find(key => !Object.hasOwn(value, key));
  if (missing) throw protocolError('CLI_MALFORMED_REQUEST', `Missing envelope field: ${missing}.`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
