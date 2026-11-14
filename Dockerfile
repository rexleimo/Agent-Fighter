# syntax=docker/dockerfile:1
# ---- build: install deps (pnpm) + compile the React frontend ---------------
# pnpm remains the package manager / lockfile source; Bun is the service runtime.
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:web

# ---- runtime: Bun ----------------------------------------------------------
FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Deps were installed by pnpm (pure-JS, no native modules); Bun runs them as-is.
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY web ./web
COPY --from=build /app/web/dist ./web/dist
COPY skills ./skills
COPY docs ./docs
COPY examples ./examples
COPY sdk ./sdk
COPY drizzle ./drizzle
COPY drizzle.config.js ./
# oven/bun ships an unprivileged `bun` user; /app/data is the persistence mount.
RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/server.js"]