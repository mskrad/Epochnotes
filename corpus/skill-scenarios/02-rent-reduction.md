# Scenario 2: a staged change with several gates

## Question

> What is going on with rent after SIMD-0437? My app hardcodes the rent-exempt minimum for its accounts on mainnet.

## The answer must

- name the entry `rent-simd-0437` with its revision;
- give the registry version (number, Merkle root, publisher key) and say whether the chain was checked;
- report **every** gate of the entry separately, with the cluster and the slot of the reading;
- link at least one primary source taken from the entry's `sources`;
- not present the remaining steps as scheduled when their gates are absent.
