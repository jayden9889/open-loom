# openloom-server: self-hosted share server for Open Loom.
# Build:  docker build -t openloom-server .
# Run:    docker run -d -p 3000:3000 -e API_KEY=change-me -v openloom-data:/data openloom-server

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY bin ./bin
COPY src ./src
RUN npm install --no-audit --no-fund \
  && npm install --no-save --no-audit --no-fund typescript@'~5.9.0' \
  && npx tsc -p tsconfig.json \
  && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY bin ./bin
RUN mkdir -p /data && chown node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "bin/openloom-server.js"]
