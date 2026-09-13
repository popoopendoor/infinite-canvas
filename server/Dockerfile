FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /var/lib/canvas-bff && chown node:node /var/lib/canvas-bff
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
