FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY chart /charts/store
COPY --from=alpine/helm:3.16.4 /usr/bin/helm /usr/local/bin/helm
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
