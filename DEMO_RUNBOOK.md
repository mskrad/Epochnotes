# Demo runbook

Every step below runs from a clean clone, on a machine with Node.js 22.12+ and network access for reading.
Nothing is signed or sent to a cluster: the writes in this runbook go to a directory on your disk.

The point of the demo is not that the tool finds a broken line. It is where the answer comes from: a signed
version of the registry, an activation status read from the network, and a report that says what it did not
check.

## 0. Clone and prove the build

```bash
git clone <repository-url> epochnotes && cd epochnotes
npm ci
npm run verify
```

`npm run verify` builds both packages, runs the tests and the linters. It must exit 0.

## 1. Publish a demo version of the registry

The registry entries in `registry/entries` are files. A consumer never reads them directly: they read a
**version** — all entries hashed into a Merkle root, signed by a publisher. The published version of the real
registry is not in this repository, so the demo signs one with a throwaway key.

```bash
mkdir -p demo
node scripts/demo-key.mjs demo/demo-key.json          # or: solana-keygen new --no-bip39-passphrase -o demo/demo-key.json
npx epochnotes registry publish --key demo/demo-key.json --entries registry/entries \
  --versions demo/versions --uri "https://example.invalid/{root}.jsonl"
```

The first line of the output names the publisher key. Put it in a file of publishers you trust — this is the
only trust anchor a consumer has, and it is yours, not the tool's:

```bash
cat > demo/publishers.json <<'JSON'
{ "publishers": [{ "name": "demo", "key": "<the key printed above>", "status": "active" }] }
JSON
export EPOCHNOTES_VERSIONS=$PWD/demo/versions
export EPOCHNOTES_PUBLISHERS=$PWD/demo/publishers.json
```

The demo key signs a log on your disk and nothing else. It is not the registry publisher key, holds no funds,
and is not registered in the on-chain program — so `--onchain` will refuse it, which is the correct answer.

## 2. Read an entry, with the status taken from the network

```bash
npx epochnotes registry read tx-v1 --status mainnet-beta
```

What to look at, in this order:

- the first line: **verified**, which version, which publisher, which root, and that revocations were not
  checked because `--onchain` was not passed;
- `status read from mainnet-beta at slot N` — the activation state comes from the feature gate accounts at
  the moment you ask, not from the entry;
- `breaks` items with the surface they belong to, and the `fix` for each;
- `sources` with the date each one was read.

## 3. Prove the entry belongs to the signed version

```bash
npx epochnotes registry verify tx-v1
```

The proof is a Merkle path to a signed root, checked against the content the manifest points at. Note the
`pin` line: pass it back as `--pin <n:root>` next time and a rolled-back or rewritten log is refused.

Now damage the content and watch the tool refuse rather than answer:

```bash
node -e "const f=require('node:fs');const p=process.argv[1];f.writeFileSync(p,f.readFileSync(p,'utf8').replace('-32015','-32016'))" \
  demo/versions/*.jsonl
npx epochnotes registry read tx-v1 ; echo "exit=$?"
```

Exit 1, no entry printed. A registry that fails verification is exactly the case this tool exists for.
Restore it by publishing again into a fresh directory:

```bash
rm -rf demo/versions && npx epochnotes registry publish --key demo/demo-key.json \
  --entries registry/entries --versions demo/versions --uri "https://example.invalid/{root}.jsonl"
```

## 4. Check code against the version

The repository carries a corpus of before/after pairs taken from real projects. Point the check at one:

```bash
npx epochnotes check repo corpus/pairs/tx-v1/real-altude-js-gettransaction ; echo "exit=$?"
```

Exit 1 with one `BREAKS` finding — the file, the line, the rule, the fix. Then read the lines below the
count, which are the point of the demo:

- `not run: …` — a rule none of the files it reads was read for. It was not answered, so it is named, and the
  reason says whether the language never turned up or the file was skipped (`skipped:` lines say which).
- `not checked: …` — an entry that carries no rule a static check can run. Nothing in this code was compared
  against it. Silence about it would read as a clean result, so the report refuses to be silent.

Every pair holds the code before the fix and after it, so that directory always has one finding. Put the
fixed file alone in a directory and the same command exits 0 with `0 finding(s)`:

```bash
mkdir -p demo/fixed && cp corpus/pairs/tx-v1/real-altude-js-gettransaction/after.ts demo/fixed/
npx epochnotes check repo demo/fixed ; echo "exit=$?"
```

## 5. Ask an RPC provider how it really behaves

An entry can pin a transaction on a cluster and say how a correct endpoint answers for it. The probe reads;
it never writes.

```bash
npx epochnotes check rpc --rpc-url https://api.mainnet-beta.solana.com ; echo "exit=$?"
```

You get the three calls it made and what each returned. Point it at an endpoint of another cluster and it
exits 2, not 0: no probe could speak about that endpoint, and a green run would be a lie.

```bash
npx epochnotes check rpc --rpc-url https://api.devnet.solana.com ; echo "exit=$?"
```

## 6. Rent left above the minimum

```bash
npx epochnotes rent scan --program opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb
npx epochnotes rent close --account 12uqkw7gJ4JAMQqKHQxMiF187Xj1taEUBb6icoiacYgG
npx epochnotes rent template --account-type Position --authority-field owner
```

`rent scan` reads mainnet and reports, per account type, what is held above the minimum, who can close it,
and how reliable the figure is. `rent close` builds the unsigned transaction for the owner and asks the
cluster what it would do — it holds no key and sends nothing. `rent template` prints an Anchor instruction
for your own program.

## 7. The same registry, through an AI assistant

```bash
mkdir -p ~/.claude/skills && cp -R skills/epochnotes ~/.claude/skills/
```

Start a new Claude session in a project of yours, with `EPOCHNOTES_VERSIONS` and `EPOCHNOTES_PUBLISHERS`
exported, and ask something the assistant would otherwise answer from memory:

- "my getTransaction started failing with -32015 on mainnet, what happened?"
- "check this project against recent Solana network changes"

The skill holds no facts about any change: it runs the commands above, and its answer carries the version,
the publisher, the gate status with cluster and slot, and the sources. If verification fails, it refuses to
answer instead of falling back to memory — `corpus/skill-scenarios/` records what each case must look like.

## 8. The on-chain part (optional, needs Rust, Solana CLI 4.x and Anchor 0.32.1)

```bash
npm run build:program
anchor test
```

This runs the registry program against a local validator: admitting a publisher, anchoring versions,
revoking an entry, and the write gate that refuses any cluster but devnet and a local validator.

## What this demo does not show

- A published version of the real registry. It is signed after release; until then every reader here is
  trusting a key they generated themselves.
- `--onchain` against the demo log: the demo key is not an admitted publisher, so the comparison refuses.
  The on-chain path is covered by step 8 instead.
- Anything written to mainnet. Every mainnet command in this runbook only reads.
