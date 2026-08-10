/**
 * Single source of truth for the "there's more, press a key to see it" affordance
 * every collapsed card in this extension needs -- extracted after web_quotes' own
 * card shipped without it (a real gap a user hit live) while web_session's own card
 * already had the right idea, duplicated inline. Two other Pi extensions (this
 * project's own web_fetch/web_session cards, and papyrus's ArtifactCard.expandHint())
 * independently arrived at the identical keyHint("app.tools.expand", ...) call --
 * this module is that convergence made explicit and shared, so a future card gets it
 * by construction instead of by remembering to copy it.
 */
import { keyHint } from "@earendil-works/pi-coding-agent";

/** Real, possibly user-remapped hotkey (defaults to ctrl+o, Pi's own "app.tools.expand" binding) -- never a hardcoded string. */
export function expandHint(): string {
	return keyHint("app.tools.expand", "expand for details");
}

/**
 * True exactly when collapsing genuinely hides something an expand would reveal.
 * Centralizing this (rather than each card re-deriving its own "is there more?"
 * condition ad hoc) is what keeps the hint from either going missing on a card that
 * really does hide content, or appearing decoratively on one that doesn't.
 */
export function shouldShowExpandHint(expanded: boolean, hasHiddenContent: boolean): boolean {
	return !expanded && hasHiddenContent;
}
