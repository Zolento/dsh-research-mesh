#!/usr/bin/env bash
# Local acceptance: typecheck, all automated suites, then the real WebUI probe.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -x node_modules/.bin/tsc ]; then node scripts/link-toolchain.mjs; fi
npm run typecheck
npm run test:all
node scripts/ui-acceptance.mjs
