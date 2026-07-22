# Completion Photo Lifecycle Hardening — follow-up plan

**Status:** PLAN ONLY — awaiting owner approval. **No code written. No data mutated.**
**Opened:** 2026-07-22 · **Author:** coordinator session · **Depends on:** PR #54 (merged or not — this is independent)
**Scope discipline:** this plan is **out of scope for PR #54**. PR #54's contents are frozen: safe-error shaping + Blob upload readiness only.

---

## ⚠️ Evidence status — read this before citing the plan

**This session did not observe any dead photo references in live data.** Preview validation never authenticated (the Crew Portal requires a password, which I will not enter), so no booking record and no photo list was ever read, in any environment.

What follows is a **structural finding proven from source**, not an observed data incident:

| Claim | Basis | Confidence |
|---|---|---|
| Completion photos are append-only, with no removal path | source-verified | **Certain** |
| Nothing ever deletes a completion-photo blob | source-verified | **Certain** |
| No reconciliation exists between the Blob store and booking records | source-verified | **Certain** |
| Dead references and orphaned bytes *can* accumulate | follows deductively from the three above | **Certain (mechanism)** |
| Dead references / orphaned bytes *do* exist right now, and how many | ❓ **NOT ESTABLISHED** | **Unknown** |

> If specific dead references were observed, they were found by another session. **Do not attribute them to this plan without a source.** The counting task is step 1 below precisely because the number is currently unknown.

---

## 1. The structural gap

### 1.1 Append-only by construction

`mergeCompletionPhotos` (`app/lib/job-assignment.ts:375`) is the sole write path, via `booking-assignment.ts:250`:

```ts
const push = (url: string) => {
  if (seen.has(url) || out.length >= max) return
  seen.add(url); out.push(url)
}
for (const url of existing ?? []) { if (typeof url === 'string' && url.trim()) push(url.trim()) }
for (const url of sanitizeCompletionPhotos(incoming, policy)) push(url)
return out
```

Every pre-existing URL is re-pushed verbatim; only additions are gated. There is **no** `filter`, `splice`, `remove`, or `delete` for completion photos anywhere in the codebase.

**This is deliberate and correct.** It is the "never retroactively delete proof of work" invariant, stated in S2's readiness doc (§P1-B, "Critical invariant preserved") and load-bearing for payroll and claims: a completion photo is evidence a crew member did the work they were paid for. An append-only ledger is the right default. **The gap is not that deletion is missing — it is that no *supported, audited* removal path exists for the cases that legitimately need one.**

### 1.2 Two distinct failure classes

**Class A — dead references** (record points at bytes that are gone or unreachable)
A record retains a URL that the *current* policy would refuse. PR #54 makes this reachable in a new way: once `requireStore` is on, a previously-persisted URL from a different store stays in the record forever while every new one like it is refused. The record becomes internally inconsistent — a URL that the system itself would no longer accept. Also arises from any blob deleted out-of-band (store rotation, retention policy, manual console deletion).

**Class B — orphaned bytes** (bytes exist with nothing pointing at them)
Upload and attachment are **two separate requests**. The presigned client upload writes bytes directly to Blob; `onUploadCompleted` is an explicit no-op (`route.ts:89` — *"the URL is persisted with the job, not here"*); the URL is attached later via `/api/portal/jobs/[id]`. If the crew member loses signal between those two steps — the exact scenario PR #54's error copy is written for — **the bytes are stored and nothing ever references them.** No retry, no cleanup, no record.

Class B is the more likely of the two to already exist in Production today, because it needs only a dropped connection mid-flow.

### 1.3 Nothing reconciles the two sides

- No `del()` for completion photos. The **only** `del()` in the app is `app/api/admin/crew-documents/route.ts:107` — a different subsystem, best-effort.
- No blob↔record reconciliation. The 7 crons in `vercel.json` (`daily`, `reminders`, `ai-jobs`, `vision-shadow`, `shadow-alerts`, `operion-reconcile`, `operion-sync`) include no blob sweep. `operion-reconcile` is the Operion control plane, unrelated.
- No admin UI surfaces a photo for removal.

**Net:** both classes accumulate silently and permanently, and today **no one can count them, see them, or safely act on them.**

---

## 2. Why cleanup cannot be completed safely right now

Five independent blockers. Any one is sufficient.

| # | Blocker | Why it stops us |
|---|---|---|
| **1** | **The population is unmeasured.** Nothing has enumerated the Blob store against booking records in any environment. | You cannot safely delete from a set you have not counted. Scope, blast radius, and whether the problem is even material are all unknown. |
| **2** | **No authenticated session in any environment.** The Crew Portal needs a password; the admin surface needs an owner session. | Neither reading the data nor exercising a removal path is possible. This blocked the PR #54 Preview validation for the same reason. |
| **3** | **"Do not mutate existing Preview data"** — standing instruction. | Even the safe rehearsal environment is off-limits for writes, so a removal path cannot be exercised anywhere. |
| **4** | **Deletion is irreversible and lands on an evidence path.** Completion photos feed payroll and claims. | A wrong delete destroys proof a crew member was paid correctly, or proof in a damage dispute. There is no undo and no soft-delete tier. This alone justifies refusing to improvise. |
| **5** | **`BLOB_STORE_ID` is absent in Production, so store identity is ambiguous there.** | Classifying a URL as "dead" requires knowing which store is authoritative. In Production the code currently falls back to a host-suffix floor (P1-B) — it cannot even distinguish its own store from Preview's. **Any classification run in Production today would be unreliable, and could mark live photos dead.** |

Blocker 5 is the sharpest: **attempting cleanup before `BLOB_STORE_ID` is set would risk deleting valid Production photos.** The correct order is env → measure → design → act.

---

## 3. Why this is separate from PR #54 (Blob upload readiness)

They sit on opposite sides of the write.

| | **PR #54 — upload readiness** | **This plan — lifecycle** |
|---|---|---|
| Question | *May these bytes be accepted?* | *What happens to bytes already accepted?* |
| Moment | before/at write | after write, indefinitely |
| Direction | **preventive** — gates what enters | **remedial** — reconciles what exists |
| Data effect | **none.** Refuses new bad input; changes no stored record | **mutates or deletes existing records/bytes** |
| Reversibility | fully reversible (revert the PR) | **irreversible** once bytes are deleted |
| Risk if wrong | an upload is refused; crew retries | evidence destroyed; payroll/claims impaired |
| Blocked by | nothing — merged/validated on its own terms | 5 blockers in §2 |
| Approval | already granted, scope frozen | **not requested yet** |

Merging them would be a category error with a concrete cost: it would take a **reversible, preventive, zero-data-effect** change and bind it to an **irreversible, remedial, data-destructive** one — so PR #54 could no longer be reverted without reasoning about deleted bytes. It would also expand a reviewed diff (6 files, +291/−16) past what was approved, and stall a ready fix behind five unresolved blockers.

PR #54 is *upstream* of this problem: by pinning new writes to one store, it stops Class A from growing. **It does not, and should not, clean up what already exists.** That separation is the design, not an oversight.

---

## 4. Proposed sequence — approval gated, staged, no deletion for three phases

**Nothing here is authorized yet. Phases 1–3 write no data at all.**

### Phase 0 — prerequisite (owner decision, already pending as B-2)
Set `BLOB_STORE_ID = store_WK8DoJzb2Q1lu5sv` in **Production**. Until this lands, no classification in Production is trustworthy (blocker 5). This is already an open owner decision; this plan does not re-request it.

### Phase 1 — **measure, read-only** ← the only sane first step
An offline script, run by the owner, that enumerates each Blob store and each booking's `completionPhotos`, then reports:
- referenced-and-present (healthy) · referenced-but-missing (**Class A**) · present-but-unreferenced (**Class B**) · referenced-but-wrong-store
Output is counts plus bounded samples. **Reads only. Writes nothing, deletes nothing.** Run Preview first, then Production.
**This phase answers the question §"Evidence status" says is currently unknown.** Everything after it is contingent on what it finds — including the possibility that the answer is "zero, no further work needed."

### Phase 2 — **make it visible, read-only**
A read-only admin health panel reporting the Phase 1 counts. Flag-gated, off by default. Turns an invisible condition into an observable one — the same "report, never auto-fill" principle the transfer gates follow.

### Phase 3 — **design the supported removal path** (design only, no execution)
Specify, for owner review before any code runs:
- **who** may remove (owner-only? never crew?)
- **soft-delete first** — a tombstone (`removedAt`, `removedBy`, `reason`) that retains the URL for audit rather than erasing it. Given the payroll/claims stakes, hard deletion may never be appropriate.
- **audit event** for every removal, matching the nine existing assignment actions
- explicit rule for whether bytes are ever `del()`d or only dereferenced
- **retention policy** — the actual upstream question nobody has answered

### Phase 4 — **execute**, only with explicit per-run approval
Preview rehearsal → owner review of the exact target list → Production, bounded, reversible where possible, fully audited.

---

## 5. Guardrails

1. **No deletion in any environment without explicit per-run owner approval**, including Preview.
2. **Soft-delete before hard-delete**, always. Prefer dereferencing over destroying bytes.
3. **Never mutate a record to satisfy a policy change.** PR #54's invariant stands: tightening what may be added must not rewrite history.
4. **Production last**, and only after Phase 0.
5. **Count before acting** — Phase 1 gates everything.
6. Flags stay **OFF**; this plan requires no flag change.

---

## 6. Open questions for the owner

1. **Were specific dead photo references actually observed?** If so, by which session, in which environment, and with what evidence? This session did not observe any (§Evidence status). The answer changes the urgency materially.
2. **Is hard deletion ever acceptable** for a completion photo, given payroll and claims use it as evidence — or is soft-delete/tombstone the permanent answer?
3. **What is the intended retention period**, if any? No policy exists today.
4. Does the same lifecycle gap apply to the other Blob writers (`careers/upload`, `portal/uniform`, `payment-proof`, `image-convert`)? They use `put` with no `del` either — likely the same structural class, **unverified**, and out of scope until asked.

---

## 7. Status

**STOPPED, awaiting approval.** No lifecycle code will be written, no data read or mutated, and no removal path built until the owner approves a phase. PR #54 is unaffected: its validation results, safe-error fixes, and Blob readiness changes stand exactly as reviewed.
