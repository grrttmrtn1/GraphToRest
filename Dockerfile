# syntax=docker/dockerfile:1
FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY packages/core packages/core
COPY apps/server apps/server
COPY apps/cli apps/cli
COPY apps/web apps/web
RUN npm run build --workspaces --if-present
# npm's workspace bin-symlinking runs during `npm ci`, before apps/cli/bin/gtr.js
# exists on disk (only package.json is copied at that point for layer caching).
# It silently skips creating node_modules/.bin/gtr as a result, so relink it
# explicitly now that the CLI source is present, matching npm's own convention.
RUN ln -sf ../@graphtorest/cli/bin/gtr.js node_modules/.bin/gtr

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DB_PATH=/data/graphtorest.db
ENV PATH="/app/node_modules/.bin:${PATH}"
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/core packages/core
COPY --from=build /app/apps/server apps/server
COPY --from=build /app/apps/cli apps/cli
# Only the built bundle; the web app has no runtime dependencies of its own.
COPY --from=build /app/apps/web/dist apps/web/dist
EXPOSE 3000
ENTRYPOINT ["node", "apps/server/dist/index.js"]
