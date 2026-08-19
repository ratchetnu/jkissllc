import { COMPANY } from './company'
import { redis } from './redis'

const KEY = 'settings:business-address'

export type BusinessAddress = {
  line1: string
  line2?: string
  city: string
  state: string
  postalCode: string
}

export const DEFAULT_BUSINESS_ADDRESS: BusinessAddress = {
  line1: COMPANY.address.line1,
  city: COMPANY.address.city,
  state: COMPANY.address.state,
  postalCode: COMPANY.address.zip,
}

const STATE = /^[A-Z]{2}$/
const POSTAL_CODE = /^\d{5}(?:-\d{4})?$/

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function parseBusinessAddress(value: unknown): { address?: BusinessAddress; error?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Business address is required.' }
  const body = value as Record<string, unknown>
  const line1 = text(body.line1, 120)
  const line2 = text(body.line2, 80)
  const city = text(body.city, 80)
  const state = typeof body.state === 'string' ? body.state.trim().toUpperCase() : ''
  const postalCode = typeof body.postalCode === 'string' ? body.postalCode.trim() : ''
  if (!line1 || !city || !state || !postalCode) return { error: 'Street, city, state, and ZIP code are required.' }
  if (!STATE.test(state)) return { error: 'State must be a two-letter abbreviation.' }
  if (!POSTAL_CODE.test(postalCode)) return { error: 'Enter a valid ZIP code.' }
  return { address: { line1, ...(line2 ? { line2 } : {}), city, state, postalCode } }
}

export function formatBusinessAddress(address: BusinessAddress): string {
  return [address.line1, address.line2, `${address.city}, ${address.state} ${address.postalCode}`].filter(Boolean).join(', ')
}

export async function getBusinessAddress(): Promise<BusinessAddress> {
  const raw = await redis.get(KEY)
  if (!raw) return DEFAULT_BUSINESS_ADDRESS
  try {
    return parseBusinessAddress(JSON.parse(raw)).address ?? DEFAULT_BUSINESS_ADDRESS
  } catch {
    return DEFAULT_BUSINESS_ADDRESS
  }
}

export async function saveBusinessAddress(value: unknown): Promise<{ address?: BusinessAddress; error?: string }> {
  const parsed = parseBusinessAddress(value)
  if (!parsed.address) return parsed
  await redis.set(KEY, JSON.stringify(parsed.address))
  return parsed
}
