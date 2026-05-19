FROM node:20-slim

# Install dependencies for Baileys
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.cjs ./

EXPOSE 3001

CMD ["node", "server.cjs"]
