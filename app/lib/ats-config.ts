// ── Careers / ATS configuration — the single source of truth ──────────────────
// Positions, pay, requirements, required document uploads, the skills assessment,
// the scenario questions, and the readiness-score bands. Both the public
// application UI and the scoring engine import from here so they never drift.

export type Position = 'driver' | 'helper'

export type ExperienceLevel = 'none' | 'lt6mo' | '6to12mo' | '1to3yr' | '3plus'

// weight is the 0..1 multiplier used by the scoring engine for that level.
export const EXPERIENCE_LEVELS: { value: ExperienceLevel; label: string; weight: number }[] = [
  { value: 'none', label: 'None', weight: 0 },
  { value: 'lt6mo', label: 'Less than 6 months', weight: 0.3 },
  { value: '6to12mo', label: '6–12 months', weight: 0.55 },
  { value: '1to3yr', label: '1–3 years', weight: 0.8 },
  { value: '3plus', label: '3+ years', weight: 1 },
]

export const CONFIDENCE_MIN = 1
export const CONFIDENCE_MAX = 10

// ── Positions & pay ───────────────────────────────────────────────────────────
export const POSITIONS: Record<Position, { value: Position; title: string; payPerDay: number; blurb: string }> = {
  driver: {
    value: 'driver',
    title: 'Driver',
    payPerDay: 175,
    blurb: 'Lead a two-person crew running box-truck delivery, moving, appliance installs, and junk-removal routes across DFW.',
  },
  helper: {
    value: 'helper',
    title: 'Driver Helper',
    payPerDay: 150,
    blurb: 'Ride with a driver and do the hands-on work: loading, carrying, wrapping, installing, and taking care of the customer.',
  },
}

export const PAY_NOTICE = 'Starting pay is a floor, not a ceiling. Pay increases based on experience, performance, certifications, and leadership.'

// ── Position requirements (display) ───────────────────────────────────────────
export const REQUIREMENTS: Record<Position, string[]> = {
  driver: [
    "Valid Driver's License (mandatory upload)",
    'Must be at least 21 years old (per company policy)',
    'Must have reliable transportation',
    "Must be able to safely operate a 26' box truck",
    'Must be able to lift 150+ lbs with assistance',
    'Customer service skills',
    'Smartphone with data',
  ],
  helper: [
    "State-issued ID minimum (Driver's License also accepted)",
    'Must be physically capable of lifting heavy items',
    'Reliable transportation to the reporting location',
    'Customer service skills',
    'Smartphone',
  ],
}

// ── Required document uploads ─────────────────────────────────────────────────
// Applicants cannot submit until every required doc for their position is present.
export type DocKind = 'drivers_license' | 'id' | 'ss_card' | 'headshot'

export type RequiredDoc = { kind: DocKind; label: string; help: string }

export const REQUIRED_DOCS: Record<Position, RequiredDoc[]> = {
  driver: [
    { kind: 'drivers_license', label: "Driver's License", help: 'Clear photo of the front. Must be valid and unexpired.' },
    { kind: 'ss_card', label: 'Social Security Card', help: 'Used for onboarding and payroll if hired.' },
    { kind: 'headshot', label: 'Professional Headshot (white background)', help: 'Used for your employee badge — see the photo rules.' },
  ],
  helper: [
    { kind: 'id', label: "State ID or Driver's License", help: 'Clear photo of the front of a valid, unexpired ID.' },
    { kind: 'ss_card', label: 'Social Security Card', help: 'Used for onboarding and payroll if hired.' },
    { kind: 'headshot', label: 'Professional Headshot (white background)', help: 'Used for your employee badge — see the photo rules.' },
  ],
}

export const HEADSHOT_GUIDELINES: string[] = [
  'Plain white background',
  'Face centered',
  'Looking directly at the camera',
  'No sunglasses',
  'No hats or hoodies (unless religious accommodation)',
  'Good lighting',
  'Passport-style photo',
]

export function requiredDocKinds(position: Position): DocKind[] {
  return REQUIRED_DOCS[position].map(d => d.kind)
}

// ── Skills assessment ─────────────────────────────────────────────────────────
// Each question is answered with an ExperienceLevel + a 1–10 confidence rating.
export type AssessmentQuestion = { key: string; label: string }
export type AssessmentCategory = { key: string; title: string; positions: Position[]; questions: AssessmentQuestion[] }

const ALL: Position[] = ['driver', 'helper']

export const ASSESSMENT: AssessmentCategory[] = [
  {
    key: 'furniture', title: 'Furniture Delivery', positions: ALL,
    questions: [
      { key: 'sectionals', label: 'Sectionals' },
      { key: 'beds', label: 'Beds' },
      { key: 'dressers', label: 'Dressers' },
      { key: 'dining_tables', label: 'Dining tables' },
      { key: 'entertainment_centers', label: 'Entertainment centers' },
    ],
  },
  {
    key: 'appliance', title: 'Appliance Delivery & Installation', positions: ALL,
    questions: [
      { key: 'refrigerator', label: 'Refrigerator installations' },
      { key: 'washer', label: 'Washer installations' },
      { key: 'dryer', label: 'Dryer installations' },
      { key: 'dishwasher', label: 'Dishwasher installations' },
      { key: 'range', label: 'Range installations' },
      { key: 'otr_microwave', label: 'Over-the-range microwave installations' },
    ],
  },
  {
    key: 'moving', title: 'Moving Experience', positions: ALL,
    questions: [
      { key: 'residential', label: 'Residential moving' },
      { key: 'commercial', label: 'Commercial moving' },
      { key: 'office', label: 'Office moves' },
      { key: 'packing', label: 'Packing' },
      { key: 'wrapping', label: 'Wrapping furniture' },
      { key: 'stair_carries', label: 'Stair carries' },
      { key: 'elevator', label: 'Elevator moves' },
    ],
  },
  {
    key: 'junk', title: 'Junk Removal', positions: ALL,
    questions: [
      { key: 'estate', label: 'Estate cleanouts' },
      { key: 'garage', label: 'Garage cleanouts' },
      { key: 'brush', label: 'Brush hauling' },
      { key: 'construction_debris', label: 'Construction debris' },
      { key: 'heavy_item', label: 'Heavy item removal' },
      { key: 'loading_trailers', label: 'Loading trailers' },
      { key: 'loading_box_trucks', label: 'Loading box trucks' },
    ],
  },
  {
    key: 'driving', title: 'Driving Experience', positions: ['driver'],
    questions: [
      { key: 'box_truck_26', label: "26' Box Truck" },
      { key: 'towing', label: 'Towing trailers' },
      { key: 'liftgate', label: 'Liftgate experience' },
      { key: 'dot_knowledge', label: 'DOT knowledge' },
      { key: 'daily_inspections', label: 'Daily inspections' },
      { key: 'route_planning', label: 'Route planning' },
    ],
  },
]

export function assessmentFor(position: Position): AssessmentCategory[] {
  return ASSESSMENT.filter(c => c.positions.includes(position))
}

// ── Scenario questions ────────────────────────────────────────────────────────
export type ScenarioPrompt = { key: string; prompt: string }

export const SCENARIOS: ScenarioPrompt[] = [
  { key: 'fridge_doorway', prompt: "A customer says their brand-new refrigerator won't fit through the doorway. What do you do?" },
  { key: 'washer_leak', prompt: 'A washer begins leaking during installation. Walk us through your process.' },
  { key: 'undisclosed_stairs', prompt: "You arrive at a home with three flights of stairs that weren't disclosed. What would you do?" },
  { key: 'helper_unsafe', prompt: 'A helper refuses to lift safely. How do you handle it?' },
  { key: 'running_late', prompt: 'The customer becomes angry because the crew is running late. What do you do?' },
  { key: 'wall_damage', prompt: 'You damage a wall while moving furniture. What do you do?' },
  { key: 'unsafe_request', prompt: "You're asked to move something that you believe is unsafe. How do you respond?" },
  { key: 'truck_full', prompt: 'The truck is full before the job is complete. What do you do?' },
  { key: 'out_of_scope', prompt: 'The customer asks you to perform work outside the original scope. How do you handle it?' },
]

// Rubric dimensions used to evaluate scenario answers.
export const RUBRIC_DIMENSIONS = ['safety', 'customerService', 'problemSolving', 'honesty', 'professionalism'] as const
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number]
export const RUBRIC_LABELS: Record<RubricDimension, string> = {
  safety: 'Safety',
  customerService: 'Customer Service',
  problemSolving: 'Problem Solving',
  honesty: 'Honesty',
  professionalism: 'Professionalism',
}

// ── Readiness-score bands ─────────────────────────────────────────────────────
export type ScoreBand = 'excellent' | 'interview' | 'review' | 'not_qualified'

export const BAND_META: Record<ScoreBand, { label: string; emoji: string; tone: string; min: number }> = {
  excellent: { label: 'Excellent Candidate', emoji: '🟢', tone: '#34d399', min: 80 },
  interview: { label: 'Interview Recommended', emoji: '🟡', tone: '#fbbf24', min: 60 },
  review: { label: 'Needs Review', emoji: '🟠', tone: '#fb923c', min: 40 },
  not_qualified: { label: 'Not Qualified', emoji: '🔴', tone: '#f87171', min: 0 },
}

export function bandFor(score: number): ScoreBand {
  if (score >= BAND_META.excellent.min) return 'excellent'
  if (score >= BAND_META.interview.min) return 'interview'
  if (score >= BAND_META.review.min) return 'review'
  return 'not_qualified'
}
