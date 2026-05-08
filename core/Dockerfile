FROM node:24-alpine

# Build-Tools für native Module (better-sqlite3) + ffmpeg für Audio
# + py3-pip für edge-tts CLI (Microsoft Edge Read-Aloud)
RUN apk add --no-cache \
      python3 py3-pip make g++ \
      ffmpeg curl tini \
      git openssh-client \
 && pip3 install --break-system-packages --no-cache-dir edge-tts

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
