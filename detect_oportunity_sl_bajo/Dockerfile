FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# si usas proto u otros assets, agrega COPY aquí

CMD ["node", "src/index.js"]