# Site components

Static X-Agent-Webui landing page (`https://x-agent.io`). Keep this registry aligned with the files in `site/`.

| Component | Source | Purpose |
| --- | --- | --- |
| Brand mark | `assets/x-agent-mark.svg` | Own X mark (cyan → indigo → violet); also the product logo/favicon source. |
| Header | `index.html` + `styles.css` + `script.js` | Sticky glass header, section navigation, GitHub link, Chinese/English switch, mobile menu (Esc closes). |
| Hero + context flow | `index.html` + `script.js` (canvas) | Headline, install/source CTAs, three stats, and an illustrative canvas: tool output/replies fold into a summary band at the compaction gate while user messages pass through intact. Paused off-screen/hidden tab; static frame under reduced motion. |
| Product shot | `assets/product-shot-zh.png`, `assets/product-shot-en.png` | Real interface screenshots with synthetic demo data, swapped with the language. |
| Memory-first compaction | `index.html` | Claude (memory-first), Hermes (settings enforced) and shared failure-safety cards, plus auxiliary-model timing bars. |
| Capabilities | `index.html` | Message identity, three agents, memory lock, frozen interface. |
| Performance | `index.html` | Before/after metric cards measured with ~800 sessions. |
| Install | `index.html` + `script.js` | Literal one-line installer, clipboard copy with selection fallback, prerequisites, first-login warning. |
| Lineage | `index.html` | Unofficial derivative of EKKOLearnAI/hermes-studio v0.7.18, BSL 1.1 non-commercial grant, Hermes Agent MIT. |

## Site constraints

- Static HTML/CSS/JS only; no build step, external CDN, external font, analytics, tracking, or runtime API.
- Product name is **X-Agent-Webui** (short: X-Agent). "Hermes Studio" appears only as the upstream name in lineage text.
- Keep the install command literal: `curl -fsSL https://raw.githubusercontent.com/gimee/x-agent-webui/main/install.sh | bash`.
- Claims must match shipped changes and their recorded measurements; Claude-only behaviour (verbatim carry-forward) is labelled as such.
- Never imply official affiliation or MIT licensing for the WebUI code.
- Preserve `_headers`, including `no-transform` and the Content-Security-Policy (no inline styles or scripts).
- Motion uses transform/opacity only; `prefers-reduced-motion` disables animation. No horizontal overflow from 320px up.
