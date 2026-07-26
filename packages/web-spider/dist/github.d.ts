/**
 * GitHub REST API strategy — query github.com's real API for repo metadata,
 * READMEs, issues, and pull requests instead of scraping GitHub's JS-heavy
 * rendered pages.
 *
 * Real, verified facts (not assumed) behind this design:
 * - Unauthenticated requests are rate-limited to 60/hour per IP (confirmed
 *   via x-ratelimit-limit: 60 on a real, unauthenticated request). This is
 *   genuinely low for a general-purpose crawler tool, so an optional token
 *   (GITHUB_TOKEN, matching the ambient convention used by the gh CLI,
 *   GitHub Actions, and countless other tools -- not a web-spider-specific
 *   env var name) raises this to 5,000/hour.
 * - GET /repos/{owner}/{repo}/issues/{number} serves BOTH issues and pull
 *   requests (GitHub models a PR as a special kind of issue). The response
 *   carries a `pull_request` key only when it actually is one -- confirmed
 *   directly against a real PR (facebook/react#1).
 * - A renamed/transferred repo 301-redirects at the API level (confirmed:
 *   facebook/react's old issue #1 URL redirects to react/react). The
 *   default fetch()-based IHttpClient already follows redirects
 *   transparently; no special handling needed here.
 * - The README endpoint returns base64-encoded content, decoded here.
 */
import type { IHttpClient } from "./ports.js";
export interface GitHubStrategyOptions {
    /** Explicit token, takes precedence over GITHUB_TOKEN/GH_TOKEN env vars. Never logged. */
    token?: string;
    /** ms before aborting each API request (default 10 000). */
    timeoutMs?: number;
    userAgent?: string;
}
export type GitHubResourceKind = "repo" | "issue" | "pull";
export interface GitHubQueryResult {
    kind: GitHubResourceKind;
    title: string;
    /** Formatted Markdown: a structured summary header followed by the README/issue/PR body. */
    markdown: string;
    htmlUrl: string;
}
type GitHubUrlInfo = {
    owner: string;
    repo: string;
    kind: "repo";
} | {
    owner: string;
    repo: string;
    kind: "issue";
    number: number;
};
/**
 * Parses github.com/{owner}/{repo}[/issues|pull/{number}] shapes. Returns
 * null for anything else (blob/file browsing, wiki pages, github.com's own
 * marketing pages, other hosts) -- those aren't this strategy's shape.
 */
export declare function parseGitHubUrl(url: string): GitHubUrlInfo | null;
/**
 * Queries GitHub's real API for the resource a URL refers to. Returns null
 * (never throws) for a URL that isn't a recognized github.com repo/issue/PR
 * shape, or when the API call itself fails (rate limited, not found,
 * network error) -- callers fall through to the normal fetch path on a miss.
 */
export declare function queryGitHub(url: string, httpClient: IHttpClient, options?: GitHubStrategyOptions): Promise<GitHubQueryResult | null>;
export {};
//# sourceMappingURL=github.d.ts.map