/**
 * Resolves the search-provider environment handed to
 * @danypops/web-spider's engine resolver: a running Enigma vault first
 * (optional, additive -- see @danypops/enigma-client), falling back to
 * whatever the daemon's own process environment already has.
 *
 * Data-driven, not a hardcoded backend list: this client asks Enigma
 * (`tryEnigmaWhoAmI`) what backends it's actually registered for, then for
 * each one reads `credential.extra.envVarName` -- the env var the operator
 * chose at `enigma login apikey --name X --env-var VAR` time -- rather than
 * guessing a backend name or env var in source. A backend name mismatch
 * (wrong case, renamed) becomes an empty/short `backends` list, discoverable
 * by inspecting Enigma's own registration, not a silent client-side guess
 * that only fails at first real search call.
 *
 * Runs once at daemon startup, not per search call -- these are static
 * provider keys with no refresh flow.
 */
import { tryEnigmaCredential, tryEnigmaWhoAmI, type TryEnigmaCredential, type TryEnigmaWhoAmI } from "@danypops/enigma-client";

export interface ResolveSearchEnvDeps {
	tryWhoAmI?: TryEnigmaWhoAmI;
	tryCredential?: TryEnigmaCredential;
}

/**
 * Returns a copy of baseEnv with each backend's declared env var overwritten
 * by Enigma's stored key -- Enigma is the preferred source, matching
 * tickets'/pipes' own "vault first" precedent. A backend with no
 * `extra.envVarName` is skipped (nothing safe to do with it). One backend's
 * lookup failing never blocks another's, nor startup itself -- defensively
 * contained even though the real client functions never throw.
 *
 * ENIGMA_CLIENT_TOKEN, when present in baseEnv, is this daemon's own
 * registered-client token (see `enigma client add`) -- Enigma's shared
 * admin-token file is deliberately unreadable outside its own service
 * account, so a consumer must present its own scoped token to get anything
 * back at all.
 */
export async function resolveSearchEnv(
	baseEnv: Record<string, string | undefined> = process.env,
	deps: ResolveSearchEnvDeps = {},
): Promise<Record<string, string | undefined>> {
	const tryWhoAmI = deps.tryWhoAmI ?? tryEnigmaWhoAmI;
	const tryCredential = deps.tryCredential ?? tryEnigmaCredential;
	const env = { ...baseEnv };
	const token = baseEnv.ENIGMA_CLIENT_TOKEN;

	let who: Awaited<ReturnType<TryEnigmaWhoAmI>>;
	try {
		who = await tryWhoAmI({ env: baseEnv, token });
	} catch {
		return env; // Enigma unreachable or misbehaving -- baseEnv's own values stand
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
				// fall through to baseEnv's own value for whichever env var this backend would have filled
			}
		}),
	);
	return env;
}
