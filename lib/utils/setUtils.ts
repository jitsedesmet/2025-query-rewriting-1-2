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
