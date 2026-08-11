/**
 * @danypops/pi-web-spider — Pi extension exposing web_fetch, web_session,
 * web_category, and web_quotes.
 *
 * Thin authenticated client of the Web Spider daemon (@danypops/web-spider-daemon):
 * this package owns each tool's contract (parameters, output shapes,
 * presentation) and daemon connection lifecycle; it performs no fetching,
 * crawling, caching, throttling, robots.txt checking, or Playwright
 * rendering itself — the daemon does all of that.
 *
 * Composition root only (SRP): each tool's own schema, handlers, and
 * registration live in their own file (fetch-tool.ts/session-tool.ts/
 * category-tool.ts/quotes-tool.ts), all built against one shared
 * VehicleGateway (vehicle-gateway.ts) rather than each importing a concrete
 * daemon client directly (DIP).
 *
 * Install: pi install git:github.com/DanyPops/web-spider
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCategoryTool } from "./category-tool.js";
import { registerFetchTool } from "./fetch-tool.js";
import { registerQuotesTool } from "./quotes-tool.js";
import { registerSessionTool } from "./session-tool.js";
import { registerWebSpiderUsageCommand } from "./usage-command.js";
import { createVehicleGateway } from "./vehicle-gateway.js";

export default async function (pi: ExtensionAPI) {
	const gateway = createVehicleGateway();

	registerFetchTool(pi, gateway);
	registerSessionTool(pi, gateway);
	registerCategoryTool(pi, gateway);
	registerQuotesTool(pi, gateway);

	registerWebSpiderUsageCommand(pi);
}
