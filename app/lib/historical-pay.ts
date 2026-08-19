import { centralToday, daysBetween, isDateStr } from './dates'
import { parseMoneyCents } from './finance'
import type { StatementDeduction, StatementLine } from './pay-statements'

// Historical pay is a manual statement snapshot, never a synthetic route, booking,
// or punch. The admin supplies the pay period and one or more earnings calculations;
// this module validates and freezes the resulting cents before anything is written.

export type HistoricalPeriodUnit = 'day' | 'week' | 'month' | 'custom'
export type HistoricalEarningKind = 'hourly' | 'daily' | 'fixed'
export type HistoricalPaymentMethod = 'cash' | 'check' | 'direct_deposit' | 'zelle' | 'other'

export type HistoricalPayInput = {
  periodStart: unknown
  periodEnd: unknown
  periodUnit: unknown
  paymentDate: unknown
  paymentMethod?: unknown
  paymentReference?: unknown
  note?: unknown
  lines: unknown
  deductions?: unknown
}

export type ValidatedHistoricalPay = {
  periodStart: string
  periodEnd: string
  periodUnit: HistoricalPeriodUnit
  paymentDate: string
  paymentMethod?: HistoricalPaymentMethod
  paymentReference?: string
  note?: string
  lines: StatementLine[]
  deductions: StatementDeduction[]
  grossCents: number
  deductionCents: number
  netCents: number
}

export type HistoricalPayValidation =
  | { ok: true; value: ValidatedHistoricalPay }
  | { ok: false; error: string; field?: string }

const PERIOD_UNITS = new Set<HistoricalPeriodUnit>(['day', 'week', 'month', 'custom'])
const EARNING_KINDS = new Set<HistoricalEarningKind>(['hourly', 'daily', 'fixed'])
const PAYMENT_METHODS = new Set<HistoricalPaymentMethod>(['cash', 'check', 'direct_deposit', 'zelle', 'other'])
const MAX_LINES = 30
const MAX_DEDUCTIONS = 20
const MAX_QUANTITY = 10_000
const MAX_RATE_CENTS = 1_000_000       // $10,000 per hour/day
const MAX_LINE_CENTS = 100_000_000     // $1,000,000 per line
const MAX_STATEMENT_CENTS = 100_000_000 // $1,000,000 total statement
const MAX_CUSTOM_DAYS = 366
const MIN_HISTORICAL_DATE = '2000-01-01'

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

function isCalendarDate(value: string): boolean {
  if (!isDateStr(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function dateInput(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length === 10 ? trimmed : ''
}

// The shared money parser intentionally rounds numeric callers. Historical pay is
// stricter because it becomes an immutable money record: JSON numbers with more
// than two decimals are rejected, just like over-precise strings.
function exactMoneyCents(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null
    const scaled = value * 100
    const rounded = Math.round(scaled)
    if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-9) return null
  }
  return parseMoneyCents(value)
}

function dayDistance(start: string, end: string): number {
  const stamp = (value: string) => {
    const [year, month, day] = value.split('-').map(Number)
    return Date.UTC(year, month - 1, day)
  }
  return Math.round((stamp(end) - stamp(start)) / 86_400_000)
}

function quantity(value: unknown): { value: number; hundredths: number } | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isFinite(n) || n <= 0 || n > MAX_QUANTITY) return null
  const hundredths = n * 100
  const rounded = Math.round(hundredths)
  if (!Number.isSafeInteger(rounded) || Math.abs(hundredths - rounded) > 1e-9) return null
  return { value: rounded / 100, hundredths: rounded }
}

function defaultDescription(kind: HistoricalEarningKind): string {
  if (kind === 'hourly') return 'Regular hours'
  if (kind === 'daily') return 'Daily pay'
  return 'Prior-period compensation'
}

export function validateHistoricalPay(input: HistoricalPayInput): HistoricalPayValidation {
  const start = dateInput(input.periodStart)
  const end = dateInput(input.periodEnd)
  const paymentDate = dateInput(input.paymentDate)
  if (!isCalendarDate(start) || !isCalendarDate(end) || end < start) {
    return { ok: false, field: 'period', error: 'Select a valid pay period.' }
  }
  if (!isCalendarDate(paymentDate)) {
    return { ok: false, field: 'paymentDate', error: 'Select the date this pay was paid.' }
  }
  const today = centralToday()
  if (start < MIN_HISTORICAL_DATE || end > today) {
    return { ok: false, field: 'period', error: `Historical pay must be dated between ${MIN_HISTORICAL_DATE} and today.` }
  }
  if (paymentDate < start || paymentDate > today) {
    return { ok: false, field: 'paymentDate', error: 'Payment date must be on or after the period start and no later than today.' }
  }

  const periodUnit = input.periodUnit
  if (typeof periodUnit !== 'string' || !PERIOD_UNITS.has(periodUnit as HistoricalPeriodUnit)) {
    return { ok: false, field: 'periodUnit', error: 'Choose day, week, month, or custom period.' }
  }
  if (periodUnit === 'day' && start !== end) {
    return { ok: false, field: 'period', error: 'A daily pay statement must begin and end on the same day.' }
  }
  if (periodUnit === 'week' && dayDistance(start, end) !== 6) {
    return { ok: false, field: 'period', error: 'A weekly pay statement must cover exactly seven days.' }
  }
  if (periodUnit === 'month') {
    const [year, month, startDay] = start.split('-').map(Number)
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const expectedEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    if (startDay !== 1 || end !== expectedEnd) {
      return { ok: false, field: 'period', error: 'A monthly pay statement must cover one full calendar month.' }
    }
  }
  if (periodUnit === 'custom' && daysBetween(start, end) >= MAX_CUSTOM_DAYS) {
    return { ok: false, field: 'period', error: `A custom pay period cannot exceed ${MAX_CUSTOM_DAYS} calendar days.` }
  }

  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_LINES) {
    return { ok: false, field: 'lines', error: `Add between 1 and ${MAX_LINES} earnings lines.` }
  }

  const lines: StatementLine[] = []
  for (let i = 0; i < input.lines.length; i++) {
    const raw = input.lines[i]
    if (!raw || typeof raw !== 'object') return { ok: false, field: `lines.${i}`, error: `Earnings line ${i + 1} is invalid.` }
    const row = raw as Record<string, unknown>
    const kind = row.kind
    if (typeof kind !== 'string' || !EARNING_KINDS.has(kind as HistoricalEarningKind)) {
      return { ok: false, field: `lines.${i}.kind`, error: `Choose hourly, daily, or fixed for earnings line ${i + 1}.` }
    }
    const typedKind = kind as HistoricalEarningKind
    const description = text(row.description, 120) || defaultDescription(typedKind)
    let amountCents: number
    let qty: number | undefined
    let rateCents: number | undefined

    if (typedKind === 'fixed') {
      const amount = exactMoneyCents(row.amount)
      if (amount == null || amount <= 0 || amount > MAX_LINE_CENTS) {
        return { ok: false, field: `lines.${i}.amount`, error: `Enter a valid fixed amount for earnings line ${i + 1}.` }
      }
      amountCents = amount
    } else {
      const parsedQuantity = quantity(row.quantity)
      const parsedRate = exactMoneyCents(row.rate)
      if (parsedQuantity == null) {
        return { ok: false, field: `lines.${i}.quantity`, error: `Enter a positive number of ${typedKind === 'hourly' ? 'hours' : 'days'} for earnings line ${i + 1}.` }
      }
      if (parsedRate == null || parsedRate <= 0 || parsedRate > MAX_RATE_CENTS) {
        return { ok: false, field: `lines.${i}.rate`, error: `Enter a valid ${typedKind === 'hourly' ? 'hourly' : 'daily'} rate for earnings line ${i + 1}.` }
      }
      qty = parsedQuantity.value
      rateCents = parsedRate
      amountCents = Math.round((parsedQuantity.hundredths * parsedRate) / 100)
      if (amountCents <= 0 || amountCents > MAX_LINE_CENTS) {
        return { ok: false, field: `lines.${i}`, error: `Earnings line ${i + 1} exceeds the allowed amount.` }
      }
    }

    lines.push({
      source: 'historical',
      routeNumber: description,
      routeDate: start,
      businessName: 'Historical compensation',
      amountCents,
      description,
      earningKind: typedKind,
      ...(qty !== undefined ? { quantity: qty } : {}),
      ...(rateCents !== undefined ? { rateCents } : {}),
    })
  }

  const rawDeductions = input.deductions ?? []
  if (!Array.isArray(rawDeductions) || rawDeductions.length > MAX_DEDUCTIONS) {
    return { ok: false, field: 'deductions', error: `Add no more than ${MAX_DEDUCTIONS} deductions.` }
  }
  const deductions: StatementDeduction[] = []
  for (let i = 0; i < rawDeductions.length; i++) {
    const raw = rawDeductions[i]
    if (!raw || typeof raw !== 'object') return { ok: false, field: `deductions.${i}`, error: `Deduction ${i + 1} is invalid.` }
    const row = raw as Record<string, unknown>
    const label = text(row.label, 120)
    const amountCents = exactMoneyCents(row.amount)
    if (!label) return { ok: false, field: `deductions.${i}.label`, error: `Add a label for deduction ${i + 1}.` }
    if (amountCents == null || amountCents <= 0 || amountCents > MAX_LINE_CENTS) {
      return { ok: false, field: `deductions.${i}.amount`, error: `Enter a valid amount for deduction ${i + 1}.` }
    }
    deductions.push({ label, amountCents })
  }

  const grossCents = lines.reduce((sum, line) => sum + line.amountCents, 0)
  const deductionCents = deductions.reduce((sum, line) => sum + line.amountCents, 0)
  if (grossCents > MAX_STATEMENT_CENTS) {
    return { ok: false, field: 'lines', error: 'Historical gross pay cannot exceed $1,000,000 on one statement.' }
  }
  if (deductionCents > grossCents) {
    return { ok: false, field: 'deductions', error: 'Deductions cannot exceed gross pay.' }
  }

  const method = input.paymentMethod
  if (method !== undefined && method !== '' && (typeof method !== 'string' || !PAYMENT_METHODS.has(method as HistoricalPaymentMethod))) {
    return { ok: false, field: 'paymentMethod', error: 'Choose a valid payment method.' }
  }
  const paymentReference = text(input.paymentReference, 120) || undefined
  const note = text(input.note, 1000) || undefined

  return {
    ok: true,
    value: {
      periodStart: start,
      periodEnd: end,
      periodUnit: periodUnit as HistoricalPeriodUnit,
      paymentDate,
      ...(method ? { paymentMethod: method as HistoricalPaymentMethod } : {}),
      ...(paymentReference ? { paymentReference } : {}),
      ...(note ? { note } : {}),
      lines,
      deductions,
      grossCents,
      deductionCents,
      netCents: grossCents - deductionCents,
    },
  }
}
