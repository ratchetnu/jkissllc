import { COMPANY } from './company'

// Stable tenant identifier for this deployment. OpsPilot runs today as replicated
// single-tenant instances (each with its own domain + isolated data namespace), so
// the tenant is fixed per deployment — but every AI record is still stamped with it
// so telemetry is attributable and the same code works unchanged under future pooled
// multi-tenancy. Overridable via TENANT_ID; otherwise derived from the apex host.
export function tenantId(): string {
  const explicit = process.env.TENANT_ID
  if (explicit && explicit.trim()) return explicit.trim()
  try { return new URL(COMPANY.siteUrlApex).host.replace(/^www\./, '') } catch { return 'default' }
}
