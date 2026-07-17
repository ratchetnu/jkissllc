# 14 — Parallel-Session Branch & Worktree Rules

This repo is frequently worked by **several engineers/agents at once**, each in its own
git worktree. These rules keep those efforts from colliding.

## The model

- One feature = one **branch** = one **isolated worktree**.
- Worktrees are sibling directories: `/Users/<you>/jkissllc-<feature>` (see
  `git worktree list`). The primary checkout stays on `main`.
- Each session is scoped to owned areas and must **not** depend on another session's
  unmerged code.

## Hard rules

1. **Fetch `origin/main` first.** Create your branch + worktree off `origin/main`, not
   off whatever another session left in the primary checkout.
2. **Never work on `main`.** Feature work happens on the branch/worktree only.
3. **Don't depend on unmerged branches.** If you need something another session is
   building, either wait for merge or stub it behind a flag.
4. **Re-check before writing shared files.** Before editing a hot shared file
   (`nav-config.ts`, `OperationsShell.tsx`, `flags.ts`, `globals.css`, `package.json`),
   re-run `git status` and check mtimes — another session may be live in the same tree.
5. **Additive over destructive.** Prefer adding a file/route/flag over rewriting a
   shared one. New flags default **OFF**; new nav items go in a group, not the primary bar.
6. **Preview-only until reviewed.** Parallel branches are verified on Preview; none of
   them merge or deploy themselves.
7. **Don't merge or deploy from a sprint session** unless that is explicitly the task.

## Known hot files (coordinate before touching)

| File | Why it's hot |
|------|--------------|
| `app/admin/operations/nav-config.ts` | Every session that adds a surface wants a nav entry; `nav-config.test.ts` locks the primary bar. Add non-primary items only. |
| `app/admin/operations/OperationsShell.tsx` | Icon map + shell layout; multiple sessions add icons. |
| `app/lib/platform/flags.ts` | New subsystems add flags here. Append; keep defaults OFF. |
| `app/globals.css` / `ui.tsx` | Shared design tokens. |
| `package.json` / `vercel.json` | Scripts + cron; merge-conflict prone. |

## Naming

- Branch: `feat/<area>` (e.g. `feat/update-center-foundation`).
- Keep the branch focused on its owned area; note cross-cutting touches in the PR/report
  as "potential navigation conflicts" so the merge order can be planned.

## Merge order guidance

When several branches touch the same hot files, merge the **least entangled additive**
branches first (docs-only, then new-route additions), and rebase the rest. Sessions that
only *add* files and append one nav line are safe to merge early; sessions that
restructure shared shells go later and absorb the rebase.
