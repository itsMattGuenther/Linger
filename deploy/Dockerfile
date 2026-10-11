# Build a static-ish linger-server binary, then ship it on a slim base.
# Build context is the repository root:  docker build -f deploy/Dockerfile .

FROM rust:1.93-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY .cargo ./.cargo
COPY crates ./crates
RUN cargo build --release -p linger-server

FROM debian:bookworm-slim
# ffmpeg is optional (ARCHITECTURE §8): without it a server stores video fine
# and simply has no poster frame or duration. It is installed here because the
# published image should do the whole job.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --home /data linger
COPY --from=build /src/target/release/linger-server /usr/local/bin/linger-server
# Starts as root only to give the data folder to `linger`, then runs the
# server as `linger` (#440): no `chown` before the first start.
# chmod here rather than trusting the checkout: a repository with
# core.fileMode off commits it without its x bit, and the image then can't
# start at all.
COPY deploy/entrypoint.sh /usr/local/bin/linger-entrypoint
RUN chmod 755 /usr/local/bin/linger-entrypoint

ENV LINGER_DATA_DIR=/data
# Memory a password hash used goes back to the system (#523). Each argon2
# hash borrows about 19 MB at once. glibc gives the first such block back,
# then raises its own bar for "big" to match and keeps every later one in its
# pools for reuse, spread over the threads hashing runs on, so the server's
# memory only ever grows. Measured on this image, 220 sign-ups left it holding
# 225 MB one at a time and 815 MB four at a time. Fixing the bar at 1 MB makes
# every block over it a mapping of its own, returned the moment it is freed:
# 16 MB and 17 MB after the same sign-ups. (MALLOC_ARENA_MAX=2, the usual
# advice, held 168 MB and 946 MB.) Only glibc reads this; Debian's base is glibc.
ENV MALLOC_MMAP_THRESHOLD_=1048576
VOLUME /data
EXPOSE 8420
ENTRYPOINT ["linger-entrypoint"]
