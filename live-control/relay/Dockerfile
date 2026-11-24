FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY public ./public
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "server.js"]
