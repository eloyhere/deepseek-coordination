import { Context } from "@deepseek-ai/cordis";
//#region src/host/providers/registry.d.ts
/** Address-scoped request policies; unregistered providers pass through unchanged. */
type RequestBody = Record<string, unknown>;
interface ProviderOptimization {
  readonly id: string;
  readonly apiBase: string;
  readonly endpoints: readonly string[];
  readonly optimize: (body: RequestBody, route: {
    readonly endpoint: string;
  }) => RequestBody | undefined;
}
interface Registration extends ProviderOptimization {
  matched: number;
  patched: number;
}
interface ProviderRoute {
  readonly registration: Registration;
  readonly endpoint: string;
}
type Fetch = typeof globalThis.fetch;
declare class ProviderOptimizationRegistry {
  private readonly entries;
  register(policy: ProviderOptimization): () => void;
  resolve(url: string, method: string): ProviderRoute | undefined;
  transform(route: ProviderRoute, body: unknown): RequestBody | undefined;
  snapshot(): ReadonlyArray<{
    id: string;
    apiBase: string;
    endpoints: readonly string[];
    matched: number;
    patched: number;
  }>;
}
declare function createOptimizedFetch(original: Fetch, registry: ProviderOptimizationRegistry, onPatched?: () => void): Fetch;
//#endregion
//#region src/host/providers/tccxy.d.ts
/** Common OpenAI model ids, including namespaced relay aliases. */
declare function isOpenAIModel(value: unknown): value is string;
declare function registerTccxyOptimization(registry: ProviderOptimizationRegistry, apiBase?: string): () => void;
//#endregion
//#region src/host/providers/index.d.ts
declare const name = "provider-context-compat";
declare const inject: string[];
declare function patchBody(url: string, method: string, text: string, upstream?: string): string | undefined;
declare function createCompatibleFetch(original: Fetch, upstream?: string, patched?: () => void): Fetch;
declare function apply(ctx: Context): void;
//#endregion
export { ProviderOptimizationRegistry, apply, createCompatibleFetch, createOptimizedFetch, inject, isOpenAIModel, name, patchBody, registerTccxyOptimization };