// Shared coverage data used by homepage map, sitemap, and per-city landing pages.
export type City = {
  name: string
  lat: number
  lon: number
  slug: string
  /** Short blurb of what's notable about delivering here. Used in landing page hero. */
  blurb: string
  /** Neighborhoods / zips frequently serviced — included as keywords for local SEO. */
  neighborhoods: string[]
}

export const CITIES: City[] = [
  {
    name: 'Dallas', lat: 32.78, lon: -96.80, slug: 'dallas',
    blurb: 'Dallas is our home base. We run daily box-truck routes from Uptown to Oak Cliff and out to White Rock, with same-day capacity for last-mile work across the urban core.',
    neighborhoods: ['Uptown', 'Oak Cliff', 'Lake Highlands', 'Lower Greenville', 'Bishop Arts', 'Deep Ellum', 'White Rock', 'Preston Hollow'],
  },
  {
    name: 'Fort Worth', lat: 32.75, lon: -97.33, slug: 'fort-worth',
    blurb: 'Fort Worth deliveries — from West 7th apartments to Tanglewood estates and the Alliance corridor. Our box trucks handle the appliance, furniture, and material runs into homes Tarrant County retailers can\'t fit a 53\' van into.',
    neighborhoods: ['West 7th', 'Tanglewood', 'TCU area', 'Alliance', 'Westover Hills', 'Ridglea Hills'],
  },
  {
    name: 'Arlington', lat: 32.74, lon: -97.11, slug: 'arlington',
    blurb: 'Arlington bridges Dallas and Fort Worth — and so do our daily routes. Stadium-district last-mile, residential furniture placements, and store-to-store transfers between major retailers.',
    neighborhoods: ['Entertainment District', 'Pantego', 'Dalworthington Gardens', 'South Arlington', 'North Arlington'],
  },
  {
    name: 'Irving', lat: 32.81, lon: -96.95, slug: 'irving',
    blurb: 'Irving sits at the center of the metroplex with DFW Airport on one side and downtown Dallas on the other. Box-truck delivery into Las Colinas towers and residential neighborhoods alike.',
    neighborhoods: ['Las Colinas', 'Valley Ranch', 'Hackberry', 'South Irving'],
  },
  {
    name: 'Plano', lat: 33.02, lon: -96.70, slug: 'plano',
    blurb: 'Plano is one of our highest-volume residential routes. Legacy West, Willow Bend, and the broader corporate-campus belt drive heavy furniture and appliance delivery demand.',
    neighborhoods: ['Legacy West', 'Willow Bend', 'West Plano', 'East Plano', 'Shops at Legacy'],
  },
  {
    name: 'Garland', lat: 32.91, lon: -96.64, slug: 'garland',
    blurb: 'Garland deliveries — full-service box-truck routes into Firewheel, Naaman Forest, and Lake Ray Hubbard neighborhoods. Same-day pickup-to-doorstep on short notice.',
    neighborhoods: ['Firewheel', 'Naaman Forest', 'Lake Ray Hubbard', 'Duck Creek'],
  },
  {
    name: 'Frisco', lat: 33.15, lon: -96.82, slug: 'frisco',
    blurb: 'Frisco is one of the fastest-growing markets in the country, and one of our biggest residential delivery zones. Stonebriar, Starwood, and the entire Dallas North Tollway corridor.',
    neighborhoods: ['Stonebriar', 'Starwood', 'Newman Village', 'The Trails', 'Frisco Square'],
  },
  {
    name: 'McKinney', lat: 33.20, lon: -96.61, slug: 'mckinney',
    blurb: 'McKinney historic and McKinney new-build — both serviced. Box-truck delivery from Custer Road retail through Stonebridge Ranch out to the Highway 380 corridor.',
    neighborhoods: ['Historic Downtown', 'Stonebridge Ranch', 'Eldorado', 'Craig Ranch', 'Adriatica'],
  },
  {
    name: 'Denton', lat: 33.22, lon: -97.13, slug: 'denton',
    blurb: 'Denton — UNT and TWU student housing turnover, Robson Ranch retirement community, and Argyle / Corinth residential deliveries. Box trucks fit where 53\' vans simply don\'t.',
    neighborhoods: ['UNT Area', 'Robson Ranch', 'Corinth', 'Argyle', 'Highland Village'],
  },
  {
    name: 'Mesquite', lat: 32.77, lon: -96.60, slug: 'mesquite',
    blurb: 'Mesquite — Town East, Skyline, and the I-635 corridor. Daily last-mile box-truck delivery for furniture, appliances, and packaged retail goods.',
    neighborhoods: ['Town East', 'Skyline', 'North Mesquite', 'South Mesquite'],
  },
]

export function findCity(slug: string): City | undefined {
  return CITIES.find(c => c.slug === slug)
}
