# Agent Control coding runner
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home runner \
 && mkdir -p /work /data /config /tmp/jobhome && chown -R runner:runner /work /data /config /tmp/jobhome
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config /config
USER runner
ENV NODE_ENV=production PORT=8787 WORK_ROOT=/work DATA_ROOT=/data REPOS_CONFIG=/config/repos.json
EXPOSE 8787
CMD ["node", "dist/server.js"]
