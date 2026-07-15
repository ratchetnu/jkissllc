// Accessibility regression for the Book Now wizard (app/quote/page.tsx).
//
// The wizard renders its labels as visual siblings of the inputs (styled <label>
// elements), so it is easy to reintroduce the WCAG 1.3.1 / 4.1.2 defect where a
// label is not programmatically associated with its control. jsdom is not part of
// this project's toolchain, so instead of a render test we do a static source-level
// audit of the JSX:
//   1. Every <input>/<select>/<textarea> carries an accessible name mechanism
//      (an `id` paired with a <label htmlFor>, or an explicit `aria-label`).
//   2. Referential integrity — every htmlFor / aria-labelledby / aria-describedby
//      target that is written as a literal string resolves to an `id` in the file.
//   3. The photo-upload progress and the submission-error surfaces remain live/
//      alert regions so assistive tech announces them.
//
// This is intentionally a lightweight guard: it can't prove the a11y tree, but it
// deterministically catches a dropped association — the exact regression this
// phase fixed — and is better than no coverage.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(join(here, '..', 'app', 'quote', 'page.tsx'), 'utf8')

// Arrow functions (`e => ...`) put a `>` inside JSX attribute values, which would
// prematurely terminate a naive `<tag ...>` match. Neutralize them before parsing.
const src = raw.replace(/=>/g, '=~')

function allIds(text: string): Set<string> {
  const ids = new Set<string>()
  for (const m of text.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1])
  return ids
}

function literalRefs(text: string, attr: string): string[] {
  const refs: string[] = []
  const re = new RegExp(`\\b${attr}="([^"]+)"`, 'g')
  for (const m of text.matchAll(re)) {
    // aria-labelledby / aria-describedby may list multiple space-separated ids.
    for (const tok of m[1].split(/\s+/)) if (tok) refs.push(tok)
  }
  return refs
}

test('every form control in the wizard has an accessible name', () => {
  const ids = allIds(src)
  const controls = [...src.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map(m => m[0])
  assert.ok(controls.length >= 10, `expected the wizard's form controls to be found (got ${controls.length})`)
  for (const tag of controls) {
    const named = /\bid="[^"]+"/.test(tag) || /\baria-label="[^"]+"/.test(tag) || /\baria-labelledby="[^"]+"/.test(tag)
    assert.ok(named, `form control is missing an accessible name (no id / aria-label): ${tag.slice(0, 120)}…`)
  }
  // Sanity: the labelled text inputs we associated must still exist by id.
  for (const id of ['q-pickup', 'q-name', 'q-email', 'q-phone', 'q-contact-method', 'q-promo']) {
    assert.ok(ids.has(id), `expected control id "${id}" to be present`)
  }
})

test('every label/description reference resolves to an id (no dangling associations)', () => {
  const ids = allIds(src)
  for (const attr of ['htmlFor', 'aria-labelledby', 'aria-describedby']) {
    for (const ref of literalRefs(src, attr)) {
      assert.ok(ids.has(ref), `${attr}="${ref}" points at an id that does not exist in app/quote/page.tsx`)
    }
  }
  // The known required text fields must be wired label→input via htmlFor.
  for (const target of ['q-pickup', 'q-name', 'q-email']) {
    assert.ok(literalRefs(src, 'htmlFor').includes(target), `required field "${target}" must have an associated <label htmlFor>`)
  }
})

test('required text fields communicate required state', () => {
  // Each of these ids should appear in a tag that also carries aria-required.
  for (const id of ['q-pickup', 'q-delivery', 'q-name', 'q-email']) {
    const tag = [...src.matchAll(/<input\b[^>]*>/g)].map(m => m[0]).find(t => t.includes(`id="${id}"`))
    assert.ok(tag, `input id="${id}" not found`)
    assert.ok(/\baria-required="true"/.test(tag!), `input id="${id}" should be aria-required`)
  }
})

test('photo upload exposes a live status and the submission error is an alert', () => {
  // Photo-upload progress/success/error announcement.
  assert.match(raw, /role="status"[^>]*aria-live="polite"/, 'photo upload status must be an aria-live polite region')
  // Submission / validation error summary announced assertively.
  assert.match(raw, /role="alert"/, 'the wizard error surface must be a role="alert" region')
  // Photo file input has an explicit accessible name.
  const fileInputs = [...src.matchAll(/<input\b[^>]*type="file"[^>]*>/g)].map(m => m[0])
  assert.ok(fileInputs.length >= 1, 'expected at least one file input')
  for (const fi of fileInputs) {
    assert.ok(/\baria-label="[^"]+"/.test(fi), `file input needs an aria-label: ${fi.slice(0, 100)}…`)
  }
})
