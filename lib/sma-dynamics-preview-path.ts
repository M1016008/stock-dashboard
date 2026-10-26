// The SMA Dynamics fixture preview is the only route that renders without the
// app chrome and without touching storage. Matching is exact on purpose: other
// /dev/* pages keep the shared header, status bar and storage guard.
export const SMA_DYNAMICS_PREVIEW_PATH = '/dev/sma-dynamics'

export function isSmaDynamicsFixturePreviewPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  const normalized = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  return normalized === SMA_DYNAMICS_PREVIEW_PATH
}
