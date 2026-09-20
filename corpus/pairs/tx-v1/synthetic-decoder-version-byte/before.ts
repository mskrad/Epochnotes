// Written for the corpus: a hand-written decoder with no branch for the version byte of version 1.
export function versionOf(bytes: Uint8Array): 'legacy' | 0 {
  const first = bytes[0] as number;
  if ((first & 0x80) === 0) return 'legacy';
  if ((first & 0x7f) === 0) return 0;
  throw new Error(`unsupported transaction version ${first & 0x7f}`);
}
