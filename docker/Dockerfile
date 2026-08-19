# Build the NestJS bundle in Linux so Prisma generates the Linux query engine
# used by the Docker container. This image is only for the isolated range
# simulator; Electron continues to build and run the Windows backend normally.
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY src ./src
COPY nest-cli.json tsconfig.json esbuild.config.mjs ./

# `build:bundle` deliberately follows a TypeScript build with esbuild: Nest's
# dependency-injection metadata is emitted by tsc, not esbuild.
RUN npx prisma generate && npm run build:bundle && npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# The bundled application still loads Prisma's generated client and native
# query engine from node_modules, so retain the production dependency tree.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/backend.cjs ./dist/backend.cjs
COPY --from=build /app/prisma ./prisma

# Compose mounts a named test-only volume here. It can never point at Electron's
# user-data database unless someone intentionally changes DATABASE_URL.
RUN mkdir /data && chown node:node /data
USER node

EXPOSE 3001/tcp
EXPOSE 14555/udp
EXPOSE 5002/udp

CMD ["node", "dist/backend.cjs"]
