import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../app/admin/operations/settings/page.tsx', import.meta.url), 'utf8')
const capabilities = readFileSync(new URL('../app/admin/operations/settings/CapabilitiesPanel.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../app/admin/operations/settings/settings.module.css', import.meta.url), 'utf8')

test('Settings is category-driven instead of rendering one continuous page', () => {
  for (const id of ['notifications', 'crew', 'business', 'features', 'tools', 'account']) {
    assert.match(page, new RegExp(`id: '${id}'`))
    assert.match(page, new RegExp(`activeSection === '${id}'`))
  }
  assert.match(page, /aria-label="Settings categories"/)
  assert.match(page, /aria-pressed=\{activeSection === section\.id\}/)
})

test('Optional features opens one business group at a time', () => {
  assert.match(capabilities, /activeGroup/)
  assert.match(capabilities, /selectedGroup\.items\.map\(row\)/)
  assert.match(capabilities, /aria-label="Feature groups"/)
})

test('Settings navigation collapses to button grids on narrow screens', () => {
  assert.match(css, /@media \(max-width: 760px\)/)
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/)
  assert.match(css, /@media \(max-width: 420px\)/)
})
