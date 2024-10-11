# Use a multi-stage build to keep the final image small
FROM node:lts-alpine as builder

# Set environment variables
ENV NODE_ENV=production

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .
RUN npm run build

# Expose the port your app listens on
EXPOSE 8080

# Start the app
CMD ["node", "dist/index.js"]