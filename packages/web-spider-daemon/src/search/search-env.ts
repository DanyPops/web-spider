/**
 * Resolves the search-provider environment handed to @danypops/web-spider's
 * engine resolver, strongest source last-applied (wins) to weakest:
 *
 *   1. baseEnv itself (the daemon's raw process environment) -- weakest,
 *      and on a systemd --user unit inherited far more broadly than
 *      intended (this daemon's own env carries the whole desktop session's
 *      secrets, not just its own).
 *   2. This daemon's own local file-backed store (search-secrets.ts) --
 *      `web-spider search-key set <engine>`, one small JSON file per
 *      engine, scoped to exactly what this daemon needs.
 *   3. A running Enigma vault, opted into through this daemon's local
 *      enigma.json configuration (or the legacy WEB_SPIDER_USE_ENIGMA flag)
 *      -- checked last so it always wins when present, matching
 *      pipes'/tickets' own "vault first" precedent.
 *
 * Enigma's own loop is data-driven, not a hardcoded backend list: this
 * client asks Enigma (`tryEnigmaWhoAmI`) what backends it's actually
 * registered for, then for each one reads `credential.extra.envVarName` --
 * the env var the operator chose at `enigma login apikey --name X --env-var
 * VAR` time -- rather than guessing a backend name or env var in source. A
 * backend name mismatch (wrong case, renamed) becomes an empty/short
 * `backends` list, discoverable by inspecting Enigma's own registration,
 * not a silent client-side guess that only fails at first real search call.
 *
 * Enigma involvement is opt-in, not inferred from Enigma merely being
 * reachable: a shared admin-token file can exist for a totally unrelated
 * daemon on the same machine, and being able to reach Enigma is not the
 * same as this daemon wanting to. The opt-in is a non-secret local config
 * value so it persists without entering Armada desired state. The local file store carries no such
 * ambient-reachability risk (nothing to reach but this daemon's own state
 * directory), so it is always consulted, unconditionally.
 *
 * Runs once at daemon startup, not per search call -- these are static
 * provider keys with no refresh flow. A key stored or removed via `web-spider
 * search-key ...` takes effect on the daemon's next restart, same as an
 * Enigma registration change.
 */
import { type TryEnigmaCredential, type TryEnigmaWhoAmI, tryEnigmaCredential, tryEnigmaWhoAmI } from "@danypops/enigma-client";
import { envKeyForEngine, listRegisteredSearchEngines } from "@danypops/web-spider";
import { resolveWebSpiderPaths } from "../state.ts";
import { loadEnigmaConfig, resolveEnigmaConfigPath } from "./enigma-config.ts";
import { createSearchKeyStore, resolveSearchKeysDir } from "./search-secrets.ts";

function enigmaOptInOverride(env: Record<string, string | undefined>): boolean | undefined {
	const flag = env.WEB_SPIDER_USE_ENIGMA;
	if (flag === "1" || flag === "true") return true;
	if (flag === "0" || flag === "false") return false;
	return undefined;
}

export interface ResolveSearchEnvDeps {
	tryWhoAmI?: TryEnigmaWhoAmI;
	tryCredential?: TryEnigmaCredential;
	/** Overridable for tests; defaults to this daemon's own real state directory. */
	searchKeysDir?: string;
	/** Overridable for tests; defaults to the persisted local Enigma opt-in. */
	useEnigma?: boolean;
}

export async function resolveSearchEnv(
	baseEnv: Record<string, string | undefined> = process.env,
	deps: ResolveSearchEnvDeps = {},
): Promise<Record<string, string | undefined>> {
	const env = { ...baseEnv };

	const searchKeysDir = deps.searchKeysDir ?? resolveSearchKeysDir(resolveWebSpiderPaths({ env: baseEnv }));
	for (const backend of listRegisteredSearchEngines()) {
		const envVar = envKeyForEngine(backend);
		if (!envVar) continue;
		const stored = createSearchKeyStore(searchKeysDir, backend).load();
		if (stored) env[envVar] = stored;
	}

	const useEnigma =
		enigmaOptInOverride(baseEnv) ??
		deps.useEnigma ??
		loadEnigmaConfig(resolveEnigmaConfigPath(resolveWebSpiderPaths({ env: baseEnv }))).useEnigma;
	if (!useEnigma) return env;

	const tryWhoAmI = deps.tryWhoAmI ?? tryEnigmaWhoAmI;
	const tryCredential = deps.tryCredential ?? tryEnigmaCredential;
	const token = baseEnv.ENIGMA_CLIENT_TOKEN;

	let who: Awaited<ReturnType<TryEnigmaWhoAmI>>;
	try {
		who = await tryWhoAmI({ env: baseEnv, token });
	} catch {
		return env; // Enigma unreachable or misbehaving -- env resolved so far stands
	}
	const backends = who?.backends;
	if (!backends || backends.length === 0) return env;

	await Promise.all(
		backends.map(async (backend) => {
			try {
				const credential = await tryCredential(backend, { env: baseEnv, token });
				const envVar = credential?.extra?.envVarName;
				if (credential?.accessToken && envVar) env[envVar] = credential.accessToken;
			} catch {
				// fall through to whatever value this backend's env var already resolved to
			}
		}),
	);
	return env;
}

/**
 * BYOK key stacking: every stored key *beyond* the primary one already
 * merged into resolveSearchEnv()'s env, per provider -- for
 * createEngineResolver's additionalKeys, which wraps a provider with more
 * than one key in a RotatingKeySearchEngine instead of a single-key
 * adapter. Only the local file-store tier (`web-spider search-key add`)
 * supports multiple keys; raw process env and Enigma remain single-value
 * tiers, unchanged by this -- a provider with zero or one stored key is
 * simply absent from the returned object, preserving the exact single-key
 * behavior for everyone not using BYOK stacking.
 */
export function resolveAdditionalSearchKeys(
	searchKeysDir: string = resolveSearchKeysDir(resolveWebSpiderPaths()),
): Partial<Record<string, string[]>> {
	const additional: Partial<Record<string, string[]>> = {};
	for (const backend of listRegisteredSearchEngines()) {
		const keys = createSearchKeyStore(searchKeysDir, backend).loadAll();
		if (keys.length > 1) additional[backend] = keys.slice(1);
	}
	return additional;
}
