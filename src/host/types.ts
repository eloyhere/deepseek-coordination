/** One registered AMP module, projected from the protocol surface. */
export interface AmpVerb {
  readonly verb: string
  readonly mutating: boolean
  readonly authority: readonly string[]
  readonly summary: string
}

export interface AmpModule {
  readonly module: string
  readonly tier: 'agent' | 'host' | 'hidden'
  readonly summary: string
  readonly verbs: readonly AmpVerb[]
  readonly withheld: readonly { readonly verb: string; readonly reason: string }[]
}

/** Result returned by one module tool call. */
export interface AmpCallResult {
  readonly module: string
  readonly verb: string
  readonly value: unknown
}
