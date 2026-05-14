/**
 * Markdown conversion and chunk splitting.
 *
 * Owns the Turndown dependency. spider.ts calls toMarkdown() and chunk();
 * it never imports Turndown directly.
 */

import TurndownService from "turndown";
import type { Chunk, ChunkType } from "./types.js";

// ---------------------------------------------------------------------------
// Turndown setup
// ---------------------------------------------------------------------------

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

// Disable escape — Turndown escapes markdown-special chars by default,
// producing backslash noise that is unnatural for agent consumption.
(turndown as unknown as { escape: (s: string) => string }).escape = (s) => s;

// Strip images — agents cannot see them and alt-text is noise.
turndown.addRule("strip-images", {
	filter: "img",
	replacement: () => "",
});

// ---------------------------------------------------------------------------
// Markdown conversion
// ---------------------------------------------------------------------------

/** Convert Readability article HTML to clean markdown. */
export function toMarkdown(html: string): string {
	return turndown.turndown(html);
}

// ---------------------------------------------------------------------------
// Content type detection
// ---------------------------------------------------------------------------

const CHUNK_TARGET_WORDS = 150;

/** Detect the dominant content type from a markdown buffer. */
export function detectContentType(lines: string[]): ChunkType {
	for (const line of lines) {
		const t = line.trim();
		if (!t) continue;
		if (t.startsWith("```")) return "code";
		if (t.startsWith("|")) return "table";
		if (/^[-*+] /.test(t) || /^\d+\. /.test(t)) return "list";
		if (t.startsWith(">")) return "blockquote";
		return "text";
	}
	return "text";
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Split markdown into RAG-ready chunks at heading boundaries.
 * Tables and fenced code blocks are never split mid-block.
 */
export function chunk(markdown: string, baseUrl: string): Chunk[] {
	const chunks: Chunk[] = [];
	const lines = markdown.split("\n");

	let heading = "";
	let buffer: string[] = [];
	let index = 0;
	let inTable = false;
	let inCode = false;

	const flush = (): void => {
		const text = buffer.join("\n").trim();
		if (!text) return;
		const wordCount = text.split(/\s+/).filter(Boolean).length;
		if (wordCount < 10) return;
		const contentType = detectContentType(buffer);
		chunks.push({ id: `${baseUrl}#chunk-${index}`, index, heading, text, wordCount, contentType });
		index++;
		buffer = [];
		inTable = false;
	};

	for (const line of lines) {
		if (line.trim().startsWith("```")) inCode = !inCode;

		const isTableRow = line.trim().startsWith("|");

		if (inCode) {
			buffer.push(line);
		} else {
			if (isTableRow) inTable = true;
			else if (inTable && !isTableRow) inTable = false;

			const headingMatch = /^#{1,3} (.+)/.exec(line);
			if (headingMatch && !inTable) {
				const currentWords = buffer.join(" ").split(/\s+/).filter(Boolean).length;
				if (currentWords >= CHUNK_TARGET_WORDS) flush();
				heading = headingMatch[1];
				buffer.push(line);
			} else {
				buffer.push(line);
				const currentWords = buffer.join(" ").split(/\s+/).filter(Boolean).length;
				if (currentWords >= CHUNK_TARGET_WORDS && !inTable) flush();
			}
		}
	}
	flush();
	return chunks;
}
