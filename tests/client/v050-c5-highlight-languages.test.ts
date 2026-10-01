// hermes-v050:C5 highlight.js 改为 core + 常用语言：清单内语言着色、别名可用、清单外回退纯文本不报错。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SAMPLES: Array<[string, string]> = [
  ['bash', 'if [ -f "$HOME/.bashrc" ]; then echo "hi"; fi'],
  ['sh', 'export PATH="$HOME/bin:$PATH"'],
  ['zsh', 'for f in *.ts; do echo $f; done'],
  ['shell', '$ npm run build\n> vite build'],
  ['console', '$ ls -la'],
  ['js', 'const answer = 42; function f() { return "x" }'],
  ['javascript', 'export default { name: "x" }'],
  ['ts', 'interface A { id: string }\nconst a: A = { id: "1" }'],
  ['typescript', 'type T = Record<string, number>'],
  ['tsx', 'const el = <div className="x">hi</div>'],
  ['json', '{"answer": 42, "ok": true}'],
  ['python', 'def main():\n    return "ok"'],
  ['py', 'import os\nprint(os.getcwd())'],
  ['go', 'package main\nfunc main() { fmt.Println("hi") }'],
  ['golang', 'var x int = 1'],
  ['rust', 'fn main() { let x: i32 = 5; println!("{}", x); }'],
  ['rs', 'pub struct A { id: u32 }'],
  ['yaml', 'name: ci\non: [push]'],
  ['yml', 'key: "value"'],
  ['sql', 'SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC'],
  ['html', '<div class="a">hi</div>'],
  ['xml', '<?xml version="1.0"?><root a="1"/>'],
  ['vue', '<template><div /></template>'],
  ['css', '.a { color: red; }'],
  ['diff', '+added line\n-removed line\n context'],
  ['markdown', '# Title\n\n**bold** `code`'],
  ['md', '- item\n- [link](http://x)'],
  ['java', 'public class A { public static void main(String[] args) {} }'],
  ['c', '#include <stdio.h>\nint main(void) { return 0; }'],
  ['cpp', '#include <vector>\nint main() { std::vector<int> v; }'],
  ['c++', 'class A { public: int x; };'],
  ['dockerfile', 'FROM node:22\nRUN npm ci'],
  ['docker', 'COPY . /app'],
  ['ini', '[section]\nkey = value'],
  ['toml', '[package]\nname = "x"'],
  ['php', '<?php echo "hi"; ?>'],
  ['ruby', 'def hi\n  puts "hi"\nend'],
  ['csharp', 'public class A { public int X { get; set; } }'],
  ['kotlin', 'fun main() { val x = 1 }'],
  ['powershell', 'Get-ChildItem -Path C:\\ | Where-Object { $_.Length -gt 1 }'],
  ['makefile', 'all:\n\tgcc -o a a.c'],
]

describe('C5 core highlighter language coverage', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('registers every commonly used code block language with highlighting spans', async () => {
    await import('@/components/hermes/chat/highlight-hljs')
    const { renderHighlightedCodeBlock } = await import('@/components/hermes/chat/highlight')
    for (const [lang, code] of SAMPLES) {
      const html = renderHighlightedCodeBlock(code, lang, 'Copy')
      expect(html, lang).toContain('class="hljs-code-block"')
      expect(html, lang).toMatch(/<span class="hljs-[a-z_-]+/)
    }
  })

  it('falls back to escaped plaintext for unregistered languages without throwing', async () => {
    await import('@/components/hermes/chat/highlight-hljs')
    const { renderHighlightedCodeBlock } = await import('@/components/hermes/chat/highlight')
    for (const lang of ['foobar', 'haskell', 'elixir', 'mermaid-ish', '']) {
      const html = renderHighlightedCodeBlock('<b>raw</b> & "q"', lang, 'Copy')
      expect(html, lang).not.toMatch(/<span class="hljs-/)
      expect(html, lang).toContain('&lt;b&gt;raw&lt;/b&gt; &amp; &quot;q&quot;')
    }
    const auto = renderHighlightedCodeBlock('plain words', undefined, 'Copy')
    expect(auto).toContain('class="code-lang">text</span>')
  })

  it('renders the same code block shell as plaintext before any highlighter is installed', async () => {
    const { isCodeHighlighterInstalled, renderHighlightedCodeBlock } = await import('@/components/hermes/chat/highlight')
    expect(isCodeHighlighterInstalled()).toBe(false)
    const html = renderHighlightedCodeBlock('const a = 1', 'ts', 'Copy')
    expect(html).toBe('<pre class="hljs-code-block"><div class="code-header"><span class="code-lang">ts</span><button type="button" class="copy-btn" data-copy-code="true">Copy</button></div><code class="hljs language-ts">const a = 1</code></pre>')
  })

  it('keeps diff folding and unified diff rendering independent of highlight.js', async () => {
    const { renderHighlightedCodeBlock } = await import('@/components/hermes/chat/highlight')
    const html = renderHighlightedCodeBlock('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n', 'diff', 'Copy')
    expect(html).toContain('hljs-unified-diff')
    expect(html).toContain('diff-line-added')
  })
})

describe('C3 highlight result cache', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('highlights an unchanged code block only once across repeated renders', async () => {
    const { installCodeHighlighter, renderHighlightedCodeBlock } = await import('@/components/hermes/chat/highlight')
    const highlight = vi.fn((code: string) => ({ value: `<span class="hljs-x">${code}</span>` }))
    installCodeHighlighter({ getLanguage: (name: string) => (name === 'ts' ? {} : undefined), highlight })
    const first = renderHighlightedCodeBlock('const a = 1', 'ts', 'Copy')
    for (let i = 0; i < 20; i += 1) {
      expect(renderHighlightedCodeBlock('const a = 1', 'ts', 'Copy')).toBe(first)
    }
    expect(highlight).toHaveBeenCalledTimes(1)
    // 语言不同或内容不同都要重新高亮
    renderHighlightedCodeBlock('const a = 1', 'tsx', 'Copy')
    renderHighlightedCodeBlock('const a = 2', 'ts', 'Copy')
    expect(highlight).toHaveBeenCalledTimes(2)
    // 复制按钮文案不进缓存键：切换语言后外壳文案立即更新
    expect(renderHighlightedCodeBlock('const a = 1', 'ts', '复制')).toContain('>复制</button>')
    expect(highlight).toHaveBeenCalledTimes(2)
  })

  it('bounds the cache so streaming partial blocks cannot grow memory without limit', async () => {
    const { installCodeHighlighter, renderHighlightedCodeBlock } = await import('@/components/hermes/chat/highlight')
    const highlight = vi.fn((code: string) => ({ value: code }))
    installCodeHighlighter({ getLanguage: () => ({}), highlight })
    for (let i = 0; i < 2_000; i += 1) renderHighlightedCodeBlock(`line ${i}\n`.repeat(20), 'ts', 'Copy')
    highlight.mockClear()
    renderHighlightedCodeBlock(`line 0\n`.repeat(20), 'ts', 'Copy')
    expect(highlight).toHaveBeenCalledTimes(1)
    renderHighlightedCodeBlock(`line 1999\n`.repeat(20), 'ts', 'Copy')
    expect(highlight).toHaveBeenCalledTimes(1)
  })
})
