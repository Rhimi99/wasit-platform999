# WASIT BUSINESS GLOBAL — API server image.
# Multi-stage: dependencies -> build (esbuild bundle) -> runtime.
# The runtime carries production dependencies only (argon2 is native and stays
# external), the bundled server, and the migration assets needed to run
# `drizzle-kit migrate` as a release step.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Workspaces: install the whole tree so the server can resolve @wasit/shared.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --ignore-scripts && npm rebuild argon2

FROM deps AS build
COPY packages/shared packages/shared
COPY packages/server packages/server
WORKDIR /app/packages/server
RUN npm run build:prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Production dependencies only, resolved from the lockfile for reproducibility.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --ignore-scripts && npm rebuild argon2 && npm cache clean --force

# Bundled server + seed scripts (shared source is inlined; argon2 from node_modules).
COPY --from=build /app/packages/server/dist-bundle ./dist-bundle
# Migration assets + config so the release step can run drizzle-kit migrate.
COPY packages/server/drizzle.config.ts packages/server/drizzle.config.ts
COPY packages/server/src/db/migrations packages/server/src/db/migrations
COPY packages/server/src/db/schema packages/server/src/db/schema
# drizzle-kit is a devDependency; the release image needs it to migrate.
RUN npm install --no-save --ignore-scripts drizzle-kit@0.28.1 typescript@5.6.3

# Run unprivileged.
RUN chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/packages/server
CMD ["node", "/app/dist-bundle/index.cjs"]