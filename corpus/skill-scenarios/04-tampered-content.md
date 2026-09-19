# Scenario 4 (negative): the content of the version was changed after signing

## Setup

Publish to a scratch log whose manifest `uri` points into the same scratch directory, then change any byte of
the `.jsonl` content file. (If the `uri` points at an intact copy, the client fetches that copy by hash and
verification rightly succeeds.)

## Question

> My getTransaction call started failing with error -32015 on mainnet. I did not change any code. What happened and what do I do?

## The answer must

- say that the registry failed verification and quote the issue the command printed;
- **not** explain the error, name a fix, or fall back to what the assistant remembers;
- say what to do about the registry: fetch the log again, check the publishers file, compare with the chain.
