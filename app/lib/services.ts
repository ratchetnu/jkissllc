import {
  Trash2, Trees, Refrigerator, Sofa, Boxes, Truck, HardHat, Building2, KeyRound,
  type LucideIcon,
} from 'lucide-react';

/**
 * Canonical customer-facing service catalog (single source of truth for the
 * homepage "Choose Your Service" section). `id` MUST match a wizard service id
 * so cards deep-link via /quote?service=<id>. Names are box-truck-accurate
 * (honest renaming: no "freight/moving/construction" oversell) and every card
 * leads with an OUTCOME, not a service label.
 */
export type HomeService = {
  id: string;         // matches /quote?service=<id>
  name: string;       // honest, box-truck-accurate service name
  outcome: string;    // outcome-first headline
  blurb: string;      // customer-focused, one or two lines
  forWho: string;     // who it's for
  turnaround: string;
  from?: string;      // starting price, when applicable
  icon: LucideIcon;
  jobBased: boolean;  // priced instantly by the disposal engine
  bookable: boolean;  // shows a "Book Now" CTA. false = quote-first (local moves,
                      // appliance/furniture last-mile, and commercial delivery)
};

export const SERVICES: HomeService[] = [
  {
    id: 'junk-removal',
    name: 'Junk Removal',
    outcome: 'Get your space back.',
    blurb: 'One item or a whole house — loaded, hauled, and disposed of responsibly. You point, we lift.',
    forWho: 'Homeowners, renters, offices',
    turnaround: 'Same / next-day',
    from: 'from $99',
    icon: Trash2,
    jobBased: true,
    bookable: true,
  },
  {
    id: 'brush-debris',
    name: 'Brush & Debris Removal',
    outcome: 'Clear the property without the work.',
    blurb: 'Yard waste, branches, and storm debris cut down to a clean lot — no trailer, no dump runs on your end.',
    forWho: 'Homeowners, landlords, crews',
    turnaround: 'Same / next-day',
    from: 'from $99',
    icon: Trees,
    jobBased: true,
    bookable: true,
  },
  {
    id: 'appliance-delivery',
    name: 'Appliance Delivery',
    outcome: 'Delivered, unboxed, and set in place.',
    blurb: 'Fridges, washers, dryers, and ranges brought in and set right where you want them — not left in the driveway. Delivery and placement only (no gas, water, or electrical hookups).',
    forWho: 'Homeowners, retailers',
    turnaround: 'Next-day',
    icon: Refrigerator,
    jobBased: false,
    bookable: false,
  },
  {
    id: 'furniture-delivery',
    name: 'Furniture Delivery',
    outcome: 'White-glove, to the room you choose.',
    blurb: 'Two-person crews carry it in, place it exactly where you want it, and take the packaging with them.',
    forWho: 'Homeowners, showrooms',
    turnaround: 'Next-day',
    icon: Sofa,
    jobBased: false,
    bookable: false,
  },
  {
    id: 'freight',
    name: 'Box-Truck / Palletized Delivery',
    outcome: 'Palletized loads, delivered right.',
    blurb: 'Pallets and packaged goods moved across the metroplex in 16–26 ft straight trucks, with live updates.',
    forWho: 'Small businesses, suppliers',
    turnaround: '1–3 days',
    icon: Boxes,
    jobBased: false,
    bookable: true,
  },
  {
    id: 'moving',
    name: 'Local Moves',
    outcome: 'A move without the chaos.',
    blurb: 'Homes and offices loaded, transported, and set in place across DFW — careful hands, clear timing.',
    forWho: 'Households, small offices',
    turnaround: 'Scheduled',
    icon: Truck,
    jobBased: false,
    bookable: false,
  },
  {
    id: 'construction-hauling',
    name: 'Material Runs & Jobsite Debris',
    outcome: 'Materials in, debris out.',
    blurb: 'Building materials delivered to the site — and the debris hauled off when the work is done.',
    forWho: 'Contractors, builders',
    turnaround: '1–3 days',
    icon: HardHat,
    jobBased: false,
    bookable: true,
  },
  {
    id: 'commercial-delivery',
    name: 'Commercial Delivery',
    outcome: 'Your reliable box-truck partner.',
    blurb: 'Store-to-store transfers, replenishment, and B2B runs — dependable drivers who communicate every stop.',
    forWho: 'Retailers, property managers',
    turnaround: 'Scheduled',
    icon: Building2,
    jobBased: false,
    bookable: false,
  },
  {
    id: 'eviction',
    name: 'Eviction & Property Cleanouts',
    outcome: 'Turned over, broom-clean, fast.',
    blurb: 'Discreet, complete cleanouts of units, garages, and foreclosures — cleared down to broom-clean.',
    forWho: 'Landlords, property managers',
    turnaround: '1–2 days',
    icon: KeyRound,
    jobBased: true,
    bookable: true,
  },
];
