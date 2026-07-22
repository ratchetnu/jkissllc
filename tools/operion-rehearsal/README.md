# operion-rehearsal

Offline, **read-only** dry-run of an Operion Preview transfer. It drives the real
transfer runtime — `buildCommitTransferManifest` and `buildTransferEvidence` — against
two local git clones instead of the GitHub App, so the outcome of a transfer (gate
verdicts, the manifest, and the exact audit evidence PR #56 would persist) can be
confirmed **without enabling a flag, dispatching a workflow, opening a PR, merging, or
writing to any repository.**

It imports the transfer runtime; it does not modify it. No production gate, no runtime
path, and no PR #56 behaviour is touched.

## Why it exists

The rehearsal must be as trustworthy as the online path it imitates. An early
scratchpad harness was not: it decided target existence from the exit status of
`git show <rev>:<path>`, and

> `git show <rev>:<path>` treats a path containing `[brackets]` as a **pathspec glob**.
> For a path that does not exist it exits `0` with **empty output** instead of failing.

Next.js dynamic segments are exactly such paths (`app/api/portal/documents/[id]/route.ts`),
so a missing bracketed file read as "exists, empty" — which for an added file looks like
target drift. A false gate result, produced by the harness, not the gate. (A plain
missing path fails loudly, which is why it hid.)

`git-path-state.ts` fixes this: existence comes from the **tree listing**, which does no
globbing, and resolves three states a boolean check collapses — `missing`, `empty` (a
real zero-byte file), `present`. The production path was never affected; it uses
`provider.readTree` and discriminates `not_found` on `readFileContent`.

## Files

| File | |
|---|---|
| `git-path-state.ts` | tree-authoritative existence + three-state resolution |
| `local-git-provider.ts` | read-only `UpdateAutomationProvider` stand-in; every mutating method throws |
| `rehearse.ts` | `rehearseTransfer()` — builds the manifest + evidence, returns the provider call log |
| `cli.ts` | runnable dry-run |

Tests: `scripts/operion-rehearsal.test.ts` (run by `npm test`).

## Usage

```
npx tsx@4 tools/operion-rehearsal/cli.ts <sourceCommit> \
  [--source <path>] [--target <path>] [--ref origin/main] [--update UPD-A-PRIME]
```

Defaults target the two sibling clones (`~/jkissllc`, `~/supercharged`). The command
prints the gate outcome, the manifest summary, the evidence PR #56 would store, and a
provider call log confirming `mutating provider calls attempted: 0`.
