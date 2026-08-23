# Multi-stage build for WhatsApp Bot with Baileys
FROM node:26-alpine AS base

# Install dependencies for Baileys and cloudflared
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    wget \
    curl \
    bash

# Install cloudflared
RUN wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

FROM base AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production && \
    npm cache clean --force

FROM base AS runner

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S whatsapp -u 1001 -G nodejs

# Copy built dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --chown=whatsapp:nodejs . .

# Create auth directory
RUN mkdir -p auth_info && chown -R whatsapp:nodejs auth_info

# Switch to non-root user
USER whatsapp

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Start the bot
CMD ["node", "index.js"]