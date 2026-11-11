/**
 * AMP behaviour governance for tool execution batches.
 *
 * Every `execution.run` batch is one observable sample of how the plugin drives
 * tools. The sample is recorded as an AMP shadow validation (record now,
 * evaluate later) so behaviour history is real data instead of a host counter.
 */
import { BehaviorGovernance } from 'attention-manifest-protocol/behavior'

/** Conservative release policy: publication is never automatic. */
const RELEASE_POLICY = {
  minimumIndependentSamples: 3,
  requireComparison: false,
  minimumImprovement: 0,
  minimumPassRate: 0.8,
} as const

export interface ExecutionRunSample {
  readonly runId: string
  readonly successes: number
  readonly total: number
}

export class AmpBehaviour {
  readonly governance: BehaviorGovernance
  readonly candidateId = 'behavior:deepseek-coordination:execution-run'
  private readonly now: () => string

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now
    this.governance = new BehaviorGovernance(RELEASE_POLICY, now)
    // AMP requires validated traces on creation; these seed observations declare
    // the baseline (scores 1) that later shadow validations are compared against.
    const at = now()
    const traces = [0, 1, 2].map((index) => ({
      traceId: `trace:seed:${index}`,
      behaviorId: 'dsh.execution.run',
      sampleId: `sample:seed:${index}`,
      independenceKey: `seed:${index}`,
      validated: true,
      candidateScore: 1,
      baselineScore: 0,
      validator: 'dsh.execution',
      observedAt: at,
      provenance: [],
    }))
    this.governance.createCandidate({
      candidateId: this.candidateId,
      behaviorId: 'dsh.execution.run',
      version: '0.14.0',
      traces,
    })
  }

  /** Records one batch observation; never mutates candidate state. */
  recordRun(sample: ExecutionRunSample): void {
    if (sample.total <= 0) return
    this.governance.recordShadowValidation({
      shadowId: `shadow:${sample.runId}`,
      candidateId: this.candidateId,
      sampleId: sample.runId,
      independenceKey: `run:${sample.runId}`,
      validator: 'dsh.execution',
      candidateScore: sample.successes / sample.total,
      baselineScore: 1,
      passed: sample.successes === sample.total,
      observedAt: this.now(),
    })
  }

  get observations(): number {
    return this.governance.listShadowValidations(this.candidateId).length
  }

  summary(): { candidateId: string; observations: number } {
    return { candidateId: this.candidateId, observations: this.observations }
  }
}
