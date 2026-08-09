export interface CrawlBudgetState {
	pagesUsed: number;
	errorsUsed: number;
}

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
