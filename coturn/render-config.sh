#!/bin/sh
set -eu

: "${TURN_SECRET:?TURN_SECRET must be set in .env}"
TURN_REALM="${TURN_REALM:-turn.local}"

# /etc/coturn isn't writable by the image's runtime user (nobody) — render
# to /tmp instead, entirely inside the container, so no secret ever touches
# a host-mounted path.
CONF=/tmp/turnserver.conf
sed -e "s|__TURN_SECRET__|$TURN_SECRET|g" \
    -e "s|__TURN_REALM__|$TURN_REALM|g" \
    /etc/coturn/turnserver.conf.template > "$CONF"

exec turnserver -c "$CONF" --log-file=stdout
