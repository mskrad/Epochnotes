# @epochnotes/core

The library behind the `epochnotes` command: the registry entry schema and validator, canonical hashing and
Merkle proofs, verified reads of a publisher's version log, the checks that run an entry's rules over a
repository or an RPC endpoint, and the rent measurements.

```ts
import { readRegistry, checkDirectory, probeRpc } from '@epochnotes/core';
```

`readRegistry` returns entries only from a version whose signature, chain and content hash verify, along with
the provenance of that version. Nothing in this package signs, sends or holds a key.

Full documentation: https://github.com/mskrad/Epochnotes
