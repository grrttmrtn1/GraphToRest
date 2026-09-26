# syntax=docker/dockerfile:1
FROM node:22-slim AS build
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

# Production dependencies only, and only for the packages the runtime image runs (not the web app's build chain).
FROM node:22-slim AS prod-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace=@graphtorest/core --workspace=@graphtorest/server --workspace=@graphtorest/cli

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DB_PATH=/data/graphtorest.db
ENV PATH="/app/node_modules/.bin:${PATH}"
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/cli/package.json apps/cli/package.json
COPY --from=build /app/apps/cli/dist apps/cli/dist
COPY --from=build /app/apps/cli/bin apps/cli/bin
# Only the built bundle; the web app has no runtime dependencies of its own.
COPY --from=build /app/apps/web/dist apps/web/dist
# npm links workspace bins during `npm ci`, before apps/cli/bin/gtr.js exists in that stage, so link it explicitly.
RUN ln -sf ../@graphtorest/cli/bin/gtr.js node_modules/.bin/gtr \
  && mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "apps/server/dist/index.js"]
