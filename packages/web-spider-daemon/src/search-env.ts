/**
 * Resolves the search-provider environment handed to
 * @danypops/web-spider's engine resolver: a running Enigma vault first
 * (optional, additive -- see @danypops/enigma-client), falling back to
 * whatever the daemon's own process environment already has. Static
 * provider API keys (Brave/Tavily/Exa/Serper/SerpApi) never rotate
 * mid-process, so this runs once at daemon startup rather than per
 * search call.
 */
import { tryEnigmaAccessToken, type TryEnigmaAccessToken } from "@danypops/enigma-client";

/** Search-engine identifier (matches @danypops/web-spider's own SearchEngine union) -> Enigma backend name + daemon env var it fills. */
const ENIGMA_BACKED_ENGINES: ReadonlyArray<{ backend: string; envVar: string }> = [
	{ backend: "brave", envVar: "BRAVE_SEARCH_API_KEY" },
	{ backend: "tavily", envVar: "TAVILY_API_KEY" },
	{ backend: "exa", envVar: "EXA_API_KEY" },
	{ backend: "serper", envVar: "SERPER_API_KEY" },
	{ backend: "serpapi", envVar: "SERPAPI_API_KEY" },
];

/**
 * Returns a copy of baseEnv with each provider's env var overwritten by
 * Enigma's stored key when Enigma has one -- Enigma is the preferred
 * source, matching tickets'/pipes' own "vault first" precedent. A
 * provider Enigma doesn't know about keeps baseEnv's value untouched, so
 * an existing static Environment= key in the systemd unit keeps working
 * during the migration. One provider's lookup failing (rejecting, timing
 * out) never blocks another's, nor startup itself -- defensively contained
 * even though the real tryEnigmaAccessToken never throws.
 */
export async function resolveSearchEnv(
	baseEnv: Record<string, string | undefined> = process.env,
	tryEnigma: TryEnigmaAccessToken = tryEnigmaAccessToken,
): Promise<Record<string, string | undefined>> {
	const env = { ...baseEnv };
	await Promise.all(
		ENIGMA_BACKED_ENGINES.map(async ({ backend, envVar }) => {
			try {
				const token = await tryEnigma(backend, { env: baseEnv });
				if (token) env[envVar] = token;
			} catch {
				// fall through to baseEnv's own value for this provider, if any
			}
		}),
	);
	return env;
}
