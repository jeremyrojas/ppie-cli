import { createError } from './errors.mjs';

const VALID_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const MAX_NAME_LENGTH = 64;

export function validateName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw createError('SKILL_NAME_REQUIRED', 'Skill name is required.');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw createError('SKILL_NAME_TOO_LONG', `Skill name too long (max ${MAX_NAME_LENGTH} characters).`, {
      maxLength: MAX_NAME_LENGTH,
      name,
    });
  }
  if (!VALID_NAME_PATTERN.test(name)) {
    throw createError('INVALID_SKILL_NAME', `Invalid skill name "${name}". Use alphanumeric, hyphens, dots, underscores.`, {
      name,
    });
  }
  return name;
}
