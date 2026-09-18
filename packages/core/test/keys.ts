import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

/** Writes a throwaway ed25519 keypair in the `solana-keygen` file format and returns the file path. */
export function writeTestKey(file: string): string {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  // The raw 32-byte seed and public key are the tails of the DER encodings.
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  writeFileSync(file, JSON.stringify([...seed, ...pub]));
  return file;
}
