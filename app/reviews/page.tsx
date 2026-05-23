import type { Metadata } from 'next'
import Link from 'next/link'
import { getReviews } from '../lib/reviews'

const SITE_URL = 'https://www.jkissllc.com'

export const metadata: Metadata = {
  title: 'Customer Reviews | J Kiss LLC — DFW Box-Truck Delivery',
  description: 'Real Google Business Profile reviews for J Kiss LLC. Box-truck and white-glove delivery feedback from DFW customers.',
  alternates: { canonical: `${SITE_URL}/reviews` },
}

// Stars helper — renders Unicode full/empty stars
function Stars({ rating }: { rating: number }) {
  const full = Math.round(rating)
  return (
    <span aria-label={`${rating.toFixed(1)} out of 5 stars`} style={{ color: '#facc15', letterSpacing: '2px' }}>
      {Array.from({ length: 5 }).map((_, i) =>
        <span key={i} style={{ opacity: i < full ? 1 : 0.25 }}>★</span>
      )}
    </span>
  )
}

export default async function ReviewsPage() {
  const data = await getReviews()

  // Build schema.org markup with aggregateRating + nested Review entities
  const jsonLd = data && data.reviews.length > 0 ? {
    '@context': 'https://schema.org',
    '@type': 'MovingCompany',
    name: 'J Kiss LLC',
    url: SITE_URL,
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: data.rating.toFixed(1),
      reviewCount: data.totalRatings,
      bestRating: 5,
      worstRating: 1,
    },
    review: data.reviews.map(r => ({
      '@type': 'Review',
      author: { '@type': 'Person', name: r.authorName },
      reviewRating: {
        '@type': 'Rating',
        ratingValue: r.rating,
        bestRating: 5,
        worstRating: 1,
      },
      reviewBody: r.text,
      datePublished: new Date(r.publishedAtUnix).toISOString(),
    })),
  } : null

  return (
    <main className="min-h-screen" style={{ background: 'var(--bg)' }}>
      {jsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      )}

      <header className="fixed top-0 left-0 right-0 z-50" style={{ background: 'rgba(11,11,12,0.95)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--line)' }}>
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-black tracking-tight" style={{ color: '#fff', letterSpacing: '-0.03em' }}>
            J Kiss <span style={{ color: 'var(--red)' }}>LLC</span>
          </Link>
          <Link href="/" className="text-sm font-semibold transition hover:text-white" style={{ color: 'var(--muted)' }}>← Back to Home</Link>
        </div>
      </header>

      <section className="pt-32 pb-16 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="label mb-6">Customer Reviews</div>
          <h1 className="text-4xl md:text-5xl font-black text-white mb-5" style={{ letterSpacing: '-0.045em', lineHeight: 1.05, fontFamily: 'var(--font-display)' }}>
            What DFW Customers <span style={{ color: 'var(--red)' }}>Say.</span>
          </h1>

          {data ? (
            <>
              {/* Aggregate */}
              <div className="glass-card p-6 mb-10 flex items-center gap-6 flex-wrap" style={{ borderRadius: '20px' }}>
                <div>
                  <p className="text-6xl font-black tabular-nums" style={{ color: '#fff', letterSpacing: '-0.04em', fontFamily: 'var(--font-display)' }}>
                    {data.rating.toFixed(1)}
                  </p>
                  <div className="text-2xl mt-1"><Stars rating={data.rating} /></div>
                </div>
                <div className="flex-1 min-w-[200px]">
                  <p className="text-sm font-semibold text-white">{data.totalRatings.toLocaleString()} Google reviews</p>
                  <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                    Pulled live from our Google Business Profile · refreshed every 24 hours
                  </p>
                </div>
              </div>

              {/* Review cards */}
              <div className="grid gap-5 md:grid-cols-2">
                {data.reviews.map((r, i) => (
                  <article key={i} className="glass-card p-6" style={{ borderRadius: '20px' }}>
                    <div className="flex items-start gap-3 mb-3">
                      {r.authorPhotoUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.authorPhotoUrl} alt="" className="w-10 h-10 rounded-full" />
                      )}
                      <div className="flex-1">
                        <p className="text-sm font-bold text-white">{r.authorName}</p>
                        <p className="text-xs" style={{ color: 'var(--muted)' }}>{r.timeAgo}</p>
                      </div>
                      <Stars rating={r.rating} />
                    </div>
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{r.text}</p>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="glass-card p-10 text-center" style={{ borderRadius: '20px' }}>
              <p className="text-xl font-black text-white mb-3" style={{ fontFamily: 'var(--font-display)' }}>Reviews coming soon</p>
              <p className="text-sm leading-relaxed max-w-lg mx-auto" style={{ color: 'var(--muted)' }}>
                Live Google reviews will appear here once the Google Places API is configured (env vars{' '}
                <code style={{ background: 'rgba(255,255,255,.08)', padding: '2px 6px', borderRadius: '4px', fontFamily: 'var(--font-mono)' }}>GOOGLE_PLACES_API_KEY</code>{' '}
                and{' '}
                <code style={{ background: 'rgba(255,255,255,.08)', padding: '2px 6px', borderRadius: '4px', fontFamily: 'var(--font-mono)' }}>GOOGLE_PLACE_ID</code>).
              </p>
              <p className="text-sm mt-5">
                <a href="https://g.page/r/jkissllc/review" target="_blank" rel="noopener noreferrer" className="font-semibold transition hover:text-white" style={{ color: 'var(--red)' }}>
                  Leave us a Google review ↗
                </a>
              </p>
            </div>
          )}
        </div>
      </section>

      <footer className="py-10 px-6 text-center text-xs" style={{ borderTop: '1px solid var(--line)', color: 'rgba(255,255,255,.3)' }}>
        © {new Date().getFullYear()} J Kiss LLC · US DOT 3484556 · MC 01155352
      </footer>
    </main>
  )
}
