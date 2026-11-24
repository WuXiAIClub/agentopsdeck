FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false
RUN pnpm --workspace-concurrency=1 -r build

FROM node:22-bookworm-slim
ENV NODE_ENV=production AOD_LISTEN_HOST=0.0.0.0 AOD_PORT=8890 AOD_DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8890
CMD ["node", "apps/server/dist/index.js"]
