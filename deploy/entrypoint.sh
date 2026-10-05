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
set -eu

data="${LINGER_DATA_DIR:-/data}"

if [ "$(id -u)" = 0 ]; then
  if [ -d "$data" ]; then
    find "$data" -maxdepth 1 ! -user linger -exec chown linger:linger {} +
  fi
  exec setpriv --reuid=linger --regid=linger --init-groups -- linger-server "$@"
fi
exec linger-server "$@"
