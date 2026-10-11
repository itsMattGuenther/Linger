#!/bin/sh
# The image's entry point (#440): the server always runs as its own user,
# `linger`, and never as root.
#
# Docker makes a missing ./data folder for root, where the server can't write
# its database, and that used to need a `chown` command before the first
# start. Started as root (the image's default), this gives the data folder and
# what's directly in it to `linger`, then runs the server as `linger`. Every
# way in comes through here, `docker compose run --rm linger reset-password`
# too, so nothing in the folder is ever written as root. Started as anybody
# else (a compose `user:` line), it runs the server as that user and leaves
# the folder alone.
#
# The folder is the server's alone (#506). It holds every DM, password hash
# and file, and on a machine with more than one account the others must not
# be able to read it. Started as root, the folder is made 0700, which also
# shuts away what an older server made 0644. Either way the server runs with
# umask 077, so what it makes from now on is 0600, and its folders 0700.
# Nothing else needs in: Caddy only talks to the server, and update.sh reads
# the database as root.
set -eu

data="${LINGER_DATA_DIR:-/data}"
umask 077

if [ "$(id -u)" = 0 ]; then
  if [ -d "$data" ]; then
    find "$data" -maxdepth 1 ! -user linger -exec chown linger:linger {} +
    chmod 700 "$data"
  fi
  exec setpriv --reuid=linger --regid=linger --init-groups -- linger-server "$@"
fi
exec linger-server "$@"
