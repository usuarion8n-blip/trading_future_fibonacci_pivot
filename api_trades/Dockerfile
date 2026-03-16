# ================================
# Stage 1: Dependencias
# ================================
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ================================
# Stage 2: Build
# ================================
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ================================
# Stage 3: Runtime
# ================================
FROM node:22-alpine AS runner

ENV NODE_ENV=production
ENV TZ=UTC

WORKDIR /app

RUN addgroup -S trader && adduser -S trader -G trader

# Copiar package.json para comandos de inicio 
COPY package.json ./

# Copiar dependencias (solo producción si prefieres, npm ci --omit=dev, o de la builder)
# En este caso deps instaló todo, podrías optimizar copiando solo las necesarias
# O instalar de nuevo con --omit=dev aquí. Para simplicidad reusamos deps
# pero sin devDependencies:
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copiar el javascript compilado
COPY --from=builder /app/dist ./dist

# Configurar permisos
RUN chown -R trader:trader /app
USER trader

# Exponer el puerto
EXPOSE 3000

CMD ["node", "dist/server.js"]
