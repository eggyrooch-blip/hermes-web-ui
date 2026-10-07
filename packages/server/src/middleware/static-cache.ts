export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const SPA_ENTRY_CACHE_CONTROL = 'no-cache'

/**
 * Build output under `assets/` is content-hashed, so it can be cached forever.
 * `index.html` is the only unfingerprinted entry and must always revalidate,
 * otherwise a deploy keeps serving stale chunk references.
 */
export function getStaticCacheControl(relativePath: string): string | null {
  const normalizedPath = relativePath.replaceAll('\\', '/').replace(/^\.\//, '')
  if (normalizedPath === 'index.html') return SPA_ENTRY_CACHE_CONTROL
  if (normalizedPath.startsWith('assets/')) return IMMUTABLE_ASSET_CACHE_CONTROL
  return null
}
