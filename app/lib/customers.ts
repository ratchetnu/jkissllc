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
  /**
   * Atomic claim: set only if absent. CUST-1 — without this, `findCustomerId`
   * (read) and `indexCustomer` (write) are a check-then-act pair, so two
   * concurrent first-touch upserts for one person both miss the index and both
   * mint a customer. Optional so an existing caller's client keeps compiling;
   * when it is absent the claim degrades to the previous read-then-write, which
   * is no worse than before.
   */
  setNxPx?(key: string, value: string, ttlMs: number): Promise<boolean>
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

  // The identity index doubles as the uniqueness claim, so the claim TTL only has
  // to outlive the few writes between winning it and persisting the record. A
  // crashed claimant frees the identity instead of wedging it forever; the normal
  // path immediately overwrites the key with a permanent (TTL-less) SET below.
  const CLAIM_TTL_MS = 60_000

  /**
   * Try to own this identity. Returns the id that owns it — ours when we won,
   * the WINNER's when we lost, so a loser converges instead of minting a second
   * record. Falls back to the legacy read/write when the client cannot claim.
   */
  async function claimIdentity(key: string, candidateId: string): Promise<string> {
    if (!client.setNxPx) {
      const seen = await client.get(key)
      if (seen) return seen
      await client.set(key, candidateId)
      return candidateId
    }
    const won = await client.setNxPx(key, candidateId, CLAIM_TTL_MS)
    if (won) return candidateId
    // Someone else owns it — read through to their id.
    return (await client.get(key)) ?? candidateId
  }

  async function indexCustomer(c: Customer): Promise<void> {
    if (c.email) await client.set(emailIndex(c.email), c.id)
    if (c.phone && normPhone(c.phone)) await client.set(phoneIndex(c.phone), c.id)
  }

  /**
   * Upsert a customer identity. Reuses an existing record when email/phone match,
   * back-filling missing contact fields; otherwise mints a new id.
   *
   * IDENTITY is exact under concurrency (CUST-1): the index is claimed atomically,
   * so N simultaneous first-touch upserts produce exactly ONE record and every
   * caller returns it.
   *
   * `bookingCount` is BEST-EFFORT, not exact. Updating an existing record is a
   * read-modify-write with no compare-and-set, so two callers incrementing at the
   * same instant can lose one increment. That is pre-existing behaviour in this
   * branch; the identity claim simply makes it reachable on first touch too.
   * Nothing reads this counter today, and making it exact means either a CAS on
   * the record or a separate atomic counter — a data-model change, deliberately
   * out of scope here. Do not treat it as a billing or reporting figure without
   * fixing that first.
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

    // ── First touch: claim the identity BEFORE minting a record ───────────────
    // Email is the primary identity, phone the fallback — the same precedence
    // findCustomerId uses, so the claim and the lookup can never disagree.
    const candidateId = newId()
    const claimKey = normEmail(input.email)
      ? emailIndex(input.email!)
      : (normPhone(input.phone).length >= 7 ? phoneIndex(input.phone!) : null)

    if (claimKey) {
      const ownerId = await claimIdentity(claimKey, candidateId)
      if (ownerId !== candidateId) {
        // We lost the race. Converge on the winner rather than creating a rival
        // record; re-running the upsert now takes the `existingId` branch, so the
        // booking count and any back-filled contact fields still land.
        //
        // The winner may have claimed microseconds ago and not persisted yet, so
        // wait briefly for its record instead of assuming it will never exist.
        for (let i = 0; i < 5; i++) {
          if (await getCustomer(ownerId)) return upsertCustomer(input)
          await new Promise<void>(r => setTimeout(r, 50))
        }
        // Still nothing: the claimant died mid-write. Take the identity over
        // rather than deadlock on a record that is never coming.
        await client.set(claimKey, candidateId)
      }
    }

    const customer: Customer = {
      id: candidateId,
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
    await indexCustomer(customer)   // permanent SET — replaces the TTL'd claim
    return { customer, isNew: true }
  }

  return { getCustomer, findCustomerId, upsertCustomer }
}

const defaultCustomers = makeCustomers(redis)
export const getCustomer = defaultCustomers.getCustomer
export const findCustomerId = defaultCustomers.findCustomerId
export const upsertCustomer = defaultCustomers.upsertCustomer
