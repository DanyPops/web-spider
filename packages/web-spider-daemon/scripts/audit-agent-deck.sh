#!/usr/bin/env bash
# Thin wrapper — the actual logic is TypeScript (audit-agent-deck.ts), run
# directly by Bun so it can import the daemon's own layout-check.ts/
# contrast-check.ts/PlaywrightSessionRegistry modules without a build step.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec bun scripts/audit-agent-deck.ts "$@"
