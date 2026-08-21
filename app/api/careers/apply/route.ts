import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { rateLimit } from '../../../lib/rate-limit'
import { isBlockedBot } from '../../../lib/botcheck'
import { str, isValidEmail, escapeHtml } from '../../../lib/validators'
import {
  ASSESSMENT, SCENARIOS, EXPERIENCE_LEVELS, POSITIONS,
  type Position, type ExperienceLevel,
} from '../../../lib/ats-config'
import {
  type Applicant, type ScenarioResponse, type SkillRating,
  generateApplicantId, nextApplicantNumber, submitApplicantOnce, rescore, findApplicantDuplicates,
} from '../../../lib/applicants'
import { emailRaw } from '../../../lib/booking-emails'
import { notifyOwnerOfReply } from '../../../lib/owner-alerts'
import { COMPANY } from '../../../lib/company'
import { validApplicationDraftId } from '../../../lib/applicant-workflow'

export const runtime = 'nodejs'
export const maxDuration = 30

const LEVELS = new Set(EXPERIENCE_LEVELS.map(l => l.value))

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

// POST /api/careers/apply — public applicant intake. Validates, scores, persists
// to Redis, and notifies the owner + confirms the applicant. Reuses the same
// rate-limit / bot-check / validator spine as the contact & quote routes.
export const POST = withTenantRoute(async (req: NextRequest) => {
  if (await rateLimit(req, 'careers-apply', 8, 30 * 60_000)) {
    return NextResponse.json({ error: 'Too many submissions. Please wait a bit and try again.' }, { status: 429 })
  }
  if (await isBlockedBot()) return NextResponse.json({ error: 'Submission blocked.' }, { status: 403 })

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const submissionKey = body.submissionKey
  if (!validApplicationDraftId(submissionKey)) {
    return NextResponse.json({ error: 'Please refresh the application and try again.' }, { status: 400 })
  }

  const pos: Position | null = body.position === 'driver' || body.position === 'helper' ? body.position : null
  if (!pos) return NextResponse.json({ error: 'Please choose a position.' }, { status: 400 })

  const name = str(body.name, 120)
  const email = str(body.email, 200)
  const phone = str(body.phone, 40)
  if (!name) return NextResponse.json({ error: 'Please enter your full name.' }, { status: 400 })
  if (!email || !isValidEmail(email)) return NextResponse.json({ error: 'Please enter a valid email.' }, { status: 400 })
  if (!phone) return NextResponse.json({ error: 'Please enter a phone number.' }, { status: 400 })

  let submitted
  try {
    submitted = await submitApplicantOnce(submissionKey, async () => {
      const now = Date.now()
      const duplicates = await findApplicantDuplicates(email, phone)
      const applicant: Applicant = {
        id: generateApplicantId(),
        applicantNumber: await nextApplicantNumber(),
        position: pos, name, email, phone,
        age21plus: body.age21plus === true,
        reliableTransport: body.reliableTransport === true,
        canOperateBoxTruck: pos === 'driver' ? body.canOperateBoxTruck === true : undefined,
        canLiftHeavy: body.canLiftHeavy === true,
        smartphone: body.smartphone === true,
        availableStart: str(body.availableStart, 40),
        availableDays: Array.isArray(body.availableDays) ? body.availableDays.map(String).filter(d => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(d)).slice(0, 7) : [],
        availabilityNotes: str(body.availabilityNotes, 500),
        experienceSummary: str(body.experienceSummary, 2000),
        skills: cleanSkills(pos, body.skills),
        scenarios: cleanScenarios(body.scenarios), documents: [],
        score: { score: 0, band: 'not_qualified', components: [], strengths: [], weaknesses: [], riskFactors: [], suggestedQuestions: [], scenarioRubric: { safety: 0, customerService: 0, problemSolving: 0, honesty: 0, professionalism: 0 }, documentsComplete: true, missingDocs: [] },
        status: 'new', source: str(body.source, 120),
        duplicateApplicantNumbers: duplicates.map(d => d.applicantNumber).slice(0, 10),
        events: [{ at: now, actor: 'applicant', action: 'Application submitted' }],
        createdAt: now, updatedAt: now,
      }
      return rescore(applicant)
    })
  } catch (e) {
    console.error('[careers-apply] save', e)
    return NextResponse.json({ error: 'We couldn’t save your application. Please try again.' }, { status: 500 })
  }
  if (!submitted.ok) {
    return NextResponse.json({ error: 'This application is still being submitted. Please wait a moment and try again.' }, { status: 409 })
  }
  const applicant = submitted.applicant

  // Fire-and-forget notifications (never block the response on them).
  const title = POSITIONS[pos].title
  const admin = `${baseUrl()}/admin/careers`
  if (!submitted.replayed) void emailRaw({
    to: [email],
    subject: `We received your ${COMPANY.legalName} contractor application (${applicant.applicantNumber})`,
    html: `<p>Hi ${escapeHtml(name)},</p><p>Thanks for applying for the <strong>${title}</strong> independent-contractor opportunity at ${COMPANY.legalName}. We received your contractor application (<strong>${applicant.applicantNumber}</strong>) and our team will review it shortly.</p><p>If we move forward, we&#39;ll contact you to arrange an interview. Identity, tax, agreement, and badge documents are requested only after approval through a secure onboarding link.</p><p>— ${COMPANY.legalName} Contractor Operations</p>`,
  }).catch(() => {})
  if (!submitted.replayed) void notifyOwnerOfReply({
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
