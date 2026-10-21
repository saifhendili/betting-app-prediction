# ── build the UI ────────────────────────────────────────────────────────────
FROM node:22-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ── runtime: one process serving the API and the built UI ───────────────────
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY server/package*.json ./server/
RUN npm --prefix server ci --omit=dev && npm cache clean --force

COPY server/ ./server/
COPY --from=client /app/client/dist ./client/dist

# Don't run as root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

# Hosting platforms inject PORT; 5000 is the local default.
ENV PORT=5000
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
