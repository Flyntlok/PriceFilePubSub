FROM node:14 AS node-builder
WORKDIR /usr/local/app
COPY .npmrc /usr/local/app/.npmrc
COPY package.json /usr/local/app/package.json
COPY yarn.lock /usr/local/app/yarn.lock
RUN yarn


FROM node:14
WORKDIR /usr/local/app
COPY . /usr/local/app
COPY --from=node-builder /usr/local/app/node_modules /usr/local/app/node_modules
RUN yarn run build-prod

CMD [ "node", "dist/server.js" ]
