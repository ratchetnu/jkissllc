'use client'

import { useMemo, useState } from 'react'
import { Check, X, Plus, Minus, Camera, HelpCircle, AlertTriangle, ChevronDown, RotateCcw } from 'lucide-react'
import {
  confidenceBucket, confidenceExplanation, CONFIDENCE_LABEL, CONFIDENCE_TONE,
  newDraftItem, IS_EVERYTHING_OPTIONS,
  type DraftItem, type IsEverythingAnswer, type FollowUpValue,
} from '../lib/ai/confirmation-ui'
import { INVENTORY_TAXONOMY, INVENTORY_CATEGORIES, type InventoryCategory } from '../lib/ai/inventory-taxonomy'
import type { FollowUpQuestion } from '../lib/ai/followup-questions'

const RED = '#E0002A'

// The enriched, customer-safe detected item shape from /api/quote/analyze.
export type DetectedItem = { id: string; label: string; quantity: number; category?: string; confidence?: number; photoUrl?: string }

export type AttestState = {
  representsEverything: boolean
  additionalMayChangePrice: boolean
  hazardousDisclosed: boolean
  accessDisclosed: boolean
  mayRequireOwnerReview: boolean
}
export const EMPTY_ATTEST: AttestState = {
  representsEverything: false, additionalMayChangePrice: false, hazardousDisclosed: false,
  accessDisclosed: false, mayRequireOwnerReview: false,
}

const card: React.CSSProperties = { border: '1px solid rgba(255,255,255,.10)', background: 'rgba(255,255,255,.02)', borderRadius: 16 }
const chip = (active: boolean): React.CSSProperties => ({
  minHeight: 44, padding: '10px 14px', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: 'pointer',
  border: `1px solid ${active ? RED : 'rgba(255,255,255,.14)'}`, background: active ? 'rgba(224,0,42,.12)' : 'rgba(255,255,255,.02)',
  color: active ? '#fff' : 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 8, transition: 'border-color .2s, background .2s, color .2s',
})
const stepBtn: React.CSSProperties = {
  width: 44, height: 44, minWidth: 44, borderRadius: 12, border: '1px solid rgba(255,255,255,.16)', background: 'rgba(255,255,255,.04)',
  color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
}

function SectionTitle({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <h3 className="font-black text-white" style={{ fontSize: 17, letterSpacing: '-0.01em' }}>{children}</h3>
      {sub && <p className="mt-1" style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>{sub}</p>}
    </div>
  )
}

export default function StepConfirm(props: {
  estimate: { items: DetectedItem[]; confidence: number; reviewReasons: string[] }
  followUps: FollowUpQuestion[]
  items: DraftItem[]; setItems: (updater: (prev: DraftItem[]) => DraftItem[]) => void
  answers: Record<string, FollowUpValue>; setAnswers: (updater: (prev: Record<string, FollowUpValue>) => Record<string, FollowUpValue>) => void
  isEverything: IsEverythingAnswer | ''; setIsEverything: (v: IsEverythingAnswer) => void
  attest: AttestState; setAttest: (v: AttestState) => void
  onAddMorePhotos: () => void
  onItemCorrected?: () => void
}) {
  const { items, setItems, answers, followUps } = props
  const [addOpen, setAddOpen] = useState(false)
  const [addCat, setAddCat] = useState<InventoryCategory>('furniture')
  const [addName, setAddName] = useState('')
  const [editId, setEditId] = useState('')
  const [catOpenId, setCatOpenId] = useState('')

  const active = items.filter(i => !i.removed)
  const removed = items.filter(i => i.removed)
  const itemCount = active.length

  const correct = () => props.onItemCorrected?.()
  const setQty = (id: string, d: number) => { setItems(prev => prev.map(i => i.id === id ? { ...i, quantity: Math.max(1, i.quantity + d) } : i)); correct() }
  const toggleRemove = (id: string) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, removed: !i.removed } : i)); correct()
  }
  const toggleUncertain = (id: string) => { setItems(prev => prev.map(i => i.id === id ? { ...i, uncertain: !i.uncertain } : i)); correct() }
  const rename = (id: string, name: string) => setItems(prev => prev.map(i => i.id === id ? { ...i, name } : i))
  const recat = (id: string, category: InventoryCategory) => { setItems(prev => prev.map(i => i.id === id ? { ...i, category, name: i.aiDetected ? i.name : (INVENTORY_TAXONOMY[category].label) } : i)); setCatOpenId(''); correct() }
  const confirmAll = () => setItems(prev => prev.map(i => i.removed ? i : { ...i, uncertain: false }))
  const addItem = () => {
    if (addOpen) {
      const id = `add-${items.length}-${addCat}`
      setItems(prev => [...prev, newDraftItem(addCat, id, addName.trim() || undefined)])
      setAddName(''); setAddOpen(false); correct()
    } else setAddOpen(true)
  }

  const explanation = useMemo(
    () => confidenceExplanation({ overall: props.estimate.confidence, itemCount, reviewReasons: props.estimate.reviewReasons }),
    [props.estimate.confidence, itemCount, props.estimate.reviewReasons],
  )

  // A calm, client-side "may need review" hint (server has the final say via the
  // Phase 1 photo-text engine). Neutral language only — never an accusation.
  const softReview = props.isEverything === 'unsure'
    || answers['hazardous'] === true || answers['hidden_items'] === true || answers['dense_debris'] === true
    || removed.some(r => r.aiDetected)

  const setAns = (q: FollowUpQuestion, value: FollowUpValue) => props.setAnswers(prev => ({ ...prev, [q.id]: value }))

  return (
    <div>
      {/* Confidence explanation — plain language, never a bare score */}
      <div className="mb-5 flex items-start gap-3 px-4 py-3.5" style={{ ...card, borderColor: 'rgba(224,0,42,.22)' }}>
        <span style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 999, background: 'rgba(224,0,42,.12)', color: RED, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <Camera size={17} />
        </span>
        <div style={{ minWidth: 0 }}>
          <p className="font-bold text-white" style={{ fontSize: 15 }}>We found these items in your photos.</p>
          <p className="mt-0.5" style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>{explanation}</p>
        </div>
      </div>

      {/* ── Detected + confirmed items ─────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <SectionTitle>Your items {itemCount > 0 && <span style={{ color: 'var(--muted)', fontWeight: 700 }}>· {itemCount}</span>}</SectionTitle>
        {active.some(i => i.aiDetected) && (
          <button type="button" onClick={confirmAll} style={{ ...chip(false), minHeight: 40 }}>
            <Check size={15} style={{ color: '#34d399' }} /> Confirm all
          </button>
        )}
      </div>

      <div className="grid gap-2.5">
        {active.map(it => {
          const bucket = it.aiConfidence != null ? confidenceBucket(it.aiConfidence) : null
          const tax = INVENTORY_TAXONOMY[it.category]
          return (
            <div key={it.id} className="px-3 py-3" style={card}>
              <div className="flex items-start gap-3">
                {it.sourcePhotoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.sourcePhotoUrl} alt="" aria-hidden style={{ width: 46, height: 46, borderRadius: 10, objectFit: 'cover', flexShrink: 0, border: '1px solid rgba(255,255,255,.12)' }} />
                ) : (
                  <span aria-hidden style={{ width: 46, height: 46, borderRadius: 10, flexShrink: 0, background: 'rgba(255,255,255,.05)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: RED }}>{tax.short.slice(0, 1)}</span>
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  {editId === it.id ? (
                    <input
                      autoFocus value={it.name} onChange={e => rename(it.id, e.target.value)} onBlur={() => setEditId('')}
                      onKeyDown={e => { if (e.key === 'Enter') setEditId('') }}
                      aria-label="Item name"
                      style={{ width: '100%', background: 'rgba(255,255,255,.04)', border: `1px solid ${RED}`, borderRadius: 8, color: '#fff', padding: '6px 9px', fontSize: 15, fontWeight: 700 }}
                    />
                  ) : (
                    <button type="button" onClick={() => setEditId(it.id)} className="text-left" style={{ background: 'none', border: 'none', padding: 0, cursor: 'text' }}>
                      <p className="font-bold text-white" style={{ fontSize: 15, lineHeight: 1.3 }}>{it.name}</p>
                    </button>
                  )}
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <button type="button" onClick={() => setCatOpenId(catOpenId === it.id ? '' : it.id)} aria-expanded={catOpenId === it.id} style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', borderRadius: 999, padding: '3px 9px', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                      {tax.short} <ChevronDown size={11} />
                    </button>
                    {bucket && (
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: CONFIDENCE_TONE[bucket], display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: CONFIDENCE_TONE[bucket] }} /> {CONFIDENCE_LABEL[bucket]}
                      </span>
                    )}
                    {it.uncertain && <span style={{ fontSize: 11.5, fontWeight: 700, color: '#fbbf24' }}>Marked unsure</span>}
                    {!it.aiDetected && <span style={{ fontSize: 11.5, fontWeight: 700, color: RED }}>Added by you</span>}
                  </div>

                  {catOpenId === it.id && (
                    <div className="flex flex-wrap gap-1.5 mt-2.5">
                      {INVENTORY_CATEGORIES.map(c => (
                        <button key={c} type="button" onClick={() => recat(it.id, c)} style={{ ...chip(it.category === c), minHeight: 36, padding: '6px 10px', fontSize: 12.5 }}>{INVENTORY_TAXONOMY[c].short}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between mt-3 gap-2">
                <div className="flex items-center gap-2" role="group" aria-label={`Quantity of ${it.name}`}>
                  <button type="button" onClick={() => setQty(it.id, -1)} aria-label="Decrease quantity" style={stepBtn} disabled={it.quantity <= 1}><Minus size={16} /></button>
                  <span className="tabular-nums font-black text-white" style={{ minWidth: 28, textAlign: 'center', fontSize: 16 }} aria-live="polite">{it.quantity}</span>
                  <button type="button" onClick={() => setQty(it.id, 1)} aria-label="Increase quantity" style={stepBtn}><Plus size={16} /></button>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => toggleUncertain(it.id)} aria-pressed={it.uncertain} style={{ ...chip(it.uncertain), minHeight: 40, padding: '8px 12px', fontSize: 13 }}>
                    <HelpCircle size={15} /> Not sure
                  </button>
                  <button type="button" onClick={() => toggleRemove(it.id)} aria-label={`Remove ${it.name}`} style={{ ...stepBtn, color: '#ffb3c0', borderColor: 'rgba(224,0,42,.3)' }}>
                    <X size={16} />
                  </button>
                </div>
              </div>
            </div>
          )
        })}

        {itemCount === 0 && (
          <div className="px-4 py-5 text-center" style={{ ...card, borderStyle: 'dashed' }}>
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>No items yet — add what needs to be removed below.</p>
          </div>
        )}

        {/* Removed items (with undo) */}
        {removed.map(it => (
          <div key={it.id} className="flex items-center justify-between px-3 py-2.5" style={{ ...card, opacity: 0.6 }}>
            <span className="text-white" style={{ fontSize: 14, textDecoration: 'line-through' }}>{it.name}</span>
            <button type="button" onClick={() => toggleRemove(it.id)} style={{ ...chip(false), minHeight: 38, padding: '7px 11px', fontSize: 13 }}><RotateCcw size={14} /> Undo</button>
          </div>
        ))}
      </div>

      {/* Add an item the AI missed */}
      <div className="mt-2.5">
        {addOpen && (
          <div className="px-3 py-3 mb-2.5" style={{ ...card, borderColor: 'rgba(224,0,42,.25)' }}>
            <p className="font-bold text-white mb-2" style={{ fontSize: 14 }}>Add an item</p>
            <div className="flex flex-wrap gap-1.5 mb-2.5">
              {INVENTORY_CATEGORIES.map(c => (
                <button key={c} type="button" onClick={() => setAddCat(c)} style={{ ...chip(addCat === c), minHeight: 38, padding: '7px 11px', fontSize: 12.5 }}>{INVENTORY_TAXONOMY[c].short}</button>
              ))}
            </div>
            <input value={addName} onChange={e => setAddName(e.target.value)} placeholder="Description (optional)" aria-label="Item description"
              style={{ width: '100%', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 10, color: '#fff', padding: '10px 12px', fontSize: 15, marginBottom: 10 }} />
            <div className="flex gap-2">
              <button type="button" onClick={addItem} className="btn" style={{ flex: 1, justifyContent: 'center', minHeight: 44 }}><Plus size={16} /> Add item</button>
              <button type="button" onClick={() => { setAddOpen(false); setAddName('') }} style={{ ...chip(false), justifyContent: 'center' }}>Cancel</button>
            </div>
          </div>
        )}
        {!addOpen && (
          <button type="button" onClick={() => setAddOpen(true)} className="w-full" style={{ ...chip(false), minHeight: 48, justifyContent: 'center', width: '100%' }}>
            <Plus size={16} /> Add an item we missed
          </button>
        )}
      </div>

      {/* ── Is this everything? ────────────────────────────────────────────── */}
      <div className="mt-7">
        <SectionTitle sub="This helps us bring the right truck and crew.">Is this everything included in the job?</SectionTitle>
        <div className="grid gap-2">
          {IS_EVERYTHING_OPTIONS.map(o => {
            const on = props.isEverything === o.value
            return (
              <button key={o.value} type="button" onClick={() => props.setIsEverything(o.value)} aria-pressed={on} className="text-left px-4 py-3"
                style={{ ...card, borderColor: on ? RED : 'rgba(255,255,255,.1)', background: on ? 'rgba(224,0,42,.08)' : 'rgba(255,255,255,.02)', minHeight: 44, cursor: 'pointer' }}>
                <div className="flex items-center gap-2.5">
                  <span aria-hidden style={{ width: 20, height: 20, borderRadius: 999, flexShrink: 0, border: `1px solid ${on ? RED : 'rgba(255,255,255,.25)'}`, background: on ? RED : 'transparent', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{on && <Check size={12} />}</span>
                  <div>
                    <p className="font-bold text-white" style={{ fontSize: 14.5 }}>{o.label}</p>
                    <p style={{ color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.4 }}>{o.hint}</p>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
        {(props.isEverything === 'more_items' || props.isEverything === 'another_area') && (
          <div className="flex gap-2 mt-2.5 flex-wrap">
            <button type="button" onClick={props.onAddMorePhotos} style={{ ...chip(false), minHeight: 44 }}><Camera size={15} /> Add more photos</button>
            <button type="button" onClick={() => setAddOpen(true)} style={{ ...chip(false), minHeight: 44 }}><Plus size={15} /> Add missing items</button>
          </div>
        )}
      </div>

      {/* ── Dynamic follow-up questions ────────────────────────────────────── */}
      {followUps.length > 0 && (
        <div className="mt-7">
          <SectionTitle sub="Just the details that affect your job — tap to answer.">A few quick questions</SectionTitle>
          <div className="grid gap-3">
            {followUps.map(q => (
              <div key={q.id} className="px-4 py-3" style={card}>
                <p className="font-semibold text-white mb-2.5" style={{ fontSize: 14, lineHeight: 1.4 }}>{q.prompt}</p>
                <FollowUp q={q} value={answers[q.id]} onChange={v => setAns(q, v)} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Soft conflict / review hint (neutral) ──────────────────────────── */}
      {softReview && (
        <div className="mt-5 flex items-start gap-3 px-4 py-3" style={{ ...card, borderColor: 'rgba(251,191,36,.3)', background: 'rgba(251,191,36,.06)' }}>
          <AlertTriangle size={18} style={{ color: '#fbbf24', flexShrink: 0, marginTop: 1 }} />
          <p style={{ color: '#fcd34d', fontSize: 13, lineHeight: 1.5 }}>We may need a quick review of a few details before your final price — that’s completely normal and helps us get it right.</p>
        </div>
      )}

      {/* ── Attestation ────────────────────────────────────────────────────── */}
      <div className="mt-7 px-4 py-4" style={{ ...card, borderColor: 'rgba(224,0,42,.22)' }}>
        <SectionTitle sub="A quick check before we finalize.">Before we finalize</SectionTitle>
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 14px', display: 'grid', gap: 8 }}>
          {[
            'These photos and this list reasonably show the job.',
            'Extra or hidden items may change the final price.',
            'Any hazardous or prohibited materials are disclosed.',
            'Access details (stairs, parking, gates) are disclosed.',
            'My estimate may need a quick owner review.',
          ].map((t, i) => (
            <li key={i} className="flex items-start gap-2" style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.45 }}>
              <Check size={14} style={{ color: '#34d399', flexShrink: 0, marginTop: 2 }} /> {t}
            </li>
          ))}
        </ul>
        <label className="flex items-start gap-3 cursor-pointer" style={{ minHeight: 44 }}>
          <input
            type="checkbox"
            checked={props.attest.representsEverything}
            onChange={e => props.setAttest(e.target.checked
              ? { representsEverything: true, additionalMayChangePrice: true, hazardousDisclosed: true, accessDisclosed: true, mayRequireOwnerReview: true }
              : EMPTY_ATTEST)}
            style={{ width: 22, height: 22, accentColor: RED, marginTop: 1, flexShrink: 0, cursor: 'pointer' }}
          />
          <span className="font-semibold text-white" style={{ fontSize: 14, lineHeight: 1.4 }}>I confirm the above and I’m ready to get my estimate.</span>
        </label>
      </div>
    </div>
  )
}

// One follow-up input, rendered by kind. Accessible + 44px targets.
function FollowUp({ q, value, onChange }: { q: FollowUpQuestion; value: FollowUpValue | undefined; onChange: (v: FollowUpValue) => void }) {
  if (q.kind === 'boolean') {
    return (
      <div className="flex gap-2">
        {[['Yes', true], ['No', false]].map(([t, v]) => (
          <button key={String(v)} type="button" onClick={() => onChange(v as boolean)} aria-pressed={value === v} style={{ ...chip(value === v), flex: 1, justifyContent: 'center' }}>{t as string}</button>
        ))}
      </div>
    )
  }
  if (q.kind === 'number') {
    const n = typeof value === 'number' ? value : 0
    return (
      <div className="flex items-center gap-2" role="group" aria-label={q.prompt}>
        <button type="button" onClick={() => onChange(Math.max(0, n - 1))} aria-label="Decrease" style={stepBtn} disabled={n <= 0}><Minus size={16} /></button>
        <span className="tabular-nums font-black text-white" style={{ minWidth: 28, textAlign: 'center', fontSize: 16 }} aria-live="polite">{n}</span>
        <button type="button" onClick={() => onChange(n + 1)} aria-label="Increase" style={stepBtn}><Plus size={16} /></button>
      </div>
    )
  }
  if (q.kind === 'multi') {
    const arr = Array.isArray(value) ? value : []
    return (
      <div className="flex flex-wrap gap-1.5">
        {(q.options ?? []).map(opt => {
          const on = arr.includes(opt)
          return <button key={opt} type="button" onClick={() => onChange(on ? arr.filter(x => x !== opt) : [...arr, opt])} aria-pressed={on} style={{ ...chip(on), minHeight: 40, padding: '8px 12px', fontSize: 13 }}>{opt}</button>
        })}
      </div>
    )
  }
  if (q.kind === 'single') {
    return (
      <div className="flex flex-wrap gap-1.5">
        {(q.options ?? []).map(opt => (
          <button key={opt} type="button" onClick={() => onChange(opt)} aria-pressed={value === opt} style={{ ...chip(value === opt), minHeight: 40, padding: '8px 12px', fontSize: 13 }}>{opt}</button>
        ))}
      </div>
    )
  }
  // text
  return (
    <input value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value)} placeholder="Type your answer" aria-label={q.prompt}
      style={{ width: '100%', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 10, color: '#fff', padding: '11px 13px', fontSize: 15 }} />
  )
}
