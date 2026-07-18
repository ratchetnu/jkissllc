// ── Product registration — validate + build (pure) ───────────────────────────
//
// Turns a registration payload into a validated SyncProduct. Adding a product to the
// Update Center is ONLY this — no code change. Every field the spec lists is accepted
// here; the id is a safe slug, providers are free-form strings (the provider registry
// resolves them, unknown ⇒ fail-closed stub), and unset optional fields are fine.

import { SYNC_RECORD_VERSION, type ProductStatus, type ProductType, type SyncProduct } from './types'

export type ProductInput = {
  id?: string
  displayName?: string
  productType?: string
  status?: string
  sourceProvider?: string
  githubOwner?: string
  githubRepo?: string
  defaultBranch?: string
  deploymentProvider?: string
  vercelProject?: string
  productionUrl?: string
  healthPath?: string
  platformSourceId?: string | null
  supportsPlatformSync?: boolean
  supportsDeploymentTracking?: boolean
}

const PRODUCT_TYPES: ProductType[] = ['platform_source', 'branded_clone', 'standalone', 'library', 'other']
const STATUSES: ProductStatus[] = ['active', 'paused', 'archived']
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export type BuildResult = { ok: true; product: SyncProduct } | { ok: false; error: string }

/**
 * Validate a registration/update payload and build a SyncProduct. On update pass the
 * existing record so createdAt (and any unspecified field) is preserved.
 */
export function validateAndBuildProduct(input: ProductInput, existing: SyncProduct | null, now: number): BuildResult {
  const id = (str(input.id) ?? existing?.id ?? '').toLowerCase()
  if (!id) return { ok: false, error: 'id is required' }
  if (!SLUG.test(id)) return { ok: false, error: 'id must be a slug [a-z0-9-]' }

  const displayName = str(input.displayName) ?? existing?.displayName
  if (!displayName) return { ok: false, error: 'displayName is required' }

  const productType = (str(input.productType) ?? existing?.productType ?? 'standalone') as ProductType
  if (!PRODUCT_TYPES.includes(productType)) return { ok: false, error: `productType must be one of ${PRODUCT_TYPES.join(', ')}` }

  const status = (str(input.status) ?? existing?.status ?? 'active') as ProductStatus
  if (!STATUSES.includes(status)) return { ok: false, error: `status must be one of ${STATUSES.join(', ')}` }

  const platformSourceId =
    input.platformSourceId === null ? null
    : str(input.platformSourceId) ?? existing?.platformSourceId ?? null
  if (platformSourceId && platformSourceId === id) return { ok: false, error: 'a product cannot be its own platform source' }

  const product: SyncProduct = {
    recordVersion: SYNC_RECORD_VERSION,
    id,
    displayName,
    productType,
    status,
    sourceProvider: str(input.sourceProvider) ?? existing?.sourceProvider ?? 'github',
    githubOwner: str(input.githubOwner) ?? existing?.githubOwner,
    githubRepo: str(input.githubRepo) ?? existing?.githubRepo,
    defaultBranch: str(input.defaultBranch) ?? existing?.defaultBranch ?? 'main',
    deploymentProvider: str(input.deploymentProvider) ?? existing?.deploymentProvider ?? 'vercel',
    vercelProject: str(input.vercelProject) ?? existing?.vercelProject,
    productionUrl: str(input.productionUrl) ?? existing?.productionUrl,
    healthPath: str(input.healthPath) ?? existing?.healthPath ?? '/api/health',
    platformSourceId,
    supportsPlatformSync: typeof input.supportsPlatformSync === 'boolean' ? input.supportsPlatformSync : existing?.supportsPlatformSync ?? false,
    supportsDeploymentTracking: typeof input.supportsDeploymentTracking === 'boolean' ? input.supportsDeploymentTracking : existing?.supportsDeploymentTracking ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  return { ok: true, product }
}
