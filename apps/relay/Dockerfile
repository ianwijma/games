# Build context: repository root.  docker build -f apps/relay/Dockerfile .
FROM node:22.23.5-alpine3.24 AS build
WORKDIR /repo
# npm needs every workspace manifest to match the lockfile, so copy the repo (see .dockerignore)
# and install only what the relay needs.
COPY . .
RUN npm ci --workspace @games/relay --include-workspace-root
RUN npm run build --workspace @games/relay

FROM node:22.23.5-alpine3.24
ENV NODE_ENV=production PORT=6767
WORKDIR /app
COPY --from=build /repo/apps/relay/dist/main.js ./main.js
# The `node` user, numeric so Kubernetes runAsNonRoot can verify it. The relay writes no files, so
# the root filesystem can be read-only.
USER 1000:1000
EXPOSE 6767
# Ignored by Kubernetes (use probes on /healthz there); useful under plain Docker.
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1
CMD ["node", "main.js"]
