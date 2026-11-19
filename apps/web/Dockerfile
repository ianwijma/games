# Build context: repository root.
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_RELAY_URL=wss://games-relay.wijma.cloud/ws .
FROM node:22.23.5-alpine3.24 AS build
WORKDIR /repo
# npm needs every workspace manifest to match the lockfile, so copy the repo (see .dockerignore)
# and install only what the site needs.
COPY . .
RUN npm ci --workspace @games/web --include-workspace-root
# Baked into the build: changing the relay address means rebuilding the image. Empty means the
# site offers only "Play on this device".
ARG NEXT_PUBLIC_RELAY_URL=""
ENV NEXT_PUBLIC_RELAY_URL=${NEXT_PUBLIC_RELAY_URL} NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace @games/web

FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24
COPY apps/web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/web/out /usr/share/nginx/html
# Numeric, so Kubernetes runAsNonRoot can verify it.
USER 101:101
EXPOSE 8080
# Skip the base image's entrypoint scripts: they rewrite files under /etc/nginx, which fails on a
# read-only root filesystem, and this config needs none of them.
ENTRYPOINT ["nginx", "-g", "daemon off;"]
