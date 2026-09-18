# Epochnotes

A signed registry of Solana network changes — and the checks built on it: what breaks in your code, where, and how to fix it.

Status: early development. Nothing here is ready for use yet.

## Layout

| Path                | Purpose                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `packages/core`     | Library: entry schema, canonical hashing, validation, on-chain status reads |
| `packages/cli`      | `epochnotes` command — a thin shell over `core`                             |
| `programs/registry` | Anchor program: publishers and the version log                              |
| `registry/`         | Entry schema, registry entries (YAML) and published versions                |
| `corpus/`           | Before/after code pairs used to evaluate detection rules                    |

## Develop

Requires Node.js 22.12+, and for the program: Rust, Solana CLI 4.x, Anchor 0.32.1.

```bash
npm ci
npm run verify        # build + tests + lint
npm run build:program # anchor build
```

## License

MIT
