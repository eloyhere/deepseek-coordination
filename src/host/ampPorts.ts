/**
 * Host ports for the AMP model and runtime modules.
 *
 * AMP deliberately does not ship an LLM client or an execution runtime: it
 * exposes `ModelPort` / `ExecutionCoordinator` contracts and the host supplies
 * the implementations. These classes own that lifecycle for the plugin, so the
 * modules have a real, configurable application here instead of being unused.
 */
import { proposeNextStep } from 'attention-manifest-protocol/model'
import type { ModelPort, ModelProposal, ModelRequest } from 'attention-manifest-protocol/model'
import { ExecutionCoordinator, MemoryReceiptSink } from 'attention-manifest-protocol/runtime'
import type { ReceiptSink } from 'attention-manifest-protocol/runtime'
import type { EvidenceLedger } from 'attention-manifest-protocol/evidence'
import type { Executor } from 'attention-manifest-protocol/execution'
import type { JsonValue } from 'attention-manifest-protocol'

export class AmpModel {
  private port: ModelPort | undefined

  /** Installs the host's model adapter; `undefined` removes it. */
  setPort(port: ModelPort | undefined): void {
    this.port = port
  }

  get configured(): boolean {
    return this.port !== undefined
  }

  /** Delegates to AMP's `proposeNextStep`; fails loudly when no port is set. */
  propose(request: ModelRequest, signal?: AbortSignal): Promise<ModelProposal> {
    if (this.port === undefined) return Promise.reject(new Error('AMP model port is not configured'))
    return proposeNextStep(this.port, request, signal)
  }
}

export interface AmpRuntimeOptions {
  readonly executor: Executor<JsonValue, JsonValue>
  readonly evidence: EvidenceLedger
  readonly receipts?: ReceiptSink
  readonly clock?: () => string
}

export class AmpRuntime {
  private coordinator: ExecutionCoordinator | undefined

  /** Builds the AMP execution coordinator; receipts default to the memory sink. */
  configure(options: AmpRuntimeOptions): void {
    this.coordinator = new ExecutionCoordinator({
      executor: options.executor,
      evidence: options.evidence,
      receipts: options.receipts ?? new MemoryReceiptSink(),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    })
  }

  get configured(): boolean {
    return this.coordinator !== undefined
  }

  /** Runs child calls through the AMP coordinator; requires `configure` first. */
  execute(...args: Parameters<ExecutionCoordinator['execute']>): ReturnType<ExecutionCoordinator['execute']> {
    if (this.coordinator === undefined) return Promise.reject(new Error('AMP runtime is not configured'))
    return this.coordinator.execute(...args)
  }
}
