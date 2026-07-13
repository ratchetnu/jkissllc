// Flagged reference route. Hidden entirely (404) unless
// DESIGN_SYSTEM_REFERENCE_ENABLED is on — so it never appears in production and
// disturbs no existing navigation.

import { notFound } from 'next/navigation'
import { isEnabled } from '../../../lib/platform/flags'
import Gallery from './Gallery'

export const dynamic = 'force-dynamic'

export default function DesignReferencePage() {
  if (!isEnabled('DESIGN_SYSTEM_REFERENCE_ENABLED')) notFound()
  return <Gallery />
}
