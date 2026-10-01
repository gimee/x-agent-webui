export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const SPA_ENTRY_CACHE_CONTROL = 'no-cache'

export function getStaticCacheControl(relativePath: string): string | null {
  // hermes-v050:S2 koa-send reports the precompressed sibling (index.html.br) it chose.
  const normalizedPath = relativePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\.(?:br|gz)$/, '')
  if (normalizedPath === 'index.html') return SPA_ENTRY_CACHE_CONTROL
  if (normalizedPath.startsWith('assets/')) return IMMUTABLE_ASSET_CACHE_CONTROL
  return null
}
