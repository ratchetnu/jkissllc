# Multi-photo dataset acquisition

## Why this cannot come from the existing manifest

The 210-entry manifest is stock-sourced: unrelated photographs, each of a different
place, acquired one at a time. Duplicate reconciliation is the code that decides
*"these two frames show the same couch, count it once."* Grouping unrelated stock
images to test that would fabricate the exact truth being measured — the answer key
would say "same object" about two objects that were never in the same room.

So this is an acquisition task, not a labelling task. Nothing in the current dataset
can be promoted into it.

## What is currently untested because of this

The 2026-08-05 Preview pilot ran **12 jobs, all single-image**. That means the
following have never executed against real data:

- `sourcePhotoIds` population and stability
- duplicate-view detection (`possibleDuplicateViewOfOtherPhoto`, `duplicateGroupId`)
- the quantity/volume inflation guard when one object appears in several frames
- per-photo `visibleItems` reconciliation against the master `normalizedItems` list

`multiPhotoReady()` in `readiness.ts` is a **separate gate** from the label-count
gate and stays failing until real groups exist. A lane can hit 25/5 verified labels
and still be multi-photo-unready; that is the expected state and is not a defect.

## Target

| Lane | Groups | Photos per group |
|---|---|---|
| Junk removal | 5 | 3–6 |
| Moving | 5 | 3–6 |

30–60 images total. Suggested scene mix — junk: curbside pile, garage cleanout,
apartment cleanout, mixed full load, appliance set. Moving: studio, one-bed, two-bed,
boxes-plus-furniture, stairs/access.

## Permitted sources, in order of preference

1. **Real J KISS completed jobs**, with the customer's recorded permission. Only
   these carry the outcome fields below, which is what makes them worth more than
   any number of staged scenes.
2. **Internally staged jobs** — a crew arranges a representative load. No customer
   permission needed; outcome fields are estimates and must be marked as such.
3. **Business-owned photos** already held by J KISS with rights to use.
4. **Photos captured specifically for evaluation.**

Never: stock libraries, customer photos without recorded permission, or any image
containing an identifiable person, a readable document, a visible address, or a
licence plate.

## Capture protocol

Per job, 3–6 photos that a real customer would plausibly send:

- one wide establishing frame of the whole load
- one or two frames from a different angle **that deliberately re-show items already
  visible** — this is the duplicate signal being measured
- one close frame of the largest or most awkward item
- optionally one access frame (stairs, doorway, driveway, lift)
- optionally one genuine near-duplicate (same angle, seconds apart) to exercise
  near-duplicate handling separately from exact duplication

Shoot at the resolution a phone produces. Downscaling to stock-image dimensions
would remove the thing that makes these representative.

## Record per group

Identity and structure:

- `jobId`
- service lane (`junk_removal` | `moving`)
- `photoIds` in capture order
- room/scene id per photo
- **same-object-across-views truth** — for each object appearing in more than one
  frame, the set of (photo, object) pairs that are one physical item
- **exact-duplicate truth** — photo pairs that are the same shot
- **near-duplicate truth** — photo pairs that overlap heavily without being identical

Outcome (sources 1 and 2 only; mark estimates as estimates):

- actual truck space used
- actual crew size
- actual labor hours
- final price
- disposal cost where applicable
- any corrections the crew made to the original estimate

Provenance:

- permission/consent status and where it is recorded
- capture date, capturing person, source category (1–4 above)

## Rules

- **Do not group unrelated images.** If a group cannot be captured, it does not exist.
- **Do not let a model produce any of the truth fields**, including the
  same-object-across-views mapping. That mapping is the answer key for the code
  under test.
- Outcome fields from staged jobs are estimates and must be labelled as such; they
  cannot be used to claim pricing accuracy.
- Groups enter the manifest through `job-groups.json`, and every constituent image
  still passes the normal licence/content/label review individually.
- Holdout assignment for a group is all-or-nothing: a job's photos never straddle
  the development/holdout boundary.

## Readiness

`multiPhotoReady(groupCount, lane)` requires **5 real groups per lane**. Until both
lanes pass, no claim may be made about duplicate reconciliation, per-photo
aggregation, or multi-photo volume accuracy — regardless of how many single-image
labels exist.
