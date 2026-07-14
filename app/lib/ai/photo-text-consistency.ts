// ─────────────────────────────────────────────────────────────────────────────
// Photo ↔ text consistency checks (Part 8). Compare the customer's confirmed
// inventory + answers against what the FIRST AI analysis actually observed in the
// photos, and surface neutral, customer-safe flags. Material conflicts route the
// request to owner review; they NEVER accuse the customer of anything.
//
// Pure + dependency-free. Every message is neutral by construction.
// ─────────────────────────────────────────────────────────────────────────────

import type { JunkPhotoAnalysis } from './analysis-schema'
import { taxonomyEntry } from './inventory-taxonomy'
import {
  activeItems, customerAddedItems, removedDetections,
  type CustomerConfirmation, type ConflictFlag,
} from './confirmation-schema'

// Governed volume (cu yd) of the confirmed, priced list — from the taxonomy, not
// from any customer-entered number.
export function confirmedVolumeCubicYards(c: CustomerConfirmation): number {
  return activeItems(c).reduce((sum, it) => sum + taxonomyEntry(it.category).perUnitVolumeCubicYards * it.quantity, 0)
}

const NEUTRAL_REVIEW = 'We need a quick review because some details may require clarification.'

/**
 * Detect consistency flags between the photo analysis and the confirmation.
 * `analysis` may be a zero-item / fallback analysis (JK-B-1007 style) — in that
 * case photo-derived comparisons are skipped, and only the customer's own
 * disclosures drive flags.
 */
export function detectPhotoTextConflicts(
  analysis: Pick<JunkPhotoAnalysis, 'normalizedItems' | 'totalEstimatedVolumeCubicYards' | 'photoObservations' | 'detectedConditions'> | undefined,
  c: CustomerConfirmation,
): ConflictFlag[] {
  const flags: ConflictFlag[] = []
  const push = (code: string, severity: ConflictFlag['severity'], message: string) => {
    if (!flags.some(f => f.code === code)) flags.push({ code, severity, message })
  }

  const d = c.disclosures
  const added = customerAddedItems(c)
  const removed = removedDetections(c)
  const photoVolume = analysis?.totalEstimatedVolumeCubicYards?.likely ?? 0
  const confirmVolume = confirmedVolumeCubicYards(c)
  const hasPhotoRead = !!analysis && analysis.normalizedItems.length > 0
  const photosLimited = (analysis?.photoObservations ?? []).length > 0
    && (analysis?.photoObservations ?? []).every(p => p.imageQuality === 'limited' || p.imageQuality === 'unusable')

  // 1) Customer added items the AI could not see (may not be in the photos).
  if (added.length > 0) {
    const heavyAdded = added.some(it => taxonomyEntry(it.category).heavy || taxonomyEntry(it.category).specialHandling)
    push('items_added_not_detected',
      heavyAdded ? 'material' : 'minor',
      `You added ${added.length} item${added.length > 1 ? 's' : ''} we didn’t spot in the photos — ${NEUTRAL_REVIEW}`)
  }

  // 2) AI detected items the customer removed (photos still show them).
  if (removed.length > 0) {
    const confidentRemoval = removed.some(it => (it.aiConfidence ?? 0) >= 0.6)
    push('detections_removed',
      confidentRemoval ? 'material' : 'minor',
      'Some items we saw in the photos were removed from the list — a quick review will confirm the final scope.')
  }

  // 3) Quantity inconsistency — confirmed qty far exceeds what a photo suggested.
  for (const it of activeItems(c)) {
    if (it.aiDetected && it.aiQuantity != null && it.aiQuantity > 0 && it.quantity >= it.aiQuantity * 3 && it.quantity - it.aiQuantity >= 3) {
      push('quantity_jump', 'material',
        'A confirmed quantity is much higher than the photos suggested — we’ll confirm the truck space needed.')
      break
    }
  }

  // 4) "Everything is pictured" but the photos look incomplete.
  const everythingPictured = d.everythingVisibleInPhotos === true || c.photoQuality.allItemsPictured === true
  if (everythingPictured && (photosLimited || (hasPhotoRead && confirmVolume > photoVolume * 1.5 && confirmVolume - photoVolume > 2))) {
    push('all_pictured_but_incomplete', 'material',
      'The photos may not show everything on the list — an extra photo or a quick review will help us quote accurately.')
  }

  // 5) Photos show MORE volume than the confirmed list (possible missed items).
  if (hasPhotoRead && photoVolume > confirmVolume * 1.6 && photoVolume - confirmVolume > 3) {
    push('photos_exceed_list', 'minor',
      'The photos look like they may include more than the confirmed list — we’ll double-check before the crew arrives.')
  }

  // 6) Heavy / dense debris disclosed but not clearly visible in the photos.
  if ((d.containsDenseDebris || d.excessivelyHeavyItems) && hasPhotoRead) {
    const denseVisible = analysis!.detectedConditions.concreteOrSoilPossible
      || analysis!.normalizedItems.some(i => i.heavy || i.category === 'construction_debris')
    if (!denseVisible) {
      push('heavy_not_visible', 'material',
        'You mentioned heavy or dense material we couldn’t clearly see — this can affect weight and disposal, so we’ll review it.')
    }
  }

  // 7) Customer reported hidden / additional items → always at least a minor flag.
  if (d.hiddenItems || d.additionalItemsNotPictured) {
    push('hidden_or_additional', d.hiddenItems ? 'material' : 'minor',
      'You noted items that may be hidden or not pictured — we’ll make sure the quote covers everything.')
  }

  // 8) Access answers conflict with visible conditions.
  const ac = c.accessConditions
  if (analysis?.detectedConditions.stairs && ac.itemsUpstairs === false && ac.elevatorAvailable !== true) {
    push('access_conflict_stairs', 'minor',
      'The photos suggest stairs, so we’ll confirm the carry path to price the labor correctly.')
  }

  // 9) Hazardous disclosed → always material (hard route to review; priced by a human).
  if (d.containsHazardous) {
    push('hazardous_disclosed', 'material',
      'You told us the load may include hazardous or special-disposal items, so a team member will confirm handling and price.')
  }

  return flags
}

/** True when any flag is material — the request should route to owner review. */
export function hasMaterialConflict(flags: ConflictFlag[]): boolean {
  return flags.some(f => f.severity === 'material')
}
