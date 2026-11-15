FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d
WORKDIR /app
COPY --chown=node:node . .
USER node
RUN npm ci --offline --ignore-scripts --no-audit --no-fund && npm run build
ENV HOST=0.0.0.0 DATA_DIR=/tmp/intake-data
EXPOSE 4310
CMD ["npm", "start"]
