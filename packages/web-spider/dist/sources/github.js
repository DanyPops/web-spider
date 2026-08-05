const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "web-spider/0.1 (AI agent research tool; +https://github.com/DanyPops)";
const API_VERSION = "2022-11-28";
/**
 * Parses github.com/{owner}/{repo}[/issues|pull/{number}] shapes. Returns
 * null for anything else (blob/file browsing, wiki pages, github.com's own
 * marketing pages, other hosts) -- those aren't this strategy's shape.
 */
export function parseGitHubUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return null;
    }
    if (parsed.hostname.toLowerCase() !== "github.com")
        return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2)
        return null;
    const [owner, repo, resource, numberStr] = segments;
    if (!owner || !repo)
        return null;
    if (segments.length === 2)
        return { owner, repo, kind: "repo" };
    if ((resource === "issues" || resource === "pull") && numberStr && /^\d+$/.test(numberStr)) {
        return { owner, repo, kind: "issue", number: Number(numberStr) };
    }
    return null; // blob/, tree/, wiki/, releases/, etc. -- not this strategy's shape
}
function resolveToken(options) {
    return options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
}
async function githubFetch(url, httpClient, options) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = DEFAULT_USER_AGENT } = options;
    const token = resolveToken(options);
    const headers = {
        "User-Agent": userAgent,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
    };
    if (token)
        headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await httpClient.fetch({ url, signal: controller.signal, headers });
        if (!res.ok)
            return null;
        const body = await res.text();
        try {
            return JSON.parse(body);
        }
        catch {
            return null;
        }
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
async function queryRepo(owner, repo, httpClient, options) {
    const info = await githubFetch(`https://api.github.com/repos/${owner}/${repo}`, httpClient, options);
    if (!info)
        return null;
    const readme = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/readme`, httpClient, options);
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
    return {
        kind: "repo",
        title: info.full_name ?? `${owner}/${repo}`,
        markdown,
        htmlUrl: info.html_url ?? `https://github.com/${owner}/${repo}`,
    };
}
async function queryIssue(owner, repo, number, httpClient, options) {
    const issue = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, httpClient, options);
    if (!issue)
        return null;
    const kind = issue.pull_request ? "pull" : "issue";
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
export async function queryGitHub(url, httpClient, options = {}) {
    const info = parseGitHubUrl(url);
    if (!info)
        return null;
    if (info.kind === "repo")
        return queryRepo(info.owner, info.repo, httpClient, options);
    return queryIssue(info.owner, info.repo, info.number, httpClient, options);
}
//# sourceMappingURL=github.js.map