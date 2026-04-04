# ThreadEx

[![CI](https://github.com/paul-bouzian/ThreadEx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/paul-bouzian/ThreadEx/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/paul-bouzian/ThreadEx?display_name=tag)](https://github.com/paul-bouzian/ThreadEx/releases)
[![macOS](https://img.shields.io/badge/platform-macOS-black)](https://github.com/paul-bouzian/ThreadEx/releases)
[![Apple Silicon](https://img.shields.io/badge/chip-Apple%20Silicon-111111)](https://github.com/paul-bouzian/ThreadEx/releases)

ThreadEx is a local-first macOS desktop app for working with Codex through a native, review-first interface.

It talks directly to `codex app-server`, keeps Git and runtime state environment-scoped, and is designed around the workflow most coding agents actually need: prompt, inspect, iterate, review, commit.

## What ThreadEx already does

- Real Codex conversations backed by `codex app-server`
- Project, environment, and thread management with the canonical model `Project -> Environment -> Thread`
- Plan mode with approve / refine flows
- Native `requestUserInput` questions and approval prompts
- Subagent visibility and context window tracking
- Git review pane with staged / unstaged / untracked changes, diffs, commit generation, fetch / pull / push
- Release-based desktop updates through Tauri's updater flow

## Product shape

ThreadEx is intentionally:

- Codex-only, not a multi-provider shell
- Local-first, not a hosted runtime product
- macOS-first for V1
- Review-first rather than terminal-first

The local repository itself is the default environment for a project. Worktrees become additional environments under that project, while multiple threads can coexist inside the same environment.

## Current status

ThreadEx is already usable as a serious local Codex desktop workflow, but it is still an early public build.

Current public focus:

- polish the Codex conversation loop
- improve review and Git ergonomics
- harden release and update flows
- keep the architecture stable while expanding desktop-native UX

## Stack

- Tauri v2
- React 19
- TypeScript
- Rust
- Bun

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
bun run tauri:dev
```

Useful commands:

- `bun run dev` starts the Vite frontend only
- `bun run tauri:dev` starts the desktop app in development
- `bun run build` builds the frontend bundle
- `bun run tauri:build` builds the desktop app bundle
- `bun run tauri:build:debug` builds the debug desktop app bundle
- `bun run verify` runs the full local validation suite
- `cargo test --manifest-path src-tauri/Cargo.toml` runs Rust tests

## Architecture

ThreadEx keeps a strict desktop boundary:

- Rust owns privileged logic, runtime supervision, persistence, Git, worktrees, and release/update plumbing
- React owns rendering, local UI state, and typed interaction with the backend
- Tauri commands stay narrow and typed

Key product surfaces already implemented:

- three-pane shell
- thread tabs
- conversation timeline
- interactive plan / approval / user-input flows
- subagent strip
- review pane + diff column
- update notice UI

## Releases and updates

ThreadEx is distributed through GitHub Releases and uses Tauri updater artifacts for in-app updates.

The current release target is:

- macOS
- Apple Silicon

## Why this exists

Most Codex workflows are still either terminal-first or web-shell-first. ThreadEx aims at a more native desktop loop:

1. pick a repo or worktree
2. talk to Codex in a real thread
3. inspect plans, approvals, tool calls, and diffs without leaving the app
4. stage, commit, and sync the repo directly from the review pane

## Contributing

Issues and pull requests are welcome. Before opening a PR, run:

```bash
bun run verify
cargo test --manifest-path src-tauri/Cargo.toml
```

If you changed Tauri, runtime, release, or desktop behavior, also run:

```bash
bun run tauri:build:debug
```
