/**
 * session.* projected as real VehicleOperations -- the sixth and final
 * slice of web-spider's own Vehicle protocol migration (task 4057390d).
 *
 * session.create/close mutate the daemon's own local session registry
 * (a real live browser process) -- effect: "local-write", idempotency
 * "unsafe" (create fails on a duplicate name; close fails on an
 * already-closed one -- neither is safe to blindly retry).
 *
 * Session actions use risk-homogeneous operations: session.inspect is a
 * read, session.interact covers structured consequential browser actions,
 * and session.eval covers arbitrary script execution. The latter two require
 * exact-input approval before their handlers can dispatch. snapshotVersion
 * remains the session service's fail-closed concurrency guard.
 *
 * session.list is a pure read of the same registry.
 */
import {
	bindVehicleOperation,
	defineLooseObjectSchema,
	defineVehicleOperation,
	passthroughVehicleSchema,
	VehicleError,
} from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { optionalBoolean, requireString, sessionActInput } from "../service.ts";
import { SESSION_ACTIONS } from "../session/session-audit.ts";
import type { SessionService } from "../session/session-service.ts";
import { withVehicleErrorParity } from "./error-parity.ts";

const OWNER = "web-spider";
const LIMITS = { defaultTimeoutMs: 15_000, maxTimeoutMs: 60_000, maxRequestBytes: 65_536, maxResponseBytes: 1_048_576 };

export function registerSessionVehicleOperations(registry: VehicleRegistry, sessionService: SessionService): void {
	const createOperation = defineVehicleOperation({
		name: "session.create",
		version: 1,
		description: "Launches a new persistent browser session under the given name.",
		input: defineLooseObjectSchema({ name: { type: "string" }, forceChromeChannel: { type: "boolean" }, headed: { type: "boolean" } }, [
			"name",
		]),
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
				sessionService.create({
					name: requireString(input, "name"),
					forceChromeChannel: optionalBoolean(input, "forceChromeChannel"),
					headed: optionalBoolean(input, "headed"),
				}),
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

	const inspectionActions = [
		"waitFor",
		"queryText",
		"readTable",
		"snapshot",
		"downloads",
		"consoleMessages",
		"networkRequests",
		"tabs",
		"screenshot",
	] as const;
	const interactionActions = ["navigate", "click", "hover", "pressKey", "type", "select", "handleDialog", "tabs"] as const;
	const properties = {
		name: { type: "string" },
		snapshotVersion: { type: "number" },
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
	} as const;

	const specs = [
		{
			name: "session.inspect",
			description: "Reads or waits for bounded state from an existing browser session.",
			actions: inspectionActions,
			effect: "read" as const,
			requiresApproval: false,
			accepts: (input: ReturnType<typeof sessionActInput>) =>
				input.action !== "tabs" || input.tabOperation === undefined || input.tabOperation === "list",
		},
		{
			name: "session.interact",
			description: "Performs a consequential structured interaction in an existing browser session.",
			actions: interactionActions,
			effect: "open-world" as const,
			requiresApproval: true,
			accepts: (input: ReturnType<typeof sessionActInput>) => input.action !== "tabs" || input.tabOperation !== "list",
		},
		{
			name: "session.eval",
			description: "Runs arbitrary JavaScript in an existing browser session.",
			actions: ["eval"] as const,
			effect: "open-world" as const,
			requiresApproval: true,
			accepts: () => true,
		},
	];

	for (const spec of specs) {
		const operation = defineVehicleOperation({
			name: spec.name,
			version: 1,
			description: `${spec.description} Fails closed on a stale snapshotVersion.`,
			input: defineLooseObjectSchema({ ...properties, action: { type: "string", enum: [...spec.actions] } }, [
				"name",
				"snapshotVersion",
				"action",
			]),
			output: passthroughVehicleSchema,
			permissions: ["web-spider:read", "web-spider:write"],
			effect: spec.effect,
			requiresApproval: spec.requiresApproval,
			idempotency: { mode: spec.effect === "read" ? "safe" : "unsafe" },
			limits: LIMITS,
		});
		registry.register(
			OWNER,
			bindVehicleOperation(operation, () => async (context) => {
				const input = sessionActInput(context.input as Record<string, unknown>);
				if (!SESSION_ACTIONS.has(input.action) || !spec.accepts(input)) {
					throw new VehicleError("risk-class-mismatch", `${input.action} is not valid for ${spec.name}`, {
						category: "validation",
					});
				}
				return withVehicleErrorParity(() => sessionService.act(input));
			}),
		);
	}
}
