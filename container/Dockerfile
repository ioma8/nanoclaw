# NanoClaw Agent Container
# Runs OpenAI Agents SDK in a lightweight container

FROM node:22-alpine AS build

RUN apk add --no-cache bash git

WORKDIR /app

COPY agent-runner/package*.json ./
RUN npm install

COPY agent-runner/ ./
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine

RUN apk add --no-cache bash

WORKDIR /app
COPY --from=build /app /app

RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks

# Create entrypoint script
# Sources env from mounted /workspace/env-dir/env if it exists
RUN printf '#!/bin/sh\nset -e\n[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)\ncat > /tmp/input.json\nnode /app/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

RUN chown -R node:node /workspace /app

USER node
WORKDIR /workspace/group

ENTRYPOINT ["/app/entrypoint.sh"]
