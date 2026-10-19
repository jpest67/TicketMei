#Image Node.js e npm alpine.
FROM node:24-alpine

#in container, app is workfolder
WORKDIR /app

#copies package, reads it and installs listed dependencies.
COPY package.json ./
RUN npm install

#copies instructions for app (server.js) and the events (data folder)
COPY server.js ./
COPY data/ ./data/

#port to be used by catalog
EXPOSE 8001

#inicia node server.js
CMD ["npm", "start"]
