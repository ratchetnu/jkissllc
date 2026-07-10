// Small display helpers shared across the crew portal pages. Kept local to the
// portal so it has no coupling to the admin operations UI.

export const money = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export const fmtDay = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export const fmtLongDay = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
}

export const mapsUrl = (a: string): string =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`

export const STATUS_LABEL: Record<string, { label: string; fg: string; bg: string }> = {
  draft: { label: 'Draft', fg: '#cbd5e1', bg: 'rgba(148,163,184,.15)' },
  assigned: { label: 'Assigned', fg: '#fcd34d', bg: 'rgba(252,211,77,.14)' },
  text_sent: { label: 'Sent', fg: '#fcd34d', bg: 'rgba(252,211,77,.14)' },
  confirmed: { label: 'Confirmed', fg: '#86efac', bg: 'rgba(134,239,172,.14)' },
  completed: { label: 'Completed', fg: '#93c5fd', bg: 'rgba(96,165,250,.14)' },
  cancelled: { label: 'Cancelled', fg: '#fca5a5', bg: 'rgba(248,113,113,.14)' },
  declined: { label: 'Declined', fg: '#fca5a5', bg: 'rgba(248,113,113,.14)' },
}
export const statusOf = (s: string) => STATUS_LABEL[s] ?? STATUS_LABEL.draft
