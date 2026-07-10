// Crew Score (Part 9) — an INTERNAL reliability signal for scheduling, visible to
// admins and managers ONLY. Never returned to the crew portal, never shown to the
// crew member.
//
// This is a presentation layer over the ONE existing scoring source:
// lib/route-stats.computeContractorStats (server-side, from full route history).
// It reshapes those counts into a weighted factor breakdown so dispatch can see
// exactly what drives the number — without introducing a second scoring engine or
// recomputing from data the client doesn't have. A factor with no data reads
// "not measured" rather than faking a value.

export type ScoreStats = {
  assignments: number
  confirmed: number
  completed: number
  declined: number
  noResponse: number
  noShow: number
  score: number | null   // the composite from route-stats (0–100, or null)
}

export type ScoreFactor = {
  key: string
  label: string
  score: number | null   // 0–100, or null when there's no data
  detail: string
}

export type CrewScore = {
  score: number | null    // composite (= ContractorStats.score)
  band: string
  factors: ScoreFactor[]
  sampleSize: number      // resolved assignments behind the score
}

export type CrewScoreExtras = {
  lateCalloffs?: number             // late time-off requests (short notice)
  availabilityWeeksSubmitted?: number
  availabilityWeeksExpected?: number // window measured against (default 4)
  incidents?: number                // claims where this crew member bears responsibility
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

export const scoreBand = (s: number | null): string =>
  s == null ? 'No data' : s >= 85 ? 'Strong' : s >= 60 ? 'Fair' : 'Needs attention'

// Build the factor breakdown. The composite stays the route-stats score (one
// source of truth); the factors below explain it and fold in the extra signals.
export function buildCrewScore(stats: ScoreStats | undefined, extras: CrewScoreExtras = {}): CrewScore {
  const s = stats ?? { assignments: 0, confirmed: 0, completed: 0, declined: 0, noResponse: 0, noShow: 0, score: null }

  const decisions = s.confirmed + s.completed + s.declined
  const completionBase = s.completed + s.noShow
  const hasHistory = s.assignments > 0

  const lateCalloffs = extras.lateCalloffs ?? 0
  const availExpected = extras.availabilityWeeksExpected ?? 4
  const availSubmitted = extras.availabilityWeeksSubmitted

  const factors: ScoreFactor[] = [
    {
      key: 'acceptance', label: 'Acceptance',
      score: decisions > 0 ? clamp(((s.confirmed + s.completed) / decisions) * 100) : null,
      detail: decisions > 0 ? `${s.confirmed + s.completed}/${decisions} accepted` : 'No responses yet',
    },
    {
      key: 'completion', label: 'Completion',
      score: completionBase > 0 ? clamp((s.completed / completionBase) * 100) : null,
      detail: completionBase > 0 ? `${s.completed}/${completionBase} finished` : 'No finished routes yet',
    },
    {
      key: 'reliability', label: 'Reliability',
      score: (hasHistory || lateCalloffs > 0) ? clamp(100 - s.noShow * 25 - lateCalloffs * 12) : null,
      detail: (hasHistory || lateCalloffs > 0) ? `${s.noShow} no-show, ${lateCalloffs} late call-off` : 'No history yet',
    },
    {
      key: 'availability', label: 'Availability',
      score: availSubmitted === undefined ? null : clamp((Math.min(availSubmitted, availExpected) / availExpected) * 100),
      detail: availSubmitted === undefined ? 'Not measured' : `${availSubmitted}/${availExpected} weeks submitted`,
    },
    {
      key: 'incidents', label: 'Incidents',
      score: extras.incidents === undefined ? null : clamp(100 - extras.incidents * 20),
      detail: extras.incidents === undefined ? 'Not measured' : `${extras.incidents} open claim(s)`,
    },
  ]

  return { score: s.score, band: scoreBand(s.score), factors, sampleSize: s.assignments }
}
