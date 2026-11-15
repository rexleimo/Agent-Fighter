#!/bin/sh
# Volume-proof startup: named volumes inherit image ownership on standard
# Docker, but bind mounts (and some backends, e.g. Apple Containerization)
# mount root-owned. Start as root, fix /app/data ownership, drop to bun.
# Uses busybox su (always present on alpine) — no extra packages needed.
set -e
if [ "$(id -u)" = '0' ]; then
  chown -R bun:bun /app/data
  exec su -p bun -s /bin/sh -c 'exec "$0" "$@"' "$@"
fi
exec "$@"
