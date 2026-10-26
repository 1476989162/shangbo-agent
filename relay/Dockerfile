FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs state.mjs ./
ENV RELAY_PORT=8787 RELAY_HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "server.mjs"]
