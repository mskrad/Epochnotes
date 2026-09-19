import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Writes a throwaway ed25519 keypair in the `solana-keygen` file format and returns the file path. */
export function writeTestKey(file: string): string {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  // The raw 32-byte seed and public key are the tails of the DER encodings.
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  writeFileSync(file, JSON.stringify([...seed, ...pub]));
  return file;
}

/**
 * The registry config on a validator is a singleton with one admin, so every on-chain test suite has to
 * act as the same admin. The key is a throwaway kept under the ignored `target/` directory.
 */
export function sharedTestAdminKey(): string {
  const file = new URL('../../../target/test-registry-admin.json', import.meta.url).pathname;
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeTestKey(file);
  }
  return file;
}
