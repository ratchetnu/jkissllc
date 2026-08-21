'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { COMPANY } from '../../lib/company'
import type { DocKind, RequiredDoc } from '../../lib/ats-config'

type Uploaded = { url: string; receipt: string }
type Contractor = {
  name: string
  email: string
  position: 'driver' | 'helper'
  applicantNumber: string
  submittedAt?: number
  agreementVersion?: number
  agreementDownloadedAt?: number
  consentVersion: string
  consentDisclosure: string
  requiredDocuments: RequiredDoc[]
}

async function asDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

export default function ContractorOnboardingPage() {
  const [token, setToken] = useState('')
  const [contractor, setContractor] = useState<Contractor | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState<DocKind | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [uploads, setUploads] = useState<Partial<Record<DocKind, Uploaded>>>({})
  const [legalName, setLegalName] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [taxClassification, setTaxClassification] = useState<'individual' | 'business'>('individual')
  const [tinLast4, setTinLast4] = useState('')
  const [signatureName, setSignatureName] = useState('')
  const [electronicConsent, setElectronicConsent] = useState(false)
  const [intentToSign, setIntentToSign] = useState(false)
  const [informationCertified, setInformationCertified] = useState(false)
  const [signatureCode, setSignatureCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [drivingAuthorized, setDrivingAuthorized] = useState(false)
  const [usesPersonalVehicle, setUsesPersonalVehicle] = useState(false)
  const [address, setAddress] = useState({ line1: '', line2: '', city: '', state: '', postalCode: '' })

  useEffect(() => {
    const current = new URLSearchParams(window.location.search).get('token') ?? ''
    setToken(current)
    if (!current) { setError('This onboarding link is missing or invalid.'); setLoading(false); return }
    fetch(`/api/careers/onboarding?token=${encodeURIComponent(current)}`)
      .then(async res => ({ ok: res.ok, body: await res.json() }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || 'This onboarding link is invalid or expired.')
        setContractor(body.contractor)
        setLegalName(body.contractor.name)
        setDone(Boolean(body.contractor.submittedAt))
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Onboarding could not be loaded.'))
      .finally(() => setLoading(false))
  }, [])

  const documents = [
    ...(contractor?.requiredDocuments ?? []),
    ...(usesPersonalVehicle ? [{ kind: 'insurance' as const, label: 'Personal Vehicle Insurance', help: 'Current insurance certificate or declarations page.' }] : []),
  ]

  async function upload(kind: DocKind, file: File) {
    setUploading(kind); setError('')
    try {
      const res = await fetch('/api/careers/onboarding/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, kind, file: await asDataUrl(file) }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Upload failed.')
      setUploads(previous => ({ ...previous, [kind]: { url: body.url, receipt: body.receipt } }))
    } catch (err) { setError(err instanceof Error ? err.message : 'Upload failed.') }
    finally { setUploading(null) }
  }

  async function submit() {
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/careers/onboarding', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token, legalName, businessName, taxClassification, tinLast4, signatureName,
          electronicConsent, intentToSign, informationCertified, signatureCode, drivingAuthorized, usesPersonalVehicle, address,
          documents: Object.entries(uploads).map(([kind, value]) => ({ kind, ...value })),
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Onboarding could not be submitted.')
      setDone(true)
    } catch (err) { setError(err instanceof Error ? err.message : 'Onboarding could not be submitted.') }
    finally { setBusy(false) }
  }

  async function requestSigningCode() {
    setSendingCode(true); setError('')
    try {
      const res = await fetch('/api/careers/onboarding/signature-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'The signing code could not be sent.')
      setCodeSent(true)
    } catch (err) { setError(err instanceof Error ? err.message : 'The signing code could not be sent.') }
    finally { setSendingCode(false) }
  }

  const input: React.CSSProperties = { width: '100%', padding: '12px 14px', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 10, color: '#f3f4f6', fontSize: 16 }
  const label: React.CSSProperties = { display: 'block', color: 'var(--muted)', fontSize: 12, fontWeight: 700, marginBottom: 6 }

  return (
    <main className="min-h-screen px-5 py-16" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <div className="max-w-2xl mx-auto">
        <Link href="/" className="text-xl font-black text-white">J Kiss <span style={{ color: 'var(--red)' }}>LLC</span></Link>
        <div className="glass-card p-6 md:p-8 mt-8" style={{ borderRadius: 20 }}>
          <div className="label mb-3" style={{ display: 'inline-block' }}>Secure Contractor Onboarding</div>
          <h1 className="text-2xl md:text-3xl font-black text-white mb-2">Complete your 1099 contractor setup</h1>
          {contractor && <p className="text-sm mb-6" style={{ color: 'var(--muted)' }}>{contractor.name} · {contractor.applicantNumber}</p>}
          {loading && <p>Loading secure onboarding…</p>}
          {error && <p role="alert" className="text-sm mb-4" style={{ color: '#f87171' }}>{error}</p>}
          {done && <div className="rounded-xl p-5" style={{ background: 'rgba(52,211,153,.08)', border: '1px solid rgba(52,211,153,.3)' }}><p className="font-bold text-white">Onboarding submitted</p><p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>J Kiss LLC will review the documents before activating your contractor setup.</p></div>}
          {!loading && contractor && !done && (
            <div className="space-y-6">
              <div className="rounded-xl p-4" style={{ background: 'rgba(224,0,42,.05)', border: '1px solid rgba(224,0,42,.2)' }}>
                <p className="text-sm font-bold text-white">Privacy notice</p>
                <p className="text-xs mt-1" style={{ color: 'var(--muted)', lineHeight: 1.55 }}>Upload a completed W-9—not a Social Security card. Your encrypted tax and identity documents are restricted to administrators. The system stores only the last four digits of your SSN or EIN outside the encrypted W-9.</p>
              </div>
              <section>
                <h2 className="font-bold text-white mb-3">Contractor and tax details</h2>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="sm:col-span-2"><label htmlFor="contractor-legal-name" style={label}>Legal name</label><input id="contractor-legal-name" value={legalName} onChange={e => setLegalName(e.target.value)} autoComplete="name" style={input} /></div>
                  <div className="sm:col-span-2"><label htmlFor="contractor-business-name" style={label}>Business name (optional)</label><input id="contractor-business-name" value={businessName} onChange={e => setBusinessName(e.target.value)} autoComplete="organization" style={input} /></div>
                  <div><label htmlFor="contractor-tax-classification" style={label}>Tax classification</label><select id="contractor-tax-classification" value={taxClassification} onChange={e => setTaxClassification(e.target.value as 'individual' | 'business')} style={{ ...input, colorScheme: 'dark' }}><option value="individual">Individual / sole proprietor</option><option value="business">Business entity</option></select></div>
                  <div><label htmlFor="contractor-tin-last-four" style={label}>SSN or EIN last four only</label><input id="contractor-tin-last-four" value={tinLast4} onChange={e => setTinLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" autoComplete="off" maxLength={4} style={input} /></div>
                </div>
              </section>
              <section>
                <h2 className="font-bold text-white mb-3">Mailing address</h2>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="sm:col-span-2"><label htmlFor="contractor-address-line1" style={label}>Street address</label><input id="contractor-address-line1" value={address.line1} onChange={e => setAddress({ ...address, line1: e.target.value })} autoComplete="address-line1" style={input} /></div>
                  <div className="sm:col-span-2"><label htmlFor="contractor-address-line2" style={label}>Unit / apartment (optional)</label><input id="contractor-address-line2" value={address.line2} onChange={e => setAddress({ ...address, line2: e.target.value })} autoComplete="address-line2" style={input} /></div>
                  <div><label htmlFor="contractor-address-city" style={label}>City</label><input id="contractor-address-city" value={address.city} onChange={e => setAddress({ ...address, city: e.target.value })} autoComplete="address-level2" style={input} /></div>
                  <div className="grid grid-cols-2 gap-2"><div><label htmlFor="contractor-address-state" style={label}>State</label><input id="contractor-address-state" value={address.state} onChange={e => setAddress({ ...address, state: e.target.value })} autoComplete="address-level1" style={input} /></div><div><label htmlFor="contractor-address-postal" style={label}>ZIP</label><input id="contractor-address-postal" value={address.postalCode} onChange={e => setAddress({ ...address, postalCode: e.target.value })} autoComplete="postal-code" style={input} /></div></div>
                </div>
              </section>
              {contractor.position === 'driver' && <section className="space-y-2"><h2 className="font-bold text-white">Driving</h2><Check checked={drivingAuthorized} onChange={setDrivingAuthorized} label="I authorize J Kiss LLC to verify my driver-license status and driving eligibility for contracted driving work." /><Check checked={usesPersonalVehicle} onChange={setUsesPersonalVehicle} label="I will use a personal vehicle for contracted work." /></section>}
              <section className="rounded-xl p-4" style={{ background: 'rgba(59,130,246,.06)', border: '1px solid rgba(147,197,253,.35)' }}>
                <h2 className="font-bold text-white mb-1">Step 1 — Review and retain your agreement</h2>
                <p className="text-xs mb-3" style={{ color: 'var(--muted)', lineHeight: 1.55 }}>
                  Download and review agreement v{contractor.agreementVersion ?? '—'}. You can save or print this exact version before deciding whether to sign electronically.
                </p>
                <a
                  className="btn"
                  href={`/api/careers/onboarding/agreement?token=${encodeURIComponent(token)}`}
                  download
                  style={{ display: 'inline-flex', justifyContent: 'center' }}
                >
                  Download agreement v{contractor.agreementVersion ?? ''}
                </a>
              </section>
              <section className="space-y-3">
                <h2 className="font-bold text-white">Step 2 — Sign electronically</h2>
                <div className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
                  <p className="text-sm font-bold text-white mb-2">Electronic records disclosure</p>
                  <p className="text-xs" style={{ color: 'var(--muted)', lineHeight: 1.65 }}>{contractor.consentDisclosure}</p>
                </div>
                <Check checked={electronicConsent} onChange={setElectronicConsent} label="I have reviewed this disclosure and consent to use electronic records and signatures for this agreement." />
                <Check checked={intentToSign} onChange={setIntentToSign} label={`I reviewed agreement v${contractor.agreementVersion ?? ''}, agree to its terms, and intend my electronic signature to bind me to ${COMPANY.legalName}.`} />
                <div><label htmlFor="contractor-signature" style={label}>Type your full legal name as your signature</label><input id="contractor-signature" value={signatureName} onChange={e => setSignatureName(e.target.value)} autoComplete="name" style={input} /></div>
                <div className="grid sm:grid-cols-[1fr_auto] gap-2 items-end">
                  <div><label htmlFor="contractor-signature-code" style={label}>One-time code sent to {contractor.email}</label><input id="contractor-signature-code" value={signatureCode} onChange={e => setSignatureCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" style={input} /></div>
                  <button type="button" className="btn-ghost" disabled={sendingCode} onClick={() => void requestSigningCode()} style={{ padding: '12px 14px' }}>{sendingCode ? 'Sending…' : codeSent ? 'Send a new code' : 'Email my code'}</button>
                </div>
                {codeSent && <p role="status" className="text-xs" style={{ color: '#34d399' }}>Code sent. It expires in 10 minutes and can be used once.</p>}
              </section>
              <section>
                <h2 className="font-bold text-white mb-1">Step 3 — Required documents</h2>
                <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>PDF, JPG, PNG, or compatible phone image; maximum about 12 MB each.</p>
                <div className="space-y-2">{documents.map(doc => <div key={doc.kind} className="rounded-xl p-4 flex items-center justify-between gap-3" style={{ border: '1px solid var(--line)' }}><div><p className="text-sm font-bold text-white">{doc.label} {uploads[doc.kind] && <span style={{ color: '#34d399' }}>✓</span>}</p><p className="text-xs" style={{ color: 'var(--muted)' }}>{doc.help}</p></div><label className="btn-ghost" style={{ cursor: 'pointer', padding: '8px 12px', whiteSpace: 'nowrap' }}>{uploading === doc.kind ? 'Uploading…' : uploads[doc.kind] ? 'Replace' : 'Upload'}<input className="file-input-a11y" type="file" accept="image/*,application/pdf" aria-label={`Upload ${doc.label}`} disabled={uploading !== null} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(doc.kind, file) }} /></label></div>)}</div>
              </section>
              <Check checked={informationCertified} onChange={setInformationCertified} label="I certify that the onboarding information and documents I provided are accurate." />
              <button type="button" className="btn w-full" disabled={busy || uploading !== null} onClick={submit} style={{ justifyContent: 'center', opacity: busy || uploading ? .6 : 1 }}>{busy ? 'Submitting…' : 'Submit secure onboarding'}</button>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <label className="flex gap-3 items-start rounded-xl p-3" style={{ border: '1px solid var(--line)' }}><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ width: 18, height: 18, marginTop: 2, accentColor: '#E0002A' }} /><span className="text-sm" style={{ lineHeight: 1.5 }}>{label}</span></label>
}
