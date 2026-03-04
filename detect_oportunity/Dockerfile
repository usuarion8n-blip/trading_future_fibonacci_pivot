# ================================
# Stage 1: Dependencias
# ================================
FROM node:22-alpine AS deps

WORKDIR /app

# Copiar solo manifests para cachear el layer de npm install
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

# ================================
# Stage 2: Runtime
# ================================
FROM node:22-alpine AS runner

# Zona horaria (opcional, útil para logs con hora local)
ENV TZ=America/Bogota

WORKDIR /app

# Usuario no-root por seguridad
RUN addgroup -S trader && adduser -S trader -G trader

# Copiar dependencias ya instaladas
COPY --from=deps /app/node_modules ./node_modules

# Copiar código fuente
COPY package.json ./
COPY src/ ./src/

USER trader

# El servicio no expone puertos HTTP (solo WebSocket saliente + Supabase REST)
# Si en el futuro se agrega un API REST, descomentar:
# EXPOSE 3000

# Variables de entorno necesarias (se pasan en runtime vía --env-file o -e)
# BINANCE_API_KEY, BINANCE_API_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
# DRY_RUN, ARMED, SYMBOL_WS, SYMBOL_DB, INTERVAL, TOUCH_BUFFER_BPS,
# REBOUND_BPS, CONFIRM_TICKS, COOLDOWN_MS, TP_PCT, SL_PCT, QTY_BTC,
# MAX_OPEN_TRADES, PRINT_EVERY_MS, RECONCILE_EVERY_MS

CMD ["node", "src/index.js"]
