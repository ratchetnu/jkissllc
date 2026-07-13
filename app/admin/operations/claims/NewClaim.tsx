'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, Paperclip, Trash2 } from 'lucide-react'
import { MoneyInput, looksLikeMoney, osField, osLabel, ymd } from '../ui'
import { invalidateClaims } from './useClaims'
import { uploadEvidence, type EvidenceUpload } from './evidence'

// One create-claim sheet, used from three places:
//   • the Claims hub        → pick a business
//   • a Business page       → business is fixed
//   • a completed Route     → routeToken is passed; the server copies the business,
//                             route, address, crew and financial snapshot across, so
//                             none of it is re-typed here.
export default function NewClaim({
  onClose, onCreated, routeToken, businessName, routeLabel,
}: {
  onClose: () => void
  onCreated?: () => void
  routeToken?: string
  businessName?: string
  routeLabel?: string
}) {
  const router = useRouter()
  const today = ymd(new Date())
  const [biz, setBiz] = useState(businessName ?? '')
  const [businesses, setBusinesses] = useState<{ key: string; name: string }[]>([])
  const [claimType, setClaimType] = useState('property_damage')
  const [claimDate, setClaimDate] = useState(today)
  const [reportedDate, setReportedDate] = useState(today)
  const [total, setTotal] = useState('')
  const [description, setDescription] = useState('')
  const [reportedBy, setReportedBy] = useState('')
  const [responseDeadline, setResponseDeadline] = useState('')
  const [internalNotes, setInternalNotes] = useState('')
  const [files, setFiles] = useState<EvidenceUpload[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const fromRoute = Boolean(routeToken)

  async function addFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? [])
    if (fileInput.current) fileInput.current.value = '' // allow re-picking the same file
    if (!picked.length) return
    setUploading(true); setUploadErr('')
    for (const file of picked) {
      try { const ev = await uploadEvidence(file); setFiles(prev => [...prev, ev]) }
      catch { setUploadErr('One file failed to upload — check the connection and try again.') }
    }
    setUploading(false)
  }

  useEffect(() => {
    if (fromRoute || businessName) return
    fetch('/api/admin/businesses', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => setBusinesses(Array.isArray(d.items) ? d.items : []))
      .catch(() => { /* the field falls back to free text */ })
  }, [fromRoute, businessName])

  const totalInvalid = total.trim() !== '' && !looksLikeMoney(total)
  const canSave = !busy && !uploading && !totalInvalid && total.trim() !== '' && description.trim() !== '' && (fromRoute || biz.trim() !== '')

  async function submit() {
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/admin/claims', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({
          routeToken, businessName: fromRoute ? undefined : biz,
          claimType, claimDate, reportedDate, reportedBy, responseDeadline, total, description, internalNotes,
          attachments: files.map(f => ({ kind: f.kind, url: f.url, name: f.name })),
        }),
      })
      const d = await res.json()
      if (!res.ok) { setError(d.error || 'Could not open the claim.'); return }
      invalidateClaims()
      onCreated?.()
      onClose()
      router.push(`/admin/operations/claims/${d.claim.id}`)
    } catch { setError('Network error — please try again.') } finally { setBusy(false) }
  }

  return (
    <div role="dialog" aria-modal aria-label="New claim" onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(6px)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} className="os-card os-expand"
        style={{ width: '100%', maxWidth: 560, maxHeight: '88vh', overflowY: 'auto', padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h2 className="jkos-h" style={{ fontSize: 21 }}>New claim</h2>
          <button onClick={onClose} aria-label="Close" className="os-tap" style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}><X size={20} /></button>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, marginBottom: 16 }}>
          {fromRoute
            ? `Opening against ${routeLabel || 'this route'}. The business, crew and route pricing are copied in and frozen.`
            : 'Record what the client says was damaged, and what it costs.'}
        </p>

        {error && <div style={{ padding: '10px 13px', borderRadius: 10, background: 'rgba(239,68,68,.12)', border: '1px solid rgba(239,68,68,.3)', color: '#fca5a5', fontSize: 13.5, marginBottom: 14 }}>{error}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!fromRoute && (
            <div>
              <label htmlFor="nc-biz" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Business</label>
              <input id="nc-biz" list="nc-biz-list" value={biz} onChange={e => setBiz(e.target.value)} disabled={Boolean(businessName)} placeholder="Which client?" style={osField} />
              <datalist id="nc-biz-list">{businesses.map(b => <option key={b.key} value={b.name} />)}</datalist>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
            <div>
              <label htmlFor="nc-type" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Type</label>
              <select id="nc-type" value={claimType} onChange={e => setClaimType(e.target.value)} style={{ ...osField, cursor: 'pointer' }}>
                <optgroup label="Claimed against us (recover from crew)">
                  <option value="property_damage">Property Damage</option>
                  <option value="vehicle_damage">Vehicle Damage</option>
                  <option value="cargo_damage">Cargo Damage</option>
                  <option value="lost_item">Lost / Missing Item</option>
                  <option value="injury">Injury</option>
                  <option value="service_failure">Service Failure</option>
                </optgroup>
                <optgroup label="We're disputing (recover from them)">
                  <option value="chargeback">Chargeback</option>
                  <option value="unfair_deduction">Unfair Deduction</option>
                  <option value="detention">Detention</option>
                  <option value="accessorial_dispute">Accessorial Dispute</option>
                  <option value="late_delivery">Late Delivery</option>
                  <option value="non_payment">Non-Payment</option>
                </optgroup>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label htmlFor="nc-total" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Claim amount</label>
              <MoneyInput value={total} onChange={setTotal} invalid={totalInvalid} aria-label="Claim amount" />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
            <div>
              <label htmlFor="nc-cd" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Date it happened</label>
              <input id="nc-cd" type="date" value={claimDate} onChange={e => setClaimDate(e.target.value)} style={osField} />
            </div>
            <div>
              <label htmlFor="nc-rd" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Date reported</label>
              <input id="nc-rd" type="date" value={reportedDate} min={claimDate} onChange={e => setReportedDate(e.target.value)} style={osField} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
            <div>
              <label htmlFor="nc-by" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Who reported it</label>
              <input id="nc-by" value={reportedBy} onChange={e => setReportedBy(e.target.value)} placeholder="Driver, client contact, broker…" style={osField} />
            </div>
            <div>
              <label htmlFor="nc-dl" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Response deadline <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>— optional</span></label>
              <input id="nc-dl" type="date" value={responseDeadline} min={claimDate} onChange={e => setResponseDeadline(e.target.value)} style={osField} />
            </div>
          </div>

          <div>
            <label htmlFor="nc-desc" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>What happened</label>
            <textarea id="nc-desc" value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="What happened…" style={{ ...osField, resize: 'vertical' }} />
          </div>

          <div>
            <label htmlFor="nc-notes" style={{ ...osLabel, display: 'block', marginBottom: 6 }}>Internal notes <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>— never shown to crew or client</span></label>
            <textarea id="nc-notes" value={internalNotes} onChange={e => setInternalNotes(e.target.value)} rows={2} style={{ ...osField, resize: 'vertical' }} />
          </div>

          <div>
            <div style={{ ...osLabel, display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}><Paperclip size={13} /> Evidence <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>— photos, video or documents</span></div>
            {files.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                {files.map((f, i) => (
                  <div key={f.url} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', minWidth: 52 }}>{f.kind}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                    <button type="button" onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`} className="os-tap" style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer' }}><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            )}
            <label className="btn-ghost os-tap" style={{ borderRadius: 10, height: 40, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px', fontSize: 13.5, cursor: uploading ? 'wait' : 'pointer' }}>
              {uploading ? 'Uploading…' : files.length ? '+ Add more' : '+ Add evidence'}
              <input ref={fileInput} type="file" accept="image/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt" capture="environment" multiple onChange={addFiles} disabled={uploading} style={{ display: 'none' }} />
            </label>
            {uploadErr && <p style={{ fontSize: 12.5, color: '#fca5a5', marginTop: 6 }}>{uploadErr}</p>}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button onClick={onClose} className="btn-ghost os-tap" style={{ borderRadius: 12, height: 44, flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button onClick={submit} disabled={!canSave} className="btn os-tap" style={{ borderRadius: 12, height: 44, flex: 1, justifyContent: 'center', opacity: canSave ? 1 : .5 }}>
            {busy ? 'Opening…' : 'Open claim'}
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>You&apos;ll assign crew responsibility on the next screen. Nothing is deducted until you start a plan.</p>
      </div>
    </div>
  )
}
