# 16 — Hosting Phase 2 Status

Phase 2 closes the code-level blockers that made a second hosted tenant unsafe.
It does **not** turn tenancy on in Production or copy Production data.

## Completed in code

- Every API route is classified as session-scoped, public-token scoped,
  verified-host scoped, background-scoped, or explicitly platform-global.
- Public host routes resolve against each tenant's persisted verified domains.
- Twilio and inbound-email callbacks resolve by a unique tenant-owned channel;
  unknown or ambiguous channels fail closed.
- Background jobs enumerate the durable active-tenant registry. The retired
  hardcoded J KISS list is gone, and an empty registry blocks tenant mode.
- Blob writes found by the static audit use the tenant path chokepoint.
- Health reports one named tenancy operating profile and calls out invalid flag
  combinations without exposing values.
- `npm run tenant:certify` is the permanent enforcement gate.

## Required before a Supercharged Preview cutover

1. Persist the Supercharged tenant record with unique domains, phone channel,
   support email, branding, and active status.
2. Run the Preview migration `inventory`, `dry-run`, `migrate`, and `verify`
   commands; stop on any conflict or mismatch.
3. Use `shadow_validation`, then `migration`, then `tenant_reads` in Preview.
4. Run `npm run tenant:certify` and the end-to-end Supercharged/J KISS isolation
   journey against that Preview.

Production remains unchanged until the Preview evidence and migration manifest
are reviewed. No Production flag flip, backfill, or legacy deletion is part of
this phase.
