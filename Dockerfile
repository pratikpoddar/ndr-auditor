# Multi-stage build. The same image runs both the web app and the worker; the process is
# chosen by the start command, so they can scale independently without a second build.
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts && npx prisma generate

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY app ./app
COPY scripts ./scripts
COPY tsconfig.json vite.config.ts ./

# Never run as root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3000
# `migrate deploy` applies committed migrations only — it never generates or resets, so a bad
# deploy cannot silently drop merchant data the way `db push` can.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
