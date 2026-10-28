# Build on a workstation/CI with Linux containers; never compile on the 2 GiB server.
# BuildKit's bundled Dockerfile frontend supports RUN --mount. Avoid a separate
# docker/dockerfile pull when Docker Hub is unreachable in the build environment.
ARG BASE_REGISTRY=docker.io
FROM ${BASE_REGISTRY}/library/rust:1.90-bookworm AS rust-base
FROM ${BASE_REGISTRY}/library/node:20-bookworm-slim AS frontend
WORKDIR /src/frontend
RUN corepack enable && corepack prepare pnpm@8.15.9 --activate
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN --mount=type=cache,id=zhihui-web-pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY frontend/ ./
ARG WEB_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_WEB_BUILD=${WEB_BUILD}
RUN pnpm build

FROM rust-base AS backend
WORKDIR /src/server
ENV CARGO_BUILD_JOBS=2
COPY server/ ./
RUN --mount=type=cache,id=zhihui-web-cargo,target=/usr/local/cargo/registry \
    --mount=type=cache,id=zhihui-web-target,target=/src/server/target \
    cargo build --release --locked && cp target/release/zhihui-web /usr/local/bin/zhihui-web

FROM ${BASE_REGISTRY}/library/debian:bookworm-slim AS runtime
# The slim base has no CA bundle yet. Bootstrap trust from the same official
# Debian-based Rust image, then let Debian's signed package update maintain it.
COPY --from=rust-base /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN --mount=type=cache,id=zhihui-web-apt-archives,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=zhihui-web-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install --no-install-recommends -y ca-certificates curl ffmpeg sqlite3 \
    && groupadd --gid 10001 zhihui && useradd --uid 10001 --gid 10001 --no-create-home zhihui \
    && mkdir -p /app/static /var/lib/zhihui-web && chown 10001:10001 /var/lib/zhihui-web
ARG PRODUCT_VERSION=0.6.6
ARG WEB_BUILD=1
ARG SOURCE_SHA=unknown
LABEL org.opencontainers.image.title="ZhiHui Web" \
      org.opencontainers.image.version="${PRODUCT_VERSION}-web.${WEB_BUILD}" \
      org.opencontainers.image.revision="${SOURCE_SHA}"
ENV ZHIHUI_BIND=0.0.0.0:8810 ZHIHUI_DATA_DIR=/var/lib/zhihui-web \
    ZHIHUI_STATIC_DIR=/app/static ZHIHUI_MASTER_KEY_FILE=/run/secrets/master_key \
    ZHIHUI_BUILD=${WEB_BUILD} RUST_LOG=info
COPY --from=backend /usr/local/bin/zhihui-web /usr/local/bin/zhihui-web
COPY --from=frontend /src/frontend/out/ /app/static/
USER 10001:10001
WORKDIR /app
EXPOSE 8810
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl --fail --silent --max-time 3 http://127.0.0.1:8810/api/v1/health > /dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/zhihui-web"]
