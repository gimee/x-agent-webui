// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

const openSessionSearchMock = vi.hoisted(() => vi.fn());
const mockAppStore = vi.hoisted(() => ({
  sidebarOpen: true,
  sidebarCollapsed: false,
  connected: true,
  serverVersion: "test",
  latestVersion: "",
  isDocker: false,
  updateAvailable: false,
  clientOutdated: false,
  updating: false,
  toggleSidebar: vi.fn(),
  toggleSidebarCollapsed: vi.fn(),
  closeSidebar: vi.fn(),
  doUpdate: vi.fn(),
  reloadClient: vi.fn(),
}));

vi.mock("@/composables/useSessionSearch", () => ({
  useSessionSearch: () => ({
    openSessionSearch: openSessionSearchMock,
  }),
}));

vi.mock("@/stores/hermes/app", () => ({
  useAppStore: () => mockAppStore,
}));

vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useRoute: () => ({ name: "hermes.chat" }),
    useRouter: () => ({ push: vi.fn(), hasRoute: () => true }),
  };
});

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
  createI18n: () => ({
    global: { locale: { value: "en" }, setLocaleMessage: vi.fn() },
  }),
}));

vi.mock("@/composables/useTheme", () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock("/logo.png", () => ({
  default: "logo.png",
}));

vi.mock("@/components/layout/ProfileSelector.vue", () => ({
  default: { name: "ProfileSelector", template: "<div />" },
}));

vi.mock("@/components/layout/ModelSelector.vue", () => ({
  default: { name: "ModelSelector", template: "<div />" },
}));

vi.mock("@/components/layout/LanguageSwitch.vue", () => ({
  default: { name: "LanguageSwitch", template: "<div />" },
}));

vi.mock("@/components/layout/ThemeSwitch.vue", () => ({
  default: { name: "ThemeSwitch", template: "<div />" },
}));

vi.mock("@/components/common/RouteLinkItem.vue", () => ({
  default: {
    name: "RouteLinkItem",
    props: ["to", "active"],
    template:
      '<a class="route-link-item" :class="{ active }" href="#"><slot /></a>',
  },
}));

vi.mock("naive-ui", async () => {
  const actual = await vi.importActual<any>("naive-ui");
  return {
    ...actual,
    useMessage: () => ({
      success: vi.fn(),
      error: vi.fn(),
    }),
    NButton: {
      template: '<button v-bind="$attrs"><slot /></button>',
    },
    NModal: {
      props: ["show"],
      template: '<div v-if="show" class="n-modal-stub"><slot /></div>',
    },
    NSelect: {
      template: "<div />",
    },
  };
});

import AppSidebar from "@/components/layout/AppSidebar.vue";

function fakeJwt(payload: Record<string, unknown>) {
  return `header.${btoa(JSON.stringify(payload)).replace(/=/g, "")}.signature`;
}

describe("AppSidebar navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as typeof window & { hermesDesktop?: unknown })
      .hermesDesktop;
    openSessionSearchMock.mockClear();
    mockAppStore.serverVersion = "test";
    mockAppStore.latestVersion = "";
    mockAppStore.isDocker = false;
    mockAppStore.updateAvailable = false;
    mockAppStore.clientOutdated = false;
    mockAppStore.updating = false;
    mockAppStore.sidebarCollapsed = false;
    mockAppStore.reloadClient.mockClear();
    mockAppStore.doUpdate.mockReset();
    mockAppStore.doUpdate.mockResolvedValue(false);
  });

  it("keeps page-sidebar-only actions out of the app sidebar", () => {
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    });

    expect(wrapper.text()).not.toContain("sidebar.search");
    expect(wrapper.text()).not.toContain("sidebar.reloadClientVersion");
    expect(wrapper.find(".sidebar-return-tab").exists()).toBe(true);
  });

  it("does not show the legacy version management entry in the desktop shell", () => {
    (window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = {
      isDesktop: true,
    };
    const desktopWrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
        },
      },
    });

    expect(desktopWrapper.find(".version-management-btn").exists()).toBe(false);
    expect(desktopWrapper.find(".version-management-modal-stub").exists()).toBe(false);
  });

  it("keeps navigation flat when the sidebar is collapsed", () => {
    mockAppStore.sidebarCollapsed = true;
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    });

    expect(wrapper.classes()).toContain("collapsed");
    expect(wrapper.findAll(".nav-group-label")).toHaveLength(0);
    expect(
      wrapper.findAll(".sidebar-nav > .route-link-item").length,
    ).toBeGreaterThan(0);
  });

  it("removes the Hermes entry while hiding Hermes-only tools and device management", () => {
    localStorage.setItem(
      "hermes_api_key",
      fakeJwt({ sub: "2", role: "admin" }),
    );
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    });

    const navigationLabels = wrapper
      .findAllComponents({ name: "RouteLinkItem" })
      .map((item) => item.text().trim());

    expect(navigationLabels).not.toContain("Hermes");
    expect(navigationLabels).not.toContain("sidebar.mcp");
    expect(navigationLabels).not.toContain("sidebar.skills");
    expect(navigationLabels).not.toContain("sidebar.journey");
    expect(wrapper.text()).toContain("sidebar.theme");
    expect(wrapper.text()).not.toContain("sidebar.devices");
  });

  it("shows the local product version without Web UI update controls", async () => {
    mockAppStore.serverVersion = "0.1.1";
    mockAppStore.updateAvailable = true;
    mockAppStore.clientOutdated = true;
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
        },
      },
    });

    expect(wrapper.text()).toContain("X-Agent v0.1.1");
    const links = wrapper.findAll('.version-links > a.sidebar-footer-link');
    expect(links.map((link) => link.attributes('href'))).toEqual([
      'https://github.com/gimee/x-agent-webui',
      'https://x-agent.io/',
    ]);
    for (const link of links) {
      expect(link.attributes('target')).toBe('_blank');
      expect(link.attributes('rel')).toBe('noopener noreferrer');
      expect(link.find('svg').attributes('width')).toBe('14');
    }
    expect(wrapper.get('.version-info').element.firstElementChild?.className).toBe('version-links');
    expect(wrapper.find(".update-btn").exists()).toBe(false);

    await wrapper.get(".version-text").trigger("click");

    // Changelog entries are i18n keys (raw keys under the test i18n stub).
    expect(wrapper.text()).toContain("changelog.product_0_1_1_1")
    expect(wrapper.text()).toContain("v0.1.12026-09-11")
    expect(wrapper.text()).not.toContain("sidebar.updateVersion")
    expect(mockAppStore.doUpdate).not.toHaveBeenCalled();
  });

});
