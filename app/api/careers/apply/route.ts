import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { rateLimit } from '../../../lib/rate-limit'
import { isBlockedBot } from '../../../lib/botcheck'
import { str, isValidEmail, escapeHtml } from '../../../lib/validators'
import {
  ASSESSMENT, SCENARIOS, EXPERIENCE_LEVELS, POSITIONS, requiredDocKinds,
  type Position, type DocKind, type ExperienceLevel,
} from '../../../lib/ats-config'
import {
  type Applicant, type ApplicantDoc, type ScenarioResponse, type SkillRating,
  generateApplicantId, nextApplicantNumber, saveApplicant, rescore,
} from '../../../lib/applicants'
import { emailRaw } from '../../../lib/booking-emails'
import { notifyOwnerOfReply } from '../../../lib/owner-alerts'
import { COMPANY } from '../../../lib/company'

export const runtime = 'nodejs'
export const maxDuration = 30

const LEVELS = new Set(EXPERIENCE_LEVELS.map(l => l.value))
const DOC_KINDS = new Set<DocKind>(['drivers_license', 'id', 'ss_card', 'headshot'])

function baseUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || process.env.PUBLIC_BASE_URL || COMPANY.siteUrl).replace(/\/$/, '')
}

// Rebuild the skills map from untrusted input using only known categories/questions.
function cleanSkills(position: Position, raw: unknown): Record<string, Record<string, SkillRating>> {
  const out: Record<string, Record<string, SkillRating>> = {}
  const input = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  for (const cat of ASSESSMENT) {
    if (!cat.positions.includes(position)) continue
    const catIn = (input[cat.key] && typeof input[cat.key] === 'object') ? input[cat.key] as Record<string, unknown> : {}
    const catOut: Record<string, SkillRating> = {}
    for (const q of cat.questions) {
      const r = (catIn[q.key] && typeof catIn[q.key] === 'object') ? catIn[q.key] as Record<string, unknown> : {}
      const level = (typeof r.level === 'string' && LEVELS.has(r.level as ExperienceLevel)) ? r.level as ExperienceLevel : 'none'
      const confidence = Math.max(1, Math.min(10, Math.round(Number(r.confidence)) || 1))
      catOut[q.key] = { level, confidence }
    }
    out[cat.key] = catOut
  }
  return out
}

function cleanScenarios(raw: unknown): ScenarioResponse[] {
  const valid = new Set(SCENARIOS.map(s => s.key))
  const input = Array.isArray(raw) ? raw : []
  const seen = new Set<string>()
  const out: ScenarioResponse[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const key = String((item as Record<string, unknown>).key || '')
    if (!valid.has(key) || seen.has(key)) continue
    const answer = str((item as Record<string, unknown>).answer, 2000) || ''
    seen.add(key)
    out.push({ key, answer })
  }
  return out
}

// A document reference is one of two shapes:
//   • a sealed blob PATHNAME  — "driver-docs/ss_card/<uuid>.jpg.enc"  (identity docs)
//   • a public https URL      — the headshot, and every doc uploaded before identity
//                               documents were encrypted
// Both must survive here: existing applicant records still carry https URLs.
const SEALED_DOC_PATH = /^driver-docs\/[a-z_]+\/[a-zA-Z0-9-]+\.(jpg|png|webp|heic|heif)\.enc$/
const PUBLIC_DOC_URL = /^https:\/\/\S+$/

function cleanDocs(raw: unknown): ApplicantDoc[] {
  const input = Array.isArray(raw) ? raw : []
  const byKind = new Map<DocKind, ApplicantDoc>()
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const kind = (item as Record<string, unknown>).kind as DocKind
    const url = String((item as Record<string, unknown>).url || '')
    if (!DOC_KINDS.has(kind)) continue
    if (url.length > 1000 || url.includes('..')) continue
    if (!SEALED_DOC_PATH.test(url) && !PUBLIC_DOC_URL.test(url)) continue
    byKind.set(kind, { kind, url, uploadedAt: Date.now() })
  }
  return Array.from(byKind.values())
}

// POST /api/careers/apply — public applicant intake. Validates, scores, persists
// to Redis, and notifies the owner + confirms the applicant. Reuses the same
// rate-limit / bot-check / validator spine as the contact & quote routes.
export const POST = withTenantRoute(async (req: NextRequest) => {
  if (await rateLimit(req, 'careers-apply', 8, 30 * 60_000)) {
    return NextResponse.json({ error: 'Too many submissions. Please wait a bit and try again.' }, { status: 429 })
  }
  if (await isBlockedBot()) return NextResponse.json({ error: 'Submission blocked.' }, { status: 403 })

  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  const pos: Position | null = body.position === 'driver' || body.position === 'helper' ? body.position : null
  if (!pos) return NextResponse.json({ error: 'Please choose a position.' }, { status: 400 })

  const name = str(body.name, 120)
  const email = str(body.email, 200)
  const phone = str(body.phone, 40)
  if (!name) return NextResponse.json({ error: 'Please enter your full name.' }, { status: 400 })
  if (!email || !isValidEmail(email)) return NextResponse.json({ error: 'Please enter a valid email.' }, { status: 400 })
  if (!phone) return NextResponse.json({ error: 'Please enter a phone number.' }, { status: 400 })

  const documents = cleanDocs(body.documents)
  const present = new Set(documents.map(d => d.kind))
  const missing = requiredDocKinds(pos).filter(k => !present.has(k))
  if (missing.length) {
    return NextResponse.json({ error: 'Please upload all required documents before submitting.' }, { status: 400 })
  }

  const now = Date.now()
  const applicant: Applicant = {
    id: generateApplicantId(),
    applicantNumber: await nextApplicantNumber(),
    position: pos,
    name,
    email,
    phone,
    age21plus: body.age21plus === true,
    reliableTransport: body.reliableTransport === true,
    canOperateBoxTruck: pos === 'driver' ? body.canOperateBoxTruck === true : undefined,
    canLiftHeavy: body.canLiftHeavy === true,
    smartphone: body.smartphone === true,
    availableStart: str(body.availableStart, 40),
    availableDays: Array.isArray(body.availableDays) ? body.availableDays.map(String).slice(0, 7) : [],
    availabilityNotes: str(body.availabilityNotes, 500),
    experienceSummary: str(body.experienceSummary, 2000),
    skills: cleanSkills(pos, body.skills),
    scenarios: cleanScenarios(body.scenarios),
    documents,
    score: { score: 0, band: 'not_qualified', components: [], strengths: [], weaknesses: [], riskFactors: [], suggestedQuestions: [], scenarioRubric: { safety: 0, customerService: 0, problemSolving: 0, honesty: 0, professionalism: 0 }, documentsComplete: true, missingDocs: [] },
    status: 'new',
    source: str(body.source, 120),
    events: [{ at: now, actor: 'applicant', action: 'Application submitted' }],
    createdAt: now,
    updatedAt: now,
  }
  rescore(applicant)

  try {
    await saveApplicant(applicant)
  } catch (e) {
    console.error('[careers-apply] save', e)
    return NextResponse.json({ error: 'We couldn’t save your application. Please try again.' }, { status: 500 })
  }

  // Fire-and-forget notifications (never block the response on them).
  const title = POSITIONS[pos].title
  const admin = `${baseUrl()}/admin/careers`
  void emailRaw({
    to: [email],
    subject: `We received your ${COMPANY.legalName} application (${applicant.applicantNumber})`,
    html: `<p>Hi ${escapeHtml(name)},</p><p>Thanks for applying for the <strong>${title}</strong> position at ${COMPANY.legalName}. We received your application (<strong>${applicant.applicantNumber}</strong>) and our team will review it shortly.</p><p>If we&#39;d like to move forward, we&#39;ll reach out by phone or email to set up an interview.</p><p>— ${COMPANY.legalName} Hiring</p>`,
  }).catch(() => {})
  void notifyOwnerOfReply({
    via: 'email',
    customerName: name,
    fromPhone: phone,
    fromEmail: email,
    bookingNumber: applicant.applicantNumber,
    preview: `New ${title} application · Readiness ${applicant.score.score}/100 (${applicant.score.band})`,
    adminUrl: admin,
  }).catch(() => {})

  return NextResponse.json({ ok: true, applicantNumber: applicant.applicantNumber })
})
