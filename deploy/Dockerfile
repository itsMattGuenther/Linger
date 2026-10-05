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
COPY deploy/entrypoint.sh /usr/local/bin/linger-entrypoint

ENV LINGER_DATA_DIR=/data
VOLUME /data
EXPOSE 8420
ENTRYPOINT ["linger-entrypoint"]
