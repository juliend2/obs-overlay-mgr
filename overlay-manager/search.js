// Search scoring shared by the manager UI and Node tests.

export function fuzzyScore(query, haystack) {
  if (!query) return 1;
  const contiguous = haystack.indexOf(query);
  if (contiguous !== -1) return 1000 + query.length * 10 - contiguous;
  let score = 0;
  let matched = 0;
  let prev = -2;
  for (let i = 0; i < haystack.length && matched < query.length; i++) {
    if (haystack[i] !== query[matched]) continue;
    score += 1;
    if (i === prev + 1) score += 2;
    if (i === 0 || haystack[i - 1] === ' ') score += 3;
    prev = i;
    matched++;
  }
  return matched === query.length ? score : 0;
}

export function presetScore(preset, query) {
  return Math.max(
    fuzzyScore(query, preset._name) * 3,
    fuzzyScore(query, preset._category) * 2,
    fuzzyScore(query, preset._text),
  );
}
