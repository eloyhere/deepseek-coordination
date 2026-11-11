/**
 * AMP capability and manifest surfaces for the module catalog.
 *
 * Every agent-tier module is registered twice: as an AMP capability (protocol
 * kind, activated at startup) and as a manifest carrying a tool definition.
 * This gives the plugin a machine-readable answer to "which AMP modules are
 * installed, at what version, with which verbs" that does not depend on
 * hand-maintained counts.
 */
import { createHash } from 'node:crypto'

import { CapabilityRegistry } from 'attention-manifest-protocol/capability'
import { ManifestStore } from 'attention-manifest-protocol/manifest'
import type { Manifest, ToolDefinition } from 'attention-manifest-protocol/manifest'

import type { AmpModule } from './types.js'

/** Protocol version these surfaces describe; keep in sync with package.json. */
export const AMP_SURFACE_VERSION = '0.14.0'

export interface AmpModuleSurface {
  readonly module: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly activationId: string
  readonly manifestId: string
  readonly digest: string
  readonly verbs: readonly string[]
}

export class AmpSurface {
  readonly capabilities: CapabilityRegistry
  readonly manifests: ManifestStore
  private readonly modules = new Map<string, AmpModuleSurface>()

  constructor(modules: readonly AmpModule[], tenantId: string, now: () => string = () => new Date().toISOString()) {
    this.capabilities = new CapabilityRegistry(now)
    this.manifests = new ManifestStore(now)
    for (const module of modules) {
      const verbs = module.verbs.map((verb) => verb.verb)
      const digest = createHash('sha256')
        .update(`${module.module}@${AMP_SURFACE_VERSION}:${verbs.join(',')}`)
        .digest('hex')
      const capabilityId = `amp.capability.${module.module}`
      this.capabilities.define({
        id: capabilityId,
        version: AMP_SURFACE_VERSION,
        kind: 'protocol',
        digest,
        contract: { verbs, summary: module.summary },
        dependencies: [],
        risk: 'low',
        definedAt: now(),
        source: 'deepseek-coordination',
      })
      const activation = this.capabilities.activate(capabilityId, AMP_SURFACE_VERSION)

      const mutating = module.verbs.some((verb) => verb.mutating)
      const tool: ToolDefinition = {
        toolId: `amp.tool.${module.module}`,
        version: AMP_SURFACE_VERSION,
        digest,
        summary: `AMP ${module.module}: ${module.summary}`.slice(0, 240),
        inputSchema: {
          type: 'object',
          properties: {
            verb: { type: 'string', enum: verbs },
            arguments: { type: 'object' },
          },
        } as never,
        risk: mutating ? 'write' : 'read',
        effect: mutating ? 'side_effect' : 'read_only',
        policyScope: `amp.${module.module}`,
      }
      const manifest: Manifest = {
        manifestId: `amp.manifest.${module.module}`,
        tenantId,
        endpointId: `amp.${module.module}`,
        endpointIdentity: 'deepseek-coordination',
        serverVersion: AMP_SURFACE_VERSION,
        digest,
        policyScope: `amp.${module.module}`,
        issuedAt: now(),
        tools: [tool],
      }
      this.manifests.put(manifest)
      this.modules.set(module.module, {
        module: module.module,
        capabilityId,
        capabilityVersion: AMP_SURFACE_VERSION,
        activationId: activation.activationId,
        manifestId: manifest.manifestId,
        digest,
        verbs,
      })
    }
  }

  infoFor(module: string): AmpModuleSurface | undefined {
    return this.modules.get(module)
  }

  get size(): number {
    return this.modules.size
  }

  /** True when the module's capability has a usable (non-invalidated) activation. */
  isActive(module: string): boolean {
    const info = this.modules.get(module)
    if (info === undefined) return false
    return this.capabilities.latestUsable(info.capabilityId) !== undefined
  }

  summary(): { modules: number; active: number; manifests: number } {
    const active = [...this.modules.keys()].filter((module) => this.isActive(module)).length
    return { modules: this.modules.size, active, manifests: this.modules.size }
  }
}
