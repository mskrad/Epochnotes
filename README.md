# Epochnotes

A signed registry of Solana network changes — and the checks built on it: what breaks in your code, where, and how to fix it.

Status: early development. Nothing here is ready for use yet.

## Layout

| Path                | Purpose                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `packages/core`     | Library: entry schema, canonical hashing, validation, on-chain status reads |
| `packages/cli`      | `epochnotes` command — a thin shell over `core`                             |
| `programs/registry` | Anchor program: publishers and the version log                              |
| `registry/`         | Entry schema, registry entries (YAML) and published versions                |
| `corpus/`           | Before/after code pairs used to evaluate detection rules                    |

## Develop

Requires Node.js 22.12+, and for the program: Rust, Solana CLI 4.x, Anchor 0.32.1.

```bash
npm ci
npm run verify        # build + tests + lint
npm run build:program # anchor build
```

## What the signed log proves, and what it does not

A registry version is a Merkle root over all entries, linked to the previous version and signed by its publisher. `epochnotes registry verify` checks the signatures, the chain of versions and the content hash without trusting the server. `--onchain` also compares the log with the registry program on Solana, which is what catches a log that was truncated, or re-signed with different content by the holder of the publisher key, and an entry its publisher has revoked.

Limits you should know about:

- **Upgrade authority.** The on-chain program is upgradeable and one key holds the authority. Whoever holds it can replace the program. The log cannot be forked by a publisher or a server; it can by that key holder.
- **Initialization.** `initialize` makes its first caller the admin. Deploy and initialize in one go, then read the `Config` account back.
- **No admin rotation.** Losing the admin key means upgrading the program.
- **The RPC node is trusted.** State is read at `confirmed` commitment with no state proofs. A lagging or dishonest node can hide newer versions and revocations.
- **Revision rules live off chain.** The program sees roots, not content, so "every edit raises `rev`" is enforced by the publisher's tooling, not by the chain.
- **A suspended publisher fails verification**, including versions it published earlier: the chain does not record since when the key was unsafe.
- **Revocations are permanent**, and a revoked id is never reused.
- **Writes go to devnet and to a local validator only.** The cluster is identified by its genesis hash, not by the name or URL you pass.

Deployed on devnet only, for development. Nothing here has been audited.

## License

MIT
