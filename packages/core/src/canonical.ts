import { createHash } from 'node:crypto';

/** A value the canonical form accepts: no floats, no null, no undefined. */
export type CanonicalValue = string | number | boolean | CanonicalValue[] | { [key: string]: CanonicalValue };

export class CanonicalizationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path || '(root)'}`);
    this.name = 'CanonicalizationError';
  }
}

/**
 * Canonical JSON text per RFC 8785 (JCS), restricted to strings, integers, booleans, arrays and objects.
 * With floats excluded, JCS reduces to: keys sorted by UTF-16 code units, no whitespace, JSON string
 * escaping — so any language can reproduce the bytes. Strings are normalized to Unicode NFC first.
 */
export function canonicalize(value: unknown, path = ''): string {
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new CanonicalizationError('Only safe integers are allowed', path);
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .map(([key, member]) => [key.normalize('NFC'), member] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, member]) => `${JSON.stringify(key)}:${canonicalize(member, path ? `${path}.${key}` : key)}`,
      );
    return `{${members.join(',')}}`;
  }
  throw new CanonicalizationError(
    `Unsupported value of type ${value === null ? 'null' : typeof value}`,
    path,
  );
}

/** Merkle leaf of an entry: sha256 over the canonical bytes. Key order of the input does not matter. */
export function entryLeafHash(entry: unknown): Uint8Array {
  return createHash('sha256').update(canonicalize(entry), 'utf8').digest();
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
