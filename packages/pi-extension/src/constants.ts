export const MODEL_CONTENT_MAX_CHARACTERS = 50_000
export const DETAILS_VERSION = 1 as const
export const DETAILS_MAX_SERIALIZED_CHARACTERS = 24_000
export const DETAILS_MAX_ITEMS = 20
export const DETAILS_MAX_FIELD_CHARACTERS = 500
export const COLLAPSED_ITEM_PREVIEW = 3
export const EXPANDED_PRIMARY_MAX_LINES = 240
/** Separate, smaller bound than the daemon's own content bounds (e.g. session snapshot's 20,000 chars) — this is for the presentation DTO's stored preview, not the model-facing content. */
export const DETAILS_MAX_BODY_CHARACTERS = 8_000
