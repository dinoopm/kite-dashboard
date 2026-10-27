import referenceUrl from '../../../backend/data/amfiMarketCaps.json?url'

let referencePromise
export function loadMarketCapReference() {
  if (!referencePromise) referencePromise = fetch(referenceUrl)
    .then(response => { if (!response.ok) throw new Error('Market-cap reference unavailable'); return response.json() })
    .catch(error => { referencePromise = null; throw error })
  return referencePromise
}
