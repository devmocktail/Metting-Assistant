# Backend container — runs anywhere (Fly.io, Render, Railway, a VPS).
FROM node:20-alpine
WORKDIR /app

# Install production deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# JSON store (if used) lives here; mount a volume at /data to persist it.
RUN mkdir -p /data
ENV DATA_DIR=/data

CMD ["node", "src/index.js"]
