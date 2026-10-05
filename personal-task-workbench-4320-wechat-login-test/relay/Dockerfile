FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.mjs ./
COPY home-forwarding.cjs ./
COPY relay-public.json ./

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "server.mjs"]
