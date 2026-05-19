FROM ghcr.io/puppeteer/puppeteer:24.0.0

USER pptruser
WORKDIR /app

COPY --chown=pptruser:pptruser package.json ./
RUN npm install --omit=dev

COPY --chown=pptruser:pptruser whatsapp-webjs-server.cjs ./
RUN mkdir -p /app/.wwebjs_auth

EXPOSE 3030
CMD ["node", "whatsapp-webjs-server.cjs"]
