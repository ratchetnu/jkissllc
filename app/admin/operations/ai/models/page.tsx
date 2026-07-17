'use client'

import Link from 'next/link'
import OperationsShell from '../../OperationsShell'
import AICommandShell, { aiCard, aiLabel } from '../AICommandShell'

// Models & Versions — a read-only registry of estimator / prompt / model / deployment versions
// with their accuracy, win %, error, confidence, sample size, and cost. In Increment 1 the
// version data lives in Usage & Controls (the relocated AI Control Center's registry tab); the
// dedicated registry view lands in the next consolidation step. No model promotion.
export default function AIModelsSectionPage() {
  return (
    <OperationsShell>
      <AICommandShell section="models" title="Models & Versions">
        <div style={{ ...aiCard, display: 'grid', gap: 8 }}>
          <span style={aiLabel}>Version registry</span>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            A read-only registry ranking every estimator, prompt, model, and deployment version by accuracy,
            win rate, median error, confidence, sample size, and cost is being assembled here. Until it lands,
            per-version performance is in <Link href="/admin/operations/ai/shadow" style={{ color: '#93c5fd', textDecoration: 'none' }}>Performance → leaderboard</Link> and
            the live-model registry is in <Link href="/admin/operations/ai/controls" style={{ color: '#93c5fd', textDecoration: 'none' }}>Usage &amp; Controls</Link>. No model is ever promoted from here.
          </p>
        </div>
      </AICommandShell>
    </OperationsShell>
  )
}
