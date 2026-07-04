'use client'

import Link from 'next/link'
import { CITIES } from '../lib/cities'

/**
 * Self-contained, brand-styled DFW coverage map — pure inline SVG, no external
 * tiles or map library. City pins are projected from their real lon/lat and link
 * to each city's landing page. Themed for a dark card (the homepage Coverage
 * section). Replaces the previous MapLibre raster-tile slippy map.
 */

const W = 760
const H = 560
const PAD = 92
const RADIUS_MILES = 50

// Equirectangular projection with longitude corrected for latitude, fit to the
// viewBox. Computed once at module scope from the static CITIES list.
const lons = CITIES.map((c) => c.lon)
const lats = CITIES.map((c) => c.lat)
const minLon = Math.min(...lons)
const maxLon = Math.max(...lons)
const minLat = Math.min(...lats)
const maxLat = Math.max(...lats)
const cosLat = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180)
const geoW = (maxLon - minLon) * cosLat || 1
const geoH = maxLat - minLat || 1
const scale = Math.min((W - 2 * PAD) / geoW, (H - 2 * PAD) / geoH)
const offX = (W - geoW * scale) / 2
const offY = (H - geoH * scale) / 2
const projX = (lon: number) => offX + (lon - minLon) * cosLat * scale
const projY = (lat: number) => H - (offY + (lat - minLat) * scale) // flip Y

const PINS = CITIES.map((c) => ({ city: c, px: projX(c.lon), py: projY(c.lat) }))
// Hub + service radius are centered on Dallas — our dispatch home base — so the
// hairlines converge on Dallas and the ring reads as "reach from home base".
const HOME = PINS.find((p) => p.city.slug === 'dallas') ?? PINS[0]
const cxPix = HOME.px
const cyPix = HOME.py
const coverR =
  Math.max(...PINS.map((p) => Math.hypot(p.px - cxPix, p.py - cyPix))) + 46

export default function CoverageMap() {
  return (
    <div
      className="glass-card overflow-hidden relative"
      style={{ borderRadius: '20px', aspectRatio: '4/3' }}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        role="group"
        aria-labelledby="jk-coverage-title"
        style={{ display: 'block' }}
      >
        {/* Not role="img" — the SVG holds real per-city links that must stay
            individually reachable/announced by assistive tech. */}
        <title id="jk-coverage-title">
          J Kiss LLC box-truck delivery coverage across the Dallas–Fort Worth metroplex — select a city for local details.
        </title>
        <defs>
          <radialGradient id="jk-glow" cx="50%" cy="46%" r="62%">
            <stop offset="0%" stopColor="rgba(224,0,42,0.20)" />
            <stop offset="55%" stopColor="rgba(224,0,42,0.06)" />
            <stop offset="100%" stopColor="rgba(224,0,42,0)" />
          </radialGradient>
          <pattern id="jk-dots" width="26" height="26" patternUnits="userSpaceOnUse">
            <circle cx="1.2" cy="1.2" r="1.2" fill="rgba(255,255,255,0.05)" />
          </pattern>
        </defs>

        {/* Backdrop */}
        <rect x="0" y="0" width={W} height={H} fill="#0b0b0c" />
        <rect x="0" y="0" width={W} height={H} fill="url(#jk-dots)" />
        <rect x="0" y="0" width={W} height={H} fill="url(#jk-glow)" />

        {/* Service-area coverage */}
        <circle cx={cxPix} cy={cyPix} r={coverR} fill="rgba(224,0,42,0.06)" />
        <circle
          cx={cxPix}
          cy={cyPix}
          r={coverR}
          fill="none"
          stroke="#E0002A"
          strokeWidth={1.5}
          strokeOpacity={0.55}
          strokeDasharray="4 5"
        />

        {/* Connective hairlines from the metro center to each city */}
        {PINS.map((p) => (
          <line
            key={`l-${p.city.slug}`}
            x1={cxPix}
            y1={cyPix}
            x2={p.px}
            y2={p.py}
            stroke="rgba(255,255,255,0.07)"
            strokeWidth={1}
          />
        ))}

        {/* City pins (links). Label flips to the inside edge to avoid clipping. */}
        {PINS.map((p) => {
          const isHome = p.city.slug === 'dallas'
          // Labels point outward (away from the Dallas hub); the hub's own label
          // sits above its pin so it never collides with nearby cities.
          const labelLeft = p.px < cxPix
          const lx = isHome ? p.px : labelLeft ? p.px - 12 : p.px + 12
          const ly = isHome ? p.py - 16 : p.py + 4
          const anchor = isHome ? 'middle' : labelLeft ? 'end' : 'start'
          return (
            <Link
              key={p.city.slug}
              href={`/box-truck-delivery/${p.city.slug}`}
              className="jk-pin"
              aria-label={`Box-truck delivery in ${p.city.name}`}
            >
              {isHome && (
                <circle cx={p.px} cy={p.py} r={13} fill="none" stroke="#E0002A" strokeOpacity={0.5} strokeWidth={1.5} />
              )}
              <circle className="jk-pin-halo" cx={p.px} cy={p.py} r={isHome ? 9 : 7} fill="rgba(224,0,42,0.25)" />
              <circle cx={p.px} cy={p.py} r={isHome ? 5 : 4} fill="#E0002A" stroke="#fff" strokeWidth={isHome ? 1.5 : 1} />
              <text
                x={lx}
                y={ly}
                textAnchor={anchor}
                fill="#fff"
                fontSize={isHome ? 15 : 13.5}
                fontWeight={isHome ? 700 : 600}
                style={{ fontFamily: 'var(--font-display, sans-serif)', paintOrder: 'stroke', stroke: '#0b0b0c', strokeWidth: 3, strokeLinejoin: 'round' }}
              >
                {p.city.name}
              </text>
            </Link>
          )
        })}
      </svg>

      {/* Branded legend */}
      <div
        className="absolute top-4 left-4 pointer-events-none"
        style={{
          background: 'rgba(11,11,12,0.78)',
          backdropFilter: 'blur(8px)',
          border: '1px solid rgba(255,255,255,.10)',
          borderRadius: '10px',
          padding: '10px 12px',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <div className="flex items-center gap-2">
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#E0002A', display: 'inline-block' }} />
          <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: '#fff', letterSpacing: '0.12em' }}>
            Service City
          </span>
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <span style={{ width: 12, height: 0, borderTop: '1.5px dashed rgba(224,0,42,.7)', display: 'inline-block' }} />
          <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.65)', letterSpacing: '0.12em' }}>
            ~{RADIUS_MILES} mi Radius
          </span>
        </div>
      </div>

      {/* Corner caption */}
      <div
        className="absolute bottom-3 right-4 pointer-events-none text-[10px] uppercase tracking-widest"
        style={{ color: 'rgba(255,255,255,.5)', letterSpacing: '0.14em', fontFamily: 'var(--font-mono)' }}
      >
        Dallas–Fort Worth Metroplex
      </div>
    </div>
  )
}
