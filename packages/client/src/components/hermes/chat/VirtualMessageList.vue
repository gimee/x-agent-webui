<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, unref, watch } from "vue";
import {
  DynamicScroller,
  DynamicScrollerItem,
  type DynamicScrollerExposed,
  type ScrollToOptions,
} from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import type { MessageViewportScrollSnapshot } from "./message-scroll-position";

type VirtualItem = {
  id: string | number;
}

type AnchorAlign = "start" | "center";
type AnchorTarget = {
  token: number;
  index: number;
  messageId: string;
  anchorId: string;
  align: AnchorAlign;
}
type BottomScrollOptions = number | {
  frames?: number;
  keepAliveMs?: number;
}
const props = withDefaults(defineProps<{
  messages: VirtualItem[];
  virtualized?: boolean;
  estimatedItemHeight?: number;
  overscan?: number;
  rowGap?: number;
  padding?: string;
  topThreshold?: number;
}>(), {
  virtualized: true,
  estimatedItemHeight: 180,
  overscan: 8,
  rowGap: 16,
  padding: "20px",
  topThreshold: 120,
});

const emit = defineEmits<{
  scroll: [];
  topReach: [];
}>();

defineSlots<{
  empty?: () => any;
  before?: () => any;
  item?: (props: { message: any }) => any;
  after?: () => any;
}>();

const hostRef = ref<HTMLElement | null>(null);
const contentRef = ref<HTMLElement | null>(null);
const scrollerRef = ref<DynamicScrollerExposed<VirtualItem> | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
let keepBottomUntil = 0;
let bottomFrame: number | null = null;
let bottomFrameRemaining = 0;
let bottomFrameAttempts = 0;
let programmaticScrollUntil = 0;
let userDetachedFromBottom = false;
let anchorFrame: number | null = null;
let anchorToken = 0;
let activeAnchorTarget: AnchorTarget | null = null;
let viewportRestoreFrame: number | null = null;
let prependAnchorState: { messageId: string; viewportOffset: number } | null = null;
let prependAnchorFrame: number | null = null;
let armedPrependAnchor: { accept?: (messageId: string) => boolean } | null = null;
const prependAnchorActive = ref(false);

const messageKeys = computed(() => props.messages.map(messageKey));
const bufferPx = computed(() => Math.max(props.estimatedItemHeight, props.estimatedItemHeight * props.overscan));

function messageKey(message: VirtualItem): string {
  return String(message.id);
}

function getScrollerElement(): HTMLElement | null {
  return hostRef.value?.querySelector<HTMLElement>(".virtual-message-list") ?? null;
}

function syncViewport() {
  const el = getScrollerElement();
  if (!el) return;
  scrollTop.value = el.scrollTop;
  viewportHeight.value = el.clientHeight;
}

function markProgrammaticScroll(ms = 120) {
  programmaticScrollUntil = Date.now() + ms;
}

function isProgrammaticScroll(): boolean {
  return Date.now() < programmaticScrollUntil;
}

function cancelBottomScroll() {
  keepBottomUntil = 0;
  if (bottomFrame != null) {
    cancelAnimationFrame(bottomFrame);
    bottomFrame = null;
  }
  bottomFrameRemaining = 0;
  bottomFrameAttempts = 0;
}

function handleScroll() {
  const previousScrollTop = scrollTop.value;
  syncViewport();
  const delta = scrollTop.value - previousScrollTop;
  if (delta < -1) {
    userDetachedFromBottom = true;
    cancelBottomScroll();
  } else if (!isProgrammaticScroll()) {
    if (isNearBottom(32)) {
      userDetachedFromBottom = false;
    }
    if (userDetachedFromBottom || !isNearBottom(96)) {
      cancelBottomScroll();
    }
  }
  emit("scroll");
  if (scrollTop.value <= props.topThreshold) emit("topReach");
}

function handleWheel(event: WheelEvent) {
  // hermes-v050:E-09 用户自己滚了：补页后的锚点对齐让给用户
  if (prependAnchorState) stopPrependAnchor();
  if (event.deltaY < -1) {
    userDetachedFromBottom = true;
    cancelBottomScroll();
  }
}

function handleResize() {
  syncViewport();
  if (!userDetachedFromBottom || Date.now() < keepBottomUntil || isNearBottom(64)) {
    scheduleScrollToBottom(2);
  }
  if (activeAnchorTarget) scheduleAnchorAlignment(activeAnchorTarget.token, 4);
  // hermes-v050:E-09 新行量出真实高度时（ResizeObserver）立刻把锚点行补偿回去
  if (prependAnchorState) stepPrependAnchor();
}

function isNearBottom(threshold = 200): boolean {
  const el = getScrollerElement();
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

function shouldAutoFollowBottom(threshold = 200): boolean {
  return !userDetachedFromBottom && isNearBottom(threshold);
}

function scrollToBottom(options: BottomScrollOptions = {}) {
  const frames = typeof options === "number" ? options : options.frames ?? 2;
  const keepAliveMs = typeof options === "number" ? 400 : options.keepAliveMs ?? 400;
  userDetachedFromBottom = false;
  keepBottomUntil = Date.now() + keepAliveMs;
  nextTick(() => {
    scheduleScrollToBottom(frames);
  });
}

function setScrollToBottomNow(): boolean {
  const el = getScrollerElement();
  markProgrammaticScroll();
  if (props.virtualized) scrollerRef.value?.scrollToBottom();
  if (el) {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    syncViewport();
    return true;
  }
  return false;
}

function scheduleScrollToBottom(frames = 1) {
  bottomFrameRemaining = Math.max(bottomFrameRemaining, frames);
  if (bottomFrame != null) return;

  const step = () => {
    const scrolled = setScrollToBottomNow();
    if (scrolled) {
      bottomFrameAttempts = 0;
      bottomFrameRemaining -= 1;
    } else {
      bottomFrameAttempts += 1;
    }
    if (bottomFrameRemaining <= 0) {
      bottomFrame = null;
      bottomFrameRemaining = 0;
      bottomFrameAttempts = 0;
      return;
    }
    if (bottomFrameAttempts > 30) {
      bottomFrame = null;
      bottomFrameRemaining = 0;
      bottomFrameAttempts = 0;
      return;
    }
    bottomFrame = requestAnimationFrame(step);
  };

  bottomFrame = requestAnimationFrame(step);
}

function findTargetElement(messageId: string, anchorId: string): HTMLElement | null {
  const el = getScrollerElement();
  if (!el) return null;

  const anchor = document.getElementById(anchorId);
  if (anchor instanceof HTMLElement && el.contains(anchor)) return anchor;

  const message = document.getElementById(`message-${messageId}`);
  if (message instanceof HTMLElement && el.contains(message)) return message;

  return null;
}

function alignElement(targetEl: HTMLElement, align: AnchorAlign) {
  const el = getScrollerElement();
  if (!el) return;

  const scrollerRect = el.getBoundingClientRect();
  const targetRect = targetEl.getBoundingClientRect();
  const delta = align === "center"
    ? targetRect.top + targetRect.height / 2 - (scrollerRect.top + scrollerRect.height / 2)
    : targetRect.top - scrollerRect.top - 24;

  if (Math.abs(delta) > 1) {
    markProgrammaticScroll();
    el.scrollTop = Math.max(0, el.scrollTop + delta);
  }
  syncViewport();
}

function findRowElement(index: number): HTMLElement | null {
  const el = getScrollerElement();
  return el?.querySelector<HTMLElement>(`.virtual-row[data-virtual-index="${index}"]`) ?? null;
}

function scrollToItem(index: number, options?: ScrollToOptions) {
  markProgrammaticScroll();
  if (props.virtualized) {
    scrollerRef.value?.scrollToItem(index, options);
    syncViewport();
    return;
  }

  const el = getScrollerElement();
  const row = findRowElement(index);
  if (!el || !row) {
    syncViewport();
    return;
  }

  const rowRect = row.getBoundingClientRect();
  const scrollerRect = el.getBoundingClientRect();
  const align = options?.align ?? "start";
  const offset = options?.offset ?? 0;
  const delta = align === "center"
    ? rowRect.top + rowRect.height / 2 - (scrollerRect.top + scrollerRect.height / 2)
    : rowRect.top - scrollerRect.top + offset;

  el.scrollTop = Math.max(0, el.scrollTop + delta);
  syncViewport();
}

function scheduleAnchorAlignment(token: number, frames = 1) {
  if (anchorFrame != null) cancelAnimationFrame(anchorFrame);

  const step = (remaining: number) => {
    const target = activeAnchorTarget;
    if (!target || target.token !== token) {
      anchorFrame = null;
      return;
    }

    const targetEl = findTargetElement(target.messageId, target.anchorId);
    if (targetEl) {
      alignElement(targetEl, target.align);
    } else {
      scrollToItem(target.index, {
        align: target.align,
        offset: target.align === "start" ? -24 : 0,
      });
    }

    if (remaining <= 1) {
      anchorFrame = null;
      activeAnchorTarget = null;
      return;
    }
    anchorFrame = requestAnimationFrame(() => step(remaining - 1));
  };

  anchorFrame = requestAnimationFrame(() => step(frames));
}

function cancelAnchorAlignment() {
  anchorToken += 1;
  activeAnchorTarget = null;
  if (anchorFrame != null) {
    cancelAnimationFrame(anchorFrame);
    anchorFrame = null;
  }
}

function scrollToMessage(messageId: string) {
  const index = props.messages.findIndex(message => String(message.id) === messageId);
  if (index < 0) return;

  cancelAnchorAlignment();
  const token = anchorToken;
  activeAnchorTarget = {
    token,
    index,
    messageId,
    anchorId: `message-${messageId}`,
    align: "center",
  };

  nextTick(() => {
    scrollToItem(index, { align: "center" });
    scheduleAnchorAlignment(token, 8);
  });
}

function scrollToAnchor(messageId: string, anchorId: string) {
  const index = props.messages.findIndex(message => String(message.id) === messageId);
  if (index < 0) return;

  cancelAnchorAlignment();
  const token = anchorToken;
  activeAnchorTarget = {
    token,
    index,
    messageId,
    anchorId,
    align: "start",
  };

  nextTick(() => {
    scrollToItem(index, { align: "start", offset: -24 });
    scheduleAnchorAlignment(token, 10);
  });
}

function captureScrollPosition() {
  const el = getScrollerElement();
  if (!el) return null;
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
  };
}

function restoreScrollPosition(snapshot: { scrollTop: number; scrollHeight: number } | null) {
  if (!snapshot) return;
  nextTick(() => {
    const el = getScrollerElement();
    if (!el) return;
    const nextScrollTop = Math.max(0, el.scrollHeight - snapshot.scrollHeight + snapshot.scrollTop);
    markProgrammaticScroll();
    if (props.virtualized) scrollerRef.value?.scrollToPosition(nextScrollTop);
    el.scrollTop = nextScrollTop;
    syncViewport();
  });
}

// hermes-v050:C12 flow-mode 与非虚拟模式下行按 DOM 顺序纵向排列：二分定位第一条底边越过视口顶的行，
// 往下命中第一条带 id 的可见行即停（原来每行一次 getBoundingClientRect，大会话卸载时 146ms）。
// 回收池里停放的视图（display:none）带 data-virtual-inactive，不参与。
// hermes-v050:E-09 accept 过滤掉不适合作锚点的行（例如补页时会挪位的工具卡片）；视口里都不合适时退回第一条。
function findViewportAnchor(
  el: HTMLElement,
  accept?: (messageId: string) => boolean,
): { messageId: string; offset: number } | null {
  const scrollerRect = el.getBoundingClientRect();
  const viewportBottom = scrollerRect.bottom || scrollerRect.top + el.clientHeight;
  const rows = el.querySelectorAll<HTMLElement>(".virtual-row[data-virtual-index]:not([data-virtual-inactive])");

  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle].getBoundingClientRect().bottom <= scrollerRect.top) low = middle + 1;
    else high = middle;
  }

  let fallback: { messageId: string; offset: number } | null = null;
  for (let position = low; position < rows.length; position += 1) {
    const row = rows[position];
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top >= viewportBottom) break;
    if (rowRect.bottom <= scrollerRect.top) continue;
    const index = Number(row.dataset.virtualIndex);
    const message = Number.isInteger(index) ? props.messages[index] : null;
    const messageId = row.dataset.messageId || (message ? messageKey(message) : "");
    if (!messageId) continue;
    const anchor = { messageId, offset: rowRect.top - scrollerRect.top };
    if (!accept || accept(messageId)) return anchor;
    fallback ??= anchor;
  }

  return fallback;
}

function captureViewportPosition(): MessageViewportScrollSnapshot | null {
  const el = getScrollerElement();
  if (!el) return null;
  const anchor = findViewportAnchor(el);
  return {
    anchorMessageId: anchor?.messageId || null,
    anchorOffset: anchor?.offset || 0,
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    wasNearBottom: isNearBottom(64),
  };
}

function restoreViewportPosition(snapshot: MessageViewportScrollSnapshot | null, frames = 4): boolean {
  if (!snapshot) return false;
  if (viewportRestoreFrame != null) {
    cancelAnimationFrame(viewportRestoreFrame);
    viewportRestoreFrame = null;
  }
  const anchorMessageId = snapshot.anchorMessageId;
  const initialIndex = anchorMessageId
    ? props.messages.findIndex(message => messageKey(message) === anchorMessageId)
    : -1;
  if (!anchorMessageId || initialIndex < 0) {
    scrollToBottom();
    return false;
  }

  cancelBottomScroll();
  cancelAnchorAlignment();
  userDetachedFromBottom = !snapshot.wasNearBottom;
  const anchorOffset = Number.isFinite(snapshot.anchorOffset) ? snapshot.anchorOffset : 0;

  nextTick(() => {
    let remaining = frames;
    const step = () => {
      const el = getScrollerElement();
      if (!el) {
        viewportRestoreFrame = null;
        return;
      }
      const index = props.messages.findIndex(message => messageKey(message) === anchorMessageId);
      if (index < 0) {
        viewportRestoreFrame = null;
        scrollToBottom();
        return;
      }

      const row = findRowElement(index);
      if (row) {
        const scrollerRect = el.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        const delta = rowRect.top - scrollerRect.top - anchorOffset;
        const nextScrollTop = Math.min(maxScrollTop, Math.max(0, el.scrollTop + delta));
        markProgrammaticScroll();
        if (props.virtualized) scrollerRef.value?.scrollToPosition(nextScrollTop);
        el.scrollTop = nextScrollTop;
        syncViewport();
      } else {
        scrollToItem(index, { align: "start", offset: -anchorOffset });
      }

      remaining -= 1;
      if (remaining <= 0) {
        viewportRestoreFrame = null;
        return;
      }
      viewportRestoreFrame = requestAnimationFrame(step);
    };
    viewportRestoreFrame = requestAnimationFrame(step);
  });

  return true;
}

// hermes-v050:E-09 在列表顶部补进更早的行时保持视口。调用方发请求前 armPrependAnchor()：行集合变化的那一刻
// （pre-flush，DOM 还是补页前的样子）记下视口里第一条行和它的视口位置——请求期间用户的滚动、上面行的高度变化
// 都已算在内；DOM 更新后把这条行对回那个位置。虚拟列表里新行先按估计高度排、量出真实高度后又变，DynamicScroller
// 每次尺寸更新还会按它自己的尺寸表改一次 scrollTop（与 DOM 可能差一行的高度差），所以之后每帧（以及 ResizeObserver
// 回调里）按 DOM 重新对齐，连续 4 帧无误差才停，最多 30 帧（约 0.5s）；用户一滚轮就停手，不和用户抢滚动。
function armPrependAnchor(accept?: (messageId: string) => boolean) {
  armedPrependAnchor = { accept };
}

function disarmPrependAnchor() {
  armedPrependAnchor = null;
}

function findRenderedRow(el: HTMLElement, messageId: string): HTMLElement | null {
  for (const row of el.querySelectorAll<HTMLElement>(".virtual-row[data-message-id]:not([data-virtual-inactive])")) {
    if (row.dataset.messageId === messageId) return row;
  }
  return null;
}

function stopPrependAnchor() {
  prependAnchorState = null;
  prependAnchorActive.value = false;
  if (prependAnchorFrame != null) {
    cancelAnimationFrame(prependAnchorFrame);
    prependAnchorFrame = null;
  }
}

// 返回这一步是否已对齐（锚点行已渲染且误差 <0.5px）
function stepPrependAnchor(): boolean {
  const state = prependAnchorState;
  const el = getScrollerElement();
  if (!state || !el) return false;
  const row = findRenderedRow(el, state.messageId);
  if (!row) {
    // 虚拟列表按原 scrollTop 渲染的是新补进来的行：先按序号把锚点行滚进来，下一帧再按真实位置对齐
    const index = props.messages.findIndex(message => messageKey(message) === state.messageId);
    if (index < 0) {
      stopPrependAnchor();
      return false;
    }
    scrollToItem(index, { align: "start", offset: -state.viewportOffset });
    return false;
  }
  const delta = row.getBoundingClientRect().top - el.getBoundingClientRect().top - state.viewportOffset;
  if (Math.abs(delta) < 0.5) return true;
  const nextScrollTop = Math.max(0, el.scrollTop + delta);
  markProgrammaticScroll();
  if (props.virtualized) scrollerRef.value?.scrollToPosition(nextScrollTop);
  el.scrollTop = nextScrollTop;
  syncViewport();
  return false;
}

function keepPrependAnchor(anchor: { messageId: string; offset: number }, frames = 30) {
  stopPrependAnchor();
  if (!getScrollerElement()) return;
  cancelBottomScroll();
  cancelAnchorAlignment();
  prependAnchorState = { messageId: anchor.messageId, viewportOffset: anchor.offset };
  prependAnchorActive.value = true;
  stepPrependAnchor();
  let elapsed = 0;
  let stableFrames = 0;
  const tick = () => {
    prependAnchorFrame = null;
    if (!prependAnchorState) return;
    stableFrames = stepPrependAnchor() ? stableFrames + 1 : 0;
    elapsed += 1;
    if (!prependAnchorState || elapsed >= frames || stableFrames >= 4) {
      stopPrependAnchor();
      return;
    }
    prependAnchorFrame = requestAnimationFrame(tick);
  };
  prependAnchorFrame = requestAnimationFrame(tick);
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  nextTick(() => {
    syncViewport();
    const el = getScrollerElement();
    if (el && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(el);
      const content = contentRef.value
        ?? el.querySelector<HTMLElement>(".vue-recycle-scroller__item-wrapper");
      if (content) resizeObserver.observe(content);
    }
  });
});

onBeforeUnmount(() => {
  cancelBottomScroll();
  if (anchorFrame != null) cancelAnimationFrame(anchorFrame);
  if (viewportRestoreFrame != null) cancelAnimationFrame(viewportRestoreFrame);
  stopPrependAnchor(); // hermes-v050:E-09
  resizeObserver?.disconnect();
});

// hermes-v050:C3 流式时 messages 每帧都是新数组（内容变、id 不变），按 id 串比较，
// 只有消息集合真的变化才取消锚点对齐并在 DOM 更新后重读视口，避免每个 delta 一次强制布局。
const messageKeySignature = computed(() => messageKeys.value.join("\u0000"));

watch(messageKeySignature, () => {
  cancelAnchorAlignment();
  nextTick(syncViewport);
});

// hermes-v050:E-09 保持锚点期间 DynamicScroller 每次更新行尺寸，都会在它自己的 post-flush 里按尺寸表改一次
// scrollTop；换渲染窗口时上方占位也按尺寸表重算（与 DOM 可能差一行的高度差）。nextTick 排在这些之后、绘制之前，
// 当帧按 DOM 对回去，不留一帧错位。只在保持期间跟踪尺寸表和上方占位。
watch(
  () => (prependAnchorActive.value
    ? [unref(scrollerRef.value?.cacheSnapshot), unref(scrollerRef.value?.startSpacerSize)]
    : null),
  () => {
    if (prependAnchorState) void nextTick(stepPrependAnchor);
  },
  { flush: "post" },
);

// hermes-v050:E-09 补页的那次行集合变化：此时 DOM 还没更新，记下锚点；更新完再开始保持
watch(messageKeySignature, () => {
  const armed = armedPrependAnchor;
  const el = getScrollerElement();
  if (!armed || !el) return;
  armedPrependAnchor = null;
  const anchor = findViewportAnchor(el, armed.accept);
  if (anchor) nextTick(() => keepPrependAnchor(anchor));
});

defineExpose({
  isNearBottom,
  shouldAutoFollowBottom,
  scrollToBottom,
  scrollToMessage,
  scrollToAnchor,
  captureScrollPosition,
  restoreScrollPosition,
  captureViewportPosition,
  restoreViewportPosition,
  armPrependAnchor, // hermes-v050:E-09
  disarmPrependAnchor,
});
</script>

<template>
  <div
    ref="hostRef"
    class="virtual-message-list-host"
    :style="{ '--virtual-row-gap': `${rowGap}px`, '--virtual-list-padding': padding }"
  >
    <DynamicScroller
      v-if="virtualized"
      ref="scrollerRef"
      class="virtual-message-list"
      :items="messages"
      key-field="id"
      :min-item-size="estimatedItemHeight"
      :buffer="bufferPx"
      :flow-mode="true"
      :prerender="overscan"
      @scroll.passive="handleScroll"
      @wheel.passive="handleWheel"
      @resize="handleResize"
      @visible="syncViewport"
    >
      <template #before>
        <slot v-if="messages.length > 0" name="before" />
      </template>
      <template #default="{ item, index, active }">
        <DynamicScrollerItem
          :item="item"
          :index="index"
          :active="active"
          class="virtual-row"
          :data-virtual-index="index"
          :data-message-id="messageKey(item)"
          :data-virtual-inactive="active ? undefined : ''"
        >
          <slot v-if="active" name="item" :message="item" />
        </DynamicScrollerItem>
      </template>
      <template #after>
        <slot v-if="messages.length > 0" name="after" />
      </template>
    </DynamicScroller>
    <div
      v-else
      class="virtual-message-list"
      @scroll.passive="handleScroll"
      @wheel.passive="handleWheel"
    >
      <div ref="contentRef" class="virtual-message-list-content">
        <slot v-if="messages.length > 0" name="before" />
        <div
          v-for="(item, index) in messages"
          :key="messageKey(item)"
          class="virtual-row"
          :data-virtual-index="index"
          :data-message-id="messageKey(item)"
        >
          <slot name="item" :message="item" />
        </div>
        <slot v-if="messages.length > 0" name="after" />
      </div>
    </div>
    <div v-if="messages.length === 0 && $slots.empty" class="virtual-message-list-empty">
      <slot name="empty" />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.virtual-message-list-host {
  flex: 1;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  display: flex;
  position: relative;
}

.virtual-message-list {
  flex: 1;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  padding: var(--virtual-list-padding);
  box-sizing: border-box;
  background-color: $bg-main-surface;
}

.virtual-row {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  padding-bottom: var(--virtual-row-gap);
}

.virtual-message-list-content {
  min-width: 0;
  max-width: 100%;
}

.virtual-message-list-empty {
  position: absolute;
  inset: var(--virtual-list-padding);
  display: grid;
  place-items: center;
  min-width: 0;
  min-height: 0;
  pointer-events: auto;
}

.virtual-message-list-empty :deep(.empty-state) {
  width: 100%;
  height: 100%;
  min-height: 0;
}

</style>
