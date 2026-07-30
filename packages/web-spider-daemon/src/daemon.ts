/**
 * Bun composition root. Delegates to @danypops/vehicle-server's
 * runDaemonProcess -- this file used to duplicate jittor's/papyrus's own
 * daemon.ts almost exactly (bind loopback:0, write the handle only after
 * a successful bind, periodic maintenance timers, clean SIGINT/SIGTERM
 * shutdown). daemon-kit's startDaemon already logs a failing maintenance
 * task itself (never silently swallowed, never crashes the daemon) --
 * the exact bug this file's own checkpoint/optimize timers were fixed for
 * earlier this session.
 */
import { runDaemonProcess } from "@danypops/vehicle-server/daemon";
import { createLogger } from "@danypops/vehicle-server/logging";
import { DB_OPTIMIZE_INTERVAL_MS, WAL_CHECKPOINT_INTERVAL_MS } from "./constants.ts";
import { resolveSearchEnv } from "./search-env.ts";
import { ensureAuthToken, resolveLegacyCachePath, resolveWebSpiderPaths } from "./state.ts";
import { createApp, createWebSpiderService } from "./service.ts";

const logger = createLogger("web-spider-daemon");

export async function serveMain(): Promise<void> {
	const paths = resolveWebSpiderPaths();
	const token = ensureAuthToken(paths);
	// Resolved once at startup, not per search call -- see search-env.ts. Enigma
	// unreachable/unconfigured falls straight through to process.env unchanged.
	const env = await resolveSearchEnv();
	const service = createWebSpiderService(paths.database, { env });
	service.importLegacyCacheIfEmpty(resolveLegacyCachePath());

	runDaemonProcess({
		daemonLabel: "Web Spider",
		handlePath: paths.handle,
		logger,
		buildApp: () => createApp({ service, token }),
		maintenanceTasks: [
			{ name: "checkpoint", intervalMs: WAL_CHECKPOINT_INTERVAL_MS, run: () => service.checkpoint() },
			{ name: "optimize", intervalMs: DB_OPTIMIZE_INTERVAL_MS, run: () => service.optimize() },
		],
		onShutdown: () => service.close(),
		onListen: ({ host, port }) => logger.info("listening", { host, port }),
	});
}
