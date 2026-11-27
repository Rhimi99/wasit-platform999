#!/usr/bin/env bash
# Proves the package can run here before anything else is attempted.
#
#   ./check-runtime.sh
#
# Checks Node.js, the CLI bundle, and the argon2 native addon — the one
# dependency the bundle does not carry. Read-only; connects to nothing.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_node
resolve_cli

printf 'node:    %s\n' "$(node -v)"
printf 'cli:     %s\n' "${CLI[*]}"

(
  cd "${HERE}"
  node -e '
const { createRequire } = require("node:module");
const req = createRequire(process.cwd() + "/");
let argon2;
try {
  argon2 = req("argon2");
} catch (err) {
  console.error("argon2:  not loadable:", err.message);
  console.error("");
  console.error("This host cannot run the bundled CLI. Either run the tool from the");
  console.error("deployed server directory (packages/server, where npm install ran), or");
  console.error("install production dependencies here: npm ci --omit=dev");
  process.exit(2);
}
argon2.hash("probe").then(
  () => console.log("argon2:  loaded, hashing works"),
  (err) => {
    console.error("argon2:  failed to hash:", err.message);
    process.exit(2);
  },
);
'
)

note ""
note "runtime check passed; nothing was changed."
