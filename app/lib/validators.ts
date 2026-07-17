// Shared input validation & sanitization helpers.
// These were previously duplicated across the contact/quote/coi routes and the
// admin booking routes; consolidated here so behavior stays identical everywhere.

/** Escape a value for safe interpolation into HTML (emails, receipts). */
export function escapeHtml(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Loose-but-practical email check (also used as a type guard). */
export function isValidEmail(email: unknown): email is string {
  if (typeof email !== 'string') return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length < 255
}

/** Trim + cap a string field; returns undefined when empty. */
export function str(v: unknown, max = 500): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim().slice(0, max)
  return t || undefined
}

/** Parse a newline/comma list (or array) into a clean, capped string array. */
export function strList(v: unknown, max = 60): string[] {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean).slice(0, max)
  if (typeof v === 'string') return v.split(/[\n,]/).map(s => s.trim()).filter(Boolean).slice(0, max)
  return []
}

/** Render one CSV cell safely. Two hazards handled together:
 *  1. Formula/DDE injection — a cell a spreadsheet would EVALUATE (starts with
 *     `= + - @` or a leading tab/CR) is prefixed with a single quote so Excel/Sheets
 *     treat it as literal text. Plain numbers (incl. negatives/decimals) are left
 *     alone so numeric columns still sum. This matters because attacker-controlled
 *     fields (customer name/email, promo codes) flow into staff-downloaded exports.
 *  2. Delimiter escaping — cells containing a quote, comma, or newline are wrapped in
 *     double quotes with embedded quotes doubled (RFC 4180).
 * Use for EVERY cell built from user-influenced data in an exported CSV. */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === undefined || v === null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Parse a positive number; returns undefined for empty/invalid/≤0. */
export function num(v: unknown): number | undefined {
  if (v === '' || v === null || v === undefined) return undefined
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) && n > 0 ? n : undefined
}
