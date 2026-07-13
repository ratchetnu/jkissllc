// Design-system smoke test: the barrel exports every promised primitive as a
// component. (DOM-based accessibility/interaction tests need jsdom/Playwright and
// are deferred — see docs/opspilot-os/13-testing-and-ai-evaluation.md.)
import assert from 'node:assert/strict'
import test from 'node:test'

import * as ui from '../app/components/ui'

const EXPECTED = [
  'Button', 'IconButton', 'Card', 'MetricCard', 'StatusBadge', 'Alert',
  'EmptyState', 'Spinner', 'Skeleton', 'ErrorState', 'FormField', 'Select', 'TableShell',
  'Dialog', 'Drawer', 'Tabs', 'AiExplanation', 'InsightCard', 'ApprovalCard',
]

test('every promised primitive is exported as a component', () => {
  for (const name of EXPECTED) {
    assert.equal(typeof (ui as Record<string, unknown>)[name], 'function', `missing primitive: ${name}`)
  }
})
