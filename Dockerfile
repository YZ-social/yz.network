# YZ Network - Active DHT Node
# Multi-stage build for optimized production image

FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --production

# Copy source code
COPY src/ ./src/

# Production image
FROM node:18-alpine

WORKDIR /app

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY package*.json ./

# Create non-root user for security
RUN addgroup -g 1001 dhtnode && \
    adduser -D -u 1001 -G dhtnode dhtnode && \
    chown -R dhtnode:dhtnode /app

# Switch to non-root user
USER dhtnode

# Expose metrics port (configurable via environment)
EXPOSE 9090

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:9090/health || exit 1

# Start the DHT node
CMD ["node", "src/docker/start-dht-node.js"]
