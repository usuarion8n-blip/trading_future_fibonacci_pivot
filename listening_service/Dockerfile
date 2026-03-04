# ================================
# Stage 1: Dependencias
# ================================
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ================================
# Stage 2: Runtime con crond
# ================================
FROM node:22-alpine AS runner

ENV TZ=UTC
WORKDIR /app

RUN addgroup -S trader && adduser -S trader -G trader

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

# entrypoint para crontab dinámico + logs a docker logs
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]