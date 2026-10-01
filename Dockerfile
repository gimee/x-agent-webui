# Build the checked-in X-Agent-Webui and retain the production agent/runtime layers.
# Agent dependencies track their upstream releases; X-Agent-Webui source stays local.
ARG BASE_IMAGE=nousresearch/hermes-agent:latest
FROM ${BASE_IMAGE}

USER root

# sudo is required by agent-browser's dependency installer, even as root.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         ca-certificates curl make g++ git python3 python3-pip sudo \
    && find /var/lib/apt/lists -type f -delete \
    && pip3 install pyyaml --break-system-packages
RUN node -v && npm -v

RUN npm install -g @anthropic-ai/claude-code && claude --version
RUN npm install -g @earendil-works/pi-coding-agent@latest && pi --version
# Keep the production CLI selection; Codex remains an optional user install.
RUN rm -f /usr/local/bin/codex /usr/local/bin/codex.cmd \
    && rm -rf /usr/local/lib/node_modules/@openai/codex /opt/hermes/node_modules/@openai/codex

WORKDIR /app
COPY package.json package-lock.json ./
ENV NODE_OPTIONS=--max-old-space-size=4096
# Base images may export NODE_ENV=production: build tools must still be installed.
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund && npm rebuild node-pty
COPY . .

# Preserve the production source-drift guards, not a checkout of upstream main.
RUN test "$(node -p "require('./package.json').upstreamProvenance.commit")" = "ee728bdc700d6409c81341003d623df9b811ee15" \
    && F=packages/server/src/modules/coding-agents/services/index.ts \
    && test "$(grep -Fc "const CLAUDE_CODE_ROOT_PERMISSION_ARGS = ['--permission-mode', 'bypassPermissions']" "$F")" = "1" \
    && test "$(grep -c 'hermes-ui-tweaks' packages/client/src/stores/hermes/chat.ts)" -ge 5 \
    && test "$(grep -c 'hermes-empty-session-keep' packages/client/src/stores/hermes/chat.ts)" -ge 1 \
    && test "$(grep -c 'hermes-delegation-timeout-fix' packages/client/src/stores/hermes/chat.ts)" -ge 1 \
    && test "$(grep -c 'reconcileMessageSnapshot(' packages/client/src/stores/hermes/chat.ts)" -ge 4 \
    && test -f packages/server/src/modules/hermes/routes/cc-api.ts \
    && test -f packages/client/src/composables/useQuickPhrases.ts
RUN npm run test:claude-context && npm run test:claude-start \
    && npm run build && npm prune --omit=dev && npm run verify:sharp-runtime

# Same Pi MCP adapter layout as the native X-Agent-Webui installer; seed missing state only.
RUN mkdir -p /opt/hermes-pi-seed/pi-mcp-adapter \
    && npm install --prefix /opt/hermes-pi-seed/pi-mcp-adapter --save-exact --no-audit --no-fund pi-mcp-adapter@latest \
    && test -f /opt/hermes-pi-seed/pi-mcp-adapter/node_modules/pi-mcp-adapter/index.ts \
    && node -p "require('/opt/hermes-pi-seed/pi-mcp-adapter/node_modules/pi-mcp-adapter/package.json').version"

ENV NODE_ENV=production \
    HOME=/home/agent \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    IS_SANDBOX=1 \
    HERMES_HOME=/home/agent/.hermes \
    HERMES_WEB_UI_HOME=/home/agent/.hermes-web-ui \
    HERMES_WEBUI_STATE_DIR=/home/agent/.hermes-web-ui \
    HERMES_ALLOW_ROOT_GATEWAY=1 \
    AUTH_DISABLED=0 \
    PORT=6060 \
    BIND_HOST=0.0.0.0 \
    HERMES_WRITE_SAFE_ROOT="" \
    HERMES_PI_SEED=/opt/hermes-pi-seed/pi-mcp-adapter \
    PATH=/opt/hermes/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Chrome must be installed under the runtime HOME, outside all persistent mounts.
RUN npm install -g --allow-scripts=agent-browser agent-browser@0.26.0 \
    && command -v agent-browser \
    && HOME=/home/agent agent-browser install --with-deps \
    && test -n "$(find /home/agent/.agent-browser/browsers -name chrome -type f -print -quit)"

# Original continuity and memory-lock patches, applied at build time fail-closed.
COPY docker/patch-amnesia.sh docker/patch-memory-policy.sh /opt/x-agent-patches/
RUN chmod +x /opt/x-agent-patches/*.sh \
    && bash /opt/x-agent-patches/patch-amnesia.sh apply \
    && bash /opt/x-agent-patches/patch-amnesia.sh check | grep -q '^patched:'
RUN bash /opt/x-agent-patches/patch-memory-policy.sh \
    && grep -q 'hermes-memory-policy-v3' /opt/hermes/tools/memory_tool.py

COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY docker/hermes-entrypoint.py /usr/local/bin/hermes-entrypoint.py
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/hermes-entrypoint.py

EXPOSE 6060
HEALTHCHECK --interval=15s --timeout=10s --start-period=60s --retries=5 \
    CMD ["node", "/app/docker/healthcheck.mjs"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD []
