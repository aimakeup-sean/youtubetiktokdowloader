FROM node:20-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install yt-dlp --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
