# Playwright's own image: chromium + every shared library it links, preinstalled.
# Tag must track the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
