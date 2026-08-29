#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "node not installed." >&2; exit 1; }

exec node server.js
