export interface CrawlBudgetState {
	pagesUsed: number;
	errorsUsed: number;
	/** Running total of extracted content size (sum of fetched pages' markdown.length so far). */
	charsUsed: number;
	/** Wall-clock time elapsed since the crawl started, in milliseconds. */
	elapsedMs: number;
}

/** Why a crawl stopped. "complete" means the frontier simply ran out — not a budget limit. */
export type CrawlStopReason = "complete" | "max-pages" | "max-total-chars" | "deadline";

/**
 * Strategy owning "should we stop fetching" bookkeeping for a crawl,
 * replacing the pages.size + errors.size comparisons previously repeated
 * across crawl()'s shouldVisit gate, main-loop guard, and remaining-slot
 * calculation. The default reproduces today's maxPages-only behavior
 * exactly; additional caps (total extracted characters, wall-clock
 * deadline) are additive extensions a later task can add as another
 * implementation of this same port.
 */
export interface CrawlBudget {
	/** True once no more pages should be fetched. */
	isExhausted(state: CrawlBudgetState): boolean;
	/** How many more fetches are allowed right now (never negative). */
	remaining(state: CrawlBudgetState): number;
	/** Optional: why isExhausted() is true, for CrawlResult.nextAction reporting. Defaults to "max-pages" when omitted. */
	reason?(state: CrawlBudgetState): CrawlStopReason;
}

export class MaxPagesBudget implements CrawlBudget {
	constructor(private readonly maxPages: number) {}

	isExhausted(state: CrawlBudgetState): boolean {
		return state.pagesUsed + state.errorsUsed >= this.maxPages;
	}

	remaining(state: CrawlBudgetState): number {
		return Math.max(0, this.maxPages - state.pagesUsed - state.errorsUsed);
	}
}

export interface DefaultCrawlBudgetOptions {
	maxPages: number;
	/** Total extracted-content character cap across the whole crawl. Omit for no cap. */
	maxTotalChars?: number;
	/** Wall-clock cap for the whole crawl, in milliseconds (default 120000). */
	deadlineMs?: number;
}

/**
 * Combines the three caps a content-adaptive crawl needs (page count, total
 * extracted characters, wall-clock deadline). A pure function of the state
 * crawl() computes each check — it owns no clock of its own, so it is
 * trivial to unit test without fake timers.
 */
export class DefaultCrawlBudget implements CrawlBudget {
	private readonly maxPages: number;
	private readonly maxTotalChars: number;
	private readonly deadlineMs: number;

	constructor(options: DefaultCrawlBudgetOptions) {
		this.maxPages = options.maxPages;
		this.maxTotalChars = options.maxTotalChars ?? Number.POSITIVE_INFINITY;
		this.deadlineMs = options.deadlineMs ?? 120_000;
	}

	isExhausted(state: CrawlBudgetState): boolean {
		return (
			state.pagesUsed + state.errorsUsed >= this.maxPages || state.charsUsed >= this.maxTotalChars || state.elapsedMs >= this.deadlineMs
		);
	}

	remaining(state: CrawlBudgetState): number {
		return Math.max(0, this.maxPages - state.pagesUsed - state.errorsUsed);
	}

	reason(state: CrawlBudgetState): CrawlStopReason {
		if (state.elapsedMs >= this.deadlineMs) return "deadline";
		if (state.charsUsed >= this.maxTotalChars) return "max-total-chars";
		if (state.pagesUsed + state.errorsUsed >= this.maxPages) return "max-pages";
		return "complete";
	}
}
