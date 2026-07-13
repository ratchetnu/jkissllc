// Pure, client-safe helper for the Book Now wizard's industry-pack service filter.
// Kept dependency-free (no server imports) so the public wizard can import it
// without pulling the pack registry into the client bundle.

/**
 * Which of the app's services to show for the active pack: the pack's matching
 * set, or ALL services when the pack defines none that match (never an empty
 * grid). This is what preserves the junk-removal reference experience — if the
 * pack's template ids don't line up with the wizard catalog, the customer still
 * sees the full catalog rather than nothing.
 */
export function filterServicesByPack<T extends { id: string }>(services: T[], packServiceIds: string[]): T[] {
  if (!packServiceIds.length) return services
  const ids = new Set(packServiceIds)
  const filtered = services.filter((s) => ids.has(s.id))
  return filtered.length ? filtered : services
}
