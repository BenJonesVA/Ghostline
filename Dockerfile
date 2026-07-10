# syntax=docker/dockerfile:1

# ---- deps stage: install production dependencies only ----------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ---- runtime stage -----------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public

USER node
EXPOSE 3000

CMD ["node", "server.js"]
