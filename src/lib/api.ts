// Treeherder / Perfherder API client.
//
// The signatures endpoint returns one row per performance series for a given
// repo. Everything else (frameworks, option collections) is small metadata
// used to give the raw rows human-readable names.

const BASE = 'https://treeherder.mozilla.org/api';

export type Framework = { id: number; name: string };

export type OptionCollection = {
  option_collection_hash: string;
  options: { name: string }[];
};

export type Repository = {
  id: number;
  name: string;
  performance_alerts_enabled?: boolean;
};

// Raw signature as returned by /performance/signatures/.
export type RawSignature = {
  id: number;
  signature_hash: string;
  framework_id: number;
  option_collection_hash: string;
  machine_platform: string;
  suite: string;
  test?: string | null;
  application?: string | null;
  extra_options?: string[];
  tags?: string[];
  measurement_unit?: string;
  has_subtests?: boolean;
  parent_signature?: string | null;
  should_alert?: boolean | null;
  lower_is_better?: boolean;
};

// Enriched signature we display in the table. `repository` and `framework`
// come from the request context / framework map; `options` is the resolved
// option-collection + extra_options list.
export type Series = {
  id: number;
  repository: string;
  framework: string;
  frameworkId: number;
  platform: string;
  suite: string;
  test: string;
  application: string;
  options: string[];
  extraOptions: string[];
  tags: string[];
  measurementUnit: string;
  hasSubtests: boolean;
  isSubtest: boolean;
  parentSignature: string | null;
  signatureHash: string;
  // Compound identity: `${repository}|${signatureHash}`. Baked in at
  // construction so callers never need to remember the composition — using
  // `signatureHash` alone would collide across repos (the same test has the
  // same hash on autoland and mozilla-central).
  key: string;
  // The parent row's `key`, if this is a subtest. `null` for parents.
  parentKey: string | null;
  // Precomputed lowercase haystack for fast text filtering.
  searchText: string;
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json() as Promise<T>;
}

export function fetchFrameworks(): Promise<Framework[]> {
  return fetchJson<Framework[]>(`${BASE}/performance/framework/`);
}

export function fetchOptionCollections(): Promise<OptionCollection[]> {
  return fetchJson<OptionCollection[]>(`${BASE}/optioncollectionhash/`);
}

export function buildOptionMap(list: OptionCollection[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const oc of list) {
    map.set(oc.option_collection_hash, oc.options.map((o) => o.name));
  }
  return map;
}

export async function fetchSignatures(
  repository: string,
  intervalSeconds: number,
  includeSubtests: boolean,
): Promise<Record<string, RawSignature>> {
  const url =
    `${BASE}/project/${encodeURIComponent(repository)}/performance/signatures/` +
    `?interval=${intervalSeconds}&subtests=${includeSubtests ? 1 : 0}`;
  return fetchJson<Record<string, RawSignature>>(url);
}

export function toSeries(
  raw: Record<string, RawSignature>,
  repository: string,
  frameworkMap: Map<number, string>,
  optionMap: Map<string, string[]>,
): Series[] {
  const out: Series[] = [];
  for (const [idStr, s] of Object.entries(raw)) {
    const framework = frameworkMap.get(s.framework_id) ?? `framework:${s.framework_id}`;
    const baseOpts = optionMap.get(s.option_collection_hash) ?? [];
    const extra = s.extra_options ?? [];
    // Dedup while preserving order.
    const options = [...new Set([...baseOpts, ...extra])];
    const suite = s.suite ?? '';
    const test = s.test ?? '';
    const application = s.application ?? '';
    const tags = s.tags ?? [];
    const searchText = [
      suite,
      test,
      application,
      s.machine_platform,
      framework,
      repository,
      ...options,
      ...tags,
    ]
      .join(' ')
      .toLowerCase();
    const parentSignature = s.parent_signature ?? null;
    out.push({
      id: Number(idStr),
      repository,
      framework,
      frameworkId: s.framework_id,
      platform: s.machine_platform,
      suite,
      test,
      application,
      options,
      extraOptions: extra,
      tags,
      measurementUnit: s.measurement_unit ?? '',
      hasSubtests: !!s.has_subtests,
      isSubtest: !!parentSignature,
      parentSignature,
      signatureHash: s.signature_hash,
      key: `${repository}|${s.signature_hash}`,
      parentKey: parentSignature ? `${repository}|${parentSignature}` : null,
      searchText,
    });
  }
  return out;
}

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
