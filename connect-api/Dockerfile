FROM node:22-alpine
WORKDIR /app
COPY connect-api/package.json connect-api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY connect-api/*.js ./connect-api/
COPY electron/cloud/protocol.js electron/cloud/http.js ./electron/cloud/
COPY electron/serverIdentity.js electron/webScopes.js ./electron/
USER node
EXPOSE 3000
CMD ["node", "connect-api/server.js"]
