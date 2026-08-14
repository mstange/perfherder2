// The two controls on the Add-series panel's "Load from" row — which is one
// row precisely because these are the fetch (`cacheKey` is
// `repo | subtests | interval`). Neither list is discovered from the API: both
// are choices Perfherder's own Graphs view makes, and we match them so a user
// coming from there finds the same options.
//
// Separate from signaturesApi.ts because they are neither transport nor
// schema — urlState.ts validates an interval from a link against `TIME_RANGES`
// without wanting the signatures client in its import graph.

// Perfherder's Graphs view pins these four repos. autoland + mozilla-central
// are the default-checked ones.
export const PINNED_REPOS = ['autoland', 'mozilla-central', 'mozilla-beta', 'try'];
export const DEFAULT_REPOS = ['autoland', 'mozilla-central'];

// Time range choices from the Perfherder graphs modal, seconds.
export const TIME_RANGES: { label: string; value: number }[] = [
  { label: '2 days', value: 172800 },
  { label: '7 days', value: 604800 },
  { label: '14 days', value: 1209600 },
  { label: '30 days', value: 2592000 },
  { label: '60 days', value: 5184000 },
  { label: '90 days', value: 7776000 },
];
