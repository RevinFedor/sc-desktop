// Tiny helpers shared across Instagram-related screens/components.

/**
 * Display label for a backend id.  Internal id stays `api` for
 * settings.json compatibility, but everywhere user-facing we say
 * "android-api" so it's not confused with apify.
 */
export function backendLabel(id) {
  if (id === 'api') return 'android-api'
  if (id === 'apify') return 'Apify'
  return id || '—'
}
