# YZ Network DHT Node - Production Docker Image
# Build: docker build -t yznetwork/dht-node:latest -f src/docker/Dockerfile .
# Run: docker run -p 8100:8100 -p 9090:9090 -e PUBLIC_ADDRESS=ws://YOUR_IP:8100 yznetwork/dht-node:latest

FROM node:20-alpine

LABEL maintainer="YZ Network Team"
LABEL description="YZ Network DHT Node - Help strengthen the decentralized network"
LABEL version="1.0.0"

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy source code
COPY src/ ./src/

# Remove build dependencies to reduce image size
RUN apk del python3 make g++

# Create non-root user for security
RUN addgroup -g 1001 -S yznetwork && \
    adduser -u 1001 -S yznetwork -G yznetwork

# Set ownership
RUN chown -R yznetwork:yznetwork /app

USER yznetwork

# Default environment variables
ENV NODE_ENV=production
ENV BOOTSTRAP_URL=ws://bootstrap.yz.network:8080
ENV METRICS_PORT=9090
ENV NODE_NAME=dht-node
ENV OPEN_NETWORK=true
ENV WEBSOCKET_PORT=8100
ENV WEBSOCKET_HOST=0.0.0.0

# Expose ports
EXPOSE 8100 9090

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget -q --spider http://localhost:${METRICS_PORT}/health || exit 1

# Start the DHT node
CMD ["node", "src/docker/start-dht-node.js"]
