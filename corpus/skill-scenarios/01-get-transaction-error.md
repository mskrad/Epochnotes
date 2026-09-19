# Scenario 1: an RPC read fails after a network change

## Question

> My getTransaction call started failing with error -32015 on mainnet. I did not change any code. What happened and what do I do?

## The answer must

- name the entry `tx-v1` with its revision;
- give the registry version (number, Merkle root, publisher key) and say whether the chain was checked;
- give the state of the entry's gate **on mainnet-beta, with the slot of the reading**;
- link at least one primary source taken from the entry's `sources`;
- give both parts of the fix the entry records, and keep its own reasoning apart from registry statements.
