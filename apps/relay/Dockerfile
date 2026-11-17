# Build context: repository root.  docker build -f apps/relay/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
# Manifests first so the install layer is cached until dependencies change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/relay/package.json apps/relay/
COPY packages/protocol/package.json packages/protocol/
COPY packages/relay-core/package.json packages/relay-core/
# Other workspace members are not copied; install only what the relay needs.
RUN pnpm install --frozen-lockfile --filter @games/relay...
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/relay-core packages/relay-core
COPY apps/relay apps/relay
RUN pnpm --filter @games/relay build

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY --from=build /repo/apps/relay/dist/main.js ./main.js
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1
CMD ["node", "main.js"]
