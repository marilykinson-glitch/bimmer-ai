#!/bin/sh
# Launch Bimmer AI Live Simulator on macOS / Linux (automatically locates Node or Antigravity runtime)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

if command -v node >/dev/null 2>&1; then
  exec node "$DIR/scripts/live_sim.js" "$@"
elif [ -x "/opt/homebrew/bin/node" ]; then
  exec /opt/homebrew/bin/node "$DIR/scripts/live_sim.js" "$@"
elif [ -x "/usr/local/bin/node" ]; then
  exec /usr/local/bin/node "$DIR/scripts/live_sim.js" "$@"
elif [ -x "/Applications/Antigravity.app/Contents/MacOS/Antigravity" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "/Applications/Antigravity.app/Contents/MacOS/Antigravity" "$DIR/scripts/live_sim.js" "$@"
else
  echo "Không tìm thấy Node.js runtime." >&2
  exit 1
fi
