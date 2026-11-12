/**
 * Error, duration and effectiveness read models for the value panel.
 *
 * Errors are a gate, not another additive term: a build with perfect quality and
 * ROI but a 20% failure rate is not 80% effective. This is the same shape as
 * OEE, where availability/performance are multiplied by quality. Duration uses
 * the observed p95 AMP call latency against a 250 ms target, so a single slow
 * tail call lowers the score without hiding behind the median.
 */

/** A journal entry only needs these two fields; unknown fields are ignored. */
export interface JournalSample {
  readonly ok?: boolean
  readonly durationMs?: number
}

/** Error and latency counters derived from AMP gateway calls. */
export interface ErrorSummary {
  /** False before the first call; the UI shows an empty state. */
  readonly available: boolean
  readonly calls: number
  readonly failures: number
  /** 0..1. */
  readonly errorRate: number
  /** 100 - errorRate * 100, 0..100. */
  readonly errorFree: number
  readonly medianDurationMs: number
  readonly p95DurationMs: number
  /** 0..100 against `durationTargetMs`; 100 means p95 is within target. */
  readonly durationScore: number
  readonly durationTargetMs: number
}

/** The composite benefit index shown as a percentage. */
export interface Effectiveness {
  /** 0..100; null until there is a quality sample and at least one call. */
  readonly score: number
  readonly components: {
    readonly quality: number
    readonly duration: number
    readonly errorFree: number
    readonly roi: number
  }
  /** Additive weights before the error-free gate is applied. */
  readonly weights: {
    readonly quality: number
    readonly duration: number
    readonly roi: number
  }
  readonly errorRate: number
  readonly p95DurationMs: number
  readonly formula: string
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value))
}

/** Nearest-rank percentile, clamped to the last sample. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index] ?? 0
}

/**
 * Summarize AMP gateway calls.
 *
 * Only `ok === false` counts as a failure; a missing flag is treated as success
 * because older journal entries predate the field. Invalid durations are
 * dropped from the latency sample instead of becoming zero.
 */
export function summarizeErrors(entries: readonly JournalSample[], durationTargetMs = 250): ErrorSummary {
  let calls = 0
  let failures = 0
  const durations: number[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    calls += 1
    if (entry.ok === false) failures += 1
    const duration = finite(entry.durationMs)
    if (duration !== undefined && duration >= 0) durations.push(duration)
  }
  durations.sort((a, b) => a - b)
  const errorRate = calls === 0 ? 0 : failures / calls
  const p95 = Math.round(percentile(durations, 0.95))
  const target = durationTargetMs > 0 ? durationTargetMs : 250
  return {
    available: calls > 0,
    calls,
    failures,
    errorRate,
    errorFree: clamp(100 * (1 - errorRate)),
    medianDurationMs: Math.round(percentile(durations, 0.5)),
    p95DurationMs: p95,
    // No latency sample is neutral, not perfect: absence of evidence must not
    // earn a 100% duration score.
    durationScore: durations.length === 0 ? 50 : clamp((100 * target) / p95),
    durationTargetMs: target,
  }
}

/**
 * Combine quality, latency. error-free rate and ROI into one percentage.
 *
 * The additive part is 45% quality + 25% duration + 30% ROI; the result is then
 * multiplied by the error-free fraction. Quality is intentionally not another
 * copy of the error rate, so an error is penalized once, as a gate.
 */
export function computeEffectiveness(
  quality: number | null,
  errors: ErrorSummary | null,
  roi: number,
): Effectiveness | null {
  // No journal sample is not a reason to hide the panel: use neutral latency
  // and a 100% error-free prior, and report `errors.available` separately.
  if (quality === null || errors === null) return null
  const q = clamp(quality)
  const duration = clamp(errors.durationScore)
  const roiScore = clamp((roi / 3) * 100)
  const errorFree = clamp(errors.errorFree)
  const core = 0.45 * q + 0.25 * duration + 0.3 * roiScore
  return {
    score: Math.round(core * (errorFree / 100)),
    components: {
      quality: Math.round(q),
      duration: Math.round(duration),
      errorFree: Math.round(errorFree),
      roi: Math.round(roiScore),
    },
    weights: { quality: 45, duration: 25, roi: 30 },
    errorRate: errors.errorRate,
    p95DurationMs: errors.p95DurationMs,
    formula: '(0.45 × quality + 0.25 × duration + 0.30 × ROI) × error-free',
  }
}
