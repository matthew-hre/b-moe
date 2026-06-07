FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    git \
    ca-certificates \
    curl \
    unzip \
    build-essential \
    ripgrep \
    jq \
  && rm -rf /var/lib/apt/lists/*

ENV BUN_INSTALL=/root/.bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

RUN curl -fsSL https://bun.sh/install | bash

RUN corepack enable \
  && corepack prepare pnpm@10 --activate

RUN npm install -g @mariozechner/pi-coding-agent

WORKDIR /workspace

CMD ["sleep", "infinity"]
