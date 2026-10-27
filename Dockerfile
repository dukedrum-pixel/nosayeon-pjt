FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node web/result.html web/result.css web/styles.css ./web/
COPY --chown=node:node web/js/result-page.mjs web/js/result-player.mjs web/js/result-state.mjs web/js/result-api.mjs ./web/js/
COPY --chown=node:node scripts/public-result-server.mjs ./scripts/public-result-server.mjs
USER node
EXPOSE 8080
CMD ["node", "--use-env-proxy", "scripts/public-result-server.mjs"]
