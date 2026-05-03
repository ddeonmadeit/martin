FROM node:20-slim

WORKDIR /app

# better-sqlite3 is a native addon — needs C++ build tools
RUN apt-get update -y \
 && apt-get install -y python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Build context is the martin repo root, so prefix paths with helix-scraper/
COPY helix-scraper/package.json helix-scraper/package-lock.json ./
RUN npm ci --production

COPY helix-scraper/ ./

RUN mkdir -p output

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]
