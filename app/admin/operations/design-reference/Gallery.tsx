'use client'
// Reference implementation of the operational design system. Not linked from any
// nav; reachable only when DESIGN_SYSTEM_REFERENCE_ENABLED is on. Demonstrates the
// primitives so the team has one canonical example to build against.

import { useState } from 'react'
import {
  Button, IconButton, Card, MetricCard, StatusBadge, Alert, EmptyState, Spinner,
  Skeleton, ErrorState, FormField, Select, TableShell, Dialog, Drawer, Tabs,
  AiExplanation, InsightCard, ApprovalCard,
} from '../../../components/ui'

export default function Gallery() {
  const [tab, setTab] = useState('primitives')
  const [dialog, setDialog] = useState(false)
  const [drawer, setDrawer] = useState(false)

  return (
    <main style={{ maxWidth: 860, margin: '0 auto', padding: 24, display: 'grid', gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 800 }}>Design System — Reference</h1>
        <p style={{ color: 'var(--ink-muted,#9ca3af)' }}>Flagged internal reference. Not production navigation.</p>
      </div>

      <Tabs tabs={[{ id: 'primitives', label: 'Primitives' }, { id: 'ai', label: 'AI Surfaces' }]} value={tab} onChange={setTab} />

      {tab === 'primitives' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button>Primary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <IconButton label="Search">⌕</IconButton>
            <Button onClick={() => setDialog(true)}>Open dialog</Button>
            <Button variant="ghost" onClick={() => setDrawer(true)}>Open drawer</Button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12 }}>
            <MetricCard label="Today's routes" value="12" hint="3 unconfirmed" tone="blue" />
            <MetricCard label="Revenue" value="$4,280" tone="green" />
            <MetricCard label="At risk" value="2" tone="amber" />
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <StatusBadge tone="green">Confirmed</StatusBadge>
            <StatusBadge tone="amber">Pending</StatusBadge>
            <StatusBadge tone="red">Blocked</StatusBadge>
            <StatusBadge tone="grey">Inactive</StatusBadge>
          </div>

          <Alert tone="amber" title="Heads up">Two routes still need crew confirmation.</Alert>

          <FormField label="Service" hint="Pick the job type">
            <Select options={[{ value: 'delivery', label: 'Delivery' }, { value: 'hauling', label: 'Hauling' }]} />
          </FormField>

          <Card>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}><Spinner /> <Skeleton width={200} /></div>
          </Card>

          <TableShell>
            <thead><tr><th style={{ textAlign: 'left', padding: 10 }}>Route</th><th style={{ textAlign: 'left', padding: 10 }}>Status</th></tr></thead>
            <tbody><tr><td style={{ padding: 10 }}>JK-R-1042</td><td style={{ padding: 10 }}><StatusBadge tone="green">Confirmed</StatusBadge></td></tr></tbody>
          </TableShell>

          <Card><EmptyState title="Nothing needs attention" description="All operations are on track." /></Card>
          <Card><ErrorState detail="Could not load routes." onRetry={() => {}} /></Card>
        </div>
      )}

      {tab === 'ai' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <AiExplanation explanation="JK-R-1042 starts in 6h and 1 crew member has not confirmed." confidence={0.95} evidence={['1/2 assignees unconfirmed', 'starts in 6h']} />
          <InsightCard insight={{ title: '1 unconfirmed on JK-R-1042', severity: 'high', category: 'scheduling', explanation: 'Crew has not confirmed a route starting soon.', evidence: ['starts in 6h'], confidence: 0.95, recommendedAction: 'Send a confirmation nudge or reassign.' }} action={<Button size="sm">Nudge crew</Button>} />
          <ApprovalCard request={{ requestedAction: 'send.reminder', requestingWorkerId: 'ai-workforce', actionPreview: 'Text Marcus: "Please confirm JK-R-1042."', explanation: 'Route starts soon and is unconfirmed.', confidence: 0.9, expectedImpact: 'One reminder SMS', riskClass: 'low', status: 'pending' }} onApprove={() => {}} onReject={() => {}} />
        </div>
      )}

      <Dialog open={dialog} onClose={() => setDialog(false)} title="Example dialog">
        <p>Focus is trapped here; Escape closes and focus returns to the opener.</p>
        <div style={{ marginTop: 12 }}><Button onClick={() => setDialog(false)}>Done</Button></div>
      </Dialog>
      <Drawer open={drawer} onClose={() => setDrawer(false)} title="Example drawer">
        <p>Side sheet with the same focus management.</p>
      </Drawer>
    </main>
  )
}
