# For your own server (OVH). Build: docker build -t officedesk .
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
ENV PORT=3000 NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "server.js"]
