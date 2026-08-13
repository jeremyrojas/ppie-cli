import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createError } from './errors.mjs';
import { PRODUCTION_ORIGIN } from './protocol.mjs';

export const NONCE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 12 * 60 * 60_000;
export const DEFAULT_CLIENT_DISPLAY_NAME = 'Prompt Pie CLI';

export function validateAllowedOrigin(value = PRODUCTION_ORIGIN) {
  let url;
  try { url = new URL(value); } catch { throw createError('CLI_INVALID_ORIGIN', `Invalid origin: ${value}.`); }
  if (url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw createError('CLI_INVALID_ORIGIN', 'Allowed origin must contain only scheme, host, and optional port.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw createError('CLI_INVALID_ORIGIN', 'Local development origins must use a loopback hostname.');
  }
  return url.origin;
}

export function createPairingState(now = Date.now(), displayName = DEFAULT_CLIENT_DISPLAY_NAME) {
  return {
    nonce: randomBytes(24).toString('base64url'),
    expiresAt: now + NONCE_TTL_MS,
    used: false,
    client: { displayName: validateClientDisplayName(displayName) },
  };
}

export function validateClientDisplayName(value) {
  const length = typeof value === 'string' ? Array.from(value).length : 0;
  const validCharacters = typeof value === 'string' && /^[\p{L}\p{N}._ -]+$/u.test(value);
  const validEdges = typeof value === 'string' && /^[\p{L}\p{N}].*[\p{L}\p{N}]$/u.test(value);
  const oneCharacterName = typeof value === 'string' && /^[\p{L}\p{N}]$/u.test(value);
  if (
    length < 1 || length > 40 || value.trim() !== value || value.includes('  ') ||
    !validCharacters || (!validEdges && !oneCharacterName)
  ) {
    throw createError(
      'CLI_INVALID_CLIENT_NAME',
      'Client name must be 1-40 letters, numbers, spaces, dots, underscores, or hyphens and start and end with a letter or number.',
    );
  }
  return value;
}

export function consumeNonce(state, candidate, now = Date.now()) {
  if (state.used) throw createError('CLI_PAIRING_REPLAY', 'Pairing nonce has already been used.');
  if (now > state.expiresAt) throw createError('CLI_PAIRING_EXPIRED', 'Pairing nonce has expired. Run "ppie pair" again.');
  if (!safeEqual(state.nonce, candidate)) throw createError('CLI_PAIRING_REJECTED', 'Pairing nonce is invalid.');
  state.used = true;
  return true;
}

export function createSession(now = Date.now()) {
  return { token: randomBytes(32).toString('base64url'), id: randomBytes(16).toString('hex'), expiresAt: now + SESSION_TTL_MS };
}

export function validateSession(session, candidate, now = Date.now()) {
  if (!session || now > session.expiresAt || !safeEqual(session.token, candidate)) {
    throw createError('CLI_NOT_PAIRED', 'Prompt Pie browser is disconnected. Run "ppie pair".');
  }
  return session;
}

export function isAllowedRequestOrigin(received, allowed) {
  return typeof received === 'string' && received === allowed;
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function safeEqual(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
