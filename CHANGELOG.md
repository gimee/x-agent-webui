# X-Agent-Webui changelog

## 0.6.3 — 2026-10-02

- History now opens with the latest messages, then automatically loads earlier pages in serial background batches. The existing virtual list and reading-position anchor remain in place; switching conversations or profiles cancels the old task, and failed pages can be retried without being mistaken for the end of history.
- Fixed `Unpaired native tool use` during Claude context compaction after parallel tool calls. Matching native tool results that live on sibling parent branches are retained with explicit provenance checks, without mixing sidechains or replaying tools. History structure is validated before an auxiliary or native summary call, avoiding a long summary wait followed by a local pairing error. No compression-model change is needed.
- Local images in coding-agent replies now use the owning conversation's existing file-content endpoint in both live chat and history. Image zoom is unchanged; session/profile selection and encoded paths remain correct when switching conversations. Generic download permissions are unchanged, and final deliverables are directed to the current profile's persistent workspace instead of temporary storage.

## 0.6.1 — 2026-10-02

- Claude chats that hit an API error (for example repeated 502 responses from a relay gateway) now show the native error text instead of only "exited with code 75: Native call failed". Claude Code's stream-json output marks these messages with `is_api_error_message`, while only the transcript spelling `isApiErrorMessage` was recognised; both are now handled. When the context check or the summary step before a compaction fails, the error line carries the native text and labels the outcome `error` instead of `success`.
- Session list tabs use logical border properties, so their shared edge stays closed in right-to-left languages.
- Tests no longer read the removed group-chat components or the upstream desktop/webui release workflows, which this distribution does not ship; the wrapper test fixture reads only complete call-log lines and stops a still-running wrapper after a failed assertion, so a flaky test can no longer hang the image build.

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
