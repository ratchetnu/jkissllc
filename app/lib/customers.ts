import { randomUUID } from 'node:crypto'
import { redis } from './redis'

// ── Customer identity (the one genuinely-new store) ──────────────────────────
//
// The universal intake needs a stable identity for a returning customer so a
// second booking links to the first. Everything else in the workflow is an
// event-sourced projection; this is the small store that gives a person a
// durable id, deduped by normalized email (primary) then phone (fallback).
//
// Tenant-owned keys (`cust:*`, no platform: prefix) → the tenancy chokepoint
// namespaces them per tenant when TENANCY_ENABLED. A factory (makeCustomers) over
// a minimal client keeps the dedup logic unit-testable; the default binds to redis.

export type Customer = {
  id: string
  tenantId?: string
  name: string
  email?: string
  phone?: string
  firstBookingToken?: string
  bookingCount: number
  createdAt: number
  updatedAt: number
}

export type UpsertCustomerInput = {
  name: string
  email?: string
  phone?: string
  tenantId?: string
  bookingToken?: string // increments bookingCount + records the first booking
}

/** The subset of the redis wrapper this store needs — lets tests inject a fake. */
export interface CustomerClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

const custKey = (id: string) => `cust:${id}`
const emailIndex = (email: string) => `cust:email:${normEmail(email)}`
const phoneIndex = (phone: string) => `cust:phone:${normPhone(phone)}`

export const normEmail = (e?: string): string => (e ?? '').trim().toLowerCase()
export const normPhone = (p?: string): string => (p ?? '').replace(/\D/g, '')

const newId = (): string => `c_${randomUUID().replace(/-/g, '').slice(0, 20)}`

export function makeCustomers(client: CustomerClient) {
  async function getCustomer(id: string): Promise<Customer | null> {
    const raw = await client.get(custKey(id))
    if (!raw) return null
    try { return JSON.parse(raw) as Customer } catch { return null }
  }

  /** Resolve an existing customer id by email (primary) or phone (fallback). */
  async function findCustomerId(email?: string, phone?: string): Promise<string | null> {
    if (normEmail(email)) {
      const id = await client.get(emailIndex(email!))
      if (id) return id
    }
    if (normPhone(phone).length >= 7) {
      const id = await client.get(phoneIndex(phone!))
      if (id) return id
    }
    return null
  }

  async function indexCustomer(c: Customer): Promise<void> {
    if (c.email) await client.set(emailIndex(c.email), c.id)
    if (c.phone && normPhone(c.phone)) await client.set(phoneIndex(c.phone), c.id)
  }

  /**
   * Upsert a customer identity. Reuses an existing record when email/phone match,
   * back-filling missing contact fields; otherwise mints a new id.
   */
  async function upsertCustomer(input: UpsertCustomerInput): Promise<{ customer: Customer; isNew: boolean }> {
    const now = Date.now()
    const existingId = await findCustomerId(input.email, input.phone)

    if (existingId) {
      const existing = await getCustomer(existingId)
      if (existing) {
        const updated: Customer = {
          ...existing,
          name: input.name || existing.name,
          email: existing.email || (normEmail(input.email) || undefined),
          phone: existing.phone || (normPhone(input.phone) ? input.phone : undefined),
          bookingCount: existing.bookingCount + (input.bookingToken ? 1 : 0),
          updatedAt: now,
        }
        await client.set(custKey(updated.id), JSON.stringify(updated))
        await indexCustomer(updated)
        return { customer: updated, isNew: false }
      }
    }

    const customer: Customer = {
      id: newId(),
      tenantId: input.tenantId,
      name: input.name,
      email: normEmail(input.email) || undefined,
      phone: normPhone(input.phone) ? input.phone : undefined,
      firstBookingToken: input.bookingToken,
      bookingCount: input.bookingToken ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    }
    await client.set(custKey(customer.id), JSON.stringify(customer))
    await indexCustomer(customer)
    return { customer, isNew: true }
  }

  return { getCustomer, findCustomerId, upsertCustomer }
}

const defaultCustomers = makeCustomers(redis)
export const getCustomer = defaultCustomers.getCustomer
export const findCustomerId = defaultCustomers.findCustomerId
export const upsertCustomer = defaultCustomers.upsertCustomer
