'use client'

// ── Operion Shadow — time-series trend chart (self-contained, CSP-safe) ──────
// No external chart lib: one responsive inline SVG. Reads ONLY the rollup buckets the API
// already aggregated (no client-side aggregation). Pointer + touch + keyboard hover, theme-
// aware via the admin CSS vars, and touch-action:pan-y so mobile users are never scroll-trapped.

import { useMemo, useRef, useState } from 'react'
import type { RollupBucket } from '../../../../lib/estimation/shadow-analytics'

export type TrendMetric = 'agreement' | 'autoQuote' | 'confidence' | 'latency'

const METRICS: Record<TrendMetric, { label: string; color: string; pick: (b: RollupBucket) => number | null; fmt: (v: number) => string; max: (bs: RollupBucket[]) => number }> = {
  agreement: { label: 'Agreement', color: '#34d399', pick: (b) => (b.count ? b.agreementPct : null), fmt: (v) => `${Math.round(v)}%`, max: () => 100 },
  autoQuote: { label: 'Auto-quote', color: '#93c5fd', pick: (b) => (b.count ? b.autoQuotePct : null), fmt: (v) => `${Math.round(v)}%`, max: () => 100 },
  confidence: { label: 'Avg confidence', color: '#fbbf24', pick: (b) => b.avgConfidence, fmt: (v) => `${Math.round(v * 100)}%`, max: () => 1 },
  latency: { label: 'Avg latency', color: '#f472b6', pick: (b) => b.avgLatencyMs, fmt: (v) => `${(v / 1000).toFixed(1)}s`, max: (bs) => Math.max(1, ...bs.map((b) => b.avgLatencyMs ?? 0)) },
}

const W = 600, H = 180, PADX = 8, PADY = 14  // viewBox space; SVG scales to 100% width

export default function TrendChart({ buckets, metric, window, filterSummary }: { buckets: RollupBucket[]; metric: TrendMetric; window: string; filterSummary: string }) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const m = METRICS[metric]
  const withData = useMemo(() => buckets.filter((b) => b.count > 0), [buckets])

  const yMax = m.max(buckets)
  const maxCount = Math.max(1, ...buckets.map((b) => b.count))
  const n = buckets.length
  const x = (i: number) => (n <= 1 ? W / 2 : PADX + (i / (n - 1)) * (W - 2 * PADX))
  const y = (v: number) => H - PADY - (Math.max(0, Math.min(yMax, v)) / yMax) * (H - 2 * PADY)

  // Line path across buckets that HAVE a value (gaps in empty buckets are skipped, not zeroed).
  const pts = buckets.map((b, i) => ({ i, v: m.pick(b), bx: x(i) }))
  const linePts = pts.filter((p): p is { i: number; v: number; bx: number } => typeof p.v === 'number')
  const linePath = linePts.map((p, k) => `${k === 0 ? 'M' : 'L'}${p.bx.toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const areaPath = linePts.length ? `${linePath} L${linePts[linePts.length - 1].bx.toFixed(1)},${H - PADY} L${linePts[0].bx.toFixed(1)},${H - PADY} Z` : ''

  const fmtTime = (t: number) => {
    const d = new Date(t)
    return window === '24h' ? d.toLocaleTimeString([], { hour: 'numeric' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  const setFromClientX = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const frac = (clientX - rect.left) / rect.width
    setHover(Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))))
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') { setHover((h) => Math.min(n - 1, (h ?? -1) + 1)); e.preventDefault() }
    else if (e.key === 'ArrowLeft') { setHover((h) => Math.max(0, (h ?? n) - 1)); e.preventDefault() }
    else if (e.key === 'Escape') setHover(null)
  }

  if (!withData.length) {
    return <div style={{ height: 200, display: 'grid', placeItems: 'center', color: 'var(--muted)', fontSize: 12.5, border: '1px dashed var(--line)', borderRadius: 10 }}>No evaluations in this range.</div>
  }

  const hb = hover != null ? buckets[hover] : null
  const hv = hb ? m.pick(hb) : null

  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none"
        role="img" aria-label={`${m.label} over ${window}. Use arrow keys to inspect points.`} tabIndex={0}
        style={{ touchAction: 'pan-y', outline: 'none', display: 'block', cursor: 'crosshair' }}
        onPointerMove={(e) => setFromClientX(e.clientX)}
        onPointerDown={(e) => setFromClientX(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
      >
        {/* gridlines */}
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={PADX} x2={W - PADX} y1={y(yMax * g)} y2={y(yMax * g)} stroke="var(--line)" strokeWidth="1" strokeDasharray="3 4" opacity="0.6" />
        ))}
        {/* sample-count context bars (faint) */}
        {buckets.map((b, i) => b.count > 0 && (
          <rect key={i} x={x(i) - 2} width="4" y={H - PADY - (b.count / maxCount) * (H - 2 * PADY) * 0.5} height={(b.count / maxCount) * (H - 2 * PADY) * 0.5} fill="var(--muted)" opacity="0.14" rx="1" />
        ))}
        {areaPath && <path d={areaPath} fill={m.color} opacity="0.12" />}
        {linePath && <path d={linePath} fill="none" stroke={m.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {linePts.map((p) => <circle key={p.i} cx={p.bx} cy={y(p.v)} r={hover === p.i ? 4.5 : 2.5} fill={m.color} />)}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PADY} y2={H - PADY} stroke={m.color} strokeWidth="1" opacity="0.5" />}
      </svg>

      {/* axis end-labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
        <span>{fmtTime(buckets[0].start)}</span>
        <span>{fmtTime(buckets[n - 1].end)}</span>
      </div>

      {/* tooltip */}
      {hb && (
        <div role="status" aria-live="polite" style={{ position: 'absolute', top: 4, left: 8, right: 8, pointerEvents: 'none', display: 'flex', justifyContent: 'center' }}>
          <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 9, padding: '6px 10px', fontSize: 11.5, boxShadow: '0 4px 14px rgba(0,0,0,.28)', maxWidth: '100%' }}>
            <div style={{ fontWeight: 700, color: 'var(--text)' }}>{fmtTime(hb.start)}</div>
            <div style={{ color: 'var(--text)' }}>{m.label}: <strong style={{ color: m.color }}>{typeof hv === 'number' ? m.fmt(hv) : '—'}</strong></div>
            <div style={{ color: 'var(--muted)' }}>{hb.count} eval{hb.count === 1 ? '' : 's'}</div>
            <div style={{ color: 'var(--muted)', fontSize: 10.5 }}>{filterSummary}</div>
          </div>
        </div>
      )}
    </div>
  )
}
