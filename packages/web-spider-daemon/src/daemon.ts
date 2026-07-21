/**
 * Bun composition root — mirrors papyrus/src/daemon.ts / jittor/src/daemon.ts.
 * Binds loopback-only on an OS-assigned port, writes the daemon handle only
 * after a successful bind, and removes it on clean shutdown.
 */
import { DB_OPTIMIZE_INTERVAL_MS, LOOPBACK_HOST, WAL_CHECKPOINT_INTERVAL_MS } from "./constants.ts";
import { ensureAuthToken, removeDaemonHandle, resolveWebSpiderPaths, writeDaemonHandle } from "./state.ts";
import { createApp, createWebSpiderService } from "./service.ts";

export function serveMain(): void {
	const paths = resolveWebSpiderPaths();
	const token = ensureAuthToken(paths);
	const service = createWebSpiderService(paths.database);
	const app = createApp({ service, token });
	const server = Bun.serve({
		hostname: LOOPBACK_HOST,
		port: 0,
		fetch: (request) => app.fetch(request),
	});
	if (!server.port) {
		service.close();
		throw new Error("Web Spider daemon failed to bind a listener");
	}
	writeDaemonHandle(paths, { host: LOOPBACK_HOST, port: server.port, pid: process.pid });

	const checkpointTimer = setInterval(() => {
		try { service.checkpoint(); } catch { /* best-effort maintenance */ }
	}, WAL_CHECKPOINT_INTERVAL_MS);
	const optimizeTimer = setInterval(() => {
		try { service.optimize(); } catch { /* best-effort maintenance */ }
	}, DB_OPTIMIZE_INTERVAL_MS);

	let stopping = false;
	const shutdown = () => {
		if (stopping) return;
		stopping = true;
		clearInterval(checkpointTimer);
		clearInterval(optimizeTimer);
		removeDaemonHandle(paths);
		service.close();
		void server.stop(true).finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
