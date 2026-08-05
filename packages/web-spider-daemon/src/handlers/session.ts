/**
 * session.* projected as real VehicleOperations -- the sixth and final
 * slice of web-spider's own Vehicle protocol migration (task 4057390d).
 *
 * session.create/close mutate the daemon's own local session registry
 * (a real live browser process) -- effect: "local-write", idempotency
 * "unsafe" (create fails on a duplicate name; close fails on an
 * already-closed one -- neither is safe to blindly retry).
 *
 * session.act is classified "open-world" like fetch/crawl/search: its
 * navigate/eval actions reach arbitrary external content and can run
 * arbitrary script, not just the daemon's own bounded state. Its own
 * snapshotVersion field stays a plain input (not re-expressed as Vehicle's
 * expectedRevision) -- see task 4057390d's own notes: expectedRevision is
 * plumbed end to end but not auto-enforced, so re-expressing it would only
 * add risk without adding safety over the handler's own existing check.
 *
 * session.list is a pure read of the same registry.
 */
import { bindVehicleOperation, defineLooseObjectSchema, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { SESSION_ACTIONS } from "../domain/session-audit.ts";
import { optionalBoolean, requireString, sessionActInput } from "../service.ts";
import type { SessionService } from "../services/session-service.ts";
import { withVehicleErrorParity } from "./error-parity.ts";

const OWNER = "web-spider";
const LIMITS = { defaultTimeoutMs: 15_000, maxTimeoutMs: 60_000, maxRequestBytes: 65_536, maxResponseBytes: 1_048_576 };

export function registerSessionVehicleOperations(registry: VehicleRegistry, sessionService: SessionService): void {
	const createOperation = defineVehicleOperation({
		name: "session.create",
		version: 1,
		description: "Launches a new persistent browser session under the given name.",
		input: defineLooseObjectSchema({ name: { type: "string" }, forceChromeChannel: { type: "boolean" } }, ["name"]),
		output: passthroughVehicleSchema,
		permissions: ["web-spider:read", "web-spider:write"],
		effect: "local-write",
		idempotency: { mode: "unsafe" },
		limits: LIMITS,
	});
	registry.register(
		OWNER,
		bindVehicleOperation(createOperation, () => async (context) => {
			const input = context.input as Record<string, unknown>;
			return withVehicleErrorParity(() =>
				sessionService.create({ name: requireString(input, "name"), forceChromeChannel: optionalBoolean(input, "forceChromeChannel") }),
			);
		}),
	);

	const listOperation = defineVehicleOperation({
		name: "session.list",
		version: 1,
		description: "Lists every currently open session.",
		input: defineLooseObjectSchema({}, []),
		output: passthroughVehicleSchema,
		permissions: ["web-spider:read"],
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
	});
	registry.register(
		OWNER,
		bindVehicleOperation(listOperation, () => async () => ({ sessions: sessionService.list() })),
	);

	const closeOperation = defineVehicleOperation({
		name: "session.close",
		version: 1,
		description: "Closes a session by name.",
		input: defineLooseObjectSchema({ name: { type: "string" } }, ["name"]),
		output: passthroughVehicleSchema,
		permissions: ["web-spider:read", "web-spider:write"],
		effect: "local-write",
		idempotency: { mode: "unsafe" },
		limits: LIMITS,
	});
	registry.register(
		OWNER,
		bindVehicleOperation(closeOperation, () => async (context) => {
			const input = context.input as Record<string, unknown>;
			return withVehicleErrorParity(() => sessionService.close({ name: requireString(input, "name") }));
		}),
	);

	const actOperation = defineVehicleOperation({
		name: "session.act",
		version: 1,
		description:
			"Acts on an existing session (navigate, click, type, eval, screenshot, tabs, ...), fails closed on a stale snapshotVersion.",
		input: defineLooseObjectSchema(
			{
				name: { type: "string" },
				snapshotVersion: { type: "number" },
				action: { type: "string", enum: [...SESSION_ACTIONS] },
				url: { type: "string" },
				selector: { type: "string" },
				script: { type: "string" },
				timeoutMs: { type: "number" },
				text: { type: "string" },
				clear: { type: "boolean" },
				value: { type: "string" },
				label: { type: "string" },
				loadState: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] },
				state: { type: "string", enum: ["visible", "hidden", "attached", "detached"] },
				fullPage: { type: "boolean" },
				scale: { type: "string", enum: ["css", "device"] },
				depth: { type: "number" },
				boxes: { type: "boolean" },
				mode: { type: "string", enum: ["ai", "default"] },
				accept: { type: "boolean" },
				promptText: { type: "string" },
				key: { type: "string" },
				includeStatic: { type: "boolean" },
				tabOperation: { type: "string", enum: ["list", "new", "close", "select"] },
				tabIndex: { type: "number" },
			},
			["name", "snapshotVersion", "action"],
		),
		output: passthroughVehicleSchema,
		permissions: ["web-spider:read", "web-spider:write"],
		effect: "open-world",
		idempotency: { mode: "unsafe" },
		limits: LIMITS,
	});
	registry.register(
		OWNER,
		bindVehicleOperation(
			actOperation,
			() => async (context) => withVehicleErrorParity(() => sessionService.act(sessionActInput(context.input as Record<string, unknown>))),
		),
	);
}
