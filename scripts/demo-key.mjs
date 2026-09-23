// Writes a throwaway ed25519 keypair in the format the Solana CLI uses, for the demo in DEMO_RUNBOOK.md.
// It exists so that the demo runs without the Solana toolchain installed; `solana-keygen new` does the same.
// This key signs a local version log and nothing else: it holds no funds and is not the registry publisher.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const file = process.argv[2];
if (file === undefined) {
  console.error('usage: node scripts/demo-key.mjs <file>');
  process.exit(2);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const jwk = privateKey.export({ format: 'jwk' });
const secret = Buffer.from(jwk.d, 'base64url');
const address = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
// The Solana keypair file is the 32-byte seed followed by the 32-byte public key, as a JSON array of bytes.
writeFileSync(file, JSON.stringify([...secret, ...address]), { mode: 0o600 });
console.log(`wrote ${file}: a throwaway signing key for the demo, readable by its owner only`);
