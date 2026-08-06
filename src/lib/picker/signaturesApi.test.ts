import { describe, expect, it } from 'vitest';
import { buildOptionMap, type OptionCollection } from './signaturesApi';

const optionCollections: OptionCollection[] = [
  { option_collection_hash: 'H_OPT', options: [{ name: 'opt' }] },
  { option_collection_hash: 'H_DEBUG', options: [{ name: 'debug' }] },
];
const optionMap = buildOptionMap(optionCollections);

describe('buildOptionMap', () => {
  it('maps hashes to option name lists', () => {
    expect(optionMap.get('H_OPT')).toEqual(['opt']);
    expect(optionMap.get('H_DEBUG')).toEqual(['debug']);
    expect(optionMap.get('unknown')).toBeUndefined();
  });
});
