/**
 * Bun composition root. Delegates to @danypops/daemon-kit's
 * runDaemonProcess -- this file used to duplicate jittor's/papyrus's own
 * daemon.ts almost exactly (bind loopback:0, write the handle only after
 * a successful bind, periodic maintenance timers, clean SIGINT/SIGTERM
 * shutdown). daemon-kit's startDaemon already logs a failing maintenance
 * task itself (never silently swallowed, never crashes the daemon) --
 * the exact bug this file's own checkpoint/optimize timers were fixed for
 * earlier this session.
 */
import { runDaemonProcess } from "@danypops/daemon-kit/daemon";
import { createLogger } from "@danypops/daemon-kit/logging";
import { DB_OPTIMIZE_INTERVAL_MS, WAL_CHECKPOINT_INTERVAL_MS } from "./constants.ts";
import { ensureAuthToken, resolveLegacyCachePath, resolveWebSpiderPaths } from "./state.ts";
import { createApp, createWebSpiderService } from "./service.ts";

const logger = createLogger("web-spider-daemon");

export function serveMain(): void {
	const paths = resolveWebSpiderPaths();
	const token = ensureAuthToken(paths);
	const service = createWebSpiderService(paths.database);
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
