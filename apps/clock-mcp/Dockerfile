FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
