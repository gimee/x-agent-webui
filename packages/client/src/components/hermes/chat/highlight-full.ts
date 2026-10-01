// hermes-v050:C5 文件预览（FilePreview / WorkspaceFileDiff 等，本身都是异步组件）保留完整语言包，
// 避免预览冷门语言文件时丢失着色；完整包只随这些预览 chunk 加载，不进聊天首屏。
import hljs from 'highlight.js'
import { installCodeHighlighter } from './highlight'

installCodeHighlighter(hljs)

export { hljs }
