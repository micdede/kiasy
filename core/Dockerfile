FROM node:24-alpine

# Build-Tools für native Module (better-sqlite3) + ffmpeg für Audio
RUN apk add --no-cache \
      python3 make g++ \
      ffmpeg curl tini \
      git openssh-client

WORKDIR /app

# Dependencies erst — bessere Layer-Caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Quellcode
COPY . .

# /data wird per Volume gemountet (jarvis.db, .env, notes/)
RUN mkdir -p /data

EXPOSE 8080 8081

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
