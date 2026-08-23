# Two stages so npm never reaches the final image: Girder's trivy gate fails
# the base image on npm's OWN bundled deps (tar, sigstore, ...), not on ours.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    /usr/local/lib/node_modules/corepack /usr/local/bin/corepack
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server.js package.json ./
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
