// @vitest-environment jsdom
// hermes-v050:U27 — Claude settings.json 编辑器默认遮罩 env 里的凭据；遮罩只在显示层，保存永远写原文。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import { mergeMessagesWithFallback } from '@/i18n/messages'

// Fake credentials only (never real ones).
const TOKEN = 'sk-test-0123456789abcdefWXYZ'
const API_KEY = 'fake-api-key-9876543210'
const SETTINGS = `{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "${TOKEN}",
    "ANTHROPIC_BASE_URL": "https://example.invalid/v1",
    "OPENAI_API_KEY": "${API_KEY}",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS_HINT": "",
    "DB_PASSWORD": "pw"
  },
  "model": "opus",
  "apiKeyHelper": "/usr/local/bin/key-helper"
}
`

const files = vi.hoisted(() => ({ store: new Map<string, string>() }))
const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/coding-agents', () => ({
  readCodingAgentConfigFile: readMock,
  writeCodingAgentConfigFile: writeMock,
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { agentId: 'claude-code', section: 'settings' } }),
}))

vi.mock('@/components/coding-agents/CodingAgentMcpPanel.vue', () => ({ default: defineComponent({ template: '<div />' }) }))
vi.mock('@/components/coding-agents/CodingAgentSkillsPanel.vue', () => ({ default: defineComponent({ template: '<div />' }) }))

vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    name: 'NButton',
    props: ['disabled', 'loading', 'type', 'size'],
    emits: ['click'],
    template: '<button type="button" class="n-button-stub" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  }),
  NInput: defineComponent({
    name: 'NInput',
    props: ['value', 'type', 'placeholder', 'readonly'],
    emits: ['update:value'],
    template: '<textarea class="n-input-stub" :value="value" :readonly="readonly" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NSpin: defineComponent({ template: '<div class="n-spin-stub" />' }),
  NTag: defineComponent({ template: '<span class="n-tag-stub"><slot /></span>' }),
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
}))

import CodingAgentConfigView from '@/views/hermes/CodingAgentConfigView.vue'
import { hasSettingsSecrets, maskSecretValue, maskSettingsSecrets } from '@/utils/coding-agent-settings-secrets'

function file(key: string, content: string) {
  return { key, path: `~/.claude/${key === 'settings' ? 'settings.json' : 'CLAUDE.md'}`, absolutePath: '/x', language: 'json', content, exists: true, size: content.length, profile: 'default' }
}

const i18n = () => createI18n({ legacy: false, locale: 'zh', fallbackLocale: 'en', messages: { en, zh: mergeMessagesWithFallback(en, zh) } })

describe('hermes-v050:U27 masking helpers', () => {
  it('keeps the CC API table mask (first 8 … last 4) for long values', () => {
    expect(maskSecretValue(TOKEN)).toBe('sk-test-…WXYZ')
    expect(maskSecretValue('abcdefghijklmnopq')).toBe('abcdefgh…nopq')
    expect(maskSecretValue('')).toBe('')
  })

  // hermes-v050:F-10 the CC API rule showed a 4-character value whole and hid 1 of 13.
  it('hides short values (up to 16 characters) completely behind a fixed-length mask', () => {
    for (const value of ['a', 'ab', 'pw12', '31999', 'abcdefghijkl', 'abcdefghijklm', 'abcdefghijklmnop']) {
      const masked = maskSecretValue(value)
      expect(masked).toBe('••••••••')
      for (let i = 0; i < value.length; i += 1) expect(masked).not.toContain(value[i])
    }
    expect(maskSettingsSecrets('{ "env": { "DB_PASSWORD": "pw12" } }')).toBe('{ "env": { "DB_PASSWORD": "••••••••" } }')
  })

  it('masks only non-empty env values whose name contains TOKEN / KEY / SECRET / PASSWORD, keeping the layout', () => {
    const masked = maskSettingsSecrets(SETTINGS)
    expect(masked).not.toContain(TOKEN)
    expect(masked).not.toContain(API_KEY)
    expect(masked).toContain('"ANTHROPIC_AUTH_TOKEN": "sk-test-…WXYZ"')
    expect(masked).toContain('"OPENAI_API_KEY": "fake-api…3210"')
    expect(masked).toContain('"DB_PASSWORD": "••••••••"')
    expect(masked).toContain('"ANTHROPIC_BASE_URL": "https://example.invalid/v1"')
    expect(masked).toContain('"CLAUDE_CODE_MAX_OUTPUT_TOKENS_HINT": ""')
    expect(masked).toContain('"apiKeyHelper": "/usr/local/bin/key-helper"')
    expect(masked.split('\n').length).toBe(SETTINGS.split('\n').length)
    expect(hasSettingsSecrets(SETTINGS)).toBe(true)
    expect(hasSettingsSecrets('{ "env": { "ANTHROPIC_BASE_URL": "x" } }')).toBe(false)
    expect(hasSettingsSecrets('# CLAUDE.md\nsome notes')).toBe(false)
  })

  it('still masks by name while the JSON is being edited and temporarily invalid', () => {
    const broken = SETTINGS.replace('"model": "opus",', '"model": "opus"')
    expect(() => JSON.parse(broken)).toThrow()
    expect(maskSettingsSecrets(broken)).not.toContain(TOKEN)
  })
})

describe('hermes-v050:U27 CodingAgentConfigView settings.json editor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    files.store = new Map([['memory', '# Notes\n'], ['settings', SETTINGS]])
    readMock.mockImplementation(async (_id: string, key: string) => file(key, files.store.get(key) || ''))
    writeMock.mockImplementation(async (_id: string, key: string, content: string) => {
      files.store.set(key, content)
      return file(key, content)
    })
  })

  async function mountView() {
    const wrapper = mount(CodingAgentConfigView, { global: { plugins: [i18n()] } })
    await flushPromises()
    const panels = wrapper.findAll('.settings-editor-panel')
    return { wrapper, settingsPanel: () => wrapper.findAll('.settings-editor-panel')[1], memoryPanel: () => panels[0] }
  }

  it('shows the masked, read-only settings.json by default and never renders the raw token', async () => {
    const { wrapper, settingsPanel } = await mountView()
    const editor = settingsPanel().get('textarea')
    expect((editor.element as HTMLTextAreaElement).value).toContain('sk-test-…WXYZ')
    expect(editor.attributes('readonly')).toBeDefined()
    expect(wrapper.html()).not.toContain(TOKEN)
    expect(wrapper.html()).not.toContain(API_KEY)
    expect(settingsPanel().text()).toContain('显示凭据')
  })

  it('ignores edits typed into the masked view and keeps Save disabled', async () => {
    const { settingsPanel } = await mountView()
    await settingsPanel().get('textarea').setValue('{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-test-…WXYZ"}}')
    const save = settingsPanel().findAll('button').find(button => button.text() === zh.files.saveFile)
    expect(save?.attributes('disabled')).toBeDefined()
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('saving without revealing writes the original file content: the token value is unchanged', async () => {
    const { wrapper } = await mountView()
    const saveButtons = wrapper.findAllComponents({ name: 'NButton' }).filter(button => button.text() === zh.files.saveFile)
    // force the save handler even though the button is disabled
    saveButtons[1].vm.$emit('click')
    await flushPromises()
    expect(writeMock).toHaveBeenCalledWith('claude-code', 'settings', SETTINGS)
    expect(files.store.get('settings')).toContain(`"ANTHROPIC_AUTH_TOKEN": "${TOKEN}"`)
    expect(files.store.get('settings')).not.toContain('…')
  })

  it('reveal → edit → hide → save keeps the real token and the edit', async () => {
    const { settingsPanel } = await mountView()
    await settingsPanel().findAll('button').find(button => button.text() === '显示凭据')!.trigger('click')
    const editor = settingsPanel().get('textarea')
    expect(editor.attributes('readonly')).toBeUndefined()
    expect((editor.element as HTMLTextAreaElement).value).toBe(SETTINGS)
    await editor.setValue(SETTINGS.replace('"model": "opus"', '"model": "sonnet"'))

    await settingsPanel().findAll('button').find(button => button.text() === '隐藏凭据')!.trigger('click')
    expect((settingsPanel().get('textarea').element as HTMLTextAreaElement).value).not.toContain(TOKEN)

    await settingsPanel().findAll('button').find(button => button.text() === zh.files.saveFile)!.trigger('click')
    await flushPromises()
    const written = files.store.get('settings') || ''
    expect(written).toContain(`"ANTHROPIC_AUTH_TOKEN": "${TOKEN}"`)
    expect(written).toContain(`"OPENAI_API_KEY": "${API_KEY}"`)
    expect(written).toContain('"model": "sonnet"')
    expect(written).not.toContain('…')
  })

  it('leaves editors without credentials editable and without a reveal button', async () => {
    const { memoryPanel } = await mountView()
    expect(memoryPanel().get('textarea').attributes('readonly')).toBeUndefined()
    expect(memoryPanel().text()).not.toContain('显示凭据')
  })
})
