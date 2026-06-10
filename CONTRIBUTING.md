# Contributing to gmux

## Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| **Node.js** ≥ 20 | JS/TS tooling | [nodejs.org](https://nodejs.org) |
| **pnpm** ≥ 9 | Package manager | `npm i -g pnpm` |
| **Go** ≥ 1.22 | Native services (gmuxd, gmux) | [go.dev](https://go.dev/dl/) |
| **watchexec** | Auto-rebuild Go on file change (dev mode) | `pacman -S watchexec` / `cargo install watchexec-cli` / [github.com/watchexec/watchexec](https://github.com/watchexec/watchexec/releases) |
| **jj** | Version control | [martinvonz.github.io/jj](https://martinvonz.github.io/jj/) |

**moon** is the build system, installed locally via pnpm (`@moonrepo/cli`). No global install needed.

## Getting started

```bash
pnpm install          # JS dependencies + moon
```

## Development

Run the full dev stack (vite + gmuxd + watchexec, with HMR):

```bash
moon run :dev
```

This starts:
- **gmuxd** (`:22226`) — Go, auto-restarts on `.go` changes via watchexec
- **gmux-web** (`:5173`) — Vite HMR, proxies `/v1/*` and `/ws/*` to gmuxd
- Open **http://localhost:22226** (gmuxd proxies vite on the same port)

**No manual kill needed.** When gmuxd starts, it asks any existing instance to shut down gracefully via the Unix socket before binding.

To run services individually:

```bash
moon run gmuxd:dev        # gmuxd with watchexec only
moon run gmux-web:serve   # vite only
```

For manual verification (bug reproduction, fix confirmation, screenshots), see **[docs/agent-verification.md](docs/agent-verification.md)**. For automated E2E tests, see **[docs/e2e.md](docs/e2e.md)**.

## Tests & linting

```bash
moon run :test    # all tests (Go + JS)
moon run :lint    # all lint/typecheck
```

## Project structure

See [README.md](README.md) for workspace layout and the [website docs](apps/website/src/content/docs/) for architecture, protocol specs, and guides.
