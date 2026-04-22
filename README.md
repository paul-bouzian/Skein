# Skein

[<img src="branding/skein-logo.png" alt="Skein logo" width="160" />](branding/skein-logo.png)

[![CI](https://github.com/paul-bouzian/Skein/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/paul-bouzian/Skein/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/paul-bouzian/Skein?display_name=tag)](https://github.com/paul-bouzian/Skein/releases)
[![macOS](https://img.shields.io/badge/platform-macOS-black)](https://github.com/paul-bouzian/Skein/releases)
[![Apple Silicon](https://img.shields.io/badge/chip-Apple%20Silicon-111111)](https://github.com/paul-bouzian/Skein/releases)

Skein is a local-first macOS desktop app for working with Codex through a native, review-first interface.

It talks directly to `codex app-server`, keeps Git and runtime state environment-scoped, and is designed around the workflow most coding agents actually need: prompt, inspect, iterate, review, commit.

## What Skein already does

- Real Codex conversations backed by `codex app-server`
- Project, environment, and thread management with the canonical model `Project -> Environment -> Thread`
- Plan mode with approve / refine flows
- Native `requestUserInput` questions and approval prompts
- Subagent visibility and context window tracking
- Git review pane with staged / unstaged / untracked changes, diffs, commit generation, fetch / pull / push
- Release-based desktop updates through Electron + `electron-updater`

## Product shape

Skein is intentionally:

- Codex-only, not a multi-provider shell
- Local-first, not a hosted runtime product
- macOS-first for V1
- Review-first rather than terminal-first

The local repository itself is the default environment for a project. Worktrees become additional environments under that project, while multiple threads can coexist inside the same environment.

## Current status

Skein is already usable as a serious local Codex desktop workflow, but it is still an early public build.

Current public focus:

- polish the Codex conversation loop
- improve review and Git ergonomics
- harden release and update flows
- keep the architecture stable while expanding desktop-native UX

## Stack

- Electron 41
- React 19
- TypeScript
- Rust
- Bun

The Electron main/preload layer owns shell concerns. The Rust backend remains the authority for Codex runtime, Git/worktrees, terminals, persistence, and validation.

## Requirements

- macOS
- Apple Silicon for the current release builds
- Bun
- Rust toolchain
- Xcode Command Line Tools
- `codex` installed locally and available on `PATH`

## Local development

```bash
bun install
bun run electron:dev
```

Useful commands:

- `bun run dev` starts the Vite frontend only
- `bun run electron:dev` starts the Electron desktop app in development
- `bun run build` builds the frontend bundle
- `bun run electron:build` builds the packaged Electron release artifacts
- `bun run electron:build:debug` builds the unpacked Electron debug app
- `bun run verify` runs the full local validation suite
- `bun run verify:electron` runs the Electron shell validation suite
- `cargo test --manifest-path desktop-backend/Cargo.toml` runs Rust tests

## Architecture

Skein keeps a strict desktop boundary:

- Rust owns privileged logic, runtime supervision, persistence, Git, worktrees, and release/update plumbing
- React owns rendering, local UI state, and typed interaction with the backend
- Electron main/preload stay narrow and typed over the Rust sidecar JSONL RPC

Implementation note:

- `desktop-backend` hosts the Rust library and the packaged `skein-backend` sidecar
- the canonical desktop shell is Electron under `electron/*`

Key product surfaces already implemented:

- three-pane shell
- thread tabs
- conversation timeline
- interactive plan / approval / user-input flows
- subagent strip
- review pane + diff column
- update notice UI

## Releases and updates

Skein is distributed through GitHub Releases and uses Electron release metadata (`latest-mac.yml`) for in-app updates.

Existing installs migrate forward during startup, and the first Electron cut publishes transition updater assets for pre-Electron installs.

The current release target is:

- macOS
- Apple Silicon

## Why this exists

Most Codex workflows are still either terminal-first or web-shell-first. Skein aims at a more native desktop loop:

1. pick a repo or worktree
2. talk to Codex in a real thread
3. inspect plans, approvals, tool calls, and diffs without leaving the app
4. stage, commit, and sync the repo directly from the review pane

## Contributing

Issues and pull requests are welcome. Before opening a PR, run:

```bash
bun run verify
cargo test --manifest-path desktop-backend/Cargo.toml
```

If you changed desktop shell, runtime, release, preload, updater, or packaging behavior, also run:

```bash
bun run verify:electron
```
