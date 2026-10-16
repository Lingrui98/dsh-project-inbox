#!/usr/bin/env bash
# Use dependencies supplied by a DSH install or checkout. No fixed host paths.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node "$ROOT/scripts/link-host.mjs"
"$ROOT/node_modules/.bin/tsc" -p "$ROOT/tsconfig.json"
