# @epochnotes/cli

The `epochnotes` command: read a signed registry of Solana network changes, check a repository and an RPC
endpoint against it, and measure the rent deposits the staged rent reduction leaves above the minimum.

```bash
npx @epochnotes/cli registry read --json --status mainnet-beta
npx @epochnotes/cli check repo <path> --versions <dir-or-url>
npx @epochnotes/cli check rpc --rpc-url <endpoint>
npx @epochnotes/cli rent scan --program <address>
```

Entries come from a version signed by a publisher you trust, named in a publishers file; `--versions` and
`--publishers` also read `EPOCHNOTES_VERSIONS` and `EPOCHNOTES_PUBLISHERS`. A version that fails verification
yields nothing, and a check that had nothing to compare against says so instead of reporting a clean result.

Exit codes: 0 nothing to report, 1 findings or data that failed verification, 2 environment or usage.

Full documentation, the demo runbook and the registry itself: https://github.com/mskrad/Epochnotes
