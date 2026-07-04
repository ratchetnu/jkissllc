import Image from 'next/image';
import Reveal from '../Reveal';

/**
 * Recent work — REAL photos only, with honest captions describing what's in the
 * shot (no fabricated customer stories, locations, or times).
 * TODO(owner): when you have true before/after pairs + real project details
 * (service, city, duration, one-line story), swap these in and we'll add the
 * before/after slider + story card treatment.
 */
const PROJECTS = [
  { src: '/images/junk-property-cleanout.jpg', tag: 'Property Cleanout', caption: 'Full property cleanout, cleared and hauled', span: true },
  { src: '/images/junk-garage-cleanout.jpg', tag: 'Junk Removal', caption: 'Garage cleared down to the walls' },
  { src: '/images/junk-yard-debris.jpg', tag: 'Brush & Debris', caption: 'Yard debris and bulk haul-off' },
  { src: '/images/appliance-delivery.jpg', tag: 'Appliance Delivery', caption: 'Delivered, set in place, ready to use' },
  { src: '/images/junk-estate-cleanout.jpg', tag: 'Property Cleanout', caption: 'Estate cleanout — furniture and appliances' },
  { src: '/images/junk-curbside-haul.jpg', tag: 'Junk Removal', caption: 'Curbside furniture pickup and haul-away' },
  { src: '/images/delivery-action.jpg', tag: 'Local Delivery', caption: 'Last-mile delivery in progress', span: true },
  { src: '/images/junk-shed-cleanout.jpg', tag: 'Junk Removal', caption: 'Shed and backyard cleanout' },
];

/** Light "Recent Work" gallery — premium image cards from real jobs. */
export default function Projects() {
  return (
    <section className="section section-light">
      <div className="wrap">
        <Reveal><span className="eyebrow">Recent work</span></Reveal>
        <Reveal as="h2" delay={70} className="display-2" style={{ marginTop: 16, maxWidth: '20ch' }}>
          Real jobs, across the metroplex.
        </Reveal>
        <Reveal as="p" delay={130} className="lede" style={{ marginTop: 16, maxWidth: '50ch' }}>
          A look at recent hauls, cleanouts, and deliveries around Dallas–Fort Worth.
        </Reveal>

        <div
          style={{
            marginTop: 44,
            display: 'grid',
            gap: 14,
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))',
            gridAutoRows: '240px',
          }}
        >
          {PROJECTS.map((p, i) => (
            <Reveal
              key={p.src}
              delay={Math.min(i, 6) * 45}
              className={`ba-tile ${p.span ? 'ba-wide' : ''}`}
            >
              <figure
                style={{ position: 'relative', overflow: 'hidden', borderRadius: 18, height: '100%', width: '100%', margin: 0, border: '1px solid var(--line-ink)' }}
              >
                <Image
                  src={p.src}
                  alt={p.caption}
                  fill
                  sizes="(max-width: 640px) 100vw, 33vw"
                  className="proj-img"
                  style={{ objectFit: 'cover' }}
                />
                <div aria-hidden style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(6,7,10,.82) 0%, rgba(6,7,10,.15) 45%, transparent 70%)' }} />
                <figcaption style={{ position: 'absolute', left: 16, right: 16, bottom: 14 }}>
                  <span style={{ display: 'inline-block', fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--red-glow)', background: 'rgba(224,0,42,.14)', border: '1px solid rgba(224,0,42,.3)', borderRadius: 100, padding: '3px 10px' }}>
                    {p.tag}
                  </span>
                  <p style={{ color: '#fff', fontSize: 14.5, fontWeight: 600, marginTop: 8, textShadow: '0 1px 6px rgba(0,0,0,.6)' }}>{p.caption}</p>
                </figcaption>
              </figure>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
