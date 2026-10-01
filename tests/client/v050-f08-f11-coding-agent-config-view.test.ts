// @vitest-environment jsdom
// hermes-v050:F-08 / F-11 CodingAgentConfigView:
// - F-08 whether the editor shows the raw text is decided by loading and by the reveal/hide
//   button only; typing JSON that is invalid for a moment must not turn it into the read-only
//   masked view.
// - F-11 a save still in flight when the user switches agent must not write the old agent's
//   text (credentials included) into the new agent's editor, and so into its config file.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import { mergeMessagesWithFallback } from '@/i18n/messages'

// Fake credentials only.
const CLAUDE_TOKEN = 'sk-test-claude-0123456789abcdefWXYZ'
const CLAUDE_SETTINGS = `{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "${CLAUDE_TOKEN}"
  },
  "model": "opus"
}
`
const PLAIN_SETTINGS = `{
  "model": "opus",
  "apiKeyHelper": "/usr/local/bin/key-helper"
}
`
const CODEX_CONFIG = 'model = "gpt-test"\napproval_policy = "on-request"\n'

const route = vi.hoisted(() => ({ value: null as any }))
const files = vi.hoisted(() => ({ store: new Map<string, string>() }))
const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/coding-agents', () => ({
  readCodingAgentConfigFile: readMock,
  writeCodingAgentConfigFile: writeMock,
}))

vi.mock('vue-router', () => ({
  useRoute: () => route.value,
}))

vi.mock('@/components/coding-agents/CodingAgentMcpPanel.vue', () => ({ default: defineComponent({ template: '<div />' }) }))
vi.mock('@/components/coding-agents/CodingAgentSkillsPanel.vue', () => ({ default: defineComponent({ template: '<div />' }) }))

vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    name: 'NButton',
    props: ['disabled', 'loading', 'type', 'size'],
    emits: ['click'],
    template: '<button type="button" class="n-button-stub" :disabled="disabled" :data-loading="loading ? \'1\' : null" @click="$emit(\'click\')"><slot /></button>',
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

const i18n = () => createI18n({ legacy: false, locale: 'zh', fallbackLocale: 'en', messages: { en, zh: mergeMessagesWithFallback(en, zh) } })

function file(agent: string, key: string, content: string) {
  return { key, path: `~/.${agent}/${key}`, absolutePath: '/x', language: 'json', content, exists: true, size: content.length, profile: 'default' }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  route.value = reactive({ params: { agentId: 'claude-code', section: 'settings' } })
  files.store = new Map([
    ['claude-code/memory', '# Notes\n'],
    ['claude-code/settings', CLAUDE_SETTINGS],
    ['codex/agents', '# Codex agents\n'],
    ['codex/config', CODEX_CONFIG],
  ])
  readMock.mockImplementation(async (agent: string, key: string) => file(agent, key, files.store.get(`${agent}/${key}`) || ''))
  writeMock.mockImplementation(async (agent: string, key: string, content: string) => {
    files.store.set(`${agent}/${key}`, content)
    return file(agent, key, content)
  })
})

async function mountView() {
  const wrapper = mount(CodingAgentConfigView, { global: { plugins: [i18n()] } })
  await flushPromises()
  const configuration = () => wrapper.findAll('.settings-editor-panel')[1]
  const editor = () => configuration().get('textarea')
  const button = (label: string) => configuration().findAll('button').find(item => item.text() === label)
  return { wrapper, configuration, editor, button }
}

const REVEAL = zh.codingAgents.revealSecrets
const HIDE = zh.codingAgents.hideSecrets
const SAVE = zh.files.saveFile

describe('hermes-v050:F-08 typing never flips the editor into the masked view', () => {
  it('a settings.json without credentials stays editable while a comma makes it invalid JSON', async () => {
    files.store.set('claude-code/settings', PLAIN_SETTINGS)
    const { editor } = await mountView()
    expect(editor().attributes('readonly')).toBeUndefined()

    const typed = PLAIN_SETTINGS.replace('"/usr/local/bin/key-helper"', '"/usr/local/bin/key-helper",')
    await editor().setValue(typed)

    expect(editor().attributes('readonly')).toBeUndefined()
    expect((editor().element as HTMLTextAreaElement).value).toBe(typed)
  })

  it('stays editable after the first character of a new credential value', async () => {
    files.store.set('claude-code/settings', '{\n  "env": { "ANTHROPIC_API_KEY": "" }\n}\n')
    const { editor, button } = await mountView()
    expect(editor().attributes('readonly')).toBeUndefined()

    // The value is typed between the quotes already there.
    const typed = '{\n  "env": { "ANTHROPIC_API_KEY": "s" }\n}\n'
    await editor().setValue(typed)
    expect(editor().attributes('readonly')).toBeUndefined()
    await editor().setValue(typed.replace('"s"', '"sk"'))
    expect(editor().attributes('readonly')).toBeUndefined()
    expect((editor().element as HTMLTextAreaElement).value).toBe(typed.replace('"s"', '"sk"'))
    // Hiding it is the user's call.
    await button(HIDE)!.trigger('click')
    expect(editor().attributes('readonly')).toBeDefined()
  })

  it('after revealing, temporarily invalid JSON keeps the raw editor; only the buttons and a reload mask again', async () => {
    const { editor, button } = await mountView()
    expect(editor().attributes('readonly')).toBeDefined()
    await button(REVEAL)!.trigger('click')

    for (const typed of [CLAUDE_SETTINGS.replace('"opus"', '"opus",'), CLAUDE_SETTINGS.replace('"model": "opus"', '"model": "op'), '{ "env": { "ANTHROPIC_AUTH_TOKEN": "sk-']) {
      await editor().setValue(typed)
      expect(editor().attributes('readonly')).toBeUndefined()
      expect((editor().element as HTMLTextAreaElement).value).toBe(typed)
    }

    await editor().setValue(CLAUDE_SETTINGS)
    await button(HIDE)!.trigger('click')
    expect(editor().attributes('readonly')).toBeDefined()
    await button(REVEAL)!.trigger('click')
    expect(editor().attributes('readonly')).toBeUndefined()

    // A reload (leaving and coming back) starts masked again.
    route.value.params.agentId = 'codex'
    await flushPromises()
    route.value.params.agentId = 'claude-code'
    await flushPromises()
    expect(editor().attributes('readonly')).toBeDefined()
    expect((editor().element as HTMLTextAreaElement).value).not.toContain(CLAUDE_TOKEN)
  })
})

describe('hermes-v050:F-11 save in flight while switching agent', () => {
  it('never writes the Claude settings (and its token) into the Codex editor or config.toml', async () => {
    const { editor, button } = await mountView()
    await button(REVEAL)!.trigger('click')
    const edited = CLAUDE_SETTINGS.replace('"opus"', '"sonnet"')
    await editor().setValue(edited)
    const pending = deferred<ReturnType<typeof file>>()
    writeMock.mockImplementationOnce((agent: string, key: string, content: string) => pending.promise.then((result) => {
      files.store.set(`${agent}/${key}`, content)
      return result
    }))
    await button(SAVE)!.trigger('click')

    route.value.params.agentId = 'codex'
    await flushPromises()
    pending.resolve(file('claude-code', 'settings', edited))
    await flushPromises()

    expect((editor().element as HTMLTextAreaElement).value).toBe(CODEX_CONFIG)
    expect(editor().attributes('readonly')).toBeUndefined()
    expect(button(SAVE)!.attributes('data-loading')).toBeUndefined()

    await editor().setValue(`${CODEX_CONFIG}sandbox_mode = "workspace-write"\n`)
    await button(SAVE)!.trigger('click')
    await flushPromises()

    expect(writeMock).toHaveBeenLastCalledWith('codex', 'config', `${CODEX_CONFIG}sandbox_mode = "workspace-write"\n`)
    expect(files.store.get('codex/config')).not.toContain(CLAUDE_TOKEN)
    // The Claude save itself went through with the Claude text.
    expect(files.store.get('claude-code/settings')).toBe(edited)
  })

  it('coming back while that save is still running shows what it wrote, not the text from before', async () => {
    const { editor, button } = await mountView()
    await button(REVEAL)!.trigger('click')
    const edited = CLAUDE_SETTINGS.replace('"opus"', '"sonnet"')
    await editor().setValue(edited)
    const pending = deferred<void>()
    writeMock.mockImplementationOnce(async (agent: string, key: string, content: string) => {
      await pending.promise
      files.store.set(`${agent}/${key}`, content)
      return file(agent, key, content)
    })
    await button(SAVE)!.trigger('click')

    route.value.params.agentId = 'codex'
    await flushPromises()
    route.value.params.agentId = 'claude-code'
    await flushPromises()
    pending.resolve()
    await flushPromises()

    await button(REVEAL)!.trigger('click')
    expect((editor().element as HTMLTextAreaElement).value).toBe(edited)
    expect(button(SAVE)!.attributes('disabled')).toBeDefined()
  })

  it('keeps what the user typed while the save was in flight', async () => {
    files.store.set('claude-code/settings', PLAIN_SETTINGS)
    const { editor, button } = await mountView()
    const first = PLAIN_SETTINGS.replace('"opus"', '"sonnet"')
    await editor().setValue(first)
    const pending = deferred<void>()
    writeMock.mockImplementationOnce(async (agent: string, key: string, content: string) => {
      await pending.promise
      files.store.set(`${agent}/${key}`, content)
      return file(agent, key, content)
    })
    await button(SAVE)!.trigger('click')
    const second = first.replace('"sonnet"', '"haiku"')
    await editor().setValue(second)
    pending.resolve()
    await flushPromises()

    expect((editor().element as HTMLTextAreaElement).value).toBe(second)
    expect(button(SAVE)!.attributes('disabled')).toBeUndefined()
  })
})
