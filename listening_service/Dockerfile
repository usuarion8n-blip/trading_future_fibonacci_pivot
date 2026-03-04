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

# Copiar app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

# El .env se monta en runtime: --env-file .env  o  -e VAR=value
# NO se copia el .env en la imagen

# ──────────────────────────────────────────────────────────────────
# Crontab: ejecuta el script a las 00:05 UTC todos los días.
# Cambia la expresión si quieres otra frecuencia:
#   "*/15 * * * *"  → cada 15 minutos
#   "0 * * * *"     → cada hora
#   "5 0 * * *"     → cada día a las 00:05 UTC  ← recomendado para pivots diarios
# ──────────────────────────────────────────────────────────────────
RUN printf '5 0 * * * cd /app && node src/index.js >> /var/log/listening_service.log 2>&1\n' \
    > /etc/crontabs/trader

# Asegurar permisos del log
RUN touch /var/log/listening_service.log \
    && chown trader:trader /var/log/listening_service.log

# crond de BusyBox:
#   -f  → foreground (para Docker)
#   -l 2 → loglevel (sólo errores a stderr)
#   -u trader → ejecuta los jobs como el usuario trader
CMD ["crond", "-f", "-l", "2", "-u", "trader"]
