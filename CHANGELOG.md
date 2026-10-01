# X-Agent-Webui changelog

## 0.6.0 — 2026-10-01

- Rebranded as X-Agent-Webui: the browser title, login and boot screens, sidebar version (X-Agent vX.Y.Z), notifications, error messages and settings now use the X-Agent name, with a new X logo and favicon; the Hermes Agent name, internal identifiers, data directories and existing settings are unchanged, so no migration is needed.

## 0.5.3 — 2026-10-01

- Use synthetic documentation/test examples and remove internal acceptance data.
- Refresh the bilingual website with a technical visual design, responsive system diagrams and reduced-motion support.
- Preserve the established repository and website footer links.

## 0.5.2 — 2026-10-01

Initial public community distribution of the 0.5.1 source snapshot:

- Export an isolated source tree without private Git history, operational state or personal deployment configuration.
- Generalize internal fixture addresses, personal markers and release notes.
- Provide a curl installer and a Docker Compose source-build path with persistent volumes and loopback-only default exposure.
- Add English and Chinese documentation, upstream attribution and explicit BSL non-commercial licensing boundaries.
- Point the settings-footer GitHub and website links to this project, without changing their layout.
- Add the independent project website at https://x-agent.io.

The original upstream remains EKKOLearnAI/hermes-studio v0.7.18, commit ee728bdc700d6409c81341003d623df9b811ee15. Earlier community changes are described by the in-application changelog and implementation documentation. They include session persistence and identity fixes, long-conversation rendering/search improvements, configurable context compression and user-controlled memory locking.

中文：本次为社区首次公开发行，提供脱敏源码、安装与中英文说明，保留原许可和分支出处；设置底部的两个项目链接改为本仓库和官网，不改布局。
