# ---- Stage 1: Build wokwi-libs and frontend ----
FROM node:20-slim AS builder

WORKDIR /app

# Copy root package.json (needed for metadata generation via tsx)
COPY package.json .
RUN npm install

# Copy metadata generation script
COPY scripts/ scripts/

# Copy and build avr8js
COPY wokwi-libs/avr8js/ wokwi-libs/avr8js/
WORKDIR /app/wokwi-libs/avr8js
RUN npm install && npm run build

# Copy and build wokwi-elements
COPY wokwi-libs/wokwi-elements/ wokwi-libs/wokwi-elements/
WORKDIR /app/wokwi-libs/wokwi-elements
RUN npm install && npm run build

# Copy frontend source and install dependencies
WORKDIR /app
COPY frontend/ frontend/
WORKDIR /app/frontend
RUN npm install

# Generate component metadata and build frontend for production
RUN npm run build

# ---- Stage 2: Serve with nginx ----
FROM nginx:alpine

# Copy custom nginx config
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built frontend assets
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
