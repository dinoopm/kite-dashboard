// Preferences contain no holdings. Legacy preferences belong only to GEK191;
// later accounts receive their own keys and start with the standard defaults.
let owner = null
export function setBrowserIdentity(identity) { owner = identity }
export function createPreferenceStore(getOwner, storage) {
  const keyFor = key => getOwner()?.appUserId ? `kite-user:${getOwner().appUserId}:${key}` : null
  return {
    getItem(key) {
      const scoped = keyFor(key)
      if (!scoped) return null
      try {
        const value = storage.getItem(scoped)
        if (value !== null) return value
        if (getOwner()?.kiteUserId !== 'GEK191') return null
        const legacy = storage.getItem(key)
        if (legacy !== null) storage.setItem(scoped, legacy)
        return legacy
      } catch { return null }
    },
    setItem(key, value) {
      const scoped = keyFor(key)
      if (scoped) { try { storage.setItem(scoped, value) } catch { /* private mode */ } }
    },
  }
}
export const userPreferences = createPreferenceStore(() => owner, {
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
})
