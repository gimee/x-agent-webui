// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({
    profileModelGroups: [],
  }),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({ profiles: [] }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NPopconfirm: defineComponent({
    name: 'NPopconfirm',
    emits: ['positive-click'],
    template: '<span><slot name="trigger" /><slot /></span>',
  }),
  NCheckbox: defineComponent({
    name: 'NCheckbox',
    props: ['checked'],
    emits: ['click'],
    template: '<input type="checkbox" :checked="checked" @click="$emit(\'click\')" />',
  }),
  NTooltip: defineComponent({
    name: 'NTooltip',
    template: '<span><slot name="trigger" /><slot /></span>',
  }),
}))

const session = {
  id: 's1',
  title: 'Session One',
  model: 'gpt-test',
  provider: 'openai',
  createdAt: Date.now(),
  profile: 'kira',
}

describe('SessionListItem', () => {
  it('keeps the full title and puts the fixed timestamp beside the unchanged agent', () => {
    const title = 'A long title remains intact in the DOM instead of being sliced by character count'
    const wrapper = mount(SessionListItem, {
      props: { session: { ...session, title, createdAt: new Date(2026, 8, 3, 13, 55).getTime() }, active: true, canDelete: true, streaming: true, completedUnread: true },
    })
    expect(wrapper.get('.session-item-title').text()).toBe(title)
    expect(wrapper.find('.session-item-profile').exists()).toBe(false)
    expect(wrapper.find('.session-item-title-row .session-item-time').exists()).toBe(false)
    expect(wrapper.get('.session-item-agent-row .session-item-time').text()).toBe('09-03 13:55')
    expect(wrapper.get('.session-item-agent-logo').attributes('alt')).toBe('Hermes')
    expect(wrapper.get('.session-item-agent-logo-wrap').classes()).toContain('streaming')
    expect(wrapper.find('.session-item-unread-dot').exists()).toBe(true)
    wrapper.unmount()
  })

  it('renders normal mode as a link to the session route', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        starred: false,
        canDelete: true,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const link = wrapper.get('a.session-item')
    expect(link.attributes('href')).toBe('/session/s1')
    expect(wrapper.find('button.session-item').exists()).toBe(false)
  })

  it('toggles an outline star without navigating, and renders yellow fill when starred', async () => {
    const wrapper = mount(SessionListItem, {
      props: { session, active: false, starred: false, canDelete: true, to: '/session/s1' },
      global: { stubs: { ProfileAvatar: true } },
    })
    const star = wrapper.get('.session-item-star')
    const x = wrapper.get('.session-item-delete svg')
    expect(star.get('svg').attributes('width')).toBe(x.attributes('width'))
    expect(star.get('svg').attributes('height')).toBe(x.attributes('height'))
    expect(star.get('svg').attributes('fill')).toBe('none')
    expect(star.attributes('aria-pressed')).toBe('false')
    await star.trigger('click')
    expect(wrapper.emitted('toggle-star')).toHaveLength(1)
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(wrapper.emitted('delete')).toBeUndefined()
    await star.trigger('contextmenu')
    expect(wrapper.emitted('contextmenu')).toBeUndefined()
    await wrapper.setProps({ starred: true })
    expect(star.get('svg').attributes('fill')).toBe('currentColor')
    expect(star.classes()).toContain('starred')
    expect(star.attributes('aria-pressed')).toBe('true')
    await star.trigger('click')
    expect(wrapper.emitted('toggle-star')).toHaveLength(2)
    wrapper.unmount()
  })

  it('does not select the row when clicking nested action controls', async () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        starred: false,
        canDelete: true,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    await wrapper.get('button.session-item-delete').trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('does not hijack modified clicks on normal links', async () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session,
        active: false,
        starred: false,
        canDelete: true,
        to: '/session/s1',
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const link = wrapper.get('a.session-item')
    link.element.addEventListener('click', event => event.preventDefault())
    await link.trigger('click', { ctrlKey: true })
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(wrapper.emitted('open-new')).toBeUndefined()
  })

  it('renders the Hermes logo for Hermes sessions', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: 'cli', agent: 'hermes' },
        active: false,
        starred: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/hermes.png')
    expect(logo.attributes('alt')).toBe('Hermes')
    expect(wrapper.find('.session-item-agent-name').exists()).toBe(false)
  })

  it('renders the Hermes logo for Hermes Global Agent sessions', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: 'global_agent', agent: 'hermes' },
        active: false,
        starred: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/hermes.png')
    expect(logo.attributes('alt')).toBe('Hermes')
  })

  it('defaults old sessions without agent metadata to the Hermes logo', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: undefined, agent: undefined, codingAgentId: undefined },
        active: false,
        starred: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/hermes.png')
    expect(logo.attributes('alt')).toBe('Hermes')
    expect(wrapper.find('.session-item-agent-name').exists()).toBe(false)
  })

  it('renders the Claude logo for Claude coding agent sessions', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: 'coding_agent', agent: 'claude', codingAgentId: 'claude-code' },
        active: false,
        starred: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/claude-code.svg')
    expect(logo.attributes('alt')).toBe('Claude')
    expect(wrapper.find('.session-item-agent-name').exists()).toBe(false)
  })

  it('renders the Codex logo for Codex coding agent sessions', () => {
    const wrapper = mount(SessionListItem, {
      props: {
        session: { ...session, source: 'coding_agent', agent: 'codex', codingAgentId: 'codex' },
        active: false,
        starred: false,
        canDelete: true,
      },
      global: {
        stubs: {
          ProfileAvatar: true,
        },
      },
    })

    const logo = wrapper.get('.session-item-agent-logo')
    expect(logo.attributes('src')).toBe('/coding-agents/codex-openai.png')
    expect(logo.attributes('alt')).toBe('Codex')
    expect(wrapper.find('.session-item-agent-name').exists()).toBe(false)
  })
})
