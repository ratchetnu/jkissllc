import type { MetadataRoute } from 'next'
import { CITIES } from './lib/cities'

const SITE = 'https://www.jkissllc.com'

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  const base: MetadataRoute.Sitemap = [
    { url: SITE,                              lastModified: now, changeFrequency: 'monthly', priority: 1.0 },
    { url: `${SITE}/start-your-carrier`,      lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE}/about`,                   lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${SITE}/opspilot`,                lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${SITE}/safety`,                  lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${SITE}/coi`,                     lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${SITE}/quote`,                   lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${SITE}/track`,                   lastModified: now, changeFrequency: 'weekly',  priority: 0.6 },
    { url: `${SITE}/reviews`,                 lastModified: now, changeFrequency: 'weekly',  priority: 0.7 },
  ]
  const cityPages: MetadataRoute.Sitemap = CITIES.map(c => ({
    url: `${SITE}/box-truck-delivery/${c.slug}`,
    lastModified: now,
    changeFrequency: 'monthly',
    priority: 0.7,
  }))
  return [...base, ...cityPages]
}
