export const SKILL_DESCRIPTION_PREVIEW_LIMIT = 140

export function normalizeSkillDescription(value: string | null | undefined): string {
  return value == null ? '' : value.replace(/\s+/gu, ' ').trim()
}

export function skillDescriptionPreview(
  value: string | null | undefined,
  maxCharacters = SKILL_DESCRIPTION_PREVIEW_LIMIT,
): string {
  if (!Number.isFinite(maxCharacters)) return ''

  const limit = Math.floor(maxCharacters)
  if (limit <= 0) return ''

  const normalized = normalizeSkillDescription(value)
  if (!normalized) return ''

  const codePoints = Array.from(normalized)
  if (codePoints.length <= limit) return normalized
  if (limit === 1) return '…'

  return `${codePoints.slice(0, limit - 1).join('').trimEnd()}…`
}

// hermes-v050:U15 list descriptions show plain text: drop **bold**, `code`
// and [text](link) markers (links keep their text).
// hermes-v050:E-11 the server cuts descriptions at 80 characters, which can end
// inside a link ("[Claude Code](https://code.claude.com/docs/en/cli-refer"): a
// trailing link without its closing parenthesis keeps its text as well.
export function skillDescriptionPlainText(value: string | null | undefined): string {
  if (value == null) return ''
  return value
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*$/, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
}

// hermes-v050:U7 preview only: a leading `---` … `---` YAML frontmatter is shown
// as a ```yaml code block (shared code-block style) instead of being parsed
// into a horizontal rule + setext heading. Editing and saving keep the raw file.
const SKILL_FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?=\r?\n|$)/

export function wrapSkillFrontmatterForPreview(content: string | null | undefined): string {
  if (!content) return ''
  const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  const match = SKILL_FRONTMATTER.exec(source)
  if (!match) return content
  const block = match[0]
  const longestTicks = Math.max(0, ...(block.match(/`+/g) || []).map(run => run.length))
  const fence = '`'.repeat(Math.max(3, longestTicks + 1))
  return `${fence}yaml\n${block}\n${fence}${source.slice(block.length)}`
}
