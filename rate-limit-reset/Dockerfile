# Build stage
FROM node:lts-alpine AS builder

WORKDIR /app

# Install dependencies (including devDependencies for build)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Verify build output exists
RUN ls -la dist/ && test -f dist/index.js

# Production stage
FROM node:lts-alpine

WORKDIR /app

# Only install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Expose the port
EXPOSE 8080

# Start the app
CMD ["node", "dist/index.js"]