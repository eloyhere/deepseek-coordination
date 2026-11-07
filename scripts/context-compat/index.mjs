//#region src/host/providers/registry.ts
function canonicalBase(value) {
	const url = new URL(value);
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError("API base must be an HTTP(S) URL without credentials, query or fragment");
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
var ProviderOptimizationRegistry = class {
	entries = /* @__PURE__ */ new Map();
	register(policy) {
		const base = canonicalBase(policy.apiBase);
		if (!policy.id || typeof policy.optimize !== "function" || policy.endpoints.length === 0 || policy.endpoints.some((path) => !/^[a-z][a-z0-9/-]*$/i.test(path) || path.includes(".."))) throw new TypeError("A policy needs an id, relative endpoints and an optimizer");
		if (this.entries.has(base) || [...this.entries.values()].some((entry) => entry.id === policy.id)) throw new Error("Provider policy id and API base must be unique");
		const registration = {
			...policy,
			apiBase: base,
			endpoints: [...new Set(policy.endpoints)],
			matched: 0,
			patched: 0
		};
		this.entries.set(base, registration);
		return () => {
			if (this.entries.get(base) === registration) this.entries.delete(base);
		};
	}
	resolve(url, method) {
		if (method.toUpperCase() !== "POST") return void 0;
		const target = new URL(url);
		if (target.username || target.password) return void 0;
		for (const registration of [...this.entries.values()].sort((a, b) => b.apiBase.length - a.apiBase.length)) {
			const endpoint = registration.endpoints.find((path) => `${target.origin}${target.pathname}` === `${registration.apiBase}/${path}`);
			if (endpoint !== void 0) return {
				registration,
				endpoint
			};
		}
	}
	transform(route, body) {
		route.registration.matched += 1;
		if (body === null || typeof body !== "object" || Array.isArray(body)) return void 0;
		const next = route.registration.optimize(body, { endpoint: route.endpoint });
		if (next !== void 0) route.registration.patched += 1;
		return next;
	}
	snapshot() {
		return [...this.entries.values()].map(({ optimize: _optimize, ...entry }) => ({
			...entry,
			endpoints: [...entry.endpoints]
		}));
	}
};
function createOptimizedFetch(original, registry, onPatched = () => {}) {
	return async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		const route = registry.resolve(url, method);
		if (route === void 0) return original(input, init);
		const request = new Request(input, init);
		if (request.headers.has("content-encoding")) return original(input, init);
		const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
		if (mediaType && mediaType !== "application/json" && !mediaType.endsWith("+json") && mediaType !== "text/plain") return original(input, init);
		let body;
		try {
			body = JSON.parse(await request.clone().text());
		} catch {
			return original(input, init);
		}
		const next = registry.transform(route, body);
		if (next === void 0) return original(input, init);
		const headers = new Headers(request.headers);
		headers.delete("content-length");
		onPatched();
		return original(new Request(request, {
			headers,
			body: JSON.stringify(next)
		}));
	};
}
//#endregion
//#region src/host/providers/tccxy.ts
const TCCXY_API_BASE = "https://api.tccxy.top/v1";
/** Common OpenAI model ids, including namespaced relay aliases. */
function isOpenAIModel(value) {
	if (typeof value !== "string") return false;
	const id = value.toLowerCase().replace(/^openai[/:]/, "");
	return /^(?:gpt(?:-|\d)|chatgpt(?:-|\d)|o\d+(?:-|$)|codex(?:-|$)|(?:text|code)-(?:davinci|curie|babbage|ada)(?:-|$)|(?:davinci|babbage)-\d)/.test(id);
}
function registerTccxyOptimization(registry, apiBase = TCCXY_API_BASE) {
	return registry.register({
		id: "tccxy-openai-reasoning-context",
		apiBase,
		endpoints: ["chat/completions", "responses"],
		optimize(body) {
			if (!isOpenAIModel(body.model)) return void 0;
			const reasoning = body.reasoning;
			if (reasoning !== void 0 && (reasoning === null || typeof reasoning !== "object" || Array.isArray(reasoning))) return void 0;
			const options = reasoning;
			if (options?.context === "all_turns") return void 0;
			return {
				...body,
				reasoning: {
					...options,
					context: "all_turns"
				}
			};
		}
	});
}
//#endregion
//#region src/host/providers/index.ts
const name = "provider-context-compat";
const inject = ["webServer"];
function patchBody(url, method, text, upstream = TCCXY_API_BASE) {
	const registry = new ProviderOptimizationRegistry();
	registerTccxyOptimization(registry, upstream);
	const route = registry.resolve(url, method);
	if (route === void 0) return void 0;
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		return;
	}
	const next = registry.transform(route, body);
	return next === void 0 ? void 0 : JSON.stringify(next);
}
function createCompatibleFetch(original, upstream = TCCXY_API_BASE, patched = () => {}) {
	const registry = new ProviderOptimizationRegistry();
	registerTccxyOptimization(registry, upstream);
	return createOptimizedFetch(original, registry, patched);
}
function apply(ctx) {
	const registry = new ProviderOptimizationRegistry();
	registerTccxyOptimization(registry);
	ctx.effect(() => {
		const original = globalThis.fetch;
		const wrapped = createOptimizedFetch(original, registry);
		globalThis.fetch = wrapped;
		return () => {
			if (globalThis.fetch === wrapped) globalThis.fetch = original;
		};
	});
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/provider-context-compat/status",
		handler: (request, response) => {
			const registrations = registry.snapshot();
			response.writeHead(request.method === "GET" ? 200 : 405, {
				"content-type": "application/json",
				"cache-control": "no-store"
			});
			response.end(JSON.stringify(request.method === "GET" ? {
				patched: registrations.reduce((sum, entry) => sum + entry.patched, 0),
				registrations
			} : { error: "GET only" }));
		}
	}));
}
//#endregion
export { ProviderOptimizationRegistry, apply, createCompatibleFetch, createOptimizedFetch, inject, isOpenAIModel, name, patchBody, registerTccxyOptimization };
