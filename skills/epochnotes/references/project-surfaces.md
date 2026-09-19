# Checking a whole project

A network change rarely breaks the file the developer is looking at. It breaks the hosted RPC that answers
differently, the indexer that feeds the dashboard, the program deployed a year ago, the snippet in the docs
that users copy. Inventory first, then check.

## 1. Inventory the surfaces

Read the repository to find what the project depends on at runtime. Write the list down before checking
anything, and show it to the person: they will know what you missed.

| Surface                               | Where to look                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Source code that talks to the network | RPC calls, transaction building and decoding, account size and cost estimates, timing assumptions    |
| Dependencies                          | lockfiles of every ecosystem in the repository                                                       |
| RPC providers                         | names of environment variables, config files, deployment manifests; note the provider, never the key |
| Streams and indexers                  | websocket subscriptions, gRPC streams, webhooks, third-party indexing APIs                           |
| Deployed programs                     | program ids in config, IDLs, deploy scripts; which cluster each lives on                             |
| Services the project exposes          | its own HTTP API, bots, cron jobs that read chain data                                               |
| Documentation and examples            | READMEs, docs sites, templates: users copy them, so a stale snippet is a breakage shipped to others  |

## 2. Check each surface with the strongest method you have

| Method                                                              | Label in the report         | When                                                                                |
| ------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| `epochnotes check rpc --rpc-url <endpoint>`                         | **verified live**           | an RPC endpoint the project uses; the command only reads a known public transaction |
| A read-only request to the project's own public endpoint            | **verified live**           | the endpoint is public, the request is a plain read, and the person agreed          |
| `epochnotes check repo <path> --versions ...`                       | **found in code**           | always; `breaks` findings are certain, `check` findings need a human look           |
| Reading code the rules do not cover, guided by the entry's `breaks` | **by reading, not by rule** | the entry names a surface and no `detect` rule covers it                            |
| Nothing available                                                   | **cannot verify** and why   | closed third-party service, no credentials, no fixture on that cluster              |

The probe reports observations (`calls`) and quotes what the entry expects (`expect`). Compare them yourself
and say what you concluded. A `fixture-missing` or `not-applicable` verdict means the behaviour was **not**
observed; it is not a pass.

For a third-party API that only the provider can fix, the useful output is the question to send them. Draft
it from the entry: the change, the symptom, the primary source.

## 3. Report

One table, one row per surface: surface, what was checked, label from the table above, entry `id@rev`,
finding, fix. Then the registry version and the status reading (cluster, slot) once for the whole report.
List the surfaces you could not check as plainly as the ones you could. A report that hides its blind spots
reads as "everything is fine", and that is the one thing it must never claim.
