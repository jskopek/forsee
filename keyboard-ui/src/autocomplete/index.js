// Factory to create the default autocomplete engine.
// Implemented inline so the engine is easy to swap later without extra files.

import WORDS from './english_top_99_subtlex.json';

export function createDefaultAutocompleteEngine() {
  const words = Array.isArray(WORDS) ? WORDS : [];

  async function suggest(prefix, opts = {}) {
    const limit = typeof opts.limit === 'number' ? opts.limit : 3;
    const needle = (prefix || '').toLowerCase();
    if (!needle) return [];

    const results = [];
    for (let i = 0; i < words.length && results.length < limit; i += 1) {
      const w = words[i];
      if (typeof w === 'string' && w.startsWith(needle) && w !== needle) {
        results.push(w);
      }
    }
    return results;
  }

  return { suggest };
}

export default createDefaultAutocompleteEngine;


