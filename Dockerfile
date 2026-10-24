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

# Repair sandbox image (Development Agent self-repair).
#
# Carries the full, pre-installed dependency closure from `deps` — including the
# devDependencies (`vitest`) the generated DB-free repair config needs — so a
# repair test runs against `/app/node_modules` inside this image and NEVER
# against the host repository's tree. It runs read-only, with no network, no
# added capabilities, no privilege escalation and as the unprivileged `node`
# user; only the mounted repair workspace is writable. The server image below is
# unchanged and does not build on this stage.
FROM deps AS repair
ENV NODE_ENV=test
# The repair workspace is mounted under /app (see REPAIR_WORKSPACE_MOUNT), so the
# tests resolve the workspace's `../src/...` imports and the image's
# `/app/node_modules`. That node_modules contains an `@wasit/shared` symlink to
# /app/packages/shared, so the shared sources MUST be present here or the link
# dangles and any repair test reaching server code that imports @wasit/shared
# fails to resolve. (This stage does not build shared to dist: the runtime image
# gets shared inlined by the esbuild bundle.)
COPY packages/shared packages/shared
RUN chown -R node:node /app
USER node
WORKDIR /app/repair-ws
CMD ["node", "/app/node_modules/vitest/vitest.mjs", "--help"]

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Runtime system packages for the marketing-video renderer: ffmpeg (with
# libass + fontconfig) and the DejaVu/CJK fonts the renderer's default style
# references. Without these the structural renderer fails at generate time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
# Production dependencies only, resolved from the lockfile for reproducibility.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --ignore-scripts && npm rebuild argon2 && npm cache clean --force

# Bundled server + seed scripts (shared source is inlined; argon2 from node_modules).
COPY --from=build /app/packages/server/dist-bundle ./dist-bundle
# Arabic shaping font for the video renderer (libass reads it via VIDEO_FONTS_DIR).
COPY packages/server/assets/fonts packages/server/assets/fonts
# Migration assets + config so the release step can run drizzle-kit migrate.
COPY packages/server/drizzle.config.ts packages/server/drizzle.config.ts
COPY packages/server/src/db/migrations packages/server/src/db/migrations
COPY packages/server/src/db/schema packages/server/src/db/schema
# drizzle-kit is a devDependency; the release image needs it to migrate.
RUN npm install --no-save --ignore-scripts drizzle-kit@0.28.1 typescript@5.6.3

# Run unprivileged. The media directory must exist in the image owned by the
# runtime user, because Docker seeds a fresh named volume from this path —
# otherwise the first upload hits EACCES on the root-owned mountpoint.
RUN mkdir -p /app/.wasit-media
RUN chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/packages/server
CMD ["node", "/app/dist-bundle/index.cjs"]