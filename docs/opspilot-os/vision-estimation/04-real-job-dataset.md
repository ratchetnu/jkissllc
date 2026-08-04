# Path B — the real operational dataset

Path A (the five-image Openverse pilot) measures whether the analyzer *runs*: inference
success, structured-output validity, latency, tokens, cost, critic invocation, decision
distribution. It cannot measure whether the analyzer is *right*, because nobody knows the
right answer for a stranger's photo — the ground truth there is a careful estimate, not a
fact.

Path B replaces that estimate with a recorded outcome. Ten J KISS jobs where the truck
space actually used, the hours actually worked and the price actually charged are known.
That is what accuracy and confidence calibration have to be measured against; Openverse
was only ever the stand-in that let the harness be built.

---

## What a case consists of

One case = one job. Ten cases.

**Photos** — 3–6 per job, taken **before loading begins**. Once anything is on the truck the
photo no longer shows the job that was quoted. Shoot the way a customer would: phone
camera, from the doorway or the driveway, whatever light there is. Do not stage, tidy or
light them — a dataset of tidy photos measures the analyzer on inputs it will never see.

**Recorded outcome** — captured at job close, from the job record rather than memory:

| Field | Source | Why it matters |
|---|---|---|
| truck space actually used (%) | crew, at load-out | the ground truth the volume estimate is scored against |
| labor time actually worked | clock in/out | scores the labor-hour estimate |
| dump / disposal cost actually paid | scale ticket or receipt | the largest driver of margin error |
| final price charged | invoice | the number the customer felt |
| access conditions | crew | stairs, carry distance, parking — the estimate's blind spot |
| crew size | schedule | pairs with labor time to give total labor hours |
| unusual handling items | crew | what needed disassembly, two people, or a special fee |

**Quoted-vs-actual is the whole point.** Record what the job was quoted at *before* the crew
arrived, alongside what it came to. A case with only the actual is half a data point: it
can score the estimate but it cannot show whether the error cost money or won the job.

---

## Privacy — non-negotiable

These are customer premises. The rules are stricter than the Openverse set, not looser.

- **Nothing leaves the private store.** Photos and outcomes live under
  `$VISION_BENCHMARK_DIR/real/`, outside the repository, exactly like the pilot images.
  The repository carries tooling and schema only.
- **No customer identity in the dataset.** No name, address, phone, email or booking id
  in a filename, a manifest field or a note. Cases are `real_001` … `real_010`, and the
  mapping back to a booking — if one is kept at all — stays in the ops system where the
  access controls already are.
- **Frame out what identifies the address.** House numbers, street signs, mail, documents,
  licence plates, and any photo where a person is identifiable. If a frame cannot be
  reshot, it is dropped — a nine-photo case is fine, a photo of someone's post is not.
- **Customer consent before a photo is retained for evaluation.** Photos taken to document
  a job are taken for that job. Reusing them to evaluate a model is a second purpose, and
  it needs to be one the customer agreed to.
- **Never uploaded to Production storage, never mixed with customer uploads.** Same rule
  as the pilot set, same reason.

Staged photos are an acceptable substitute for any case where consent is not available:
the crew's own load, a yard, a garage cleanout on a J KISS property. A staged case is
marked as staged and is worth slightly less — it is still shot with a phone, unlit and
untidied, but the crew knew a camera was coming.

---

## Sequencing

Path B does **not** need to wait for AI credits. Capturing photos and outcomes is
operational work that produces value on its own — the quoted-vs-actual table is a pricing
artefact before it is ever a benchmark.

1. **Capture** — 10 jobs. This is the long pole; it moves at the rate jobs are booked.
2. **Ingest** — a `real/` manifest in the private store, same schema plus the outcome
   fields, cases grouped by `jobGroupId` so a job scores as a job rather than as 4
   unrelated photos.
3. **Label** — far cheaper than the pilot: the outcome fields are transcribed from the job
   record, not estimated. Only the ambiguity notes and difficulty need a judgement.
4. **Benchmark** — once credits exist, the same `bench:junk` path with `--split=real`.
5. **Retire the Openverse accuracy claim** — the moment real cases carry the accuracy
   report, the stock-photo numbers stop being quoted for anything but harness health.

---

## What Path B unlocks that Path A cannot

- **Real accuracy** — volume, labor and price error against recorded outcomes.
- **Real calibration** — whether the model's stated confidence predicts its error on
  photos from actual J KISS customers, which is the only population that matters.
- **The false-high-confidence rate** — confident *and* materially wrong. On stock photos
  this is a curiosity; on real jobs it is the number that decides whether a quote can be
  auto-issued or has to go to review.
- **Access and handling as measured factors** — stairs and long carries are the estimate's
  blind spot and cannot be scored at all without knowing what the crew actually met.
