FROM node:20-slim

WORKDIR /app

# Сначала только манифесты — слой кэшируется, пока зависимости не меняются.
COPY package*.json ./
RUN npm ci --omit=dev

# Затем исходники.
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
