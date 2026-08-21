import { createHash, createHmac, randomInt } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { put } from '@vercel/blob'
import { PDFDocument, rgb } from 'pdf-lib'
import { redis } from './redis'
import { sealDoc, docCryptoReady } from './doc-crypto'
import { scopeBlobPath, sanitizeBlobSegment } from './platform/tenancy/blob-keys'
import {
  getContractorAgreementVersion,
  readContractorAgreementBytes,
} from './contractor-agreement'
import type { Applicant, ApplicantDoc, ContractorOnboarding } from './applicants'
import { registerPendingContractorUpload } from './contractor-upload-registry'
import { COMPANY } from './company'

export const ELECTRONIC_CONSENT_VERSION = '2026-08-20-v1'
export const ELECTRONIC_CONSENT_DISCLOSURE =
  `I consent to use electronic records and signatures for this contractor agreement. `
  + `I can download, print, and retain the agreement before signing, may request a paper copy from ${COMPANY.email} at no charge, `
  + `and may withdraw electronic consent before signing by contacting ${COMPANY.email}. Withdrawing consent does not cancel obligations already accepted.`

const CODE_TTL_MS = 10 * 60_000
const MAX_CODE_ATTEMPTS = 5
const OTP_KEY = (applicantId: string) => `app:esign:otp:${applicantId}`

// The code and its expiry must become visible in one Redis operation. A separate
// SET + PEXPIRE briefly creates a reusable code with no TTL if the second command
// is delayed or fails.
const ISSUE_CODE = `
-- ESIGN_ISSUE
redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1
`

// Consume and increment in one Lua transaction so parallel guesses cannot all
// observe the same attempt count. A stale request deliberately leaves the current
// code intact: an old browser tab must not revoke a newer code.
const CONSUME_CODE = `
-- ESIGN_CONSUME
local raw = redis.call('get', KEYS[1])
if not raw then return 0 end
local ok, record = pcall(cjson.decode, raw)
if not ok then redis.call('del', KEYS[1]); return 0 end
if tonumber(record.requestedAt) ~= tonumber(ARGV[1]) then return 0 end
local now = tonumber(ARGV[2])
local expiresAt = tonumber(record.expiresAt) or 0
local attempts = tonumber(record.attempts) or 0
if expiresAt < now or attempts >= tonumber(ARGV[4]) then
  redis.call('del', KEYS[1])
  return 0
end
if record.codeHash == ARGV[3] then
  redis.call('del', KEYS[1])
  return 1
end
attempts = attempts + 1
if attempts >= tonumber(ARGV[4]) then
  redis.call('del', KEYS[1])
else
  record.attempts = attempts
  redis.call('set', KEYS[1], cjson.encode(record), 'PX', math.max(1, expiresAt - now))
end
return 0
`

type SignatureCodeRecord = {
  requestedAt: number
  codeHash: string
  expiresAt: number
  attempts: number
}

function signatureSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET || process.env.DOC_ENCRYPTION_KEY
  if (!secret || secret.length < 16) throw new Error('ELECTRONIC_SIGNATURE_SECRET_UNAVAILABLE')
  return secret
}

function codeHash(applicantId: string, requestedAt: number, code: string): string {
  return createHmac('sha256', signatureSecret())
    .update(`${applicantId}:${requestedAt}:${code}`)
    .digest('hex')
}

export async function issueElectronicSignatureCode(input: {
  applicantId: string
  requestedAt: number
}): Promise<{ code: string; expiresAt: number }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expiresAt = Date.now() + CODE_TTL_MS
  const record: SignatureCodeRecord = {
    requestedAt: input.requestedAt,
    codeHash: codeHash(input.applicantId, input.requestedAt, code),
    expiresAt,
    attempts: 0,
  }
  await redis.eval(ISSUE_CODE, [OTP_KEY(input.applicantId)], [JSON.stringify(record), String(CODE_TTL_MS)])
  return { code, expiresAt }
}

export async function revokeElectronicSignatureCode(applicantId: string): Promise<void> {
  await redis.del(OTP_KEY(applicantId))
}

export async function consumeElectronicSignatureCode(input: {
  applicantId: string
  requestedAt: number
  code: string
}): Promise<boolean> {
  const submittedHash = /^\d{6}$/.test(input.code)
    ? codeHash(input.applicantId, input.requestedAt, input.code)
    : ''
  const result = await redis.eval(CONSUME_CODE, [OTP_KEY(input.applicantId)], [
    String(input.requestedAt), String(Date.now()), submittedHash, String(MAX_CODE_ATTEMPTS),
  ])
  return Number(result) === 1
}

export function requestEvidence(req: Request): { sourceIp: string; userAgent: string } {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const sourceIp = (forwarded || req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || 'unavailable').slice(0, 64)
  const userAgent = (req.headers.get('user-agent') || 'unavailable').replace(/[\r\n]/g, ' ').slice(0, 500)
  return { sourceIp, userAgent }
}

function wrap(text: string, max = 88): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (!line) line = word
    else if (`${line} ${word}`.length <= max) line += ` ${word}`
    else { lines.push(line); line = word }
  }
  if (line) lines.push(line)
  return lines
}

const require = createRequire(import.meta.url)
// Load the CommonJS fontkit bundle directly. Static transpilation of its generated
// tables is needlessly expensive in the test runner and does not change its API.
const fontkit = require('@pdf-lib/fontkit') as Parameters<PDFDocument['registerFontkit']>[0]
const FONT_PACKAGE_DIR = dirname(require.resolve('dejavu-fonts-ttf/package.json'))
const REGULAR_FONT_PATH = join(FONT_PACKAGE_DIR, 'ttf', 'DejaVuSans.ttf')
const BOLD_FONT_PATH = join(FONT_PACKAGE_DIR, 'ttf', 'DejaVuSans-Bold.ttf')
let signatureFonts: Promise<[Buffer, Buffer]> | undefined

function loadSignatureFonts(): Promise<[Buffer, Buffer]> {
  signatureFonts ??= Promise.all([readFile(REGULAR_FONT_PATH), readFile(BOLD_FONT_PATH)])
  return signatureFonts
}

export async function buildExecutedAgreementPdf(input: {
  templateBytes: Buffer
  templateSha256: string
  agreementVersion: number
  applicantNumber: string
  contractor: NonNullable<ContractorOnboarding['electronicSignature']>['contractor']
  company: NonNullable<NonNullable<ContractorOnboarding['electronicSignature']>['company']>
  certificateId: string
}): Promise<Buffer> {
  const actualHash = createHash('sha256').update(input.templateBytes).digest('hex')
  if (actualHash !== input.templateSha256) throw new Error('AGREEMENT_TEMPLATE_HASH_MISMATCH')
  const pdf = await PDFDocument.load(input.templateBytes, { updateMetadata: false })
  pdf.registerFontkit(fontkit)
  const page = pdf.addPage([612, 792])
  const [regularBytes, boldBytes] = await loadSignatureFonts()
  const regular = await pdf.embedFont(regularBytes, { subset: true })
  const bold = await pdf.embedFont(boldBytes, { subset: true })
  const blue = rgb(0.05, 0.34, 0.78)
  let y = 742
  const line = (text: string, opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb>; gap?: number } = {}) => {
    const size = opts.size ?? 10
    page.drawText(text, { x: 54, y, size, font: opts.bold ? bold : regular, color: opts.color ?? rgb(0.12, 0.12, 0.14) })
    y -= opts.gap ?? 16
  }
  line('ELECTRONIC SIGNATURE EXECUTION CERTIFICATE', { bold: true, size: 16, color: blue, gap: 27 })
  for (const part of wrap(`This certificate is attached to and forms part of the J Kiss LLC Independent Contractor Agreement identified below. The original agreement pages precede this certificate and have not been altered.`)) line(part)
  y -= 8
  line(`Agreement version: ${input.agreementVersion}`, { bold: true })
  line(`Applicant record: ${input.applicantNumber}`)
  line(`Original agreement SHA-256: ${input.templateSha256}`, { size: 8, gap: 20 })
  line('CONTRACTOR ELECTRONIC SIGNATURE', { bold: true, color: blue, gap: 21 })
  line(`Signed by: ${input.contractor.name}`, { bold: true })
  line(`Verified email: ${input.contractor.email}`)
  line(`Signed at: ${new Date(input.contractor.signedAt).toISOString()}`)
  line(`Source IP: ${input.contractor.sourceIp}`)
  line(`Electronic-consent version: ${ELECTRONIC_CONSENT_VERSION}`, { gap: 22 })
  line('J KISS LLC COUNTERSIGNATURE', { bold: true, color: blue, gap: 21 })
  line(`Signed by: ${input.company.name}`, { bold: true })
  line(`Title: ${input.company.title}`)
  line(`Authorized account: ${input.company.actorId}`)
  line(`Signed at: ${new Date(input.company.signedAt).toISOString()}`)
  line(`Source IP: ${input.company.sourceIp}`, { gap: 24 })
  for (const part of wrap('Both signers affirm their intent to sign and be bound by the agreement. Operion authenticated the contractor using the version-pinned onboarding link and a one-time code sent to the verified email address.')) line(part)
  y -= 8
  line(`Certificate ID: ${input.certificateId}`, { bold: true })
  line(`Generated by Operion for ${COMPANY.legalName}.`, { size: 9 })
  return Buffer.from(await pdf.save({ useObjectStreams: false }))
}

export async function createExecutedAgreement(input: {
  applicant: Pick<Applicant, 'id' | 'applicantNumber' | 'contractorOnboarding'>
  company: NonNullable<NonNullable<ContractorOnboarding['electronicSignature']>['company']>
  store?: (path: string, bytes: Buffer) => Promise<void>
}): Promise<{ document: ApplicantDoc; certificateId: string; executedSha256: string }> {
  const onboarding = input.applicant.contractorOnboarding
  const signature = onboarding?.electronicSignature
  if (!onboarding?.agreementVersion || !signature?.contractor) throw new Error('CONTRACTOR_SIGNATURE_REQUIRED')
  if (!docCryptoReady()) throw new Error('ELECTRONIC_SIGNATURE_CRYPTO_UNAVAILABLE')
  const template = await getContractorAgreementVersion(onboarding.agreementVersion)
  if (!template || template.sha256 !== signature.contractor.agreementSha256) throw new Error('AGREEMENT_VERSION_MISMATCH')
  const templateBytes = await readContractorAgreementBytes(template)
  const certificateId = `esign_${crypto.randomUUID()}`
  const bytes = await buildExecutedAgreementPdf({
    templateBytes,
    templateSha256: template.sha256,
    agreementVersion: template.version,
    applicantNumber: input.applicant.applicantNumber,
    contractor: signature.contractor,
    company: input.company,
    certificateId,
  })
  const filename = sanitizeBlobSegment(`${certificateId}.pdf.enc`)
  const path = scopeBlobPath(`contractor-docs/contractor_agreement/${filename}`)
  const sealed = sealDoc(bytes)
  if (input.store) await input.store(path, sealed)
  else await put(path, sealed, { access: 'public', contentType: 'application/octet-stream', addRandomSuffix: false })
  await registerPendingContractorUpload({ id: certificateId, applicantId: input.applicant.id, path, createdAt: Date.now() })
  return {
    document: { kind: 'contractor_agreement', url: path, uploadedAt: Date.now() },
    certificateId,
    executedSha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
