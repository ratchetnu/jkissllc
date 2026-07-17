'use client'

import Link from 'next/link'
import OperationsShell from '../../OperationsShell'
import AICommandShell, { aiCard, aiLabel } from '../AICommandShell'

// Settings — owner-safe AI configuration only. Never exposes secrets or credentials. Operational
// switches (budget, kill switch, flags) live in Usage & Controls; this section is reserved for
// future owner-safe preferences and lands in the next consolidation step.
export default function AISettingsSectionPage() {
  return (
    <OperationsShell>
      <AICommandShell section="settings" title="Settings">
        <div style={{ ...aiCard, display: 'grid', gap: 8 }}>
          <span style={aiLabel}>AI configuration</span>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            Owner-safe AI preferences will live here. Operational controls — budget, evaluation caps, the kill
            switch, and feature flags — are in <Link href="/admin/operations/ai/controls" style={{ color: '#93c5fd', textDecoration: 'none' }}>Usage &amp; Controls</Link>.
            No secrets or credentials are ever shown in this product.
          </p>
        </div>
      </AICommandShell>
    </OperationsShell>
  )
}
