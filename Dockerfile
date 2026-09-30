FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder
RUN apk --no-cache add python3 build-base pkgconf cairo-dev pango-dev jpeg-dev giflib-dev
WORKDIR /home/app/crafatar
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

FROM builder AS test
RUN node test/cache-recovery.js && node test/image-processing.js
RUN npm prune --omit=dev

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
RUN apk --no-cache add cairo pango jpeg giflib && rm -rf /usr/local/lib/node_modules/npm /opt/yarn* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /home/app/crafatar
COPY --chown=node:node --from=test /home/app/crafatar/node_modules/ node_modules/
COPY --chown=node:node package.json www.js config.js ./
COPY --chown=node:node lib/ lib/
RUN mkdir -p images/faces images/helms images/skins images/renders images/capes && chown -R node:node images
USER node
ENV NODE_ENV=production
ENTRYPOINT ["node", "www.js"]
EXPOSE 3000
