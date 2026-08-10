export class MaxPagesBudget {
    constructor(maxPages) {
        this.maxPages = maxPages;
    }
    isExhausted(state) {
        return state.pagesUsed + state.errorsUsed >= this.maxPages;
    }
    remaining(state) {
        return Math.max(0, this.maxPages - state.pagesUsed - state.errorsUsed);
    }
}
/**
 * Combines the three caps a content-adaptive crawl needs (page count, total
 * extracted characters, wall-clock deadline). A pure function of the state
 * crawl() computes each check — it owns no clock of its own, so it is
 * trivial to unit test without fake timers.
 */
export class DefaultCrawlBudget {
    constructor(options) {
        this.maxPages = options.maxPages;
        this.maxTotalChars = options.maxTotalChars ?? Number.POSITIVE_INFINITY;
        this.deadlineMs = options.deadlineMs ?? 120_000;
    }
    isExhausted(state) {
        return (state.pagesUsed + state.errorsUsed >= this.maxPages || state.charsUsed >= this.maxTotalChars || state.elapsedMs >= this.deadlineMs);
    }
    remaining(state) {
        return Math.max(0, this.maxPages - state.pagesUsed - state.errorsUsed);
    }
    reason(state) {
        if (state.elapsedMs >= this.deadlineMs)
            return "deadline";
        if (state.charsUsed >= this.maxTotalChars)
            return "max-total-chars";
        if (state.pagesUsed + state.errorsUsed >= this.maxPages)
            return "max-pages";
        return "complete";
    }
}
//# sourceMappingURL=budget.js.map