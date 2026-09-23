# Epochnotes

A signed registry of Solana network changes — and the checks built on it: what breaks in your code, where, and how to fix it.

An upgrade lands, a call that worked for a year starts failing, and the answer lives in a SIMD, a client changelog and a feature gate account — three places, none of them your code. Epochnotes keeps that answer as a signed entry, tells you where it applies in your repository, and reads the activation status from the network at the moment you ask. When it cannot verify what it reads, it refuses to answer rather than guess; when it had nothing to check something against, it says so instead of reporting a clean result.

Status: pre-release. The first signed version of the registry is published after release, so today every reader signs a log of their own — [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md) walks through it end to end in about ten minutes. Nothing here has been audited.

## Layout

| Path                | Purpose                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `packages/core`     | Library: entry schema, canonical hashing, validation, on-chain status reads |
| `packages/cli`      | `epochnotes` command — a thin shell over `core`                             |
| `programs/registry` | Anchor program: publishers and the version log                              |
| `registry/`         | Entry schema, registry entries (YAML) and published versions                |
| `skills/epochnotes` | Claude skill: answers from the verified registry, checks a whole project    |
| `corpus/`           | Before/after code pairs and the manifest of what a correct check reports    |

## Develop

Requires Node.js 22.12+, and for the program: Rust, Solana CLI 4.x, Anchor 0.32.1.

```bash
npm ci
npm run verify        # build + tests + lint
npm run build:program # anchor build
npm run corpus:check  # the corpus manifest, its files and the detection engine agree; prints recall
```

## For AI assistants

`skills/epochnotes` is a Claude skill (copy the directory into `.claude/skills/`). It holds no facts about any change: it reads entries from the latest verified version, reads the activation status from the network, and refuses to answer when verification fails. The commands it uses work for any consumer:

```bash
epochnotes registry read --json --status mainnet-beta   # verified entries, their provenance, gate status with cluster and slot
epochnotes check repo <path> --versions <dir-or-url>    # detection rules taken from the verified version
epochnotes check rpc --rpc-url <endpoint>               # read-only probe: does this provider behave as the entry says
```

A publisher withdraws an entry with a record on chain, which the signed log alone does not show. With `--onchain`, `registry read`, `check repo`, `check rpc` and `rent scan` leave withdrawn entries out, name them under `revoked`, and refuse an entry asked for by name (exit 1), in the same words as `registry verify`. Without it the output says that revocations were not checked.

`--versions` and `--publishers` default to the environment variables `EPOCHNOTES_VERSIONS` and `EPOCHNOTES_PUBLISHERS`. `--working-copy <dir>` reads unsigned entry files, and the output says so.

A check that could not ask its question says so instead of passing. `check repo` lists, under `entriesNotChecked`, every entry that carries no rule a static check can run: no finding for such an entry means nothing was looked for. `check rpc` exits 2, not 0, when no probe observed the endpoint — the probes of an entry are pinned to the cluster of their fixture, so an endpoint of another cluster is left unexamined, and a check that runs it in CI must not go green on that.

## Rent held above the minimum

The staged rent reduction lowers the minimum balance of every account, and returns nothing by itself. `rent scan` measures, read-only, what is left above the minimum:

```bash
epochnotes rent scan --program <address>            # every account of a program, split by account type
epochnotes rent scan --program <address> --sample   # a program too large for one request: seeded random sample, with a standard error
epochnotes rent scan --wallet <address>             # accounts of known programs that the wallet owns
```

Getting it back:

```bash
epochnotes rent close --account <address>   # builds the unsigned transaction for the owner, and simulates it; sends nothing
epochnotes rent template --account-type Position --authority-field owner   # an Anchor instruction for your own program
```

`rent close` has adapters for OpenBook v2 open-orders accounts and marginfi v2 accounts. It reads the owner out of the account, builds the close transaction with that owner as the only signer and as the destination, and asks the cluster what the transaction would do (`simulateTransaction`, signature checks off). It holds no keys and never sends. A program's IDL is not proof that an instruction runs: Drift's IDL lists `deleteUser` and `reclaimRent`, and the deployed program rejects both, which only the simulation showed. `rent template` prints `withdraw_excess`: authority-gated, with the minimum read from the cluster at run time. It takes everything the account holds above that minimum, so it fits accounts whose lamports are a rent deposit and nothing else; the template says so where a developer will read it. With the default names it is the file `programs/rent-example/src/withdraw_excess.rs`, which is tested on a local validator.

A sample splits accounts by one byte of their data. The groups of the byte values 0x00, 0x01 and 0xff are always read, because a flag, a counter or padding piles a whole account type onto them; the rest is sampled. Accounts too short to have that byte sit in no group; they are read separately, by exact size, and counted as they are. When the offset is too far in for that, the result is marked `partial`. The standard error is that of `excessNow` of the sampled part.

The rates come from the registry entry, the rate in force from the Rent sysvar, the state of every step from its feature gate. For OpenBook v2, marginfi v2 and Drift the report says who can close each account type — its owner, a program admin, or nobody — as read from the `close` constraints in the program's source, with the signer taken from its on-chain IDL; for Drift, from what its deployed program answered to a simulation. `excessNow` counts only accounts whose balance is exactly an earlier minimum; everything else above the minimum is reported apart, as an upper bound that may be reserves. The figures are estimates of deposits, not a market size.

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
