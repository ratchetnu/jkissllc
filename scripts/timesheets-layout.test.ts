// Timesheets filter layout — the From/To date inputs used to render at the BROWSER's
// intrinsic width (no width was declared at all), which made them tower over the Crew
// and Work selects. These tests pin the sizing contract by reading the component
// source, the same static approach the repo's other layout gates use.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const SRC = readFileSync(path.join(process.cwd(), 'app/admin/operations/timesheets/page.tsx'), 'utf8')

const styleBlock = (name: string): string => {
  const m = new RegExp(`const ${name}: React\\.CSSProperties = \\{([^}]*)\\}`).exec(SRC)
  assert.ok(m, `expected a ${name} style block`)
  return m![1]
}
const numberIn = (block: string, prop: string): number | null => {
  const m = new RegExp(`${prop}:\\s*'?([0-9]+)`).exec(block)
  return m ? Number(m[1]) : null
}
const flexBasis = (block: string): number => {
  const m = /flex:\s*'[\d]+ [\d]+ (\d+)px'/.exec(block)
  assert.ok(m, 'expected a flex basis')
  return Number(m![1])
}

test('desktop widths: Crew 160–180, From/To 120–135, Work 120–150', () => {
  const crew = flexBasis(styleBlock('crewCell'))
  const date = flexBasis(styleBlock('dateCell'))
  const work = flexBasis(styleBlock('workCell'))

  assert.ok(crew >= 160 && crew <= 180, `crew basis ${crew} must be 160–180`)
  assert.ok(date >= 120 && date <= 135, `date basis ${date} must be 120–135`)
  assert.ok(work >= 120 && work <= 150, `work basis ${work} must be 120–150`)

  // Caps keep the row compact — a date field can never grow into a full-width input.
  assert.ok((numberIn(styleBlock('dateCell'), 'maxWidth') ?? 999) <= 135, 'date fields are capped')
  assert.ok((numberIn(styleBlock('crewCell'), 'maxWidth') ?? 999) <= 180, 'crew select is capped')
  assert.ok((numberIn(styleBlock('workCell'), 'maxWidth') ?? 999) <= 150, 'work select is capped')
})

test('From and To are equal-width columns', () => {
  // Both use the SAME cell style, so they can never drift apart.
  const uses = SRC.match(/style=\{dateCell\}/g) ?? []
  assert.equal(uses.length, 2, 'exactly the From and To cells use the shared date sizing')
  // NB: [^>]* would stop at the `>` of an arrow function in an attribute.
  const inputs = SRC.match(/type="date"[\s\S]*?style=\{dateField\}/g) ?? []
  assert.equal(inputs.length, 2, 'and both date inputs share one field style')
})

test('the row wraps and nothing can force page-level overflow', () => {
  const row = styleBlock('filterRow')
  assert.match(row, /flexWrap:\s*'wrap'/, 'the filter row wraps on narrow screens')
  // minWidth:0 on every cell is what lets a flex item shrink instead of overflowing.
  for (const name of ['filterLabel', 'crewField', 'dateField', 'workField']) {
    assert.match(styleBlock(name), /minWidth:\s*0/, `${name} must allow shrinking`)
  }
  // A floor keeps the date control usable rather than shrinking to nothing.
  const floor = numberIn(styleBlock('dateCell'), 'minWidth') ?? 0
  assert.ok(floor >= 110, `date fields keep a usable floor (${floor}px)`)
})

test('touch targets stay ~44px where it matters', () => {
  assert.ok((numberIn(styleBlock('dateField'), 'minHeight') ?? 0) >= 40, 'date inputs keep a tappable height')
  assert.match(SRC, /minHeight: 44/, 'the correction editor uses 44px targets')
})

test('native date rendering and localization are left alone', () => {
  // We size the control; we never lay out its segments or impose a format.
  assert.match(SRC, /<input type="date"/, 'still a native date input')
  assert.doesNotMatch(SRC, /placeholder="(MM|DD|YYYY)/i, 'no hand-rolled date format')
  assert.doesNotMatch(styleBlock('dateField'), /width:\s*'?\d+px/, 'width comes from the flex cell, not a hard pixel on the input')
})

test('the dark Apple-style field treatment is preserved', () => {
  const base = styleBlock('field')
  assert.match(base, /color-mix\(in srgb, var\(--card\)/, 'same translucent card fill')
  assert.match(base, /border: '1px solid var\(--line\)'/, 'same hairline border')
  assert.match(base, /borderRadius: 10/, 'same corner radius')
  for (const name of ['crewField', 'dateField', 'workField']) {
    assert.match(styleBlock(name), /\.\.\.field/, `${name} extends the shared field style`)
  }
})

test('the row action is permission-gated in the markup as well as the API', () => {
  assert.match(SRC, /data\.canCorrect &&/, 'the Edit time control is conditional')
  assert.match(SRC, /Edit time/, 'the action exists for permitted roles')
  assert.match(SRC, /aria-label=\{`Edit time for/, 'and is labelled for assistive tech')
})
