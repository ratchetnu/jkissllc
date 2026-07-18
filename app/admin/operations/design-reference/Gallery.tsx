'use client'
// Reference implementation of the Operion design system. Not linked from any nav;
// reachable only when DESIGN_SYSTEM_REFERENCE_ENABLED is on. One canonical example
// of every primitive, token, and status tone the team builds against.

import { useState } from 'react'
import {
  Button, IconButton, Card, MetricCard, StatusBadge, Alert, EmptyState, Spinner,
  Skeleton, ErrorState, FormField, Select, TableShell, Dialog, Drawer, Tabs,
  Input, Textarea, SearchInput, CurrencyInput, Toggle, Segmented,
  PageHeader, Toolbar, KpiRow, Progress, Avatar,
  AiExplanation, InsightCard, ApprovalCard, tokens as t, type StatusTone,
} from '../../../components/ui'

const TONES: StatusTone[] = ['neutral', 'info', 'good', 'warn', 'bad', 'accent']

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: t.space[3] }}>
      <h2 style={{ fontSize: t.text.sm, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: t.color.muted, margin: 0 }}>{title}</h2>
      {children}
    </section>
  )
}

export default function Gallery() {
  const [tab, setTab] = useState('primitives')
  const [dialog, setDialog] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [on, setOn] = useState(true)
  const [seg, setSeg] = useState<'list' | 'board'>('list')
  const [amount, setAmount] = useState('350.00')

  return (
    <main className="jkos" style={{ maxWidth: 900, margin: '0 auto', padding: t.space[6], display: 'grid', gap: t.space[8] }}>
      <PageHeader title="Operion Design System" subtitle="Flagged internal reference — not production navigation."
        actions={<><Button variant="secondary" size="sm">Docs</Button><Button size="sm">Primary</Button></>} />

      <Tabs tabs={[{ id: 'primitives', label: 'Primitives' }, { id: 'forms', label: 'Forms' }, { id: 'ai', label: 'AI Surfaces' }]} value={tab} onChange={setTab} />

      {tab === 'primitives' && (
        <div style={{ display: 'grid', gap: t.space[8] }}>
          <Section title="Buttons">
            <Toolbar>
              <Button>Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="danger">Danger</Button>
              <Button variant="quiet">Quiet</Button>
              <IconButton label="Search">⌕</IconButton>
              <Button size="sm">Small</Button>
              <Button size="lg">Large</Button>
              <Button onClick={() => setDialog(true)}>Open dialog</Button>
              <Button variant="secondary" onClick={() => setDrawer(true)}>Open drawer</Button>
            </Toolbar>
          </Section>

          <Section title="Metrics (KpiRow)">
            <KpiRow>
              <MetricCard label="Today's routes" value="12" hint="3 unconfirmed" tone="info" />
              <MetricCard label="Revenue" value="$4,280" tone="good" />
              <MetricCard label="At risk" value="2" tone="warn" />
              <MetricCard label="Disputed" value="1" tone="bad" />
            </KpiRow>
          </Section>

          <Section title="Status tones (one vocabulary)">
            <Toolbar>{TONES.map((tone) => <StatusBadge key={tone} tone={tone}>{tone}</StatusBadge>)}</Toolbar>
          </Section>

          <Section title="Feedback">
            <Alert tone="warn" title="Heads up">Two routes still need crew confirmation.</Alert>
            <Card><div style={{ display: 'grid', gap: t.space[3] }}><Progress value={68} label="Sync" /><Progress label="Loading" /><div style={{ display: 'flex', gap: t.space[3], alignItems: 'center' }}><Spinner /> <Skeleton width={200} /></div></div></Card>
            <Card><EmptyState title="Nothing needs attention" description="All operations are on track." action={<Button size="sm" variant="secondary">Refresh</Button>} /></Card>
            <Card><ErrorState detail="Could not load routes." onRetry={() => {}} /></Card>
          </Section>

          <Section title="Table">
            <TableShell>
              <thead><tr><th style={{ textAlign: 'left', padding: 10 }}>Crew</th><th style={{ textAlign: 'left', padding: 10 }}>Route</th><th style={{ textAlign: 'left', padding: 10 }}>Status</th></tr></thead>
              <tbody><tr>
                <td style={{ padding: 10 }}><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Avatar name="Marcus Bell" size={28} /> Marcus Bell</div></td>
                <td style={{ padding: 10 }}>JK-R-1042</td>
                <td style={{ padding: 10 }}><StatusBadge tone="good">Confirmed</StatusBadge></td>
              </tr></tbody>
            </TableShell>
          </Section>
        </div>
      )}

      {tab === 'forms' && (
        <div style={{ display: 'grid', gap: t.space[6], maxWidth: 460 }}>
          <SearchInput placeholder="Search requests…" />
          <FormField label="Customer name" hint="As it appears on the booking"><Input placeholder="Jane Doe" /></FormField>
          <FormField label="Quote amount"><CurrencyInput value={amount} onChange={setAmount} aria-label="Quote amount" /></FormField>
          <FormField label="Service"><Select options={[{ value: 'delivery', label: 'Delivery' }, { value: 'hauling', label: 'Hauling' }]} /></FormField>
          <FormField label="Notes"><Textarea placeholder="Anything the crew should know…" /></FormField>
          <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3] }}><Toggle on={on} onChange={setOn} label="Notify customer" /><span style={{ color: t.color.muted }}>Notify customer</span></div>
          <Segmented value={seg} onChange={setSeg} ariaLabel="View" options={[{ value: 'list', label: 'List' }, { value: 'board', label: 'Board' }]} />
          <FormField label="Invalid example" error="This field is required"><Input invalid defaultValue="" /></FormField>
        </div>
      )}

      {tab === 'ai' && (
        <div style={{ display: 'grid', gap: t.space[4] }}>
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
