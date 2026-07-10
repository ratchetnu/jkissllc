'use client'

import { useState } from 'react'
import { FileText, Copy, Printer, Download, X, Check, Users } from 'lucide-react'
import { COMPANY } from '../../../lib/company'
import type { ClaimType } from '../../../lib/claim-types'
import {
  templatesForClaim, buildClaimDocValues, populateClaimDoc, type ClaimDocTemplate,
} from '../../../lib/claim-documents'
import { CLAIM_TYPE_LABEL, osLabel, money, fmtDay } from '../ui'
import type { Claim, ClaimAssignment } from './useClaims'

// Native claim documents — ClaimGuard's document system, generated inside OpsPilot,
// free, no ClaimGuard login. Inbound claims get the crew-responsibility /
// acknowledgment paperwork built from data only OpsPilot has; outbound claims get the
// dispute + demand letters (chargeback rebuttal, non-payment demand, deduction
// dispute, freight/detention demand, late-delivery dispute). Copy / print / download.
export default function ClaimDocuments({ claim }: { claim: Claim }) {
  const templates = templatesForClaim(claim.claimType as ClaimType)
  const [doc, setDoc] = useState<{ title: string; text: string } | null>(null)
  if (!templates.length) return null

  const company = { legalName: COMPANY.legalName, phone: COMPANY.phoneDisplay, email: COMPANY.email }

  function generate(tpl: ClaimDocTemplate, assignment?: ClaimAssignment) {
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    const values = buildClaimDocValues(
      {
        claimNumber: claim.claimNumber,
        claimTypeLabel: CLAIM_TYPE_LABEL[claim.claimType] ?? claim.claimType,
        claimDate: fmtDay(claim.claimDate),
        businessName: claim.businessName,
        totalCents: claim.totalCents,
        description: claim.description,
        routeNumber: claim.routeNumber ?? claim.snapshot?.routeNumber,
        routeDate: claim.snapshot?.routeDate ? fmtDay(claim.snapshot.routeDate) : undefined,
        responseDeadline: claim.responseDeadline ? fmtDay(claim.responseDeadline) : undefined,
      },
      company, today,
      assignment && {
        name: assignment.name,
        responsibilityCents: assignment.responsibilityCents,
        responsibilityPct: assignment.responsibilityPct,
        weeklyDeductionCents: assignment.weeklyDeductionCents,
        startDate: assignment.startDate ? fmtDay(assignment.startDate) : undefined,
      },
    )
    setDoc({ title: tpl.title, text: populateClaimDoc(tpl, values) })
  }

  return (
    <div className="os-card os-rise" style={{ padding: 20, marginBottom: 14 }}>
      <div style={{ ...osLabel, display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
        <FileText size={14} /> Documents
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>
        Generated here from this claim — free, no ClaimGuard login. Print, copy, or download to send.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {templates.map(tpl => (
          <div key={tpl.id} style={{ padding: 13, borderRadius: 12, border: '1px solid var(--line)', background: 'rgba(255,255,255,.02)' }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{tpl.title}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>{tpl.blurb}</div>

            {tpl.needsAssignment ? (
              claim.assignments.length === 0 ? (
                <p style={{ fontSize: 12.5, color: '#fcd34d', marginTop: 9, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Users size={13} /> Assign crew responsibility first to generate this.
                </p>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 10 }}>
                  {claim.assignments.map(a => (
                    <button key={a.staffId} onClick={() => generate(tpl, a)} className="os-tap"
                      style={{ fontSize: 12.5, fontWeight: 700, padding: '7px 12px', borderRadius: 9, border: '1px solid var(--line)', background: 'rgba(255,255,255,.05)', color: 'var(--text)', cursor: 'pointer' }}>
                      {a.name} · {money(a.responsibilityCents)}
                    </button>
                  ))}
                </div>
              )
            ) : (
              <button onClick={() => generate(tpl)} className="os-tap"
                style={{ fontSize: 12.5, fontWeight: 700, padding: '8px 14px', borderRadius: 9, border: '1px solid var(--line)', background: 'rgba(255,255,255,.05)', color: 'var(--text)', cursor: 'pointer', marginTop: 10 }}>
                Generate
              </button>
            )}
          </div>
        ))}
      </div>

      {doc && <DocModal title={doc.title} text={doc.text} onClose={() => setDoc(null)} />}
    </div>
  )
}

function DocModal({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch { /* clipboard blocked */ }
  }
  function print() {
    const w = window.open('', '_blank', 'width=720,height=900')
    if (!w) return
    // Plain, print-friendly page — the document text only, monospaced, black on white.
    w.document.write(`<pre style="font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;padding:32px;color:#000">${text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))}</pre>`)
    w.document.close(); w.focus(); w.print()
  }
  function download() {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.txt`
    a.click(); URL.revokeObjectURL(url)
  }

  return (
    <div role="dialog" aria-modal aria-label={title} onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(6px)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} className="os-card os-expand"
        style={{ width: '100%', maxWidth: 640, maxHeight: '88vh', display: 'flex', flexDirection: 'column', padding: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '16px 18px', borderBottom: '1px solid var(--line)' }}>
          <span className="jkos-h" style={{ fontSize: 16 }}>{title}</span>
          <button onClick={onClose} aria-label="Close" className="os-tap" style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={19} /></button>
        </div>
        <pre style={{ margin: 0, padding: 18, overflowY: 'auto', flex: 1, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5, lineHeight: 1.55, color: 'var(--text)' }}>{text}</pre>
        <div style={{ display: 'flex', gap: 9, padding: '13px 18px', borderTop: '1px solid var(--line)' }}>
          <button onClick={copy} className="btn os-tap" style={{ borderRadius: 10, height: 40, flex: 1, justifyContent: 'center', gap: 7 }}>
            {copied ? <><Check size={15} /> Copied</> : <><Copy size={15} /> Copy</>}
          </button>
          <button onClick={print} className="btn-ghost os-tap" style={{ borderRadius: 10, height: 40, flex: 1, justifyContent: 'center', gap: 7 }}><Printer size={15} /> Print</button>
          <button onClick={download} className="btn-ghost os-tap" style={{ borderRadius: 10, height: 40, justifyContent: 'center', gap: 7, padding: '0 14px' }}><Download size={15} /></button>
        </div>
      </div>
    </div>
  )
}
