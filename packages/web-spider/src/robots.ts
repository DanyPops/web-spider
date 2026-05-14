/**
 * Minimal robots.txt fetcher and per-domain cache.
 * Respects User-agent: * directives (Allow, Disallow, Crawl-delay).
 * Fails open — any fetch/parse error allows all URLs.
 */

interface RobotsDirective {
	allow: boolean;
	path: string;
}

interface ParsedRobots {
	directives: RobotsDirective[];
	/** Crawl-delay in ms, if the robots.txt specified one (capped at 60s). */
	crawlDelayMs?: number;
}

function parse(text: string): ParsedRobots {
	const lines = text.split(/\r?\n/);
	const directives: RobotsDirective[] = [];
	let crawlDelayMs: number | undefined;
	let inBlock = false;

	for (const raw of lines) {
		const line = raw.split("#")[0].trim();
		if (!line) continue;

		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();

		if (key === "user-agent") {
			inBlock = value === "*";
		} else if (inBlock) {
			if (key === "disallow" && value) {
				directives.push({ allow: false, path: value });
			} else if (key === "allow" && value) {
				directives.push({ allow: true, path: value });
			} else if (key === "crawl-delay") {
				const s = parseFloat(value);
				if (!isNaN(s) && s > 0) crawlDelayMs = Math.min(s * 1_000, 60_000);
			}
		}
	}

	return { directives, crawlDelayMs };
}

function isAllowed(robots: ParsedRobots, path: string): boolean {
	// Longest matching path prefix wins.
	let best: RobotsDirective | undefined;
	for (const d of robots.directives) {
		if (path.startsWith(d.path)) {
			if (!best || d.path.length > best.path.length) best = d;
		}
	}
	return best?.allow ?? true; // default: allow
}

const TTL_MS = 60 * 60 * 1_000; // 1 hour

export class RobotsCache {
	private readonly cache = new Map<string, { robots: ParsedRobots; expiresAt: number }>();
	private readonly userAgent: string;

	constructor(userAgent = "web-spider/0.1") {
		this.userAgent = userAgent;
	}

	/**
	 * Returns whether the URL is allowed and the crawl-delay if specified.
	 * Caches per origin for 1 hour. Fails open on any error.
	 */
	async check(url: string): Promise<{ allowed: boolean; crawlDelayMs?: number }> {
		const { origin, pathname } = new URL(url);
		let entry = this.cache.get(origin);

		if (!entry || Date.now() > entry.expiresAt) {
			const robots = await this.fetchRobots(`${origin}/robots.txt`);
			entry = { robots, expiresAt: Date.now() + TTL_MS };
			this.cache.set(origin, entry);
		}

		return {
			allowed: isAllowed(entry.robots, pathname),
			crawlDelayMs: entry.robots.crawlDelayMs,
		};
	}

	private async fetchRobots(robotsUrl: string): Promise<ParsedRobots> {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 5_000);
			let res: Response;
			try {
				res = await globalThis.fetch(robotsUrl, {
					signal: controller.signal,
					headers: { "User-Agent": this.userAgent },
				});
			} finally {
				clearTimeout(timer);
			}
			if (!res.ok) return { directives: [] }; // 404 → allow all
			return parse(await res.text());
		} catch {
			return { directives: [] }; // network error → fail open
		}
	}
}
