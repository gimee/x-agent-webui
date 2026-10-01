// hermes-v050:C5 聊天代码块用 highlight.js core + 常用语言（原来整包 947KB 约 190 种语言）。
// MarkdownRenderer 静态引入本文件（它本身已是异步 chunk），MessageItem 在展开工具详情时再动态引入；
// 清单外的语言由 highlight.ts 按纯文本输出，不报错。
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import makefile from 'highlight.js/lib/languages/makefile'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import plaintext from 'highlight.js/lib/languages/plaintext'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { installCodeHighlighter } from './highlight'

// 语言自带别名：sh/zsh→bash、console→shell、js/jsx/mjs→javascript、ts/tsx→typescript、py→python、
// golang→go、rs→rust、yml→yaml、html/svg/xhtml→xml、toml→ini、docker→dockerfile、md→markdown、
// h→c、cc/c++/hpp→cpp、cs/c#→csharp、kt→kotlin、ps1→powershell、mk/make→makefile、rb→ruby、patch→diff。
export const COMMON_HIGHLIGHT_LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  makefile,
  markdown,
  php,
  plaintext,
  powershell,
  python,
  ruby,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
} as const

for (const [name, language] of Object.entries(COMMON_HIGHLIGHT_LANGUAGES)) {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, language)
}

installCodeHighlighter(hljs)

export { hljs }
