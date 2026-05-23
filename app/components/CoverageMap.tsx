'use client'

import { useEffect, useRef } from 'react'
import maplibregl, { type Map as MLMap, type StyleSpecification } from 'maplibre-gl'
import { CITIES } from '../lib/cities'

// DFW metro center + service radius
const DFW_CENTER: [number, number] = [-97.0, 32.9] // [lon, lat]
const RADIUS_MILES = 50

// Build a GeoJSON polygon approximating a circle in geographic coords.
function circlePolygon(centerLon: number, centerLat: number, miles: number, segments = 96): GeoJSON.Feature<GeoJSON.Polygon> {
  const km = miles * 1.60934
  const coords: [number, number][] = []
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * 2 * Math.PI
    const dxKm = km * Math.cos(angle)
    const dyKm = km * Math.sin(angle)
    const dLat = dyKm / 110.574
    const dLon = dxKm / (111.320 * Math.cos((centerLat * Math.PI) / 180))
    coords.push([centerLon + dLon, centerLat + dLat])
  }
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [coords] },
  }
}

// Free CartoDB Dark Matter raster tiles — no API key required.
const RASTER_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    'carto-dark': {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0b0b0c' } },
    { id: 'carto', type: 'raster', source: 'carto-dark' },
  ],
}

export default function CoverageMap() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: RASTER_STYLE,
      center: DFW_CENTER,
      zoom: 8.4,
      minZoom: 7.5,
      maxZoom: 11,
      attributionControl: { compact: true },
      // Keep interactivity light — locked aspect ratio, no rotation/pitch
      pitchWithRotate: false,
      dragRotate: false,
      touchPitch: false,
      // Constrain panning to roughly DFW metro
      maxBounds: [
        [-98.0, 32.2], // SW
        [-96.0, 33.7], // NE
      ],
    })

    map.on('load', () => {
      // Service radius polygon
      map.addSource('service-radius', {
        type: 'geojson',
        data: circlePolygon(DFW_CENTER[0], DFW_CENTER[1], RADIUS_MILES),
      })
      map.addLayer({
        id: 'service-radius-fill',
        type: 'fill',
        source: 'service-radius',
        paint: { 'fill-color': '#E0002A', 'fill-opacity': 0.10 },
      })
      map.addLayer({
        id: 'service-radius-line',
        type: 'line',
        source: 'service-radius',
        paint: {
          'line-color': '#E0002A',
          'line-width': 1.5,
          'line-dasharray': [3, 3],
          'line-opacity': 0.7,
        },
      })

      // City markers — custom HTML so we get hover state + click-through
      for (const city of CITIES) {
        const el = document.createElement('a')
        el.href = `/box-truck-delivery/${city.slug}`
        el.className = 'jk-city-marker'
        el.setAttribute('aria-label', `Box-truck delivery in ${city.name}`)
        el.innerHTML = `
          <span class="jk-city-dot"></span>
          <span class="jk-city-label">${city.name}</span>
        `
        new maplibregl.Marker({ element: el, anchor: 'left' })
          .setLngLat([city.lon, city.lat])
          .addTo(map)
      }
    })

    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  return (
    <div className="glass-card overflow-hidden relative" style={{ borderRadius: '20px', aspectRatio: '4/3' }}>
      <div ref={containerRef} className="w-full h-full" />
      {/* Top-left badge — branded legend */}
      <div className="absolute top-4 left-4 pointer-events-none" style={{
        background: 'rgba(11,11,12,0.78)',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(255,255,255,.10)',
        borderRadius: '10px',
        padding: '10px 12px',
        fontFamily: 'var(--font-mono)',
      }}>
        <div className="flex items-center gap-2">
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#E0002A', display: 'inline-block' }} />
          <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: '#fff', letterSpacing: '0.12em' }}>
            Service City
          </span>
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <span style={{
            width: 12, height: 0, borderTop: '1.5px dashed rgba(224,0,42,.7)', display: 'inline-block',
          }} />
          <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,.65)', letterSpacing: '0.12em' }}>
            ~{RADIUS_MILES} mi Radius
          </span>
        </div>
      </div>
    </div>
  )
}
