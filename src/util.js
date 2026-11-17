// Small shared helpers. No dependencies beyond Node built-ins.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function packageHash(sourceId, bundle) {
  return 'sha256:' + sha256(sourceId + '\u0000' + stableStringify(bundle));
}

export function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** A value as it appeared on the wire, plus where it came from. */
export function origin(selector) {
  return { selector, hash: 'sha256:' + sha256(stableStringify(selector)) };
}

export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Structural fingerprint of a JSON value: object keys matter, array/object shape matters,
 * leaf scalar *types* matter. Array contents are ignored on purpose: an alternating
 * array is just a longer list of the same per-element shape. Order matters in objects
 * only for readability — sortKeys normalizes it.
 */
export function signature(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth > 8) return 'array<deep>';
    const inner = value.length === 0 ? 'empty' : [...new Set(value.map((v) => signature(v, depth + 1)))].sort().join('|');
    return `array<${inner}>`;
  }
  if (typeof value === 'object') {
    if (depth > 8) return 'object<deep>';
    return '{' + Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${signature(value[k], depth + 1)}`).join(',') + '}';
  }
  return typeof value;
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
