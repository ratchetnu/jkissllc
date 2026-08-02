'use client'

// ── Reports — revenue by day ─────────────────────────────────────────────────
// Replaces a 30-row table (mostly $0.00) with one glanceable bar chart. Same
// idiom as ai/shadow/TrendChart: a self-contained inline SVG, no chart library,
// CSP-safe, themed from the admin CSS vars, pointer + touch + keyboard hover,
// and touch-action:pan-y so mobile users are never scroll-trapped.
//
// Form: discrete daily magnitude over time → vertical bars, not a line. A zero
// day is an ABSENT bar over a baseline tick, which reads as "nothing happened"
// rather than a line dropping to the floor.
//
// One series, so there is no legend — the heading names it. Only the peak day is
// labelled; a number on every bar is noise. The full day-by-day table is still
// here, one tap away, so the exact figures and the CSV never disappear.

import { useMemo, useRef, useState } from 'react'
import { Download } from 'lucide-react'

export type DayRow = { date: string; amountCents: number }

// Validated against the #121214 card surface with the dataviz palette checker:
// lightness band, chroma floor and contrast all pass in dark mode.
const MARK = '#16a34a'

const W = 640, H = 132, PADX = 4, TOP = 18, BASE = H - 22

const usd = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const usdCompact = (c: number) => {
  const d = c / 100
  return d >= 1000 ? `$${(d / 1000).toFixed(d >= 10000 ? 0 : 1)}k` : `$${Math.round(d)}`
}
const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export default function RevenueTrend({ rows, exportHref }: { rows: DayRow[]; exportHref: string }) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  const { total, peak, activeDays } = useMemo(() => {
    let total = 0, peak = -1, activeDays = 0
    rows.forEach((r, i) => {
      total += r.amountCents
      if (r.amountCents > 0) activeDays++
      if (peak < 0 || r.amountCents > rows[peak].amountCents) peak = i
    })
    return { total, peak, activeDays }
  }, [rows])

  const n = rows.length
  const yMax = Math.max(1, ...rows.map(r => r.amountCents))
  // 2px surface gap between adjacent bars (mark spec), so fills never touch.
  const slot = n > 0 ? (W - 2 * PADX) / n : 0
  const barW = Math.max(2, slot - 2)
  const x = (i: number) => PADX + i * slot + (slot - barW) / 2
  const h = (c: number) => (c <= 0 ? 0 : Math.max(3, (c / yMax) * (BASE - TOP)))

  const setFromClientX = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || n === 0) return
    const frac = (clientX - rect.left) / rect.width
    setHover(Math.max(0, Math.min(n - 1, Math.floor(frac * n))))
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') { setHover(v => Math.min(n - 1, (v ?? -1) + 1)); e.preventDefault() }
    else if (e.key === 'ArrowLeft') { setHover(v => Math.max(0, (v ?? n) - 1)); e.preventDefault() }
    else if (e.key === 'Escape') setHover(null)
  }

  const active = hover != null ? rows[hover] : null
  const labelled = active ?? (peak >= 0 && rows[peak].amountCents > 0 ? rows[peak] : null)
  const labelledIdx = hover != null ? hover : (peak >= 0 && rows[peak].amountCents > 0 ? peak : -1)

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 14, padding: 16, marginBottom: 16, background: 'var(--card)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Revenue by day</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--text)', letterSpacing: '-.02em', lineHeight: 1.15, marginTop: 4 }}>{usd(total)}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
            {n === 0 ? 'No days in range' : `Last ${n} days · ${activeDays === 0 ? 'no days with revenue' : activeDays === 1 ? '1 day with revenue' : `${activeDays} days with revenue`}`}
          </div>
        </div>
        <a href={exportHref} download style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 11px', border: '1px solid var(--line)', borderRadius: 10, background: 'color-mix(in srgb, var(--card) 90%, transparent)', color: 'var(--muted)', fontSize: 12.5, fontWeight: 700, textDecoration: 'none' }}>
          <Download size={13} /> Export CSV
        </a>
      </div>

      {activeDays === 0 ? (
        <div style={{ height: 96, display: 'grid', placeItems: 'center', color: 'var(--muted)', fontSize: 13, border: '1px dashed var(--line)', borderRadius: 10 }}>
          No revenue recorded in this period.
        </div>
      ) : (
        <>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            height={H}
            role="img"
            aria-label={`Revenue by day. ${usd(total)} across ${n} days.`}
            tabIndex={0}
            onKeyDown={onKey}
            onMouseMove={e => setFromClientX(e.clientX)}
            onMouseLeave={() => setHover(null)}
            onTouchStart={e => setFromClientX(e.touches[0].clientX)}
            onTouchMove={e => setFromClientX(e.touches[0].clientX)}
            onTouchEnd={() => setHover(null)}
            style={{ display: 'block', touchAction: 'pan-y', outline: 'none', cursor: 'crosshair' }}
          >
            {/* Recessive baseline — every day exists even when it earned nothing. */}
            <line x1={PADX} y1={BASE} x2={W - PADX} y2={BASE} stroke="var(--line)" strokeWidth={1} />
            {rows.map((r, i) => {
              const bh = h(r.amountCents)
              const isHot = i === labelledIdx
              if (bh === 0) {
                return <rect key={i} x={x(i)} y={BASE - 1.5} width={barW} height={1.5} rx={0.75} fill="var(--line)" />
              }
              return (
                <rect
                  key={i}
                  x={x(i)}
                  y={BASE - bh}
                  width={barW}
                  height={bh}
                  rx={Math.min(4, barW / 2)}
                  fill={MARK}
                  opacity={hover == null || isHot ? 1 : 0.45}
                />
              )
            })}
            {/* Selective direct label: the hovered day, else the peak. Never every bar. */}
            {labelled && labelledIdx >= 0 && labelled.amountCents > 0 && (
              <text
                x={Math.max(22, Math.min(W - 22, x(labelledIdx) + barW / 2))}
                y={Math.max(11, BASE - h(labelled.amountCents) - 6)}
                textAnchor="middle"
                fill="var(--text)"
                fontSize={11.5}
                fontWeight={700}
              >
                {usdCompact(labelled.amountCents)}
              </text>
            )}
          </svg>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginTop: 2, padding: `0 ${PADX}px` }}>
            <span>{n > 0 ? dayLabel(rows[0].date) : ''}</span>
            <span aria-live="polite" style={{ fontWeight: 700, color: active ? 'var(--text)' : 'var(--muted)' }}>
              {active ? `${dayLabel(active.date)} · ${usd(active.amountCents)}` : ''}
            </span>
            <span>{n > 0 ? dayLabel(rows[n - 1].date) : ''}</span>
          </div>
        </>
      )}

      <button
        type="button"
        onClick={() => setShowTable(v => !v)}
        aria-expanded={showTable}
        style={{ marginTop: 12, padding: 0, background: 'none', border: 'none', color: 'var(--muted)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}
      >
        {showTable ? 'Hide daily figures' : `Show all ${n} days`}
      </button>

      {showTable && (
        <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 10, marginTop: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 320 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '9px 12px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Date</th>
                <th style={{ textAlign: 'right', padding: '9px 12px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td style={{ padding: '9px 12px', fontSize: 13, color: 'var(--text)', borderTop: '1px solid var(--line)', fontWeight: 700 }}>{dayLabel(r.date)}</td>
                  <td style={{ padding: '9px 12px', fontSize: 13, borderTop: '1px solid var(--line)', textAlign: 'right', color: r.amountCents > 0 ? 'var(--text)' : 'var(--muted)' }}>{usd(r.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
