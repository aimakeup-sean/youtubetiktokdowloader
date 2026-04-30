FROM node:20-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    curl \
    ca-certificates \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp standalone binary (nightly channel for newest YouTube fixes)
RUN curl -L "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp" \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    /usr/local/bin/yt-dlp --version

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

# Try self-update on start so containers stay current without a rebuild
CMD ["sh", "-c", "/usr/local/bin/yt-dlp -U --update-to nightly 2>/dev/null || true; node server.js"]
