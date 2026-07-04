import Link from 'next/link';
import { ArrowRight, Star } from 'lucide-react';
import { getReviews } from '../../lib/reviews';
import { listReviews, displayName, aggregate } from '../../lib/site-reviews';
import Reveal from '../Reveal';

function Stars({ rating }: { rating: number }) {
  const full = Math.round(rating);
  return (
    <span aria-label={`${rating.toFixed(1)} out of 5`} style={{ display: 'inline-flex', gap: 2 }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star key={i} size={16} fill={i < full ? '#f5a623' : 'none'} color="#f5a623" style={{ opacity: i < full ? 1 : 0.35 }} aria-hidden />
      ))}
    </span>
  );
}

/**
 * Real reviews only — mirrors /reviews: first-party reviews are primary, Google
 * is the fallback. If none exist yet, an honest "be among the first" state
 * renders (never fabricated testimonials).
 */
export default async function Reviews() {
  const site = (await listReviews()).filter((r) => !r.hidden);
  const google = site.length === 0 ? await getReviews() : null;

  let reviews: { name: string; rating: number; text?: string }[] = [];
  let rating = 0;
  let count = 0;
  let source: 'site' | 'google' | null = null;

  if (site.length > 0) {
    const agg = aggregate(site);
    rating = agg.rating;
    count = agg.count;
    source = 'site';
    reviews = site.filter((r) => r.text).slice(0, 3).map((r) => ({ name: displayName(r.authorName), rating: r.rating, text: r.text }));
    if (reviews.length === 0) reviews = site.slice(0, 3).map((r) => ({ name: displayName(r.authorName), rating: r.rating, text: r.text }));
  } else if (google && google.reviews.length > 0) {
    rating = google.rating;
    count = google.totalRatings;
    source = 'google';
    reviews = google.reviews.slice(0, 3).map((r) => ({ name: r.authorName, rating: r.rating, text: r.text }));
  }

  const reviewUrl = process.env.GOOGLE_REVIEW_URL || '/reviews';
  const hasReviews = reviews.length > 0;

  return (
    <section className="section section-light">
      <div className="wrap">
        <Reveal><span className="eyebrow">In their words</span></Reveal>
        <Reveal as="h2" delay={70} className="display-2" style={{ marginTop: 16, maxWidth: '18ch' }}>
          What DFW customers say.
        </Reveal>

        {hasReviews ? (
          <>
            <Reveal delay={130} style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <span className="kpi" style={{ fontSize: '2.4rem' }}>{rating.toFixed(1)}</span>
              <Stars rating={rating} />
              <span style={{ color: 'var(--ink-muted)', fontSize: 14 }}>
                {count.toLocaleString()} {source === 'google' ? 'Google reviews' : `verified review${count === 1 ? '' : 's'}`}
              </span>
            </Reveal>

            <div style={{ marginTop: 36, display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))' }}>
              {reviews.map((r, i) => (
                <Reveal key={i} delay={i * 60}>
                  <figure className="card-light" style={{ padding: 24, height: '100%', display: 'flex', flexDirection: 'column', margin: 0 }}>
                    <Stars rating={r.rating} />
                    <blockquote style={{ color: 'var(--ink-body)', fontSize: 15, lineHeight: 1.6, marginTop: 14, flex: 1 }}>“{r.text}”</blockquote>
                    <figcaption style={{ marginTop: 16, fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>{r.name}</figcaption>
                  </figure>
                </Reveal>
              ))}
            </div>

            <Reveal delay={120} style={{ marginTop: 28 }}>
              <Link href="/reviews" className="btn-ghost-ink" style={{ display: 'inline-flex' }}>
                Read all reviews <ArrowRight size={16} aria-hidden />
              </Link>
            </Reveal>
          </>
        ) : (
          <Reveal delay={130}>
            <div className="card-light" style={{ marginTop: 26, padding: 32, maxWidth: '46rem' }}>
              <Stars rating={5} />
              <p style={{ color: 'var(--ink-body)', fontSize: 16, lineHeight: 1.6, marginTop: 14 }}>
                Verified reviews from real, completed jobs show up here as customers leave them — so
                every word you read is from someone we actually served.
              </p>
              <a href={reviewUrl} target={reviewUrl.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer" className="btn-ink" style={{ marginTop: 20, display: 'inline-flex' }}>
                Be one of the first to review us <ArrowRight size={16} aria-hidden />
              </a>
            </div>
          </Reveal>
        )}
      </div>
    </section>
  );
}
