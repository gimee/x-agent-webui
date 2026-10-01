// @vitest-environment jsdom
// hermes-v050:U7 SKILL.md frontmatter 预览成 yaml 代码块；U15 技能列表描述去掉 Markdown 标记；U16-T22 统计图标提示走 i18n。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import { mergeMessagesWithFallback } from '@/i18n/messages'

const mockFetchSkillContent = vi.hoisted(() => vi.fn())
const mockFetchSkillFiles = vi.hoisted(() => vi.fn())
const mockSaveSkillContent = vi.hoisted(() => vi.fn())

vi.mock('@/api/hermes/skills', () => ({
  fetchSkillContent: mockFetchSkillContent,
  fetchSkillFiles: mockFetchSkillFiles,
  saveSkillContent: mockSaveSkillContent,
  pinSkillApi: vi.fn(),
  toggleSkill: vi.fn(),
  deleteSkillApi: vi.fn(),
}))

vi.mock('@/components/hermes/chat/MarkdownRenderer.vue', () => ({
  default: defineComponent({ props: ['content'], template: '<pre class="markdown-renderer-stub">{{ content }}</pre>' }),
}))

vi.mock('naive-ui', () => ({
  NSwitch: defineComponent({ name: 'NSwitch', props: ['value', 'loading'], template: '<button type="button"></button>' }),
  useMessage: () => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }),
  useDialog: () => ({ warning: vi.fn() }),
}))

import SkillDetail from '@/components/hermes/skills/SkillDetail.vue'
import SkillList from '@/components/hermes/skills/SkillList.vue'
import { skillDescriptionPlainText, wrapSkillFrontmatterForPreview } from '@/utils/hermes/skill-display'

const i18n = () => createI18n({ legacy: false, locale: 'zh', fallbackLocale: 'en', messages: { en, zh: mergeMessagesWithFallback(en, zh) } })

const SKILL = '---\nname: hermes-make-group\ndescription: Make a group\ntags: [a, b]\n---\n\n# Make Group\n\nBody text.\n'

describe('hermes-v050:U7 wrapSkillFrontmatterForPreview', () => {
  it('wraps a leading --- … --- block into a yaml code fence and leaves the body alone', () => {
    expect(wrapSkillFrontmatterForPreview(SKILL)).toBe('```yaml\n---\nname: hermes-make-group\ndescription: Make a group\ntags: [a, b]\n---\n```\n\n# Make Group\n\nBody text.\n')
  })

  it('handles CRLF, a BOM and trailing spaces after the delimiters', () => {
    const crlf = '﻿---  \r\nname: x\r\n---\r\n# T\r\n'
    expect(wrapSkillFrontmatterForPreview(crlf)).toBe('```yaml\n---  \r\nname: x\r\n---\n```\r\n# T\r\n')
  })

  it('uses a longer fence when the frontmatter itself contains backticks', () => {
    const tricky = '---\nnote: "```"\n---\nbody'
    expect(wrapSkillFrontmatterForPreview(tricky)).toBe('````yaml\n---\nnote: "```"\n---\n````\nbody')
  })

  it('does not touch content without a leading frontmatter or without a closing delimiter', () => {
    expect(wrapSkillFrontmatterForPreview('# Title\n---\nnot frontmatter\n---\n')).toBe('# Title\n---\nnot frontmatter\n---\n')
    expect(wrapSkillFrontmatterForPreview('---\nname: x\nno close')).toBe('---\nname: x\nno close')
    expect(wrapSkillFrontmatterForPreview('')).toBe('')
  })
})

describe('hermes-v050:U7 SkillDetail preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchSkillContent.mockResolvedValue(SKILL)
    mockFetchSkillFiles.mockResolvedValue([])
    mockSaveSkillContent.mockResolvedValue(undefined)
  })

  function mountDetail() {
    return mount(SkillDetail, {
      props: { category: 'misc', skill: 'demo', skillName: 'demo', readonly: false, canPin: false, viewCount: 3, useCount: 2, patchCount: 1 },
      global: { plugins: [i18n()] },
    })
  }

  it('previews the frontmatter as a yaml block but edits and saves the raw file', async () => {
    const wrapper = mountDetail()
    await flushPromises()
    expect(wrapper.get('.markdown-renderer-stub').text().startsWith('```yaml\n---\nname: hermes-make-group')).toBe(true)

    await wrapper.get('.detail-action').trigger('click')
    const editor = wrapper.get('textarea.skill-editor')
    expect((editor.element as HTMLTextAreaElement).value).toBe(SKILL)
    await editor.setValue(SKILL.replace('Body text.', 'Body text 2.'))
    await wrapper.findAll('.detail-action')[0].trigger('click')
    await flushPromises()
    expect(mockSaveSkillContent).toHaveBeenCalledWith('misc', 'demo', SKILL.replace('Body text.', 'Body text 2.'), 'hermes')
  })

  it('titles the usage stat icons in the UI language (T22)', async () => {
    const wrapper = mountDetail()
    await flushPromises()
    expect(wrapper.findAll('.usage-stat').map(node => node.attributes('title'))).toEqual(['浏览', '使用', '修改'])
  })
})

describe('hermes-v050:U15 skill list descriptions', () => {
  it('strips bold, inline-code and link markdown, keeping the link text', () => {
    expect(skillDescriptionPlainText('Run a **separate pipeline** with `computer_use` via [Claude Code](https://example.com/x) now'))
      .toBe('Run a separate pipeline with computer_use via Claude Code now')
    expect(skillDescriptionPlainText('plain text stays')).toBe('plain text stays')
    expect(skillDescriptionPlainText('')).toBe('')
    expect(skillDescriptionPlainText(undefined)).toBe('')
  })

  it('hermes-v050:E-11 drops a link cut open by the 80-character server truncation, keeping its text', () => {
    // Two descriptions exactly as /api/hermes/skills serves them (claude-code, godmode; 80 characters each).
    expect(skillDescriptionPlainText('Delegate coding tasks to [Claude Code](https://code.claude.com/docs/en/cli-refer'))
      .toBe('Delegate coding tasks to Claude Code')
    expect(skillDescriptionPlainText('Bypass safety filters on API-served LLMs using techniques from [G0DM0D3](https:/'))
      .toBe('Bypass safety filters on API-served LLMs using techniques from G0DM0D3')
    // closed links before the cut keep working; a cut right after "](" is handled too
    expect(skillDescriptionPlainText('See [a](https://a.test) and [b](')).toBe('See a and b')
    expect(skillDescriptionPlainText('[`@chenglou/pretext`](https://github.com/chenglou/pretext) is a 15KB zero-depend'))
      .toBe('@chenglou/pretext is a 15KB zero-depend')
    // brackets that are not a link stay as written
    expect(skillDescriptionPlainText('Use [x] then (y')).toBe('Use [x] then (y')
  })

  it('renders plain-text descriptions in all three list sections', () => {
    const desc = 'Use **bold** and `code` and [link](https://x.test)'
    const wrapper = mount(SkillList, {
      props: {
        categories: [{ name: 'tools', description: '', skills: [{ name: 'a-skill', description: desc, enabled: true, source: 'local' }] }],
        archived: [{ name: 'old-skill', description: desc, enabled: false, source: 'local' } as any],
        selectedSkill: null,
        searchQuery: '',
        sourceFilter: null,
      },
      global: { plugins: [i18n()] },
    })
    const texts = wrapper.findAll('.skill-desc').map(node => node.text())
    expect(texts.length).toBeGreaterThan(0)
    for (const text of texts) expect(text).toBe('Use bold and code and link')
  })
})
