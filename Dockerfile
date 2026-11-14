# syntax=docker/dockerfile:1
# ---- build: compile the React frontend -------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:web

# ---- runtime: server + static assets + migration tooling -------------------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# Full install (includes drizzle-kit) so `pnpm db:migrate` can run at deploy time.
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY web ./web
COPY --from=build /app/web/dist ./web/dist
COPY skills ./skills
COPY docs ./docs
COPY examples ./examples
COPY sdk ./sdk
COPY drizzle ./drizzle
COPY drizzle.config.js ./
# Run unprivileged; /app/data is the persistence mount (league.json + replays).
RUN addgroup -S afl && adduser -S afl -G afl \
  && mkdir -p /app/data && chown -R afl:afl /app
USER afl
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]