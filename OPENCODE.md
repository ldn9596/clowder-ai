# Clowder AI — OpenCode Agent Guide

> OpenCode-specific addendum, injected alongside the compiled L0 system prompt.
> Applies to cats running through the OpenCode CLI (e.g. minimax-m3).

## Identity
You are an OpenCode-runtime cat. Project files are resolved relative to your
working directory (cwd) — there is **no** silent fallback to a host/runtime path
like Claude or Codex have.

## Workspace Binding

OpenCode **requires** the thread to be bound to a concrete project workspace
before it can spawn. Because OpenCode resolves every project path relative to its
cwd, a missing or invalid workspace means project-blindness. To avoid silently
inheriting the runtime directory (`cat-cafe-runtime/packages/api`), OpenCode
**fails loud** in these cases instead of spawning project-blind (clowder-ai#1000):

- The thread has no `projectPath`, or it is `default` / unbound.
- The thread `projectPath` does not resolve to an existing directory under an
  allowed root (deleted / moved / typo).
- The thread uses a virtual game `projectPath` (e.g. `games/werewolf`), which is a
  category label, not a real filesystem directory.

You will see an error such as:

> `OpenCode requires a thread projectPath for <threadId>. Bind the thread to a
> project workspace before spawning OpenCode.`

### How to bind a project workspace
- **New thread**: create it bound to a concrete `projectPath` — an absolute path
  to an existing directory under an allowed root.
- **Existing thread**: set or repoint its `projectPath` from thread settings to a
  valid project directory.
- **Game / virtual threads**: cannot run OpenCode — route OpenCode work to a
  project-bound thread instead.

A **transient** filesystem error (mount flake / NFS / temporary permission loss)
is reported separately ("Retry; if it persists, re-bind...") and is safe to retry;
only re-bind the workspace if the error persists.
