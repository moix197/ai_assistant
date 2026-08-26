# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
RUN corepack enable

# --- deps/build: install workspace deps and build every package ---
FROM base AS build
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/hermes/package.json apps/hermes/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/store/package.json packages/store/package.json
COPY packages/channels/package.json packages/channels/package.json
COPY packages/llm/package.json packages/llm/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build

# --- deploy: trim to hermes' own production dependency graph only ---
# Path filter (not --filter hermes) because the root package is also named
# for the repo; --legacy is required on pnpm >=10 so workspace deps are
# copied in rather than left as symlinks (ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE).
FROM build AS deploy
RUN pnpm deploy --filter ./apps/hermes --prod --legacy /out

# --- runtime: minimal image, exec-form CMD so SIGTERM reaches Node ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deploy --chown=node:node /out .
USER node
CMD ["node", "dist/index.js"]
