FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./

EXPOSE 8002

CMD ["npm", "start"]
