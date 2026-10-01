<script setup lang="ts">
// hermes-v050:C1 侧栏会话列表虚拟滚动：只渲染视口加上下缓冲区里的约 20–30 行，其余会话不再挂 DOM 和
// naive 弹层；行保持文档顺序（Tab 焦点顺序不乱），行高按首屏实测值固定，上下用占位撑出完整滚动高度。
// hermes-v050:F-07 不再用 vue-virtual-scroller 的 RecycleScroller：顺序一变它就把可见行全部回收、
// 按池子重新分配，每行都换了会话、整行重挂（焦点掉到 body、打开的删除确认消失）。这里改为按会话 id
// 作 key 的 v-for 切片，重排时与 v0.4.6 的带 key v-for 一样只移动变了位置的行，其余行 DOM 原样保留。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

type SessionRow = { id: string };

const props = withDefaults(defineProps<{
  items: SessionRow[];
  estimatedItemSize?: number;
  buffer?: number;
}>(), {
  estimatedItemSize: 62,
  buffer: 400,
});

defineSlots<{
  default?: (props: { item: any; index: number }) => any;
  empty?: () => any;
}>();

const rootRef = ref<HTMLElement | null>(null);
const itemSize = ref(props.estimatedItemSize);
const scrollTop = ref(0);
const viewportHeight = ref(0);
let fontsReadyListened = false;
let disposed = false;
let resizeObserver: ResizeObserver | null = null;

// 可见窗口：视口上下各多渲染 buffer 像素；数值不变时 computed 不触发，滚动一行以内不重渲染
const startIndex = computed(() => {
  const start = Math.floor((scrollTop.value - props.buffer) / itemSize.value);
  return Math.max(0, Math.min(props.items.length, start));
});
const endIndex = computed(() => {
  const end = Math.ceil((scrollTop.value + viewportHeight.value + props.buffer) / itemSize.value);
  return Math.max(startIndex.value, Math.min(props.items.length, end));
});
const visibleRows = computed(() => props.items.slice(startIndex.value, endIndex.value));
const beforeSize = computed(() => startIndex.value * itemSize.value);
const afterSize = computed(() => (props.items.length - endIndex.value) * itemSize.value);

function scrollerElement(): HTMLElement | null {
  return rootRef.value;
}

function readViewport() {
  const root = rootRef.value;
  if (!root) return;
  scrollTop.value = root.scrollTop;
  viewportHeight.value = root.clientHeight || window.innerHeight || 0;
}

function onScroll() {
  const root = rootRef.value;
  if (root) scrollTop.value = root.scrollTop;
}

// 行高以相邻两行的位置差为准（含 SessionListItem 的 2px 下边距折叠），
// 单行时退回元素高度加外边距；量不出合理值就保持估计值，行仍按真实高度排布。
// hermes-v050:E-03 用 getBoundingClientRect 取小数：Chrome 里行距是 65.797px，offsetTop / offsetHeight
// 取整后成了 66px，781 行的占位多出 159px，越往下行越偏（实测最大漂移 2.44px）。
function measureItemSize() {
  const root = rootRef.value;
  if (!root) return;
  const views = Array.from(root.querySelectorAll<HTMLElement>(":scope > .virtual-session-list__row"))
    .filter(view => view.firstElementChild instanceof HTMLElement);
  if (views.length === 0) return;
  let measured = 0;
  if (views.length >= 2) {
    measured = views[1].getBoundingClientRect().top - views[0].getBoundingClientRect().top;
  } else {
    const row = views[0].firstElementChild as HTMLElement;
    const style = getComputedStyle(row);
    measured = row.getBoundingClientRect().height + (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0);
  }
  if (!Number.isFinite(measured) || measured < 16 || measured > 240) return;
  // hermes-v050:E-03 小数差也要写回（原来差 <0.5px 就不更新），否则 0.2px 的误差会乘上几百行
  if (Math.abs(measured - itemSize.value) >= 0.01) itemSize.value = measured;
}

function scheduleMeasure() {
  void nextTick(() => {
    if (!disposed) measureItemSize();
  });
}

watch(
  () => props.items.length > 0,
  (hasItems) => {
    if (hasItems) scheduleMeasure();
  },
  { flush: "post" },
);

onMounted(() => {
  readViewport();
  scheduleMeasure();
  if (typeof ResizeObserver !== "undefined" && rootRef.value) {
    resizeObserver = new ResizeObserver(() => {
      if (!disposed) readViewport();
    });
    resizeObserver.observe(rootRef.value);
  } else {
    window.addEventListener("resize", readViewport);
  }
  const fonts = typeof document !== "undefined" ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
  if (fonts?.ready && !fontsReadyListened) {
    fontsReadyListened = true;
    void fonts.ready.then(() => {
      if (!disposed) measureItemSize();
    }).catch(() => undefined);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener("resize", readViewport);
});

defineExpose({
  measureItemSize,
  scrollerElement,
});
</script>

<template>
  <div ref="rootRef" class="virtual-session-list" @scroll.passive="onScroll">
    <div class="virtual-session-list__spacer" aria-hidden="true" :style="{ height: `${beforeSize}px` }" />
    <div
      v-for="(item, offset) in visibleRows"
      :key="item.id"
      class="virtual-session-list__row"
      :data-index="startIndex + offset"
    >
      <slot :item="item" :index="startIndex + offset" />
    </div>
    <div class="virtual-session-list__spacer" aria-hidden="true" :style="{ height: `${afterSize}px` }" />
    <slot v-if="items.length === 0" name="empty" />
  </div>
</template>

<style scoped>
/* 与 RecycleScroller flow-mode 相同：占位高度随滚动变化，不让浏览器的滚动锚定去修正位置 */
.virtual-session-list {
  position: relative;
  overflow-anchor: none;
}

.virtual-session-list__spacer {
  flex: 0 0 auto;
  margin: 0;
  padding: 0;
  border: 0;
  visibility: hidden;
  pointer-events: none;
  overflow-anchor: none;
}

.virtual-session-list__row {
  overflow-anchor: none;
}
</style>
