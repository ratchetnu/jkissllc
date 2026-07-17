'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Camera, Check, Loader2, X, ArrowRight } from 'lucide-react'
import { COMPANY } from '../../../lib/company'
import StepConfirm, { EMPTY_ATTEST, type AttestState, type DetectedItem } from '../../StepConfirm'
import {
  buildConfirmationPayload,
  type DraftItem, type IsEverythingAnswer, type FollowUpValue, type CustomerFinalState,
} from '../../../lib/ai/confirmation-ui'
import type { FollowUpQuestion } from '../../../lib/ai/followup-questions'

const RED = '#E0002A'
const MAX = 8

type ResumeData = {
  requestNumber: string
  reason: string
  message: string | null
  fields: string[]
  fieldLabels: string[]
  completed: boolean
  estate: boolean
  photoCount: number
  estimate: { items: DetectedItem[]; confidence: number; reviewReasons: string[] } | null
  followUps: FollowUpQuestion[]
  items: DraftItem[]
  final: CustomerFinalState
}

type Ph = { id: string; previewUrl: string; status: 'uploading' | 'done' | 'error'; url?: string; file?: File }

async function toDataUrl(file: File): Promise<string> {
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale)
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
    bmp.close?.()
    return c.toDataURL('image/jpeg', 0.7)
  } catch {
    return await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(new Error('read')); fr.readAsDataURL(file) })
  }
}

function Resume({ token }: { token: string }) {
  const [data, setData] = useState<ResumeData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [photos, setPhotos] = useState<Ph[]>([])
  const [items, setItems] = useState<DraftItem[]>([])
  const [answers, setAnswers] = useState<Record<string, FollowUpValue>>({})
  const [isEverything, setIsEverything] = useState<IsEverythingAnswer | ''>('')
  const [attest, setAttest] = useState<AttestState>(EMPTY_ATTEST)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<CustomerFinalState | null>(null)
  const idem = useRef('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await fetch(`/api/quote/resume/${encodeURIComponent(token)}`)
      if (!res.ok) { setError('This link is no longer active. Please contact us and we’ll help you finish.'); return }
      const j = (await res.json()) as ResumeData
      setData(j)
      setItems(j.items?.length ? j.items : [])
      if (j.completed) setResult(j.final)
    } catch { setError('Something went wrong loading your request.') }
    finally { setLoading(false) }
  }, [token])
  useEffect(() => { load() }, [load])

  const wantsPhotos = !!data && data.fields.some(f => f === 'more_photos' || f === 'wide_photo' || f === 'closeup_photo')
  const wantsConfirm = !!data && data.fields.some(f => ['confirm_inventory', 'item_quantity', 'access_details', 'heavy_item'].includes(f))
  const uploadedUrls = photos.filter(p => p.status === 'done' && p.url).map(p => p.url!)
  const anyUploading = photos.some(p => p.status === 'uploading')

  async function uploadOne(id: string, file: File) {
    setPhotos(ps => ps.map(p => p.id === id ? { ...p, status: 'uploading' } : p))
    try {
      const dataUrl = await toDataUrl(file)
      if (dataUrl.length > 8_000_000) { setPhotos(ps => ps.map(p => p.id === id ? { ...p, status: 'error' } : p)); return }
      const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl }) })
      const j = await res.json().catch(() => ({}))
      setPhotos(ps => ps.map(p => p.id === id ? { ...p, status: res.ok && j.url ? 'done' : 'error', url: j.url } : p))
    } catch { setPhotos(ps => ps.map(p => p.id === id ? { ...p, status: 'error' } : p)) }
  }
  async function addFiles(files: FileList | File[]) {
    const room = Math.max(0, MAX - photos.length)
    const chosen = Array.from(files).slice(0, room)
    for (const file of chosen) {
      const id = crypto.randomUUID()
      setPhotos(ps => [...ps, { id, previewUrl: URL.createObjectURL(file), status: 'uploading', file }])
      void uploadOne(id, file)
    }
  }
  function retryOne(id: string) {
    const it = photos.find(p => p.id === id)
    if (it?.file) void uploadOne(id, it.file)
  }
  const anyFailed = photos.some(p => p.status === 'error')

  async function submit() {
    if (submitting || !data) return
    if (anyUploading) { setError('Your photos are still uploading — give it a moment.'); return }
    setSubmitting(true); setError('')
    if (!idem.current) idem.current = crypto.randomUUID()
    let confirmation: unknown
    if (wantsConfirm) {
      const ans = data.followUps.map(q => ({ question: q, value: answers[q.id] })).filter((a): a is { question: FollowUpQuestion; value: FollowUpValue } => a.value !== undefined)
      confirmation = buildConfirmationPayload({
        items, answers: ans,
        isEverything: (isEverything || 'yes') as IsEverythingAnswer,
        everythingPictured: true,
        attestation: attest.representsEverything ? attest : { representsEverything: true, additionalMayChangePrice: true, hazardousDisclosed: true, accessDisclosed: true, mayRequireOwnerReview: true },
        idempotencyKey: idem.current,
      })
    }
    try {
      const res = await fetch(`/api/quote/resume/${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photos: uploadedUrls, confirmation }),
      })
      const j = await res.json()
      if (res.ok) setResult(j.final as CustomerFinalState)
      else setError(j.error ?? 'Could not submit. Please try again.')
    } catch { setError('Connection error — please try again.') }
    finally { setSubmitting(false) }
  }

  const canSubmit = (wantsPhotos && uploadedUrls.length > 0) || (wantsConfirm && !!isEverything) || (!wantsPhotos && !wantsConfirm)

  return (
    <main className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="fixed top-0 left-0 right-0 z-50" style={{ background: 'rgba(11,11,12,0.9)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-2xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-black" style={{ color: '#fff', letterSpacing: '-0.03em' }}>J Kiss <span style={{ color: RED }}>LLC</span></Link>
        </div>
      </header>

      <section className="relative z-10 pt-28 pb-24 px-5 sm:px-6">
        <div className="max-w-2xl mx-auto">
          {loading ? (
            <p style={{ color: 'var(--muted)' }}>Loading your request…</p>
          ) : error && !data ? (
            <div className="glass-card p-7 text-center" style={{ borderRadius: 20 }}>
              <p style={{ color: '#ffb3c0' }}>{error}</p>
              <p className="text-sm mt-3" style={{ color: 'var(--muted)' }}>Email us at <a href={`mailto:${COMPANY.email}`} className="underline" style={{ color: '#fff' }}>{COMPANY.email}</a>.</p>
            </div>
          ) : result ? (
            <div className="glass-card p-7 sm:p-9 text-center" style={{ borderRadius: 24, border: '1px solid rgba(224,0,42,.25)' }}>
              <span style={{ display: 'inline-flex', width: 60, height: 60, borderRadius: 999, background: 'rgba(224,0,42,.12)', color: RED, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}><Check size={30} /></span>
              <h1 className="text-2xl font-black text-white" style={{ fontFamily: 'var(--font-display)' }}>{result.headline}</h1>
              {result.stage === 'quote_ready' && result.lowUsd != null && (
                <p className="text-3xl font-black tabular-nums mt-3" style={{ color: RED, fontFamily: 'var(--font-display)' }}>${result.lowUsd.toLocaleString()}{result.highUsd != null && result.highUsd !== result.lowUsd ? `–$${result.highUsd.toLocaleString()}` : ''}</p>
              )}
              <p className="text-base mt-3" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>{result.message}</p>
            </div>
          ) : data ? (
            <>
              <div className="mb-6">
                <p className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: RED }}>Request {data.requestNumber}</p>
                <h1 className="text-3xl font-black text-white mb-3" style={{ letterSpacing: '-0.03em', fontFamily: 'var(--font-display)' }}>Just one more thing</h1>
                <p className="text-base" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>{data.message || data.reason}</p>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {data.fieldLabels.map((l, i) => <span key={i} className="text-xs font-bold" style={{ color: '#fff', background: 'rgba(224,0,42,.12)', border: '1px solid rgba(224,0,42,.3)', borderRadius: 999, padding: '4px 11px' }}>{l}</span>)}
                </div>
              </div>

              {wantsPhotos && (
                <div className="glass-card p-5 mb-5" style={{ borderRadius: 18 }}>
                  <p className="font-bold text-white mb-3">Add the photos</p>
                  <label className="file-label flex flex-col items-center justify-center text-center rounded-2xl" style={{ padding: '30px 20px', cursor: 'pointer', border: '1.5px dashed rgba(255,255,255,.2)' }}>
                    <Camera size={24} style={{ color: RED, marginBottom: 8 }} />
                    <span className="font-bold text-white text-sm">Tap to add photos</span>
                    <input type="file" aria-label="Add photos of your items" accept="image/*" multiple className="file-input-a11y" onChange={e => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) addFiles(f) }} />
                  </label>
                  {photos.length > 0 && (
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mt-3">
                      {photos.map(p => (
                        <div key={p.id} style={{ position: 'relative', aspectRatio: '1/1', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--line)' }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={p.url || p.previewUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: p.status === 'done' ? 1 : 0.5 }} />
                          {p.status === 'uploading' && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.35)' }}><Loader2 size={18} className="animate-spin" style={{ color: '#fff' }} /></div>}
                          {p.status === 'done' && <span style={{ position: 'absolute', bottom: 4, left: 4, width: 20, height: 20, borderRadius: 999, background: '#16a34a', color: '#fff', display: 'grid', placeItems: 'center' }}><Check size={12} /></span>}
                          {p.status === 'error' && <button type="button" onClick={() => retryOne(p.id)} aria-label="Retry upload" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, background: 'rgba(224,0,42,.4)', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}><Loader2 size={15} /> Retry</button>}
                          <button type="button" onClick={() => setPhotos(ps => ps.filter(x => x.id !== p.id))} aria-label="Remove" style={{ position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 999, border: 'none', background: 'rgba(0,0,0,.7)', color: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={12} /></button>
                        </div>
                      ))}
                    </div>
                  )}
                  {anyFailed && <p style={{ color: '#ffb3c0', fontSize: 12.5, marginTop: 8 }}>Some photos didn’t upload — tap a red tile to retry, or remove and choose another.</p>}
                </div>
              )}

              {wantsConfirm && data.estimate && (
                <div className="glass-card p-5 mb-5" style={{ borderRadius: 18 }}>
                  <StepConfirm
                    estimate={data.estimate}
                    followUps={data.followUps}
                    items={items} setItems={setItems}
                    answers={answers} setAnswers={setAnswers}
                    isEverything={isEverything} setIsEverything={setIsEverything}
                    attest={attest} setAttest={setAttest}
                    estate={data.estate}
                    onAddMorePhotos={() => { /* photos section is already on this page */ }}
                  />
                </div>
              )}

              {error && <p role="alert" className="mb-4 text-sm rounded-xl px-4 py-3" style={{ color: '#ffb3c0', background: 'rgba(224,0,42,.1)', border: '1px solid rgba(224,0,42,.35)' }}>{error}</p>}

              <button type="button" onClick={submit} disabled={submitting || anyUploading || !canSubmit} className="btn w-full" style={{ justifyContent: 'center', minHeight: 52, opacity: submitting || anyUploading || !canSubmit ? 0.6 : 1 }}>
                {submitting ? <><Loader2 size={18} className="animate-spin" /> Sending…</> : <>Send to J Kiss <ArrowRight size={16} /></>}
              </button>
              <p className="text-xs text-center mt-3" style={{ color: 'rgba(255,255,255,.4)' }}>Your original request and photos are saved — you’re just adding to them.</p>
            </>
          ) : null}
        </div>
      </section>
    </main>
  )
}

export default function ResumePage() {
  const params = useParams()
  return <Resume token={String(params?.token ?? '')} />
}
