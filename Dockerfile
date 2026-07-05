FROM node:20-alpine

WORKDIR /usr/src/app

COPY app/package.json ./
RUN npm install --omit=dev

COPY app/server.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
