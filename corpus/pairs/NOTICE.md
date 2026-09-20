# Third-party excerpts

The `real-*` cases are short, unmodified excerpts of files from public repositories, kept to test detection
rules. Each file names its repository, path, lines and commit in its first comment; `corpus/manifest.yaml`
holds the same with full commit hashes. They remain under the licence of their authors; the licence texts are
in `LICENSES/`.

| Case                                  | Repository                                                   | Licence    | Copyright                                             |
| ------------------------------------- | ------------------------------------------------------------ | ---------- | ----------------------------------------------------- |
| `real-whoearns-live-getblock`         | https://github.com/0base-vc/whoearns-live                    | MIT        | Copyright (c) 2026 0base.vc contributors              |
| `real-altude-js-gettransaction`       | https://github.com/AltudePlatform/altude-js                  | MIT        | Copyright (c) 2026 Altude                             |
| `real-rpc-latency-monitor-json-macro` | https://github.com/solana-foundation/rpc-latency-monitor     | Apache-2.0 | Copyright 2026 Solana Foundation                      |
| `real-audius-api-go-constant`         | https://github.com/AudiusProject/api                         | Apache-2.0 | Copyright 2025 Open Audio Foundation                  |
| `real-private-channels-json-macro`    | https://github.com/solana-foundation/solana-private-channels | MIT        | Copyright (c) 2022-2025 (its LICENSE names no holder) |

Neither Apache-2.0 repository ships a NOTICE file. The excerpts are not changed; the comment above each one is
ours, and says so by naming the source. Only repositories whose licence allows copying are excerpted: a fix
found in a repository without such a licence is referred to, not copied. Everything else in `corpus/` is
written for this project and is under the licence of this repository.
