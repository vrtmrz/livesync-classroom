FROM node:16-alpine
WORKDIR /usr/src/app
COPY . .
RUN npm i -D && npm run build
CMD [ "node", "dist/index.js" ]