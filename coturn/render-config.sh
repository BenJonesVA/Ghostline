#!/bin/sh
set -eu

: "${TURN_SECRET:?TURN_SECRET must be set in .env}"
TURN_REALM="${TURN_REALM:-turn.local}"

# A weak secret undermines the entire HMAC credential scheme — fail fast
# rather than rendering a config with it (mirrors .env.example's guidance:
# openssl rand -hex 32). Only the length is checked, never the value itself.
if [ "${#TURN_SECRET}" -lt 32 ]; then
  echo "TURN_SECRET must be at least 32 characters (use: openssl rand -hex 32)" >&2
  exit 1
fi

# /etc/coturn isn't writable by the image's runtime user (nobody) — render
# to /tmp instead, entirely inside the container, so no secret ever touches
# a host-mounted path.
CONF=/tmp/turnserver.conf
sed -e "s|__TURN_SECRET__|$TURN_SECRET|g" \
    -e "s|__TURN_REALM__|$TURN_REALM|g" \
    /etc/coturn/turnserver.conf.template > "$CONF"
chmod 600 "$CONF"

exec turnserver -c "$CONF" --log-file=stdout
