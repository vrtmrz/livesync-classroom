# LiveSync classroom - Sharing obsidian's vault via Self-hosted LiveSync.
# Initial Author: @kenjibailly
# Modified      : @vrtmrz
FROM node:16-alpine
WORKDIR /usr/src/app
COPY . .
RUN npm i -D && npm run build
CMD [ "node", "dist/index.js" ]