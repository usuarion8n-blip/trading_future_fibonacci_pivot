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

# Usuario no-root
RUN addgroup -S trader && adduser -S trader -G trader

# App
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

# Log file
RUN mkdir -p /var/log \
    && touch /var/log/listening_service.log \
    && chown trader:trader /var/log/listening_service.log

# Cron del usuario trader (BusyBox lee /etc/crontabs/<user>)
# IMPORTANTE: BusyBox requiere newline al final
RUN printf '5 0 * * * cd /app && node src/index.js >> /var/log/listening_service.log 2>&1\n' \
    > /etc/crontabs/trader

# BusyBox crond: sin -u
# -f foreground, -l loglevel, -L log file (opcional)
CMD ["crond", "-f", "-l", "8"]