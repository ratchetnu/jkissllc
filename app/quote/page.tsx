'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { filterServicesByPack } from '../lib/pack-services'
import { COMPANY, CREDENTIALS_DOT } from '../lib/company';
import Link from 'next/link'
import {
  Trash2, Truck, Refrigerator, Sofa, Boxes, Trees, HardHat, Building2, KeyRound, HelpCircle,
  Zap, DoorOpen, PlugZap, Wrench, Users, Recycle, CalendarClock, ShieldCheck,
  Camera, Check, ArrowLeft, ArrowRight, X, MapPin, Loader2, Star, Lightbulb, ChevronDown, Clock,
  type LucideIcon,
} from 'lucide-react'
import StepConfirm, { EMPTY_ATTEST, type AttestState, type DetectedItem } from './StepConfirm'
import {
  seedDraftItems, buildConfirmationPayload,
  type DraftItem, type IsEverythingAnswer, type FollowUpValue, type CustomerFinalState,
} from '../lib/ai/confirmation-ui'
import type { FollowUpQuestion } from '../lib/ai/followup-questions'

// ─────────────────────────────────────────────────────────────────────────────
// A guided, concierge-style quote experience for the company. Same premium
// multi-step FLOW as our best work — rendered entirely in the J Kiss brand
// (red #E0002A on near-black, Space Grotesk display). All existing business
// logic is preserved: the primary CTA files a lead via /api/quote, and eligible
// jobs can optionally lock a date via /api/book + Stripe.
// ─────────────────────────────────────────────────────────────────────────────

const RED = '#E0002A'
const WINDOWS = ['8am–10am', '10am–12pm', '12pm–2pm', '2pm–4pm', '4pm–6pm']
const MAX_PHOTOS = 8

// A single selected photo, tracked from selection → processing → upload →
// done/error. The tile appears the instant the file is picked (previewUrl), so
// the customer sees their photos immediately — downscale + upload happen after.
type PhotoItem = {
  id: string
  name: string
  file: File                      // kept so processing/upload can retry
  previewUrl: string              // instant local preview (object URL)
  status: 'processing' | 'uploading' | 'done' | 'error'
  url?: string                    // Vercel Blob URL once uploaded
}

// Customer-safe AI estimate returned by /api/quote/analyze (no cost basis/margin).
type QuoteEstimate = {
  analysisId: string
  decision: 'instant_quote' | 'estimate_range' | 'manual_review'
  recommendedUsd: number
  lowUsd: number
  highUsd: number
  photoCount: number
  confidence: number
  items: DetectedItem[]
  estimatedTruckLoads: number
  questions: string[]
  reviewReasons: string[]
  note: string
}

// Step keys — dynamic so the guided-confirmation step slots in for job-based
// (junk-family) services WITHOUT hardcoded index math anywhere.
type StepKey = 'service' | 'job' | 'photos' | 'confirm' | 'upgrades' | 'contact' | 'review'
const STEP_LABEL_BY_KEY: Record<StepKey, string> = {
  service: 'Service', job: 'The job', photos: 'Photos', confirm: 'Confirm',
  upgrades: 'Upgrades', contact: 'Your info', review: 'Review',
}

type Svc = {
  id: string
  label: string
  icon: LucideIcon
  desc: string
  turnaround: string
  starting?: string
  quoteType: string       // → /api/quote serviceType (drives pricing)
  bookType: string        // → /api/book service (booking enum)
  jobBased: boolean       // single-site, disposal-priced
  debris?: string
  estate?: boolean        // Estate/property-cleanout family — shows estate intake
}

// Card catalog. Each card carries BOTH vocabularies so pricing (quoteType) and
// booking (bookType) stay correct while the customer only ever sees one choice.
const SERVICES: Svc[] = [
  { id: 'junk-removal', label: 'Junk Removal', icon: Trash2, desc: 'A few items up to a full truck — hauled away and gone.', turnaround: 'Same / next-day', starting: 'from $99', quoteType: 'junk-removal', bookType: 'junk-removal', jobBased: true, debris: 'general' },
  { id: 'moving', label: 'Moving Services', icon: Truck, desc: 'Homes and offices — loaded, moved, and set in place.', turnaround: '2–4 days', quoteType: 'moving', bookType: 'moving', jobBased: false },
  { id: 'appliance-delivery', label: 'Appliance Delivery', icon: Refrigerator, desc: 'Fridges, washers, ranges — delivered and positioned.', turnaround: 'Next-day', quoteType: 'appliance-delivery', bookType: 'appliance-delivery', jobBased: false },
  { id: 'furniture-delivery', label: 'Furniture Delivery', icon: Sofa, desc: 'White-glove furniture delivery to the room of your choice.', turnaround: 'Next-day', quoteType: 'white-glove', bookType: 'moving', jobBased: false },
  { id: 'freight', label: 'Freight Delivery', icon: Boxes, desc: 'Palletized freight, dock-to-dock across the metroplex.', turnaround: '2–4 days', quoteType: 'dock-to-dock', bookType: 'freight', jobBased: false },
  { id: 'brush-debris', label: 'Brush & Debris Removal', icon: Trees, desc: 'Yard waste, branches, and storm debris cleared out.', turnaround: 'Same / next-day', starting: 'from $99', quoteType: 'junk-removal', bookType: 'junk-removal', jobBased: true, debris: 'yard-waste' },
  { id: 'construction-hauling', label: 'Construction Material Hauling', icon: HardHat, desc: 'Building materials delivered — or jobsite debris hauled off.', turnaround: '1–3 days', quoteType: 'last-mile-curbside', bookType: 'freight', jobBased: false },
  { id: 'commercial-delivery', label: 'Commercial Delivery', icon: Building2, desc: 'Retail replenishment and B2B box-truck runs.', turnaround: 'Scheduled', quoteType: 'dock-to-dock', bookType: 'freight', jobBased: false },
  { id: 'estate-cleanout', label: 'Estate & Property Cleanout', icon: KeyRound, desc: 'Whole homes, apartments, garages, and storage — sorted, hauled, and cleaned.', turnaround: '1–3 days', quoteType: 'eviction', bookType: 'estate-cleanout', jobBased: true, debris: 'eviction-cleanout', estate: true },
  { id: 'eviction', label: 'Eviction / Foreclosure Cleanout', icon: Building2, desc: 'Turnovers, evictions, and foreclosures cleared, start to finish.', turnaround: '1–2 days', quoteType: 'eviction', bookType: 'eviction', jobBased: true, debris: 'eviction-cleanout', estate: true },
  { id: 'other', label: 'Something Else', icon: HelpCircle, desc: "Not sure which fits? Tell us the job and we'll advise.", turnaround: "We'll advise", quoteType: 'other', bookType: 'other', jobBased: false },
]

// Estate/cleanout subtypes (customer picks one when an estate service is chosen).
const CLEANOUT_SUBTYPES: { id: string; label: string }[] = [
  { id: 'estate', label: 'Estate Cleanout' }, { id: 'whole_home', label: 'Whole-Home' }, { id: 'apartment', label: 'Apartment' },
  { id: 'garage', label: 'Garage' }, { id: 'storage', label: 'Storage Unit' }, { id: 'hoarding', label: 'Hoarding Cleanup' },
  { id: 'turnover', label: 'Property Turnover' }, { id: 'eviction', label: 'Eviction' }, { id: 'foreclosure', label: 'Foreclosure' },
]
const ESTATE_RELATIONSHIPS: { id: string; label: string }[] = [
  { id: 'owner', label: 'Owner' }, { id: 'family', label: 'Family' }, { id: 'executor', label: 'Executor' },
  { id: 'property_manager', label: 'Property Mgr' }, { id: 'realtor', label: 'Realtor' }, { id: 'attorney', label: 'Attorney' }, { id: 'tenant', label: 'Tenant' },
]

// Shared load-size scale. `pallets` feeds distance pricing for delivery services;
// `id` feeds the disposal engine + scheduling units for job-based services.
const SIZES = [
  { id: 'few-items', label: 'A few items', hint: '1–3 pieces', pallets: 1 },
  { id: 'quarter', label: 'Quarter load', hint: 'A small room', pallets: 2 },
  { id: 'half', label: 'Half load', hint: 'A room or two', pallets: 3 },
  { id: 'three-quarter', label: 'Three-quarter', hint: 'Most of a home', pallets: 4 },
  { id: 'full', label: 'Full truck', hint: 'A whole home or office', pallets: 6 },
  { id: 'multiple', label: 'Multiple loads', hint: 'More than one truck', pallets: 10 },
]

// Optional upgrades. Prices MUST match PRICING.addOns in /api/quote so the range
// the customer sees equals what the server computes.
const UPGRADES: { id: string; label: string; price: number; icon: LucideIcon; why: string }[] = [
  { id: 'same-day', label: 'Same-Day Service', price: 120, icon: Zap, why: 'Jump the queue — we come today when a slot is open.' },
  { id: 'inside-placement', label: 'Inside Placement', price: 60, icon: DoorOpen, why: 'Carried inside to the exact room, not left at the curb.' },
  { id: 'appliance-hookup', label: 'Appliance Hookup', price: 45, icon: PlugZap, why: 'Connect and test washers, dryers, ranges, and fridges.' },
  { id: 'assembly', label: 'Furniture Assembly', price: 55, icon: Wrench, why: 'Beds, tables, and shelving assembled and ready to use.' },
  { id: 'extra-labor', label: 'Extra Labor', price: 65, icon: Users, why: 'An extra mover for heavy, tight, or high-volume jobs.' },
  { id: 'disposal', label: 'Dump Run / Haul-Away', price: 50, icon: Recycle, why: 'We take the old stuff away and dispose of it for you.' },
  { id: 'priority', label: 'Priority Scheduling', price: 40, icon: CalendarClock, why: 'First arrival window and a tighter time promise.' },
  { id: 'packing', label: 'Protective Wrapping', price: 75, icon: ShieldCheck, why: 'Blankets and shrink-wrap so nothing gets scratched.' },
]

// ISO yyyy-mm-dd → "Fri, Jul 4, 2026" (parsed LOCAL so it never slips a day).
function fmtDateLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

function parseZip(s: string): string {
  const m = s.match(/\b(\d{5})\b/)
  return m ? m[1] : ''
}

// Downscale an image to a small JPEG data URL before upload. Falls back to the
// original (e.g. a HEIC the browser can't decode to canvas).
async function downscaleToDataUrl(file: File, maxDim = 1280, quality = 0.7): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no ctx')
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return await new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(new Error('read failed'))
      fr.readAsDataURL(file)
    })
  }
}

// ── Small shared styles (J Kiss brand) ──────────────────────────────────────
const inp: React.CSSProperties = { width: '100%', padding: '13px 15px', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.10)', borderRadius: 12, color: '#f3f4f6', fontSize: 16, outline: 'none' }
const lbl: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }
export default function QuotePage() {
  // Flow state
  const [step, setStep] = useState(0)
  const [svcId, setSvcId] = useState('')
  const svc = SERVICES.find(s => s.id === svcId)
  const singleSite = !!svc && (svc.jobBased || svc.id === 'other')

  // The guided confirmation step appears only for job-based (junk-family) services.
  const stepKeys = useMemo<StepKey[]>(
    () => (svc?.jobBased
      ? ['service', 'job', 'photos', 'confirm', 'upgrades', 'contact', 'review']
      : ['service', 'job', 'photos', 'upgrades', 'contact', 'review']),
    [svc?.jobBased],
  )
  const stepKey: StepKey = stepKeys[step] ?? 'service'
  const lastStep = stepKeys.length - 1
  const stepLabels = stepKeys.map(k => STEP_LABEL_BY_KEY[k])

  // Industry-pack intake config (the universal-engine seam). The service grid comes
  // from the active pack when it defines matching service templates; junk removal
  // (the reference/default pack) and any load/parse failure fall back to the full
  // local catalog — i.e. today's experience is preserved unless a pack replaces it.
  const [intakeCfg, setIntakeCfg] = useState<{ packId: string; serviceTemplates: { id: string }[]; intakeQuestions: string[] } | null>(null)
  useEffect(() => {
    let alive = true
    fetch('/api/intake/config', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && d?.config) setIntakeCfg(d.config) })
      .catch(() => { /* fall back to the local catalog */ })
    return () => { alive = false }
  }, [])
  const displayServices = useMemo(
    () => filterServicesByPack(SERVICES, intakeCfg?.serviceTemplates.map(t => t.id) ?? []),
    [intakeCfg],
  )

  // Step 1 — the job
  const [pickupText, setPickupText] = useState('')
  const [deliveryText, setDeliveryText] = useState('')
  const [sizeId, setSizeId] = useState('')
  const [heavy, setHeavy] = useState<boolean | null>(null)
  const [stairs, setStairs] = useState<boolean | null>(null)
  const [elevator, setElevator] = useState<boolean | null>(null)
  const [prefDate, setPrefDate] = useState('')

  // Step 2 — photos. Each selected image is tracked individually so the customer
  // can SEE upload progress, success, and failure (and retry) — not a single
  // opaque spinner. Only `done` items are attached to the request on submit.
  const [photos, setPhotos] = useState<PhotoItem[]>([])
  const [dragOver, setDragOver] = useState(false)
  const uploadedUrls = photos.filter(p => p.status === 'done' && p.url).map(p => p.url as string)
  const anyUploading = photos.some(p => p.status === 'uploading' || p.status === 'processing')

  // AI estimate (job-based services only). Produced when the customer leaves the
  // Photos step; the analysisId is sent on submit so the booking carries it.
  const [analyzing, setAnalyzing] = useState(false)
  const [estimate, setEstimate] = useState<QuoteEstimate | null>(null)
  const analysisIdRef = useRef('')

  // Guided confirmation (job-based services). The confirmation draft is lifted here
  // so it survives step navigation and is sent to the durable server-side workflow.
  const [followUps, setFollowUps] = useState<FollowUpQuestion[]>([])
  const [confItems, setConfItems] = useState<DraftItem[]>([])
  const [confAnswers, setConfAnswers] = useState<Record<string, FollowUpValue>>({})
  const [isEverything, setIsEverything] = useState<IsEverythingAnswer | ''>('')
  const [everythingPictured, setEverythingPictured] = useState<boolean | null>(null)
  const [attest, setAttest] = useState<AttestState>(EMPTY_ATTEST)
  const [estate, setEstate] = useState<{ subtype?: string; relationship?: string; occupancy?: string; deadlineType?: string; deadlineDate?: string }>({})
  const [finalState, setFinalState] = useState<CustomerFinalState | null>(null)
  const confIdemRef = useRef('')

  // Step 3 — upgrades
  const [upgrades, setUpgrades] = useState<string[]>([])

  // Step 4 — contact
  const [name, setName] = useState(''); const [company, setCompany] = useState('')
  const [phone, setPhone] = useState(''); const [email, setEmail] = useState('')
  const [contactMethod, setContactMethod] = useState('Text message')
  const [promo, setPromo] = useState('')

  // Estimate + reserve
  const [est, setEst] = useState<{ hasPrice: boolean; low?: number; high?: number; depositCents: number; confidence?: string; units: number } | null>(null)
  const [reserveOpen, setReserveOpen] = useState(false)
  const [avail, setAvail] = useState<{ dates: string[]; depositCents: number } | null>(null)
  const [bookDate, setBookDate] = useState(''); const [bookWin, setBookWin] = useState('')
  // Deposit payment method chosen at checkout + Zelle proof, and a stable idempotency
  // key so a double-click / retry can never create two bookings.
  const [bookMethod, setBookMethod] = useState<'stripe' | 'zelle'>('stripe')
  const [bookProof, setBookProof] = useState('')
  const [proofReading, setProofReading] = useState(false)
  const idemRef = useRef('')
  const quoteIdemRef = useRef('')   // stable key so a retried quote can't double-submit

  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  const [sent, setSent] = useState<{ estimate?: Estimate; request?: { number: string; token: string } } | null>(null)

  // Deep-link: /quote?service=junk-removal preselects a card and jumps to step 2.
  // Always land at the top — Next's client navigation keeps the homepage's scroll
  // position, so reset it on mount whether or not a service was deep-linked.
  useEffect(() => {
    window.scrollTo(0, 0)
    const q = new URLSearchParams(window.location.search).get('service')
    if (!q) return
    const match = SERVICES.find(s => s.id === q || s.quoteType === q || s.bookType === q)
    if (match) { setSvcId(match.id); setStep(1) }
  }, [])

  // Refresh recovery: if we land with a saved request token (URL ?r= or session),
  // rehydrate the submitted/result view and resume polling — the durable worker
  // never lost the request, so the customer never loses it either.
  useEffect(() => {
    let token = ''
    try { token = new URLSearchParams(window.location.search).get('r') || sessionStorage.getItem('jkq_r') || '' } catch { token = '' }
    if (!token || !/^[a-f0-9]{16,}$/i.test(token)) return
    let alive = true
    fetch(`/api/quote/status/${encodeURIComponent(token)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (!alive || !j?.ok) return
        setSent({ request: { number: j.requestNumber, token } })
        recordClientEvent('confirmation_resumed')
        if (j.final) { setFinalState(j.final as CustomerFinalState); if (j.final.stage === 'processing') void pollFinalState(token) }
      })
      .catch(() => { /* stale/expired token — fall through to a fresh wizard */ })
    return () => { alive = false }
  }, [])

  // Scroll to top on each step change, AFTER the new step renders. A scrollTo in
  // the click handler runs before the re-render and gets undone by the step swap.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [step])

  // Funnel: the customer reached the guided confirmation step.
  useEffect(() => {
    if (stepKey === 'confirm' && estimate) recordClientEvent('confirmation_started')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepKey])

  // Any change to the service, size, or the uploaded photo set invalidates a prior
  // AI estimate so it is always recomputed from the CURRENT inputs (fixes a stale
  // estimate lingering after Back → remove a photo or change the job).
  const uploadedKey = uploadedUrls.join('|')
  useEffect(() => {
    setEstimate(null); analysisIdRef.current = ''
    setFollowUps([]); setConfItems([]); setConfAnswers({}); setIsEverything(''); setAttest(EMPTY_ATTEST)
  }, [svcId, sizeId, uploadedKey])

  const size = SIZES.find(s => s.id === sizeId)
  const upgradeTotal = UPGRADES.filter(u => upgrades.includes(u.id)).reduce((s, u) => s + u.price, 0)
  const deposit = ((est?.depositCents ?? avail?.depositCents ?? 5000) / 100).toFixed(0)
  // When the photo analysis routes to manual review, our team hand-prices the job —
  // so don't show the customer the size-based auto-range (it reads as a firm high
  // quote next to "we'll review your photos"). Fall back to the "Priced by our team"
  // copy the sidebar already renders when showLow is null.
  const photoManualReview = estimate?.decision === 'manual_review'
  const showLow = !photoManualReview && est?.hasPrice && est.low != null ? est.low + upgradeTotal : null
  const showHigh = !photoManualReview && est?.hasPrice && est.high != null ? est.high + upgradeTotal : null

  function toggleUpgrade(id: string) {
    setUpgrades(u => u.includes(id) ? u.filter(x => x !== id) : [...u, id])
  }

  // Downscale + upload a single tracked photo, updating just that item's status.
  // The tile is already on screen (added by addPhotos) — this only advances it
  // through processing → uploading → done/error.
  async function processItem(item: PhotoItem) {
    setPhotos(ps => ps.map(p => p.id === item.id ? { ...p, status: 'processing' } : p))
    let dataUrl = ''
    try { dataUrl = await downscaleToDataUrl(item.file) }
    catch { setPhotos(ps => ps.map(p => p.id === item.id ? { ...p, status: 'error' } : p)); return }
    // Guard the doomed case (e.g. a HEIC the browser can't downscale falls back to
    // full size) so it fast-fails locally instead of looping against the 8MB server cap.
    if (dataUrl.length > 8_000_000) { setPhotos(ps => ps.map(p => p.id === item.id ? { ...p, status: 'error' } : p)); return }
    setPhotos(ps => ps.map(p => p.id === item.id ? { ...p, status: 'uploading' } : p))
    try {
      const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl }) })
      const j = await res.json().catch(() => ({}))
      if (res.ok && j.url) {
        setPhotos(ps => ps.map(p => p.id === item.id ? { ...p, status: 'done', url: j.url } : p))
      } else {
        setPhotos(ps => ps.map(p => p.id === item.id ? { ...p, status: 'error' } : p))
      }
    } catch {
      setPhotos(ps => ps.map(p => p.id === item.id ? { ...p, status: 'error' } : p))
    }
  }

  // Add tiles IMMEDIATELY on selection (with a local preview) so the customer sees
  // their photos at once; downscale + upload run in the background per tile. We
  // don't pre-filter by MIME type (some phones report HEIC as an empty type) —
  // the input already restricts to images and the server validates each upload.
  function invalidateEstimate() {
    setEstimate(null); analysisIdRef.current = ''
    setFollowUps([]); setConfItems([]); setConfAnswers({}); setIsEverything(''); setAttest(EMPTY_ATTEST)
  }

  function addPhotos(files: FileList | File[]) {
    setErr(''); invalidateEstimate()   // new photos → any prior estimate is stale
    const room = Math.max(0, MAX_PHOTOS - photos.length)
    if (room <= 0) { setErr(`You can attach up to ${MAX_PHOTOS} photos.`); return }
    const chosen = Array.from(files).slice(0, room)
    if (chosen.length === 0) return
    const items: PhotoItem[] = chosen.map(file => ({
      id: crypto.randomUUID(), name: file.name || 'photo', file,
      previewUrl: URL.createObjectURL(file), status: 'processing',
    }))
    setPhotos(ps => [...ps, ...items].slice(0, MAX_PHOTOS))
    items.forEach(it => void processItem(it))
  }
  function retryPhoto(id: string) {
    invalidateEstimate()
    const it = photos.find(p => p.id === id)
    if (it) void processItem(it)
  }
  function removePhoto(id: string) {
    invalidateEstimate()
    setPhotos(ps => {
      const it = ps.find(p => p.id === id)
      if (it) { try { URL.revokeObjectURL(it.previewUrl) } catch { /* noop */ } }
      return ps.filter(p => p.id !== id)
    })
  }

  // AI analysis of the uploaded photo set (job-based services). Fail-soft: on any
  // error the customer simply continues to a hand-priced quote — never blocked.
  async function runAnalysis(): Promise<void> {
    if (!svc || !svc.jobBased || uploadedUrls.length === 0) return
    setAnalyzing(true); setErr('')
    try {
      const res = await fetch('/api/quote/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photos: uploadedUrls, service: svc.bookType, debris: svc.debris }),
      })
      const j = await res.json().catch(() => ({}))
      if (res.ok && j.estimate) {
        setEstimate(j.estimate as QuoteEstimate)
        analysisIdRef.current = j.estimate.analysisId
        setFollowUps(Array.isArray(j.followUps) ? j.followUps : [])
        setConfItems(seedDraftItems((j.estimate.items ?? []) as DetectedItem[]))
      }
    } catch { /* non-blocking — proceed without an instant estimate */ }
    finally { setAnalyzing(false) }
  }

  // Fire-and-forget client funnel beacon (durable server-side counter). Never blocks.
  function recordClientEvent(event: string) {
    try {
      fetch('/api/quote/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event }), keepalive: true }).catch(() => {})
    } catch { /* best-effort */ }
  }

  // Instant, email-free price/deposit preview once service + size are known.
  async function loadEstimate() {
    if (!svc) return
    try {
      const res = await fetch('/api/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: svc.quoteType, loadSize: sizeId, debris: svc.debris }) })
      const j = await res.json()
      if (res.ok) setEst(j)
    } catch { /* non-blocking — the summary just omits a live range */ }
  }

  function validate(): string {
    if (stepKey === 'service' && !svcId) return 'Choose the service you need to continue.'
    if (stepKey === 'job') {
      if (!parseZip(pickupText)) return singleSite ? 'Add the job address or ZIP so we can price it.' : 'Add the pickup address or ZIP so we can price the route.'
      if (!singleSite && !parseZip(deliveryText)) return 'Add the delivery address or ZIP.'
      if (!sizeId) return 'Tell us roughly how much there is.'
    }
    if (stepKey === 'confirm' && estimate) {
      if (!isEverything) return 'Let us know if this is everything included in the job.'
      if (!attest.representsEverything) return 'Please confirm the short list before we finalize your estimate.'
    }
    if (stepKey === 'contact') {
      if (!name.trim()) return 'Please add your name.'
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Please add a valid email so we can send your quote.'
    }
    return ''
  }

  async function next() {
    const v = validate()
    if (v) { setErr(v); return }
    setErr('')
    if (stepKey === 'job') loadEstimate()          // fetch as we leave the job-details step
    // Leaving the Photos step: analyze the uploaded set for an instant AI estimate.
    if (stepKey === 'photos' && svc?.jobBased && uploadedUrls.length > 0 && !estimate && !analyzing) {
      await runAnalysis()
    }
    if (stepKey === 'confirm') recordClientEvent('confirmation_attested')
    setStep(s => Math.min(lastStep, s + 1))        // scroll handled by the [step] effect
  }
  function back() {
    setErr(''); setReserveOpen(false)
    setStep(s => Math.max(0, s - 1))
  }

  function buildNotes(): string {
    return [
      !singleSite && deliveryText ? `Delivery: ${deliveryText}` : '',
      size ? `Size: ${size.label}` : '',
      heavy ? 'Has large / heavy items' : '',
      stairs ? 'Stairs on site' : '',
      elevator ? 'Elevator available' : '',
      prefDate ? `Preferred date: ${fmtDateLabel(prefDate)}` : '',
      contactMethod ? `Best contact: ${contactMethod}` : '',
    ].filter(Boolean).join(' · ')
  }

  // Primary CTA — file the quote request via the existing engine, which now ALSO
  // persists it as an OpsPilot booking (so it appears in the admin with photos).
  async function submitLead() {
    if (!svc || busy) return
    if (anyUploading) { setErr('Your photos are still uploading — give it a moment.'); return }
    setBusy(true); setErr('')
    if (!quoteIdemRef.current) quoteIdemRef.current = crypto.randomUUID()
    const pickupZip = parseZip(pickupText)
    const deliveryZip = singleSite ? pickupZip : parseZip(deliveryText)

    // Build the structured customer confirmation (job-based services only). The
    // SERVER runs the durable second analysis — the browser only sends the answers.
    let confirmation: unknown
    if (svc.jobBased && estimate && confItems.length >= 0) {
      if (!confIdemRef.current) confIdemRef.current = crypto.randomUUID()
      const answers = followUps
        .map(q => ({ question: q, value: confAnswers[q.id] }))
        .filter((a): a is { question: FollowUpQuestion; value: FollowUpValue } => a.value !== undefined)
      confirmation = buildConfirmationPayload({
        items: confItems, answers,
        isEverything: (isEverything || 'unsure') as IsEverythingAnswer,
        everythingPictured: everythingPictured === true,
        attestation: attest,
        estate: svc.estate ? estate : undefined,
        idempotencyKey: confIdemRef.current,
      })
    }

    try {
      const res = await fetch('/api/quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceType: svc.quoteType, timing: 'standard',
          pickupZip, deliveryZip,
          pallets: String(size?.pallets ?? 1), weight: '',
          loadSize: sizeId, debris: svc.debris ?? 'general',
          name, email, phone, company,
          notes: buildNotes(), referral: '', promo,
          addOns: upgrades, photos: uploadedUrls,
          // Structured fields so the persisted booking has a real service type,
          // address, and preferred date — plus an idempotency key against retries.
          bookService: svc.bookType,
          pickupAddress: pickupText,
          dropoffAddress: singleSite ? '' : deliveryText,
          preferredDate: prefDate,
          contactMethod,
          idempotencyKey: quoteIdemRef.current,
          analysisId: analysisIdRef.current || undefined,
          confirmation,
        }),
      })
      const j = await res.json()
      if (res.ok) {
        if (j.final) setFinalState(j.final as CustomerFinalState)
        setSent({ estimate: j.estimate, request: j.request })
        // Refresh recovery: remember the token so a reload can rehydrate the result
        // (the durable worker keeps running server-side regardless).
        if (j.request?.token) {
          try { sessionStorage.setItem('jkq_r', j.request.token); window.history.replaceState(null, '', `/quote?r=${j.request.token}`) } catch { /* private mode */ }
        }
        window.scrollTo({ top: 0, behavior: 'smooth' })
        // Durable: if the server's inline final analysis is still processing, poll
        // the customer-safe status (the cron worker is the real source of truth).
        if (j.request?.token && (!j.final || j.final.stage === 'processing')) {
          void pollFinalState(j.request.token)
        }
      } else setErr(j.error ?? 'Could not submit your request. Please try again.')
    } catch { setErr(`Connection error — please try again or email ${COMPANY.email}.`) }
    setBusy(false)
  }

  // Poll the durable final state until it settles (or we give up and leave the
  // reassuring "received" state showing). Never throws, never blocks the UI.
  async function pollFinalState(token: string) {
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 2500))
      try {
        const res = await fetch(`/api/quote/status/${encodeURIComponent(token)}`)
        if (!res.ok) continue
        const j = await res.json()
        if (j.final) {
          setFinalState(j.final as CustomerFinalState)
          if (j.final.stage !== 'processing') return
        }
      } catch { /* keep the current state; the customer already sees "received" */ }
    }
    // Poll budget spent and still processing — the durable worker keeps going, but
    // we must NOT leave a perpetual "this only takes a moment" spinner. Flip to a
    // calm static state; the owner alert + email carry it from here.
    setFinalState(prev => (prev && prev.stage === 'processing')
      ? { stage: 'owner_review', headline: 'We’ve got your request', message: 'Your estimate is taking a little longer than usual — we’ll email it to you shortly. No need to wait here.' }
      : prev)
  }

  // Secondary CTA — lock a real open date + pay the deposit via /api/book.
  async function openReserve() {
    setReserveOpen(true); setErr(''); setAvail(null)
    idemRef.current = crypto.randomUUID()   // one key per reservation attempt
    try {
      const res = await fetch(`/api/availability?loadSize=${encodeURIComponent(sizeId)}`)
      const j = await res.json()
      setAvail({ dates: j.dates ?? [], depositCents: j.depositCents ?? 5000 })
    } catch { setErr('Could not load open dates — you can still request a quote above.') }
  }
  async function onBookProof(file: File) {
    setErr(''); setProofReading(true)
    try { setBookProof(await downscaleToDataUrl(file, 1600, 0.85)) }
    catch { setErr('Please choose a JPG, PNG, or HEIC screenshot.') }
    finally { setProofReading(false) }
  }
  async function submitBooking() {
    if (!svc || busy) return
    if (anyUploading) { setErr('Your photos are still uploading — give it a moment.'); return }
    if (bookMethod === 'zelle' && !bookProof) { setErr('Please upload your Zelle payment screenshot to reserve.'); return }
    setBusy(true); setErr('')
    if (!idemRef.current) idemRef.current = crypto.randomUUID()
    try {
      const res = await fetch('/api/book', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service: svc.bookType, loadSize: sizeId, debris: svc.debris,
          address: pickupText, notes: buildNotes(), photos: uploadedUrls,
          date: bookDate, window: bookWin, name, phone, email, promo,
          paymentMethod: bookMethod,
          proofImage: bookMethod === 'zelle' ? bookProof : undefined,
          zelleReference: undefined,
          idempotencyKey: idemRef.current,
        }),
      })
      const j = await res.json()
      if (!res.ok) { setErr(j.error ?? 'Could not complete your reservation.'); setBusy(false); return }
      if (j.url) { window.location.href = j.url; return }
      if (j.bookingUrl) { window.location.href = j.bookingUrl; return }
      setBusy(false)
    } catch { setErr('Connection error — please try again.'); setBusy(false) }
  }

  return (
    <main className="min-h-screen" style={{ background: 'var(--bg)' }}>
      {/* Restrained brand glow — J Kiss red, not an all-over wash */}
      <div aria-hidden className="pointer-events-none fixed inset-0" style={{ background: 'radial-gradient(900px 520px at 82% -6%, rgba(224,0,42,.14), transparent 60%), radial-gradient(760px 520px at 6% 108%, rgba(224,0,42,.06), transparent 60%)', zIndex: 0 }} />

      <header className="fixed top-0 left-0 right-0 z-50" style={{ background: 'rgba(11,11,12,0.9)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
            J Kiss <span style={{ color: RED }}>LLC</span>
          </Link>
          <Link href="/" className="text-sm font-semibold transition hover:text-white" style={{ color: 'var(--muted)' }}>← Back to Home</Link>
        </div>
      </header>

      <section className="relative z-10 pt-28 md:pt-32 pb-28 lg:pb-20 px-5 sm:px-6">
        <div className="max-w-6xl mx-auto">
          {sent ? (
            <SuccessView
              sent={sent} deposit={deposit} final={finalState}
              summary={{
                name,
                service: svc?.label ?? 'Service',
                address: singleSite ? pickupText : [pickupText, deliveryText].filter(Boolean).join(' → '),
                prefDate: prefDate ? fmtDateLabel(prefDate) : 'Flexible',
                photoCount: uploadedUrls.length,
                contactMethod,
              }}
              onReset={() => { try { sessionStorage.removeItem('jkq_r'); window.history.replaceState(null, '', '/quote') } catch { /* noop */ } setSent(null); setFinalState(null); quoteIdemRef.current = ''; confIdemRef.current = ''; setEstimate(null); analysisIdRef.current = ''; setFollowUps([]); setConfItems([]); setConfAnswers({}); setIsEverything(''); setEverythingPictured(null); setAttest(EMPTY_ATTEST); setEstate({}); setStep(0); setSvcId(''); setPickupText(''); setDeliveryText(''); setSizeId(''); setHeavy(null); setStairs(null); setElevator(null); setPrefDate(''); setPhotos([]); setUpgrades([]); setName(''); setCompany(''); setPhone(''); setEmail(''); setPromo(''); setEst(null); setContactMethod('Text message'); setErr(''); setAnalyzing(false); setReserveOpen(false); setAvail(null); setBookDate(''); setBookWin(''); setBookMethod('stripe'); setBookProof(''); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />
          ) : (
            <>
              {/* Intro */}
              <div className="max-w-2xl mb-8">
                <div className="label mb-5">Book a Job</div>
                <h1 className="text-4xl md:text-5xl font-black text-white mb-4" style={{ letterSpacing: '-0.045em', lineHeight: 1.05, fontFamily: 'var(--font-display)' }}>
                  Let&apos;s Plan Your <span style={{ color: RED }}>Move.</span>
                </h1>
                <p className="text-lg" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
                  Answer a few quick questions and our team will price your job by hand — most quotes come back within one business hour during operating hours.
                </p>
              </div>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
                {/* ── Wizard column ── */}
                <div className="glass-card wiz-fade" style={{ border: '1px solid rgba(224,0,42,.22)', borderRadius: 24, overflow: 'hidden' }}>
                  <ProgressBar step={step} setStep={setStep} labels={stepLabels} />

                  <div className="px-5 sm:px-8 py-7">
                    <div key={step} className="wiz-reveal">
                      {stepKey === 'service' && <StepService svcId={svcId} onPick={setSvcId} services={displayServices} />}
                      {stepKey === 'job' && (
                        <>
                          <StepJob
                            svc={svc!} singleSite={singleSite}
                            pickupText={pickupText} setPickupText={setPickupText}
                            deliveryText={deliveryText} setDeliveryText={setDeliveryText}
                            sizeId={sizeId} setSizeId={setSizeId}
                            heavy={heavy} setHeavy={setHeavy}
                            stairs={stairs} setStairs={setStairs}
                            elevator={elevator} setElevator={setElevator}
                            prefDate={prefDate} setPrefDate={setPrefDate}
                          />
                          {svc?.estate && <EstateIntakeBlock estate={estate} setEstate={setEstate} />}
                        </>
                      )}
                      {stepKey === 'photos' && (
                        <StepPhotos
                          photos={photos} dragOver={dragOver} setDragOver={setDragOver}
                          onAdd={addPhotos} onRemove={removePhoto} onRetry={retryPhoto}
                          jobBased={!!svc?.jobBased}
                          everythingPictured={everythingPictured} setEverythingPictured={setEverythingPictured}
                        />
                      )}
                      {stepKey === 'confirm' && (
                        estimate ? (
                          <StepConfirm
                            estimate={{ items: estimate.items, confidence: estimate.confidence, reviewReasons: estimate.reviewReasons }}
                            followUps={followUps}
                            items={confItems} setItems={setConfItems}
                            answers={confAnswers} setAnswers={setConfAnswers}
                            isEverything={isEverything} setIsEverything={setIsEverything}
                            attest={attest} setAttest={setAttest}
                            estate={!!svc?.estate}
                            onAddMorePhotos={() => setStep(stepKeys.indexOf('photos'))}
                            onItemCorrected={() => recordClientEvent('confirmation_item_corrected')}
                          />
                        ) : analyzing ? (
                          <AnalyzingView />
                        ) : (
                          <ConfirmUnavailable />
                        )
                      )}
                      {stepKey === 'upgrades' && <StepUpgrades selected={upgrades} onToggle={toggleUpgrade} />}
                      {stepKey === 'contact' && (
                        <StepContact
                          name={name} setName={setName} company={company} setCompany={setCompany}
                          phone={phone} setPhone={setPhone} email={email} setEmail={setEmail}
                          contactMethod={contactMethod} setContactMethod={setContactMethod}
                          promo={promo} setPromo={setPromo}
                        />
                      )}
                      {stepKey === 'review' && svc && (
                        <StepReview
                          svc={svc} singleSite={singleSite} pickupText={pickupText} deliveryText={deliveryText}
                          size={size} photoCount={uploadedUrls.length} upgrades={upgrades} prefDate={prefDate}
                          name={name} company={company} email={email} phone={phone} contactMethod={contactMethod}
                          showLow={showLow} showHigh={showHigh} deposit={deposit} est={est}
                          reserveOpen={reserveOpen} avail={avail} bookDate={bookDate} setBookDate={setBookDate}
                          bookWin={bookWin} setBookWin={setBookWin} onOpenReserve={openReserve} onReserve={submitBooking}
                          jobBased={svc.jobBased} busy={busy}
                          bookMethod={bookMethod} setBookMethod={setBookMethod}
                          bookProof={bookProof} onBookProof={onBookProof} proofReading={proofReading}
                          zelleAddress={COMPANY.zelle}
                          estimate={estimate}
                        />
                      )}
                    </div>

                    {err && <p role="alert" className="mt-5 text-sm rounded-xl px-4 py-3" style={{ color: '#ffb3c0', background: 'rgba(224,0,42,.10)', border: '1px solid rgba(224,0,42,.35)' }}>{err}</p>}

                    {/* Nav */}
                    <div className="flex items-center gap-3 mt-7">
                      {step > 0 && (
                        <button type="button" onClick={back} className="btn-ghost wiz-ease" style={{ padding: '13px 20px' }}>
                          <ArrowLeft size={16} /> Back
                        </button>
                      )}
                      {step < lastStep ? (
                        <button type="button" onClick={next} disabled={stepKey === 'photos' && (anyUploading || analyzing)} className="btn wiz-ease" style={{ flex: 1, justifyContent: 'center', padding: '15px 24px', fontSize: 15, opacity: stepKey === 'photos' && (anyUploading || analyzing) ? 0.6 : 1 }}>
                          {stepKey === 'photos' ? (
                            anyUploading ? <><Loader2 size={16} className="animate-spin" /> Uploading photos…</>
                            : analyzing ? <><Loader2 size={16} className="animate-spin" /> Analyzing your photos…</>
                            : photos.length === 0 ? <>Skip photos for now <ArrowRight size={16} /></>
                            : (svc?.jobBased && !estimate) ? <>Analyze {uploadedUrls.length} photo{uploadedUrls.length === 1 ? '' : 's'} <ArrowRight size={16} /></>
                            : <>Continue with {uploadedUrls.length} photo{uploadedUrls.length === 1 ? '' : 's'} <ArrowRight size={16} /></>
                          ) : stepKey === 'confirm' ? <>Get my estimate <ArrowRight size={16} /></>
                          : <>Continue <ArrowRight size={16} /></>}
                        </button>
                      ) : (
                        <button type="button" onClick={submitLead} disabled={busy || anyUploading} className="btn wiz-ease" style={{ flex: 1, justifyContent: 'center', padding: '16px 24px', fontSize: 16, opacity: busy || anyUploading ? 0.6 : 1 }}>
                          {busy ? <Loader2 size={18} className="animate-spin" /> : anyUploading ? <><Loader2 size={18} className="animate-spin" /> Uploading photos…</> : <>Request My Quote <ArrowRight size={16} /></>}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* ── Sticky desktop summary ── */}
                <aside className="hidden lg:block lg:sticky lg:top-28 self-start">
                  <SummaryCard
                    svc={svc} size={size} singleSite={singleSite} pickupText={pickupText} deliveryText={deliveryText}
                    photoCount={uploadedUrls.length} upgrades={upgrades} prefDate={prefDate}
                    showLow={showLow} showHigh={showHigh} deposit={deposit} est={est}
                  />
                </aside>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ── Mobile sticky summary bar ── */}
      {!sent && svc && (
        <div className="lg:hidden fixed inset-x-0 bottom-0 z-40 px-4 py-3" style={{ background: 'rgba(11,11,12,0.96)', backdropFilter: 'blur(14px)', borderTop: '1px solid var(--line)' }}>
          <div className="flex items-center justify-between gap-3">
            <div style={{ minWidth: 0 }}>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>Step {step + 1} of {stepKeys.length} · {stepLabels[step]}</p>
              <p className="text-sm font-bold text-white truncate">{svc.label}{size ? ` · ${size.label}` : ''}</p>
            </div>
            <div className="text-right" style={{ flexShrink: 0 }}>
              {showLow != null ? (
                <p className="text-base font-black" style={{ color: RED }}>${showLow.toLocaleString()}–${showHigh!.toLocaleString()}</p>
              ) : (
                <p className="text-xs" style={{ color: 'var(--muted)' }}>Quoted by our team</p>
              )}
              <p className="text-[11px]" style={{ color: 'rgba(255,255,255,.4)' }}>Deposit ${deposit}</p>
            </div>
          </div>
        </div>
      )}

      <footer className="relative z-10 py-10 px-6 text-center text-xs" style={{ borderTop: '1px solid var(--line)', color: 'rgba(255,255,255,.3)' }}>
        © {new Date().getFullYear()} {COMPANY.legalName} · {CREDENTIALS_DOT}
      </footer>
    </main>
  )
}

type Estimate = { low: number; high: number; miles: number; fuelCharge?: number; promoCode?: string; promoPct?: number; confidence?: string; jobBased?: boolean; pickupLabel?: string; deliveryLabel?: string }

// ── Progress indicator ───────────────────────────────────────────────────────
function ProgressBar({ step, setStep, labels }: { step: number; setStep: (n: number) => void; labels: string[] }) {
  return (
    <div className="px-5 sm:px-8 pt-6 pb-5" style={{ borderBottom: '1px solid var(--line)' }}>
      {/* Mobile: label + fill bar */}
      <div className="sm:hidden">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Step {step + 1} of {labels.length}</span>
          <span className="text-xs font-bold" style={{ color: RED }}>{labels[step]}</span>
        </div>
        <div style={{ height: 6, borderRadius: 999, background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${((step + 1) / labels.length) * 100}%`, borderRadius: 999, background: `linear-gradient(90deg, ${RED}, #ff6680)`, transition: 'width .5s cubic-bezier(.16,1,.3,1)' }} />
        </div>
      </div>
      {/* Desktop: clickable step chips */}
      <ol className="hidden sm:flex gap-2">
        {labels.map((label, i) => {
          const state = i === step ? 'current' : i < step ? 'done' : 'future'
          return (
            <li key={label} className="flex-1">
              <button
                type="button"
                disabled={i > step}
                onClick={() => i < step && setStep(i)}
                className="w-full text-left rounded-xl px-3 py-2.5 wiz-ease"
                style={{
                  cursor: i < step ? 'pointer' : 'default',
                  border: `1px solid ${state === 'current' ? RED : state === 'done' ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.06)'}`,
                  background: state === 'current' ? 'rgba(224,0,42,.10)' : 'transparent',
                }}
              >
                <div className="flex items-center gap-2">
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: 999, fontSize: 11, fontWeight: 800, border: `1px solid ${state === 'future' ? 'rgba(255,255,255,.2)' : RED}`, background: state === 'done' ? RED : 'transparent', color: state === 'done' ? '#fff' : state === 'current' ? RED : 'rgba(255,255,255,.35)' }}>
                    {state === 'done' ? <Check size={11} /> : i + 1}
                  </span>
                  <span className="text-xs font-semibold truncate" style={{ color: state === 'future' ? 'rgba(255,255,255,.3)' : state === 'current' ? '#fff' : 'var(--muted)' }}>{label}</span>
                </div>
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ── Step 1: Service ──────────────────────────────────────────────────────────
function StepService({ svcId, onPick, services }: { svcId: string; onPick: (id: string) => void; services: Svc[] }) {
  return (
    <>
      <StepHeading kicker="What can we handle for you?" title="What do you need moved?" sub="Pick the closest fit — you can add details next." />
      <div className="grid sm:grid-cols-2 gap-3">
        {services.map(s => {
          const active = svcId === s.id
          const Icon = s.icon
          return (
            <button
              key={s.id} type="button" onClick={() => onPick(s.id)}
              className="text-left rounded-2xl p-4 wiz-ease group"
              style={{
                border: `1px solid ${active ? RED : 'rgba(255,255,255,.08)'}`,
                background: active ? 'rgba(224,0,42,.07)' : 'rgba(255,255,255,.02)',
                boxShadow: active ? '0 0 0 1px rgba(224,0,42,.35), 0 18px 50px -22px rgba(224,0,42,.4)' : 'none',
              }}
            >
              <div className="flex items-start gap-3">
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 42, height: 42, borderRadius: 12, flexShrink: 0, background: active ? RED : 'rgba(255,255,255,.06)', color: active ? '#fff' : RED, transition: 'background .25s, color .25s' }}>
                  <Icon size={20} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <p className="font-bold text-white leading-tight">{s.label}</p>
                  <p className="text-sm mt-1" style={{ color: 'var(--muted)', lineHeight: 1.4 }}>{s.desc}</p>
                </div>
                <span style={{ marginLeft: 'auto', flexShrink: 0, width: 20, height: 20, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${active ? RED : 'rgba(255,255,255,.2)'}`, background: active ? RED : 'transparent', color: '#fff' }}>
                  {active && <Check size={12} />}
                </span>
              </div>
              <div className="flex items-center gap-3 mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,.06)' }}>
                <span className="text-xs font-semibold flex items-center gap-1" style={{ color: 'var(--muted)' }}><CalendarClock size={13} /> {s.turnaround}</span>
                {s.starting && <span className="text-xs font-bold ml-auto" style={{ color: RED }}>{s.starting}</span>}
              </div>
            </button>
          )
        })}
      </div>
    </>
  )
}

// ── Step 2: The job ──────────────────────────────────────────────────────────
function StepJob(props: {
  svc: Svc; singleSite: boolean
  pickupText: string; setPickupText: (v: string) => void
  deliveryText: string; setDeliveryText: (v: string) => void
  sizeId: string; setSizeId: (v: string) => void
  heavy: boolean | null; setHeavy: (v: boolean) => void
  stairs: boolean | null; setStairs: (v: boolean) => void
  elevator: boolean | null; setElevator: (v: boolean) => void
  prefDate: string; setPrefDate: (v: string) => void
}) {
  const { svc, singleSite } = props
  const today = new Date(); const min = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return (
    <>
      <StepHeading kicker={svc.label} title="Tell us about the job." sub="Just the essentials — we'll confirm the rest when we reach out." />

      <div className="grid gap-4">
        <div>
          <label htmlFor="q-pickup" style={lbl}>{singleSite ? 'Where is the job?' : 'Where are we picking up?'}</label>
          <div style={{ position: 'relative' }}>
            <MapPin size={16} style={{ position: 'absolute', left: 14, top: 15, color: 'var(--muted)' }} aria-hidden="true" />
            <input id="q-pickup" aria-required="true" value={props.pickupText} onChange={e => props.setPickupText(e.target.value)} placeholder="Address or ZIP — e.g. 123 Main St, Dallas 75201" style={{ ...inp, paddingLeft: 40 }} />
          </div>
        </div>
        {!singleSite && (
          <div>
            <label htmlFor="q-delivery" style={lbl}>Where are we delivering?</label>
            <div style={{ position: 'relative' }}>
              <MapPin size={16} style={{ position: 'absolute', left: 14, top: 15, color: 'var(--muted)' }} aria-hidden="true" />
              <input id="q-delivery" aria-required="true" value={props.deliveryText} onChange={e => props.setDeliveryText(e.target.value)} placeholder="Address or ZIP — e.g. 456 Oak Ave, Fort Worth 76102" style={{ ...inp, paddingLeft: 40 }} />
            </div>
          </div>
        )}

        <div role="group" aria-labelledby="q-size-label">
          <label id="q-size-label" style={lbl}>How much are we moving?</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {SIZES.map(s => {
              const active = props.sizeId === s.id
              return (
                <button key={s.id} type="button" onClick={() => props.setSizeId(s.id)} aria-pressed={active} className="text-left rounded-xl px-3 py-2.5 wiz-ease"
                  style={{ border: `1px solid ${active ? RED : 'rgba(255,255,255,.08)'}`, background: active ? 'rgba(224,0,42,.07)' : 'rgba(255,255,255,.02)' }}>
                  <p className="text-sm font-bold text-white leading-tight">{s.label}</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{s.hint}</p>
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid sm:grid-cols-3 gap-3">
          <YesNo id="q-heavy" label="Large or heavy items?" value={props.heavy} onChange={props.setHeavy} />
          <YesNo id="q-stairs" label="Any stairs?" value={props.stairs} onChange={props.setStairs} />
          <YesNo id="q-elevator" label="Elevator access?" value={props.elevator} onChange={props.setElevator} />
        </div>

        <div>
          <label htmlFor="q-prefdate" style={lbl}>Preferred date <span style={{ textTransform: 'none', fontWeight: 400 }}>(optional)</span></label>
          <input id="q-prefdate" type="date" min={min} value={props.prefDate} onChange={e => props.setPrefDate(e.target.value)} style={{ ...inp, colorScheme: 'dark', cursor: 'pointer' }} />
        </div>
      </div>
    </>
  )
}

// Estate/cleanout intake — the service-specific structured detail. Shown only for
// the Estate Cleanout family. Chip selectors keep typing to a minimum (premium feel).
type EstateState = { subtype?: string; relationship?: string; occupancy?: string; deadlineType?: string; deadlineDate?: string }
function EstateChips({ groupId, label, options, active, onPick }: { groupId: string; label: string; options: { id: string; label: string }[]; active?: string; onPick: (id: string) => void }) {
  const labelId = `${groupId}-label`
  return (
    <div role="group" aria-labelledby={labelId}>
      <label id={labelId} style={lbl}>{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {options.map(o => {
          const on = active === o.id
          return <button key={o.id} type="button" onClick={() => onPick(o.id)} aria-pressed={on} className="rounded-xl wiz-ease"
            style={{ minHeight: 40, padding: '8px 12px', fontSize: 13, fontWeight: 700, border: `1px solid ${on ? RED : 'rgba(255,255,255,.12)'}`, background: on ? 'rgba(224,0,42,.1)' : 'rgba(255,255,255,.02)', color: on ? '#fff' : 'var(--muted)', cursor: 'pointer' }}>{o.label}</button>
        })}
      </div>
    </div>
  )
}
function EstateIntakeBlock({ estate, setEstate }: { estate: EstateState; setEstate: (u: EstateState) => void }) {
  const set = (k: keyof EstateState, v: string) => setEstate({ ...estate, [k]: estate[k] === v ? undefined : v })
  return (
    <div className="grid gap-4 mt-5 pt-5" style={{ borderTop: '1px solid var(--line)' }}>
      <p className="text-xs font-bold uppercase tracking-widest" style={{ color: RED }}>Estate & cleanout details</p>
      <EstateChips groupId="q-estate-subtype" label="What kind of cleanout?" options={CLEANOUT_SUBTYPES} active={estate.subtype} onPick={v => set('subtype', v)} />
      <EstateChips groupId="q-estate-relationship" label="Your relationship to the property" options={ESTATE_RELATIONSHIPS} active={estate.relationship} onPick={v => set('relationship', v)} />
      <EstateChips groupId="q-estate-occupancy" label="Is the property occupied?" options={[{ id: 'vacant', label: 'Vacant' }, { id: 'partial', label: 'Partially' }, { id: 'occupied', label: 'Occupied' }]} active={estate.occupancy} onPick={v => set('occupancy', v)} />
      <div>
        <label id="q-estate-deadline-label" style={lbl}>Is there a deadline? <span style={{ textTransform: 'none', fontWeight: 400 }}>(optional)</span></label>
        <div role="group" aria-labelledby="q-estate-deadline-label" className="flex flex-wrap gap-1.5 mb-2">
          {[{ id: 'none', label: 'No deadline' }, { id: 'closing', label: 'Closing' }, { id: 'listing', label: 'Listing' }, { id: 'probate', label: 'Probate' }, { id: 'eviction', label: 'Eviction' }, { id: 'turnover', label: 'Turnover' }].map(o => {
            const active = estate.deadlineType === o.id
            return <button key={o.id} type="button" onClick={() => set('deadlineType', o.id)} aria-pressed={active} className="rounded-xl wiz-ease" style={{ minHeight: 40, padding: '8px 12px', fontSize: 13, fontWeight: 700, border: `1px solid ${active ? RED : 'rgba(255,255,255,.12)'}`, background: active ? 'rgba(224,0,42,.1)' : 'rgba(255,255,255,.02)', color: active ? '#fff' : 'var(--muted)', cursor: 'pointer' }}>{o.label}</button>
          })}
        </div>
        {estate.deadlineType && estate.deadlineType !== 'none' && (
          <input type="date" aria-label="Deadline date" value={estate.deadlineDate ?? ''} onChange={e => setEstate({ ...estate, deadlineDate: e.target.value })} style={{ ...inp, colorScheme: 'dark', cursor: 'pointer' }} />
        )}
      </div>
    </div>
  )
}

function YesNo({ id, label, value, onChange }: { id: string; label: string; value: boolean | null; onChange: (v: boolean) => void }) {
  const labelId = `${id}-label`
  return (
    <div role="group" aria-labelledby={labelId}>
      <label id={labelId} style={lbl}>{label}</label>
      <div className="flex gap-2">
        {[['Yes', true], ['No', false]].map(([t, v]) => {
          const active = value === v
          return (
            <button key={String(v)} type="button" onClick={() => onChange(v as boolean)} aria-pressed={active} className="flex-1 rounded-xl py-2.5 text-sm font-bold wiz-ease"
              style={{ border: `1px solid ${active ? RED : 'rgba(255,255,255,.1)'}`, background: active ? 'rgba(224,0,42,.10)' : 'rgba(255,255,255,.02)', color: active ? '#fff' : 'var(--muted)' }}>
              {t as string}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Step 3: Photos ───────────────────────────────────────────────────────────
const PHOTO_TIPS: { icon: LucideIcon; text: string }[] = [
  { icon: Camera, text: 'One wide shot showing the whole area or pile — stand back far enough to fit it all in.' },
  { icon: Boxes, text: 'Include everything that needs to be removed; open cabinets, closets, or storage with items in them.' },
  { icon: Truck, text: 'At least two angles when items overlap or hide each other — it helps us not double-count.' },
  { icon: HardHat, text: 'Close-ups of unusually heavy, unclear, or specialty items (appliances, exercise gear, etc.).' },
  { icon: DoorOpen, text: 'Show stairs, elevators, gates, hallways, and the path to where a truck can park.' },
  { icon: Lightbulb, text: 'Keep photos bright and sharp — avoid dark, blurry, cropped, or blocked shots, and don’t upload the same photo twice.' },
]
function StepPhotos(props: {
  photos: PhotoItem[]; dragOver: boolean; setDragOver: (v: boolean) => void
  onAdd: (f: FileList | File[]) => void; onRemove: (id: string) => void; onRetry: (id: string) => void
  jobBased: boolean; everythingPictured: boolean | null; setEverythingPictured: (v: boolean) => void
}) {
  const [tipsOpen, setTipsOpen] = useState(false)
  const total = props.photos.length
  const done = props.photos.filter(p => p.status === 'done').length
  const uploading = props.photos.filter(p => p.status === 'uploading' || p.status === 'processing').length
  const failed = props.photos.filter(p => p.status === 'error').length

  // One clear, human status line — not a fleeting toast.
  let status = ''
  if (total === 0) status = ''
  else if (uploading > 0) status = `Uploading ${done + 1} of ${total}…`
  else if (failed > 0) status = `${done} of ${total} uploaded · ${failed} failed — tap ↻ to retry`
  else status = `${done} photo${done === 1 ? '' : 's'} uploaded successfully — they'll be included with your booking`

  return (
    <>
      <StepHeading kicker="Help us see the job" title="Upload photos of the items, junk, debris, rooms, or property." sub="The more photos you provide, the more accurate your quote will be. This step is optional — but it really helps." />

      {/* Compact, expandable photo guidance (Part 3). */}
      <div className="mb-4 rounded-2xl" style={{ border: '1px solid rgba(255,255,255,.1)', background: 'rgba(255,255,255,.02)', overflow: 'hidden' }}>
        <button type="button" onClick={() => setTipsOpen(o => !o)} aria-expanded={tipsOpen} className="w-full flex items-center gap-2.5 px-4" style={{ minHeight: 48, background: 'none', border: 'none', cursor: 'pointer' }}>
          <Lightbulb size={16} style={{ color: RED, flexShrink: 0 }} />
          <span className="font-bold text-white text-sm" style={{ flex: 1, textAlign: 'left' }}>How to take photos that get you an accurate quote</span>
          <ChevronDown size={16} style={{ color: 'var(--muted)', transform: tipsOpen ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
        </button>
        {tipsOpen && (
          <div className="px-4 pb-4 grid gap-2 sm:grid-cols-2">
            {PHOTO_TIPS.map((t, i) => {
              const Icon = t.icon
              return (
                <div key={i} className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl" style={{ background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.07)' }}>
                  <Icon size={15} style={{ color: RED, flexShrink: 0, marginTop: 1 }} />
                  <span className="text-xs" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>{t.text}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <label
        onDragOver={e => { e.preventDefault(); props.setDragOver(true) }}
        onDragLeave={() => props.setDragOver(false)}
        onDrop={e => { e.preventDefault(); props.setDragOver(false); if (e.dataTransfer.files?.length) props.onAdd(e.dataTransfer.files) }}
        className="flex flex-col items-center justify-center text-center rounded-2xl wiz-ease"
        style={{ padding: '38px 20px', cursor: 'pointer', border: `1.5px dashed ${props.dragOver ? RED : 'rgba(255,255,255,.18)'}`, background: props.dragOver ? 'rgba(224,0,42,.06)' : 'rgba(255,255,255,.02)' }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, borderRadius: 999, background: 'rgba(224,0,42,.12)', color: RED, marginBottom: 12 }}>
          <Camera size={24} />
        </span>
        <p className="font-bold text-white">Tap to take a photo or choose from your library</p>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>JPG, PNG or HEIC · up to {MAX_PHOTOS} photos · ~6MB each</p>
        <input type="file" aria-label="Upload photos of your items, junk, debris, rooms, or property" accept="image/*" multiple onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) props.onAdd(files) }} style={{ display: 'none' }} />
      </label>

      {/* How to take useful photos (helps the estimate). */}
      <ul className="mt-3 text-xs" style={{ color: 'var(--muted)', lineHeight: 1.7, listStyle: 'none', padding: 0 }}>
        <li>• One wide shot of the whole pile, then a few from different angles</li>
        <li>• Include something for scale, and don’t crop out the top or bottom</li>
        <li>• Snap stairs, gates, or a long carry — and heavy items on their own</li>
      </ul>
      <p className="mt-2 text-xs" style={{ color: 'rgba(255,255,255,.4)', lineHeight: 1.5 }}>
        Uploaded photos may be analyzed using automated tools to estimate item type, volume, labor, and disposal needs. Final pricing may change if the actual items, quantity, weight, or access differ from the photos.
      </p>

      {/* Live status: upload progress / success / failure is announced to screen
          readers as it changes. Always-present region so appearances announce too. */}
      <div role="status" aria-live="polite" aria-atomic="true">
        {status && (
          <p className="mt-3 text-sm font-semibold flex items-center gap-2" style={{ color: failed > 0 ? '#ffb3c0' : uploading > 0 ? 'var(--muted)' : '#34d399' }}>
            {uploading > 0 ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : failed > 0 ? <X size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
            {status}
          </p>
        )}
        {/* Coverage nudge: a single photo rarely captures a whole job — invite a second
            angle for a more accurate instant estimate (non-blocking). */}
        {done === 1 && uploading === 0 && (
          <p className="mt-2 text-xs flex items-center gap-1.5" style={{ color: '#fbbf24', lineHeight: 1.5 }}>
            <Camera size={13} aria-hidden="true" /> One more angle helps us quote accurately — add a wide shot or a second view if you can.
          </p>
        )}
      </div>

      {total > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5 mt-4">
          {props.photos.map(p => (
            <div key={p.id} style={{ position: 'relative', aspectRatio: '1 / 1', borderRadius: 12, overflow: 'hidden', border: `1px solid ${p.status === 'error' ? 'rgba(224,0,42,.5)' : 'rgba(255,255,255,.1)'}` }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url || p.previewUrl} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: p.status === 'done' ? 1 : 0.55 }} />

              {/* Per-photo status overlay */}
              {(p.status === 'uploading' || p.status === 'processing') && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.35)' }}>
                  <Loader2 size={20} className="animate-spin" style={{ color: '#fff' }} />
                </div>
              )}
              {p.status === 'done' && (
                <span style={{ position: 'absolute', bottom: 4, left: 4, width: 20, height: 20, borderRadius: 999, background: '#16a34a', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Check size={12} />
                </span>
              )}
              {p.status === 'error' && (
                <button type="button" onClick={() => props.onRetry(p.id)} aria-label="Retry upload" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, background: 'rgba(224,0,42,.35)', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>
                  <Loader2 size={16} /> Retry
                </button>
              )}

              <button type="button" onClick={() => props.onRemove(p.id)} aria-label="Remove photo" style={{ position: 'absolute', top: 4, right: 4, width: 24, height: 24, borderRadius: 999, border: 'none', background: 'rgba(0,0,0,.7)', color: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* "Is everything being removed shown?" — persisted with the request (Part 3). */}
      {props.jobBased && done > 0 && (
        <div className="mt-4 px-4 py-3.5 rounded-2xl" style={{ border: '1px solid rgba(255,255,255,.1)', background: 'rgba(255,255,255,.02)' }}>
          <p id="q-everything-pictured-label" className="font-bold text-white text-sm mb-2.5">Is everything being removed shown in these photos?</p>
          <div className="flex gap-2" role="group" aria-labelledby="q-everything-pictured-label">
            {[['Yes', true], ['Not all of it', false]].map(([t, v]) => {
              const active = props.everythingPictured === v
              return (
                <button key={String(v)} type="button" onClick={() => props.setEverythingPictured(v as boolean)} aria-pressed={active} className="flex-1 rounded-xl text-sm font-bold wiz-ease"
                  style={{ minHeight: 44, border: `1px solid ${active ? RED : 'rgba(255,255,255,.12)'}`, background: active ? 'rgba(224,0,42,.10)' : 'rgba(255,255,255,.02)', color: active ? '#fff' : 'var(--muted)' }}>
                  {t as string}
                </button>
              )
            })}
          </div>
          {props.everythingPictured === false && (
            <p className="text-xs mt-2.5" style={{ color: '#fcd34d', lineHeight: 1.5 }}>
              No problem — add more photos above, or you’ll be able to add the missing items in the next step.
            </p>
          )}
        </div>
      )}
    </>
  )
}

// ── Step 4: Upgrades ─────────────────────────────────────────────────────────
function StepUpgrades({ selected, onToggle }: { selected: string[]; onToggle: (id: string) => void }) {
  return (
    <>
      <StepHeading kicker="Make it effortless" title="Customize your service." sub="Optional upgrades that save you time and hassle. Add what you need — skip the rest." />
      <div className="grid sm:grid-cols-2 gap-3">
        {UPGRADES.map(u => {
          const active = selected.includes(u.id)
          const Icon = u.icon
          return (
            <button key={u.id} type="button" onClick={() => onToggle(u.id)} className="text-left rounded-2xl p-4 wiz-ease"
              style={{ border: `1px solid ${active ? RED : 'rgba(255,255,255,.08)'}`, background: active ? 'rgba(224,0,42,.07)' : 'rgba(255,255,255,.02)', boxShadow: active ? '0 0 0 1px rgba(224,0,42,.35)' : 'none' }}>
              <div className="flex items-start gap-3">
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 38, borderRadius: 10, flexShrink: 0, background: active ? RED : 'rgba(255,255,255,.06)', color: active ? '#fff' : RED, transition: 'background .25s, color .25s' }}>
                  <Icon size={18} />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="flex items-center gap-2">
                    <p className="font-bold text-white leading-tight">{u.label}</p>
                    <span className="text-xs font-bold ml-auto" style={{ color: active ? RED : 'var(--muted)' }}>+${u.price}</span>
                  </div>
                  <p className="text-sm mt-1" style={{ color: 'var(--muted)', lineHeight: 1.4 }}>{u.why}</p>
                </div>
              </div>
            </button>
          )
        })}
      </div>
      <p className="text-xs mt-4 text-center" style={{ color: 'rgba(255,255,255,.4)' }}>Add-on prices are estimates — your final quote confirms everything. No upgrades? Just continue.</p>
    </>
  )
}

// ── Step 5: Your info ────────────────────────────────────────────────────────
function StepContact(props: {
  name: string; setName: (v: string) => void; company: string; setCompany: (v: string) => void
  phone: string; setPhone: (v: string) => void; email: string; setEmail: (v: string) => void
  contactMethod: string; setContactMethod: (v: string) => void; promo: string; setPromo: (v: string) => void
}) {
  return (
    <>
      <StepHeading kicker="Almost there" title="Where should we send your quote?" sub="We'll only use this to send your quote and coordinate the job." />
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2"><label htmlFor="q-name" style={lbl}>Full name</label><input id="q-name" aria-required="true" value={props.name} onChange={e => props.setName(e.target.value)} autoCapitalize="words" placeholder="Jordan Kiss" style={inp} /></div>
        <div><label htmlFor="q-company" style={lbl}>Company <span style={{ textTransform: 'none', fontWeight: 400 }}>(optional)</span></label><input id="q-company" value={props.company} onChange={e => props.setCompany(e.target.value)} placeholder="Company name" style={inp} /></div>
        <div><label htmlFor="q-phone" style={lbl}>Phone</label><input id="q-phone" aria-describedby="q-sms-consent" value={props.phone} onChange={e => props.setPhone(e.target.value)} type="tel" placeholder="(555) 000-0000" style={inp} /></div>
        <div><label htmlFor="q-email" style={lbl}>Email</label><input id="q-email" aria-required="true" value={props.email} onChange={e => props.setEmail(e.target.value)} type="email" placeholder="you@email.com" style={inp} /></div>
        <div>
          <label htmlFor="q-contact-method" style={lbl}>Best way to reach you</label>
          <select id="q-contact-method" value={props.contactMethod} onChange={e => props.setContactMethod(e.target.value)} style={{ ...inp, cursor: 'pointer', colorScheme: 'dark' }}>
            <option>Text message</option>
            <option>Phone call</option>
            <option>Email</option>
          </select>
        </div>
        <div className="sm:col-span-2"><label htmlFor="q-promo" style={lbl}>Promo code <span style={{ textTransform: 'none', fontWeight: 400 }}>(optional)</span></label><input id="q-promo" value={props.promo} onChange={e => props.setPromo(e.target.value.toUpperCase())} placeholder="Have a code?" style={{ ...inp, textTransform: 'uppercase' }} /></div>
      </div>
      <p id="q-sms-consent" className="text-xs mt-4" style={{ color: 'rgba(255,255,255,.4)', lineHeight: 1.5 }}>
        By providing your phone number, you agree to receive booking and service-related text messages from {COMPANY.legalName} at the number provided, including messages sent by autodialer. Consent is not a condition of purchase. Message &amp; data rates may apply. Reply STOP to opt out, HELP for help.
      </p>
    </>
  )
}

// ── Step 6: Review ───────────────────────────────────────────────────────────
function StepReview(props: {
  svc: Svc; singleSite: boolean; pickupText: string; deliveryText: string
  size?: { label: string }; photoCount: number; upgrades: string[]; prefDate: string
  name: string; company: string; email: string; phone: string; contactMethod: string
  showLow: number | null; showHigh: number | null; deposit: string
  est: { hasPrice: boolean } | null
  reserveOpen: boolean; avail: { dates: string[]; depositCents: number } | null
  bookDate: string; setBookDate: (v: string) => void; bookWin: string; setBookWin: (v: string) => void
  onOpenReserve: () => void; onReserve: () => void; jobBased: boolean; busy: boolean
  bookMethod: 'stripe' | 'zelle'; setBookMethod: (m: 'stripe' | 'zelle') => void
  bookProof: string; onBookProof: (f: File) => void; proofReading: boolean; zelleAddress: string
  estimate?: QuoteEstimate | null
}) {
  const est = props.estimate
  const rows: [string, string][] = [
    ['Service', props.svc.label],
    [props.singleSite ? 'Job location' : 'Pickup', props.pickupText || '—'],
    ...(!props.singleSite ? [['Delivery', props.deliveryText || '—'] as [string, string]] : []),
    ['Size', props.size?.label ?? '—'],
    ['Photos', props.photoCount ? `${props.photoCount} attached` : 'None'],
    ['Upgrades', props.upgrades.length ? props.upgrades.map(id => UPGRADES.find(u => u.id === id)?.label).filter(Boolean).join(', ') : 'None'],
    ['Preferred date', props.prefDate ? fmtDateLabel(props.prefDate) : 'Flexible'],
    ['Name', props.name || '—'],
    ...(props.company ? [['Company', props.company] as [string, string]] : []),
    ['Contact', [props.email, props.phone].filter(Boolean).join(' · ') || '—'],
    ['Preferred contact', props.contactMethod],
  ]
  return (
    <>
      <StepHeading kicker="One last look" title="Review & request." sub="Confirm the details below — then we'll get to work on your number." />

      {est && (
        <div className="rounded-2xl overflow-hidden mb-5" style={{ border: `1px solid ${est.decision === 'manual_review' ? 'rgba(255,255,255,.14)' : 'rgba(224,0,42,.3)'}` }}>
          <div className="px-5 py-4 text-center" style={{ background: est.decision === 'manual_review' ? 'rgba(255,255,255,.03)' : 'rgba(224,0,42,.07)' }}>
            <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
              {est.decision === 'instant_quote' ? 'Your instant estimate' : est.decision === 'estimate_range' ? 'Your estimated range' : 'Photo review'}
            </p>
            {est.decision === 'instant_quote' ? (
              <p className="text-4xl font-black tabular-nums mt-1" style={{ color: RED, letterSpacing: '-0.03em', fontFamily: 'var(--font-display)' }}>${est.recommendedUsd.toLocaleString()}</p>
            ) : est.decision === 'estimate_range' ? (
              <p className="text-3xl font-black tabular-nums mt-1" style={{ color: RED, letterSpacing: '-0.03em', fontFamily: 'var(--font-display)' }}>${est.lowUsd.toLocaleString()}–${est.highUsd.toLocaleString()}</p>
            ) : (
              <p className="text-lg font-black mt-1 text-white">We’ll confirm your price shortly</p>
            )}
            <p className="text-xs mt-1.5" style={{ color: 'rgba(255,255,255,.55)', lineHeight: 1.5 }}>{est.note}</p>
          </div>
          <div className="px-5 py-3" style={{ borderTop: '1px solid var(--line)' }}>
            {est.items.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {est.items.slice(0, 8).map((it, i) => (
                  <span key={i} className="text-xs" style={{ background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)', borderRadius: 999, padding: '3px 9px', color: 'var(--muted)' }}>
                    {it.quantity > 1 ? `${it.quantity}× ` : ''}{it.label}
                  </span>
                ))}
              </div>
            )}
            {est.reviewReasons.length > 0 && (
              <ul className="text-xs" style={{ color: 'var(--muted)', lineHeight: 1.6, listStyle: 'none', padding: 0, margin: 0 }}>
                {est.reviewReasons.slice(0, 3).map((r, i) => <li key={i}>• {r}</li>)}
              </ul>
            )}
            <p className="text-[11px] mt-2" style={{ color: 'rgba(255,255,255,.35)' }}>
              Estimated from your photos · confirmed on site. Photos were reviewed by an automated tool; a person makes the final call.
            </p>
          </div>
        </div>
      )}

      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--line)' }}>
        {props.showLow != null && (
          <div className="px-5 py-4 text-center" style={{ background: 'rgba(224,0,42,.07)', borderBottom: '1px solid var(--line)' }}>
            <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Estimated range</p>
            <p className="text-3xl font-black mt-1" style={{ color: RED, letterSpacing: '-0.03em' }}>${props.showLow.toLocaleString()}–${props.showHigh!.toLocaleString()}</p>
            <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,.5)' }}>Instant estimate — your team confirms the firm number.</p>
          </div>
        )}
        <div className="px-5 py-2">
          {rows.map(([k, v], i) => (
            <div key={k} className="flex justify-between gap-4 py-2.5 text-sm" style={i > 0 ? { borderTop: '1px solid rgba(255,255,255,.06)' } : undefined}>
              <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{k}</span>
              <span className="text-white text-right" style={{ minWidth: 0 }}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-3 mt-5 rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
        <Star size={16} style={{ color: RED, flexShrink: 0, marginTop: 2 }} />
        <p className="text-sm" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
          <strong className="text-white">Most quotes are returned within one business hour</strong> during operating hours. We&apos;ll reach out by your preferred method with a firm number.
        </p>
      </div>

      {/* Optional: lock a date now (eligible job-based services) */}
      {props.jobBased && (
        <div className="mt-5 rounded-2xl" style={{ border: '1px solid rgba(224,0,42,.22)', overflow: 'hidden' }}>
          {!props.reserveOpen ? (
            <button type="button" onClick={props.onOpenReserve} className="w-full text-left px-5 py-4 wiz-ease" style={{ background: 'rgba(224,0,42,.05)' }}>
              <p className="font-bold text-white flex items-center gap-2"><Zap size={15} style={{ color: RED }} /> Rather lock your date now?</p>
              <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>Reserve an open date with a fully-refundable ${props.deposit} deposit — skip the callback.</p>
            </button>
          ) : (
            <div className="px-5 py-4 wiz-fade">
              <p className="font-bold text-white mb-3 flex items-center gap-2"><Zap size={15} style={{ color: RED }} /> Reserve your date</p>
              {!props.avail ? (
                <p className="text-sm flex items-center gap-2" style={{ color: 'var(--muted)' }}><Loader2 size={14} className="animate-spin" /> Loading open dates…</p>
              ) : props.avail.dates.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--muted)' }}>No online dates are open for a job this size right now — request your quote above and we&apos;ll schedule you.</p>
              ) : (
                <>
                  <label id="q-bookdate-label" style={lbl}>Open dates</label>
                  <div role="group" aria-labelledby="q-bookdate-label" className="flex flex-wrap gap-2 mb-4" style={{ maxHeight: 150, overflowY: 'auto' }}>
                    {props.avail.dates.map(d => {
                      const active = props.bookDate === d
                      return <button key={d} type="button" onClick={() => props.setBookDate(d)} aria-pressed={active} className="rounded-xl px-3 py-2 text-sm font-semibold wiz-ease" style={{ border: `1px solid ${active ? RED : 'rgba(255,255,255,.12)'}`, background: active ? RED : 'rgba(255,255,255,.04)', color: active ? '#fff' : 'var(--text)' }}>{fmtDateLabel(d)}</button>
                    })}
                  </div>
                  {props.bookDate && (
                    <>
                      <label id="q-bookwin-label" style={lbl}>Arrival window</label>
                      <div role="group" aria-labelledby="q-bookwin-label" className="flex flex-wrap gap-2 mb-4">
                        {WINDOWS.map(w => {
                          const active = props.bookWin === w
                          return <button key={w} type="button" onClick={() => props.setBookWin(w)} aria-pressed={active} className="rounded-xl px-3 py-2 text-sm font-semibold wiz-ease" style={{ border: `1px solid ${active ? RED : 'rgba(255,255,255,.12)'}`, background: active ? RED : 'rgba(255,255,255,.04)', color: active ? '#fff' : 'var(--text)' }}>{w}</button>
                        })}
                      </div>
                    </>
                  )}
                  {props.bookDate && props.bookWin && (
                    <>
                      <label id="q-bookmethod-label" style={lbl}>How would you like to pay the ${props.deposit} deposit?</label>
                      <div role="group" aria-labelledby="q-bookmethod-label" className="grid grid-cols-1 gap-2 mb-3">
                        <button type="button" onClick={() => props.setBookMethod('stripe')} aria-pressed={props.bookMethod === 'stripe'} className="rounded-2xl px-4 py-3 text-left wiz-ease" style={{ border: `1.5px solid ${props.bookMethod === 'stripe' ? RED : 'rgba(255,255,255,.12)'}`, background: props.bookMethod === 'stripe' ? 'rgba(224,0,42,.08)' : 'rgba(255,255,255,.03)' }}>
                          <p className="font-bold text-white text-sm">💳 Credit / Debit Card</p>
                          <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>Instant confirmation · secure checkout · booking confirmed right after payment.</p>
                        </button>
                        <button type="button" onClick={() => props.setBookMethod('zelle')} aria-pressed={props.bookMethod === 'zelle'} className="rounded-2xl px-4 py-3 text-left wiz-ease" style={{ border: `1.5px solid ${props.bookMethod === 'zelle' ? RED : 'rgba(255,255,255,.12)'}`, background: props.bookMethod === 'zelle' ? 'rgba(224,0,42,.08)' : 'rgba(255,255,255,.03)' }}>
                          <p className="font-bold text-white text-sm">🏦 Zelle <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· no processing fee</span></p>
                          <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>Send the deposit by Zelle, upload your confirmation, and we&apos;ll confirm after verifying it.</p>
                        </button>
                      </div>

                      {props.bookMethod === 'zelle' && (
                        <div className="rounded-2xl px-4 py-3 mb-3" style={{ border: '1px solid rgba(255,255,255,.1)', background: 'rgba(255,255,255,.03)' }}>
                          <p className="text-sm mb-2" style={{ color: 'var(--muted)' }}>Send <span className="font-bold text-white">${props.deposit}</span> to <span className="font-mono text-white">{props.zelleAddress}</span>, then upload a screenshot showing the amount, recipient, and date.</p>
                          {props.bookProof ? (
                            <div className="rounded-xl overflow-hidden mb-2" style={{ border: '1px solid rgba(255,255,255,.12)' }}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={props.bookProof} alt="Your Zelle confirmation" style={{ display: 'block', width: '100%', maxHeight: 220, objectFit: 'contain', background: 'rgba(0,0,0,.2)' }} />
                            </div>
                          ) : null}
                          <label className="flex items-center justify-center gap-2 rounded-xl px-4 py-3 cursor-pointer text-sm font-semibold" style={{ border: '1px dashed rgba(255,255,255,.25)', color: '#fff' }}>
                            <span role="status" aria-live="polite" aria-atomic="true">{props.proofReading ? 'Reading…' : props.bookProof ? '↻ Choose a different screenshot' : '📷 Upload payment screenshot'}</span>
                            <input type="file" aria-label="Upload your Zelle payment screenshot" aria-busy={props.proofReading} accept="image/jpeg,image/png,image/webp,image/heic,image/heif" hidden onChange={e => { const f = e.target.files?.[0]; if (f) props.onBookProof(f) }} />
                          </label>
                        </div>
                      )}
                    </>
                  )}
                  <button type="button" onClick={props.onReserve} disabled={!props.bookDate || !props.bookWin || props.busy || props.proofReading || (props.bookMethod === 'zelle' && !props.bookProof)} className="btn w-full wiz-ease" style={{ justifyContent: 'center', opacity: (props.bookDate && props.bookWin && !props.busy && !(props.bookMethod === 'zelle' && !props.bookProof)) ? 1 : 0.5 }}>
                    {props.busy ? 'Reserving…' : props.bookMethod === 'zelle' ? <>Reserve with Zelle · Upload Confirmation</> : <>Reserve &amp; Pay ${props.deposit} <ArrowRight size={16} /></>}
                  </button>
                  <p className="text-xs text-center mt-2" style={{ color: 'rgba(255,255,255,.4)' }}>Your deposit holds the date and is fully refunded if we can&apos;t make it.</p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}

// ── Sticky summary card ──────────────────────────────────────────────────────
function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 text-sm">
      <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{k}</span>
      <span className="text-white text-right" style={{ minWidth: 0 }}>{v}</span>
    </div>
  )
}
function SummaryCard(props: {
  svc?: Svc; size?: { label: string }; singleSite: boolean; pickupText: string; deliveryText: string
  photoCount: number; upgrades: string[]; prefDate: string
  showLow: number | null; showHigh: number | null; deposit: string; est: { hasPrice: boolean } | null
}) {
  const { svc } = props
  return (
    <div className="glass-card" style={{ borderRadius: 20, overflow: 'hidden' }}>
      <div className="px-5 py-4" style={{ background: 'linear-gradient(135deg, rgba(224,0,42,.12), rgba(255,255,255,.02))', borderBottom: '1px solid var(--line)' }}>
        <p className="text-xs font-bold uppercase tracking-widest" style={{ color: RED }}>Your job</p>
        <p className="text-lg font-black text-white mt-0.5">{svc?.label ?? 'Choose a service'}</p>
      </div>
      <div className="px-5 py-4">
        {!svc ? (
          <p className="text-sm" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>Pick a service to see your quote take shape here.</p>
        ) : (
          <>
            {props.size && <SummaryRow k="Size" v={props.size.label} />}
            {props.pickupText && <SummaryRow k={props.singleSite ? 'Location' : 'Pickup'} v={props.pickupText} />}
            {!props.singleSite && props.deliveryText && <SummaryRow k="Delivery" v={props.deliveryText} />}
            {props.photoCount > 0 && <SummaryRow k="Photos" v={`${props.photoCount} attached`} />}
            {props.upgrades.length > 0 && <SummaryRow k="Upgrades" v={`${props.upgrades.length} selected`} />}
            {props.prefDate && <SummaryRow k="Preferred" v={fmtDateLabel(props.prefDate)} />}

            <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
              {props.showLow != null ? (
                <>
                  <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Estimated range</p>
                  <p className="text-2xl font-black mt-0.5" style={{ color: RED, letterSpacing: '-0.02em' }}>${props.showLow.toLocaleString()}–${props.showHigh!.toLocaleString()}</p>
                </>
              ) : (
                <p className="text-sm" style={{ color: 'var(--muted)' }}>Priced by our team — most quotes back within <strong className="text-white">one business hour</strong>.</p>
              )}
              <p className="text-xs mt-1.5" style={{ color: 'rgba(255,255,255,.45)' }}>Refundable deposit to reserve: <strong style={{ color: '#fff' }}>${props.deposit}</strong></p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Success ──────────────────────────────────────────────────────────────────
type SuccessSummary = { name: string; service: string; address: string; prefDate: string; photoCount: number; contactMethod: string }
function SuccessView({ sent, deposit, summary, onReset, final }: {
  sent: { estimate?: Estimate; request?: { number: string; token: string } }
  deposit: string; summary: SuccessSummary; onReset: () => void; final?: CustomerFinalState | null
}) {
  void deposit
  const e = sent.estimate
  const reqNo = sent.request?.number
  const rows: [string, string][] = [
    ...(reqNo ? [['Request number', reqNo] as [string, string]] : []),
    ['Name', summary.name || '—'],
    ['Service', summary.service],
    ['Address', summary.address || '—'],
    ['Preferred date', summary.prefDate],
    ['Photos attached', summary.photoCount ? `${summary.photoCount} photo${summary.photoCount === 1 ? '' : 's'}` : 'None'],
  ]
  return (
    <div className="max-w-2xl mx-auto wiz-reveal" style={{ position: 'relative', zIndex: 10 }}>
      <div className="glass-card p-7 sm:p-10 text-center" style={{ borderRadius: 24, border: '1px solid rgba(224,0,42,.25)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 64, height: 64, borderRadius: 999, background: 'rgba(224,0,42,.12)', color: RED, marginBottom: 18 }}>
          <Check size={32} />
        </span>
        <h1 className="text-3xl md:text-4xl font-black text-white mb-2" style={{ letterSpacing: '-0.03em', fontFamily: 'var(--font-display)' }}>
          {final ? final.headline : 'Request received.'}
        </h1>
        {reqNo && (
          <p className="text-sm font-bold mb-3" style={{ color: RED }}>
            Your request number is <span className="font-mono">{reqNo}</span> — keep it for your records.
          </p>
        )}

        {/* Guided-confirmation result state (Part 13). Falls back to the generic
            pending-review copy when there was no confirmation flow. */}
        {final ? (
          <FinalResultCard final={final} firstName={summary.name ? summary.name.split(' ')[0] : ''} />
        ) : (
          <p className="text-base mb-5" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
            Thanks{summary.name ? `, ${summary.name.split(' ')[0]}` : ''} — we&apos;ve got your details{summary.photoCount ? ` and your ${summary.photoCount} photo${summary.photoCount === 1 ? '' : 's'}` : ''}. Your request is <strong className="text-white">pending review</strong>; our team will send a firm quote by your preferred method — most come back within one business hour during operating hours.
          </p>
        )}

        {e && e.low > 0 && (
          <div className="inline-block rounded-2xl px-8 py-4 mb-5" style={{ background: 'rgba(224,0,42,.07)', border: '1px solid rgba(224,0,42,.25)' }}>
            <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Instant estimate (not final)</p>
            <p className="text-4xl font-black tabular-nums mt-1" style={{ color: RED, letterSpacing: '-0.04em', fontFamily: 'var(--font-display)' }}>${e.low.toLocaleString()}–${e.high.toLocaleString()}</p>
            {e.promoCode && <p className="text-xs mt-2 font-semibold" style={{ color: '#34d399' }}>✓ Promo {e.promoCode} applied{e.promoPct ? ` — ${e.promoPct}% off` : ''}.</p>}
          </div>
        )}

        {/* Structured recap so the customer can see exactly what we received. */}
        <div className="rounded-2xl overflow-hidden text-left mb-5" style={{ border: '1px solid var(--line)' }}>
          <div className="px-5 py-2">
            {rows.map(([k, v], i) => (
              <div key={k} className="flex justify-between gap-4 py-2.5 text-sm" style={i > 0 ? { borderTop: '1px solid rgba(255,255,255,.06)' } : undefined}>
                <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{k}</span>
                <span className="text-white text-right" style={{ minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl px-4 py-3 mb-5 text-left flex items-start gap-3" style={{ background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
          <Star size={16} style={{ color: RED, flexShrink: 0, marginTop: 2 }} />
          <p className="text-sm" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
            <strong className="text-white">What happens next:</strong> our team reviews your request and photos, prepares a firm quote, and reaches out by {summary.contactMethod?.toLowerCase() || 'your preferred method'}. No charge until you approve.
          </p>
        </div>

        <p className="text-sm" style={{ color: 'rgba(255,255,255,.5)', lineHeight: 1.6 }}>Need it handled fast? Call or email us at <a href={"mailto:" + COMPANY.email} className="underline" style={{ color: '#fff' }}>info@jkissllc.com</a>.</p>
        {/* ROOT-CAUSE FIX: both controls (a Link AND a button) were unclickable, which
            can only mean clicks weren't reaching them — a stacking/overlay issue, not a
            Link- or handler-specific one. position:relative + a positive zIndex here (and
            on the card above) put these controls in their own stacking context above the
            animated card / brand-glow / any sibling layer, so the click always lands.
            Link keeps native-anchor + client navigation; the reset is an explicit type=button. */}
        <div className="mt-7 flex justify-center gap-3 flex-wrap" style={{ position: 'relative', zIndex: 10 }}>
          <Link href="/" className="btn wiz-ease" style={{ pointerEvents: 'auto' }}>Back to Home</Link>
          <button type="button" onClick={onReset} className="btn-ghost wiz-ease" style={{ pointerEvents: 'auto' }}>Request Another Quote</button>
        </div>
      </div>
    </div>
  )
}

// ── Analyzing state (guided confirmation) ────────────────────────────────────
function AnalyzingView() {
  const stages = ['Uploading your photos', 'Identifying items', 'Estimating job size', 'Preparing your review']
  return (
    <div className="py-6 text-center wiz-reveal">
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 60, height: 60, borderRadius: 999, background: 'rgba(224,0,42,.12)', color: RED, marginBottom: 16 }}>
        <Loader2 size={28} className="animate-spin" />
      </span>
      <h2 className="text-2xl font-black text-white" style={{ letterSpacing: '-0.02em', fontFamily: 'var(--font-display)' }}>Analyzing your photos</h2>
      <p className="text-sm mt-2 mb-5" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
        We’re identifying the items and estimating the size of the job. This usually takes just a few seconds.
      </p>
      <div className="grid gap-2 max-w-sm mx-auto text-left">
        {stages.map((s, i) => (
          <div key={s} className="flex items-center gap-2.5 px-3 py-2 rounded-xl" style={{ border: '1px solid var(--line)', background: 'rgba(255,255,255,.02)' }}>
            <Loader2 size={14} className="animate-spin" style={{ color: i === 0 ? RED : 'rgba(255,255,255,.3)', flexShrink: 0 }} />
            <span className="text-sm" style={{ color: 'var(--muted)' }}>{s}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Graceful fallback when the automatic photo read didn't produce items — the
// customer is never trapped; the durable server worker + team still handle it.
function ConfirmUnavailable() {
  return (
    <div className="py-6 text-center wiz-reveal">
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 56, height: 56, borderRadius: 999, background: 'rgba(255,255,255,.05)', color: RED, marginBottom: 14 }}>
        <Clock size={26} />
      </span>
      <h2 className="text-2xl font-black text-white" style={{ letterSpacing: '-0.02em', fontFamily: 'var(--font-display)' }}>We’ll review your photos</h2>
      <p className="text-sm mt-2" style={{ color: 'var(--muted)', lineHeight: 1.55, maxWidth: 420, margin: '8px auto 0' }}>
        We couldn’t read every detail automatically, so a team member will review your photos and confirm your quote. Continue and we’ll take it from here.
      </p>
    </div>
  )
}

// ── Guided-confirmation result card (Part 13) ────────────────────────────────
function FinalResultCard({ final, firstName }: { final: CustomerFinalState; firstName: string }) {
  const tone = final.stage === 'quote_ready' ? RED
    : final.stage === 'failed' ? '#f87171'
    : final.stage === 'owner_review' || final.stage === 'more_info' ? '#fbbf24'
    : 'var(--muted)'
  return (
    <div className="mb-5">
      {final.stage === 'processing' ? (
        <div className="inline-flex items-center gap-2 rounded-full px-4 py-2 mb-3" style={{ background: 'rgba(224,0,42,.08)', border: '1px solid rgba(224,0,42,.25)' }}>
          <Loader2 size={15} className="animate-spin" style={{ color: RED }} />
          <span className="text-sm font-bold text-white">Finalizing your estimate…</span>
        </div>
      ) : null}

      {final.stage === 'quote_ready' && final.lowUsd != null && (
        <div className="inline-block rounded-2xl px-8 py-4 mb-4" style={{ background: 'rgba(224,0,42,.07)', border: '1px solid rgba(224,0,42,.25)' }}>
          <p className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Your estimate</p>
          <p className="text-4xl font-black tabular-nums mt-1" style={{ color: RED, letterSpacing: '-0.04em', fontFamily: 'var(--font-display)' }}>
            ${final.lowUsd.toLocaleString()}{final.highUsd != null && final.highUsd !== final.lowUsd ? `–$${final.highUsd.toLocaleString()}` : ''}
          </p>
        </div>
      )}

      <p className="text-base mb-3" style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
        {firstName ? `Thanks, ${firstName} — ` : ''}{final.message}
      </p>

      {final.moreInfo && final.moreInfo.length > 0 && (
        <ul className="text-sm text-left inline-block" style={{ color: tone, lineHeight: 1.7, listStyle: 'none', padding: 0, margin: '0 auto' }}>
          {final.moreInfo.map((m, i) => <li key={i}>• {m}</li>)}
        </ul>
      )}
    </div>
  )
}

// ── Shared heading ───────────────────────────────────────────────────────────
function StepHeading({ kicker, title, sub }: { kicker: string; title: string; sub: string }) {
  return (
    <div className="mb-6">
      <p className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: RED, letterSpacing: '0.14em' }}>{kicker}</p>
      <h2 className="text-2xl font-black text-white" style={{ letterSpacing: '-0.02em', fontFamily: 'var(--font-display)' }}>{title}</h2>
      <p className="text-sm mt-2" style={{ color: 'var(--muted)', lineHeight: 1.55 }}>{sub}</p>
    </div>
  )
}
