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

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "web-spider/0.1 (AI agent research tool; +https://github.com/DanyPops)";
const API_VERSION = "2022-11-28";

type GitHubUrlInfo = { owner: string; repo: string; kind: "repo" } | { owner: string; repo: string; kind: "issue"; number: number };

/**
 * Parses github.com/{owner}/{repo}[/issues|pull/{number}] shapes. Returns
 * null for anything else (blob/file browsing, wiki pages, github.com's own
 * marketing pages, other hosts) -- those aren't this strategy's shape.
 */
export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.hostname.toLowerCase() !== "github.com") return null;

	const segments = parsed.pathname.split("/").filter(Boolean);
	if (segments.length < 2) return null;
	const [owner, repo, resource, numberStr] = segments;
	if (!owner || !repo) return null;

	if (segments.length === 2) return { owner, repo, kind: "repo" };

	if ((resource === "issues" || resource === "pull") && numberStr && /^\d+$/.test(numberStr)) {
		return { owner, repo, kind: "issue", number: Number(numberStr) };
	}
	return null; // blob/, tree/, wiki/, releases/, etc. -- not this strategy's shape
}

function resolveToken(options: GitHubStrategyOptions): string | undefined {
	return options.token ?? process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
}

async function githubFetch<T>(url: string, httpClient: IHttpClient, options: GitHubStrategyOptions): Promise<T | null> {
	const { timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = DEFAULT_USER_AGENT } = options;
	const token = resolveToken(options);
	const headers: Record<string, string> = {
		"User-Agent": userAgent,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": API_VERSION,
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await httpClient.fetch({ url, signal: controller.signal, headers });
		if (!res.ok) return null;
		const body = await res.text();
		try {
			return JSON.parse(body) as T;
		} catch {
			return null;
		}
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

interface RepoResponse {
	full_name?: string;
	description?: string | null;
	stargazers_count?: number;
	language?: string | null;
	topics?: string[];
	default_branch?: string;
	html_url?: string;
	archived?: boolean;
}

interface ReadmeResponse {
	content?: string;
	encoding?: string;
}

interface IssueResponse {
	number?: number;
	title?: string;
	state?: string;
	body?: string | null;
	user?: { login?: string } | null;
	labels?: Array<{ name?: string } | string>;
	comments?: number;
	html_url?: string;
	created_at?: string;
	updated_at?: string;
	pull_request?: unknown;
}

async function queryRepo(owner: string, repo: string, httpClient: IHttpClient, options: GitHubStrategyOptions): Promise<GitHubQueryResult | null> {
	const info = await githubFetch<RepoResponse>(`https://api.github.com/repos/${owner}/${repo}`, httpClient, options);
	if (!info) return null;

	const readme = await githubFetch<ReadmeResponse>(`https://api.github.com/repos/${owner}/${repo}/readme`, httpClient, options);
	const readmeText = readme?.encoding === "base64" && readme.content ? Buffer.from(readme.content, "base64").toString("utf8") : null;

	const summaryLines = [
		`# ${info.full_name ?? `${owner}/${repo}`}`,
		"",
		info.description ?? "",
		"",
		`- ⭐ ${info.stargazers_count ?? 0} stars`,
		`- Language: ${info.language ?? "unknown"}`,
		`- Default branch: ${info.default_branch ?? "unknown"}`,
		...(info.topics?.length ? [`- Topics: ${info.topics.join(", ")}`] : []),
		...(info.archived ? ["- ⚠️ This repository is archived (read-only)."] : []),
	];
	const markdown = [...summaryLines, "", "---", "", readmeText ?? "*No README found.*"].join("\n");

	return { kind: "repo", title: info.full_name ?? `${owner}/${repo}`, markdown, htmlUrl: info.html_url ?? `https://github.com/${owner}/${repo}` };
}

async function queryIssue(owner: string, repo: string, number: number, httpClient: IHttpClient, options: GitHubStrategyOptions): Promise<GitHubQueryResult | null> {
	const issue = await githubFetch<IssueResponse>(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, httpClient, options);
	if (!issue) return null;

	const kind: GitHubResourceKind = issue.pull_request ? "pull" : "issue";
	const labels = (issue.labels ?? []).map((label) => (typeof label === "string" ? label : (label.name ?? ""))).filter(Boolean);
	const title = `${issue.title ?? "(untitled)"} (#${issue.number ?? number})`;

	const summaryLines = [
		`# ${title}`,
		"",
		`- Kind: ${kind === "pull" ? "Pull Request" : "Issue"}`,
		`- State: ${issue.state ?? "unknown"}`,
		`- Author: ${issue.user?.login ?? "unknown"}`,
		`- Comments: ${issue.comments ?? 0}`,
		...(labels.length ? [`- Labels: ${labels.join(", ")}`] : []),
		`- Created: ${issue.created_at ?? "unknown"}`,
		`- Updated: ${issue.updated_at ?? "unknown"}`,
	];
	const markdown = [...summaryLines, "", "---", "", issue.body ?? "*No description provided.*"].join("\n");

	return { kind, title, markdown, htmlUrl: issue.html_url ?? `https://github.com/${owner}/${repo}/issues/${number}` };
}

/**
 * Queries GitHub's real API for the resource a URL refers to. Returns null
 * (never throws) for a URL that isn't a recognized github.com repo/issue/PR
 * shape, or when the API call itself fails (rate limited, not found,
 * network error) -- callers fall through to the normal fetch path on a miss.
 */
export async function queryGitHub(url: string, httpClient: IHttpClient, options: GitHubStrategyOptions = {}): Promise<GitHubQueryResult | null> {
	const info = parseGitHubUrl(url);
	if (!info) return null;
	if (info.kind === "repo") return queryRepo(info.owner, info.repo, httpClient, options);
	return queryIssue(info.owner, info.repo, info.number, httpClient, options);
}
