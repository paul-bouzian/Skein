---
name: skein-standards
description: Production engineering standards for the Skein desktop app. Use when working in this repository on Electron, React, TypeScript, Rust, Codex runtime integration, Git/worktree services, desktop command boundaries, permissions, persistence, release/update plumbing, or any architectural change that should stay aligned with the project's professional desktop standards.
---

# Skein Standards

## Overview

Apply the repository's desktop engineering standards before changing Skein. Keep the implementation aligned with the app's Electron, React, TypeScript, and Rust architecture instead of making local optimizations that weaken long-term maintainability.

## Workflow

1. Read [docs/engineering-standards.md](../../../docs/engineering-standards.md) when the task affects architecture, command boundaries, runtime services, capabilities, persistence, updater/release flow, or cross-layer behavior.
   If the local engineering standards document is not present, use the rules in this skill as the source of truth.
2. Classify the change:
   - frontend-only UI work
   - Rust/backend/runtime work
   - cross-boundary desktop work
3. Keep the responsibility boundary intact:
   - React owns presentation and local UI state
   - Rust owns privileged logic, process supervision, Git/worktree orchestration, persistence coordination, and Codex runtime integration
4. Prefer the canonical project model:
   - `Project -> Environment -> Thread`
   - worktrees are environments, not threads
   - shared runtime/Git/terminal state is environment-scoped
5. When changing desktop privileges, review least-privilege requirements first:
   - prefer explicit capabilities
   - avoid broad shell/process exposure
   - keep privileged APIs narrow and typed
6. When changing React code:
   - keep renders pure
   - avoid effects for derivation
   - prefer explicit state structure over store sprawl
7. When changing Rust code:
   - keep command handlers thin
   - move logic into domain or service modules
   - use `Result`, add context, and avoid `unwrap`/`expect` on runtime paths
8. Run the standard validation suite before finishing:
   - `bun run verify`
   - `bun run verify:electron` when Electron shell, preload, updater, packaging, or desktop behavior changed

## Task-Specific Checks

### Electron and permissions

- Add desktop capabilities only when the capability is first-class and necessary.
- Do not expose unrestricted shell execution to the frontend.
- Keep permissions granular and auditable.
- Treat preload exposure and window boundaries as security boundaries, not UI details.

### React and TypeScript

- Keep component responsibilities narrow.
- Prefer derived data during render over mirrored state.
- Keep transport details out of presentational components.
- Use typed desktop bridge helpers rather than scattering raw `invoke()` calls.
- Reach for `startTransition` or `useDeferredValue` when interaction latency matters, not as decoration.

### Rust and runtime services

- Commands are boundary adapters, not business-logic containers.
- Long-running work belongs in dedicated services or background tasks.
- Logs should use structured `tracing` context rather than ad hoc prints.
- Shared state should be synchronized deliberately and kept lock-light.

### Codex integration

- Do not reconstruct app-server behavior from terminal scraping if structured events already exist.
- Keep Codex integration app-server first.
- Favor environment-scoped supervisors over thread-scoped runtime duplication.
- Keep settings precedence explicit: global defaults, then project overrides, then thread overrides only where justified.

### Distribution and updates

- The intended path is GitHub Releases plus `electron-updater`, with a temporary transition bridge for pre-Electron installs.
- Preserve a stable bundle identifier and semantic versioning discipline.
- When implementing updates, use signed updater artifacts and a user-controlled restart flow.
- For updater work, consult the Electron updater and GitHub release pipeline docs before changing code.

## References

- A local-only engineering standards document may exist at `docs/engineering-standards.md`.
- Product shape: [README.md](../../../README.md)
- Local-only product brief may exist beside the repo, but do not assume it is tracked or available to other contributors.
