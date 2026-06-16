# Playwright base image ships Chromium + all system deps, pinned to our Playwright version.
# (Browsers live at /ms-playwright; no need to re-download — hence --ignore-scripts.)
FROM mcr.microsoft.com/playwright:v1.61.0-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.61.0-noble AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist

# Render provides PORT; the server binds 0.0.0.0:$PORT.
EXPOSE 3000
CMD ["node", "dist/server.js"]
