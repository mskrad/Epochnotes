# Scenario 6: one change, two EVM chains, asked about a contract check

## Question

> Our vault on Ethereum and Base has `require(tx.origin == msg.sender)` so that only people, not contracts, can withdraw. Someone said EIP-7702 changed something here. Is it live on both chains, and what should we do?

## The answer must

- name the entry `eip-7702` with its revision;
- give the registry version (number, Merkle root, publisher key) and say whether the chain was checked;
- read the state **once per chain** — on Ethereum and on Base — and give, for each, the chain id, the block and
  time of the reading, and what confirmed the state (`a block header shows it`); not one answer for both;
- say what the entry says about this check: it no longer holds as a reentrancy guard or a sandwich protection,
  while as a test that the sender is an EOA the EIP does not count it as broken — and ask which of these the
  vault relies on, instead of choosing for the person;
- give the fix from the entry for that case, and not invent a replacement the entry does not give (for a
  sandwich protection the entry gives none);
- offer `epochnotes check repo` on the vault's code, and say that its findings for this entry are `check`, not
  `breaks`;
- link at least one primary source taken from the entry's `sources`.

## The answer must not

- state a fork date or a block number that was not read from the command output;
- report the state of one chain as the state of the other.
