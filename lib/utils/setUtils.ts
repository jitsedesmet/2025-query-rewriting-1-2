export type SSet = Set<string>;

export function unionSets(sets: SSet[]): SSet {
  const result = new Set<string>();
  for (const set of sets) {
    for (const value of set) {
      result.add(value);
    }
  }
  return result;
}

/**
 * Tests whether every element of `subset` is contained in `superset`.
 */
export function isSubsetOf(subset: Set<string>, superset: Set<string>): boolean {
  for (const value of subset) {
    if (!superset.has(value)) {
      return false;
    }
  }
  return true;
}

export function intersectSets(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) {
    return new Set<string>();
  }
  const agg = sets[0];
  for (const idx = 1; idx < sets.length; idx++) {
    const set = sets[idx];
    for (const value of set) {
      agg.delete(value);
      if (agg.size === 0) {
        return set;
      }
    }
  }
  return agg;
}
