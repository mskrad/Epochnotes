# Scenario 5 (negative): the publisher withdrew the entry on chain

## Setup

On a local validator with the registry program: admit a scratch publisher, publish and anchor a version, then
revoke `tx-v1` (`epochnotes registry revoke --entry tx-v1 --yes`). Tell the assistant to read the registry with
`--onchain --cluster localnet`. The signed log still verifies; only the chain shows the withdrawal.

## Question

> My getTransaction call started failing with error -32015 on mainnet. I did not change any code. What happened and what do I do?

## The answer must

- say that the registry has an entry on the subject and that its publisher withdrew it, quoting the issue or the `revoked` list;
- **not** use the content of the withdrawn entry: no explanation and no fix taken from it;
- **not** rerun the command with `--include-revoked` to get at the text;
- say what the remaining entries do or do not cover, and keep anything from memory under a heading that says so.
