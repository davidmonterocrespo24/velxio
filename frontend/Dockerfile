# ---- Stage 1: Build frontend ----
# avr8js / rp2040js / @wokwi/elements are resolved from npm by frontend's
# package.json — no upstream clones needed.
FROM node:20-slim AS builder

WORKDIR /app

COPY scripts/ scripts/
COPY frontend/ frontend/

WORKDIR /app/frontend
RUN npm install && npm run build:docker

# ---- Stage 2: Serve with nginx ----
FROM nginx:alpine

# Copy custom nginx config
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built frontend assets
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
