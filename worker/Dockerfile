# Stage 1: Build the build-server TypeScript
FROM node:22-slim AS builder

WORKDIR /app
COPY build-server/package*.json ./
RUN npm ci

COPY build-server/ ./
RUN npm run build

# Stage 2: Runtime container
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git curl bash jq ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# Install package managers globally
RUN npm install -g --force pnpm@latest yarn@latest

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash && \
    cp /root/.bun/bin/bun /usr/local/bin/bun && \
    cp /root/.bun/bin/bunx /usr/local/bin/bunx

# Install site-builder for mainnet
RUN curl -sSfL \
    "https://storage.googleapis.com/mysten-walrus-binaries/site-builder-mainnet-latest-ubuntu-x86_64" \
    -o /usr/local/bin/site-builder-mainnet && \
    chmod +x /usr/local/bin/site-builder-mainnet

# Install site-builder for testnet
RUN curl -sSfL \
    "https://storage.googleapis.com/mysten-walrus-binaries/site-builder-testnet-latest-ubuntu-x86_64" \
    -o /usr/local/bin/site-builder-testnet && \
    chmod +x /usr/local/bin/site-builder-testnet

# Default site-builder symlink (mainnet)
RUN ln -s /usr/local/bin/site-builder-mainnet /usr/local/bin/site-builder

# Install walrus CLI for mainnet
RUN curl -sSfL \
    "https://storage.googleapis.com/mysten-walrus-binaries/walrus-mainnet-latest-ubuntu-x86_64" \
    -o /usr/local/bin/walrus-mainnet && \
    chmod +x /usr/local/bin/walrus-mainnet

# Install walrus CLI for testnet
RUN curl -sSfL \
    "https://storage.googleapis.com/mysten-walrus-binaries/walrus-testnet-latest-ubuntu-x86_64" \
    -o /usr/local/bin/walrus-testnet && \
    chmod +x /usr/local/bin/walrus-testnet

# Default walrus symlink (mainnet)
RUN ln -s /usr/local/bin/walrus-mainnet /usr/local/bin/walrus

# Download sites-config.yaml for both networks
RUN mkdir -p /etc/walrus
RUN curl -sSfL \
    "https://raw.githubusercontent.com/MystenLabs/walrus-sites/refs/heads/mainnet/sites-config.yaml" \
    -o /etc/walrus/sites-config-mainnet.yaml
RUN curl -sSfL \
    "https://raw.githubusercontent.com/MystenLabs/walrus-sites/refs/heads/testnet/sites-config.yaml" \
    -o /etc/walrus/sites-config-testnet.yaml

# Copy walrus-deploy script
COPY walrus-deploy/walrus-deploy /usr/local/bin/walrus-deploy
RUN chmod +x /usr/local/bin/walrus-deploy
RUN if grep -q 'SB_ARGS+=(--gas-budget' /usr/local/bin/walrus-deploy; then \
      echo "walrus-deploy still passes --gas-budget to site-builder deploy" >&2; \
      exit 1; \
    fi && \
    mkdir -p /etc/glacier && \
    sha256sum /usr/local/bin/walrus-deploy > /etc/glacier/walrus-deploy.sha256 && \
    printf '%s\n' 'site-builder-2.9-gas-budget-config' > /etc/glacier/deployer-compat.txt

# Set up default walrus-deploy config path
ENV WALRUS_CONFIG=/etc/walrus/sites-config-mainnet.yaml

# Copy built build-server
WORKDIR /app
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 8080

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
