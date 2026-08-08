// Pi's own keyHint() (used by any renderer showing a real hotkey hint, e.g.
// SessionResultCard's expand-hint lines) reads Pi's global theme singleton and
// throws if it was never initialized -- true regardless of which fake Theme a
// given test constructs for its own component under test. Runs once per
// isolated test file via vitest's own setupFiles, so no test file needs to
// remember this itself.
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme();
