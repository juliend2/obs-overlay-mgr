#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "node not installed: sudo apt install nodejs" >&2; exit 1; }

exec node server.js
