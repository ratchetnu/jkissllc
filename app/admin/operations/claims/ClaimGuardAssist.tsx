'use client'

import { ShieldCheck, ExternalLink, ArrowRight, CircleDot, Clock } from 'lucide-react'
import { recommendForClaim } from '../../../lib/claim-assist'
import type { ClaimType } from '../../../lib/claims'
import { osLabel, fmtDay } from '../ui'

// ClaimGuard Assist — the guided next-step panel on a claim.
//
// Reads the claim's type and surfaces: the situation framing, the recommended next
// action, an evidence checklist, and the matching ClaimGuard document with a
// deep link to claimguardhelp.com carrying claim context (source/ref/amount, and the
// pre-selected dispute flow). Admin-only (it lives on the claim detail).
export default function ClaimGuardAssist({ claimType, responseDeadline, refCode, amountCents }: {
  claimType: string; responseDeadline?: string; refCode?: string; amountCents?: number
}) {
  const p = recommendForClaim({ claimType: claimType as ClaimType, refCode, amountCents })
  const inbound = p.direction === 'inbound'

  return (
    <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14, border: '1px solid rgba(37,99,235,.28)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
        <div style={{ ...osLabel, display: 'flex', alignItems: 'center', gap: 7 }}>
          <ShieldCheck size={14} style={{ color: 'var(--red)' }} /> ClaimGuard Assist
        </div>
        <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 9px', borderRadius: 99, background: inbound ? 'rgba(239,68,68,.14)' : 'rgba(37,99,235,.16)', color: inbound ? '#fca5a5' : '#7dd3fc' }}>
          {inbound ? 'Claimed against us' : 'We’re disputing'}
        </span>
      </div>

      <p style={{ fontSize: 14.5, fontWeight: 700, marginTop: 8 }}>{p.headline}</p>

      {responseDeadline && (
        <p style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#fcd34d', marginTop: 6 }}>
          <Clock size={13} /> Response due {fmtDay(responseDeadline)}
        </p>
      )}

      {/* Next action */}
      <div style={{ marginTop: 12, padding: '11px 13px', borderRadius: 11, background: 'rgba(37,99,235,.07)', border: '1px solid rgba(37,99,235,.16)' }}>
        <div style={{ ...osLabel, fontSize: 10, marginBottom: 4 }}>Recommended next step</div>
        <p style={{ fontSize: 13.5, lineHeight: 1.5 }}>{p.nextAction}</p>
      </div>

      {/* Evidence checklist */}
      <div style={{ marginTop: 14 }}>
        <div style={{ ...osLabel, fontSize: 10, marginBottom: 7 }}>Gather this evidence</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {p.evidence.map((e, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: 'var(--text)' }}>
              <CircleDot size={14} style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 2 }} /> {e}
            </div>
          ))}
        </div>
      </div>

      {/* The recommended ClaimGuard document */}
      <a href={p.claimGuardHref} target="_blank" rel="noopener noreferrer"
        style={{ display: 'flex', alignItems: 'center', gap: 11, marginTop: 16, padding: 13, borderRadius: 12, background: 'var(--red)', color: '#fff', textDecoration: 'none' }}
        className="os-tap">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, opacity: .85 }}>Open in ClaimGuard</div>
          <div style={{ fontSize: 14.5, fontWeight: 800 }}>{p.document}</div>
        </div>
        <ExternalLink size={17} />
      </a>
      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
        <ArrowRight size={12} /> Opens claimguardhelp.com — free for OpsPilot users.
      </p>
    </div>
  )
}
