/**
 * Real Papyrus adapter — the only module in this daemon that imports
 * @danypops/papyrus. Uses Papyrus's own published, authenticated client
 * (deep-imported: that package has no "exports"/"main" field, matching how
 * its own extension imports it) exactly like any other Papyrus consumer —
 * same token/port discovery, same trust boundary. This daemon never opens
 * Papyrus's SQLite file directly, and Papyrus never opens this daemon's.
 *
 * Safe to import directly (not duplicated, unlike pi-extension's
 * daemon-client.ts): both this daemon and Papyrus are raw-TypeScript
 * packages run only via a real `bun` process, so Bun's native TS transform
 * applies uniformly — none of the Node/jiti loader concerns that apply to
 * the Pi extension apply here.
 */
import { connectPapyrusClient } from "@danypops/papyrus/src/client.ts";
import type { PapyrusDocInput, PapyrusIngestPort } from "../ports/papyrus-ingest.ts";

export class PapyrusHttpAdapter implements PapyrusIngestPort {
	// Uses Papyrus's "docs.*" domain-facade operations (not the lower-level
	// "artifact.*"/"graph.*" escape hatches) — the same preference Papyrus's
	// own documentation asks of every consumer, human or programmatic.
	async createDoc(input: PapyrusDocInput): Promise<{ id: string }> {
		const client = await connectPapyrusClient();
		const result = await client.call<Record<string, unknown>, { id: string }>("docs.create", {
			title: input.title,
			subtype: input.subtype,
			body: input.body,
			labels: input.labels,
			extra: input.extra,
		});
		return { id: result.id };
	}

	async linkDoc(fromId: string, relation: string, toId: string): Promise<void> {
		const client = await connectPapyrusClient();
		await client.call("docs.link", { id: fromId, relation, target_id: toId });
	}
}
