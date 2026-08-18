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
import { readLaunchProvenance, runDaemonProcess } from "@danypops/vehicle-server/daemon";
import type { DaemonIdentity } from "@danypops/vehicle-server/daemon-lifecycle";
import { createLogger } from "@danypops/vehicle-server/logging";
import { openVehicleMetricsStore } from "@danypops/vehicle-server/metrics";
import { createVehicleMetricsMiddleware } from "@danypops/vehicle-server/metrics-middleware";
import { registerVehicleMetricsOperations } from "@danypops/vehicle-server/metrics-operations";
import { DB_OPTIMIZE_INTERVAL_MS, WAL_CHECKPOINT_INTERVAL_MS } from "./constants.ts";
import { createWebSpiderLifecycleLog, resolveDaemonLifecycleLogPath } from "./daemon-lifecycle.ts";
import { resolveAdditionalSearchKeys, resolveSearchEnv } from "./search/search-env.ts";
import { createSearchKeyStore, resolveSearchKeysDir } from "./search/search-secrets.ts";
import { createApp, createWebSpiderService } from "./service.ts";
import {
	clearSharedVehicleHandle,
	ensureAuthToken,
	resolveLegacyCachePath,
	resolveWebSpiderPaths,
	writeSharedVehicleHandle,
} from "./state.ts";

const logger = createLogger("web-spider-daemon");

export async function serveMain(): Promise<void> {
	const paths = resolveWebSpiderPaths();
	const token = ensureAuthToken(paths);
	// Resolved once at startup, not per search call -- see search-env.ts. Enigma
	// unreachable/unconfigured falls straight through to process.env unchanged.
	const env = await resolveSearchEnv();
	// BYOK key stacking: also resolved once at startup, same lifecycle as env
	// above -- a key added/removed via `web-spider search-key add/remove` takes
	// effect on the daemon's next restart, matching env's own tier.
	const searchKeysDir = resolveSearchKeysDir(paths);
	const additionalSearchKeys = resolveAdditionalSearchKeys(searchKeysDir);
	const loadSearchKeys = (engine: string) => createSearchKeyStore(searchKeysDir, engine).loadAll();

	// Persistent (XDG_STATE_HOME, survives a restart) -- the whole point of a lifecycle log is
	// seeing what a *previous* process instance did, not just this one.
	const lifecycleLog = createWebSpiderLifecycleLog(resolveDaemonLifecycleLogPath(paths));
	// Real identity is only known once runDaemonProcess's own startDaemon() mints it -- which
	// happens *inside* startDaemon(), after buildApp() (where daemon.diagnose gets registered)
	// already ran. This mutable ref is how the handler (reading it lazily, at call time, well after
	// the daemon has finished starting) learns the real value onListen captures below -- see
	// vehicle-server daemon.ts's own onListen doc comment for why there's no earlier hook.
	let currentIdentity: DaemonIdentity | undefined;
	const getCurrentIdentity = () => currentIdentity;

	const service = createWebSpiderService(paths.database, { env, additionalSearchKeys, loadSearchKeys, lifecycleLog, getCurrentIdentity });
	service.importLegacyCacheIfEmpty(resolveLegacyCachePath());

	// Records how often each real operation is invoked (server-side, every caller) plus, via
	// metrics.recordClientEvent, client-observed Vehicle Shell meta-tool calls -- see
	// @danypops/vehicle-server's own metrics README section. Wired directly onto the same registry
	// every real web-spider operation is already registered on, so it's discoverable through the
	// exact same tools_list/tools_man path as any other operation.
	const vehicleMetrics = openVehicleMetricsStore(paths.metrics);
	service.vehicleRegistry.useExecutionMiddleware(createVehicleMetricsMiddleware(vehicleMetrics, "web-spider"));
	registerVehicleMetricsOperations(service.vehicleRegistry, vehicleMetrics, "web-spider");

	runDaemonProcess({
		daemonLabel: "Web Spider",
		handlePath: paths.handle,
		logger,
		buildApp: () => createApp({ service, token }, { logger }),
		maintenanceTasks: [
			{ name: "checkpoint", intervalMs: WAL_CHECKPOINT_INTERVAL_MS, run: () => service.checkpoint() },
			{ name: "optimize", intervalMs: DB_OPTIMIZE_INTERVAL_MS, run: () => service.optimize() },
		],
		lifecycleLog,
		onShutdown: async () => {
			try {
				clearSharedVehicleHandle();
			} catch (error) {
				logger.error("shared_vehicle_handle_remove_failed", { message: error instanceof Error ? error.message : String(error) });
			}
			await service.close();
			vehicleMetrics.close();
		},
		onListen: ({ host, port, instanceId }) => {
			currentIdentity = {
				instanceId,
				pid: process.pid,
				startedAt: new Date().toISOString(),
				provenance: readLaunchProvenance(process.env),
			};
			logger.info("listening", { host, port });
			try {
				writeSharedVehicleHandle(port, paths.token);
			} catch (error) {
				logger.error("shared_vehicle_handle_write_failed", { message: error instanceof Error ? error.message : String(error) });
			}
		},
	});
}
