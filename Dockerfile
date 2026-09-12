# Beluchis — single-stage container (Node LTS + Prisma/SQLite)
FROM node:22-alpine

WORKDIR /app

# PORT + DATABASE_URL are runtime defaults; NODE_ENV is set AFTER install
# so that npm ci includes devDependencies (tsx, prisma CLI) needed at boot.
ENV PORT=8080 \
    DATABASE_URL=file:/data/beluchis.db

# Dependencies first (layer caching). package.json `allowScripts` permits
# the prisma/esbuild/tsx postinstall scripts under npm 11.
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY catalog ./catalog
RUN npm ci

ENV NODE_ENV=production

# Application
COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

# Non-root runtime user; /data holds the SQLite db (ephemeral on Code Engine)
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /data \
    && chown -R app:app /app /data

USER app
EXPOSE 8080
ENTRYPOINT ["./docker-entrypoint.sh"]