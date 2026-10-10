FROM node:22-slim

# ffmpeg: converts Gemini voice (WAV) to Telegram voice notes (OGG/Opus)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src

# All runtime state (myra.db, gate.json, history.json, ...) is written to the current directory,
# so run from /data, which is the persistent Fly volume.
RUN mkdir -p /data
WORKDIR /data
ENV NODE_ENV=production

CMD ["node", "/app/node_modules/tsx/dist/cli.mjs", "/app/src/index.ts"]
