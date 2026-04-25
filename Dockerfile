# syntax=docker/dockerfile:1.6

# ToCodex API Server
# Zero-dependency Node.js relay. The final image contains only:
#   - node:20-alpine runtime
#   - tini as PID 1
#   - package.json + server.js + lib/ (protocol translators and helpers)
#   - non-root 'app' user

FROM node:20-alpine

RUN apk add --no-cache tini \
 && addgroup -S app \
 && adduser  -S app -G app

ENV NODE_ENV=production \
    LISTEN_HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app

COPY --chown=app:app package.json ./
COPY --chown=app:app server.js    ./
COPY --chown=app:app lib          ./lib

USER app

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||8787) +'/_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
