// hermes-v050:E-01 冷打开会话时正文晚一帧才撑开（真浏览器 CLS 0.458）：原来 MessageItem 用
// defineAsyncComponent 加载 MarkdownRenderer，要等第一个 MessageItem 挂载才开始解析，第一批消息行
// 挂进 DOM 时正文是空的，约 190ms 后才撑开。这里把解析提前：MessageList 挂载时调 loadMarkdownRenderer()，
// 结果放进 shallowRef；MessageItem 创建时已解析就直接用组件本身，同一次挂载里就渲染出正文。
// MarkdownRenderer 仍只经这里的动态 import() 到达，保持独立 chunk（C5：完整 highlight.js 不进首屏静态闭包）。
import { defineAsyncComponent, shallowRef, type Component, type ShallowRef } from "vue";

// 显式标注类型：shallowRef<Component | null>(null) 的重载推断会把值类型收窄成 null
const resolvedComponent: ShallowRef<Component | null> = shallowRef(null);
let pendingLoad: Promise<Component> | null = null;

export function loadMarkdownRenderer(): Promise<Component> {
  if (resolvedComponent.value) return Promise.resolve(resolvedComponent.value);
  if (!pendingLoad) {
    pendingLoad = import("./MarkdownRenderer.vue").then(
      (module) => {
        resolvedComponent.value = module.default;
        return module.default;
      },
      (error: unknown) => {
        // 失败不缓存：下一次 MessageList 挂载可以重新请求
        pendingLoad = null;
        throw error;
      },
    );
  }
  return pendingLoad;
}

export function resolvedMarkdownRenderer(): Component | null {
  return resolvedComponent.value;
}

// 还没解析时的退路，与原来的写法一样晚一拍出正文
export const AsyncMarkdownRenderer = defineAsyncComponent(loadMarkdownRenderer);
