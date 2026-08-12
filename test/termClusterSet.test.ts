import type * as RDF from '@rdfjs/types';
import { describe, it } from 'vitest';
import { meetPinsOf, TermClusterSet } from '../lib/datastructures/TermClusterSet.js';
import { RangeSet, subjectRange } from '../lib/RangeSet.js';
import { DF } from '../lib/utils/rdfDatatypes.js';

const termC = DF.namedNode('ex://c');
const termD = DF.namedNode('ex://d');

function clusters(): TermClusterSet<string, RDF.Term> {
  return new TermClusterSet<string, RDF.Term>(
    name => name,
    meetPinsOf((a, b) => a.equals(b)),
    term => new RangeSet([ term.termType ]),
  );
}

/** The children of the triple pin of `name`, which the test asks for as a shape rather than as a check. */
function shapeOf(set: TermClusterSet<string, RDF.Term>, name: string): readonly [ number, number, number ] {
  const children = set.setTriple(set.getGroup(name));
  if (children === false) {
    throw new Error(`${name} cannot hold a triple term`);
  }
  return children;
}

describe('termClusterSet', () => {
  describe('the pin lattice', () => {
    it('gives a group the same components however often it is asked for the shape', ({ expect }) => {
      const set = clusters();
      expect(shapeOf(set, 'o')).toEqual(shapeOf(set, 'o'));
    });

    it('refuses a shape on a group pinned to a term, and a term on a shaped group', ({ expect }) => {
      const set = clusters();
      set.setTerm(set.getGroup('o'), termC);
      expect(set.setTriple(set.getGroup('o'))).toBe(false);

      const other = clusters();
      shapeOf(other, 'o');
      expect(other.setTerm(other.getGroup('o'), termC)).toBe(false);
    });

    it('decomposes: unifying two shaped groups unifies their components', ({ expect }) => {
      const set = clusters();
      const left = shapeOf(set, 'o');
      const right = shapeOf(set, 'x');
      // `?o ≡ ?x` says nothing new about either shape, and everything about their positions.
      expect(set.mergeGroups('o', 'x')?.conflict).toBe(false);
      const merged = set.childrenOf(set.getGroup('o'))!;
      for (const [ index ] of merged.entries()) {
        // Whichever of the two survived, both sides now name the same group per position.
        expect(new Set([ left[index], right[index] ]).has(merged[index])).toBe(true);
        expect(set.reaches(set.getGroup('x'), merged[index])).toBe(true);
      }
    });

    it('carries a component pin through the decomposition, contradicting where they disagree', ({ expect }) => {
      const set = clusters();
      set.setTerm(shapeOf(set, 'o')[0], termC);
      set.setTerm(shapeOf(set, 'x')[0], termD);
      // `subject(?o) ≡ :c` and `subject(?x) ≡ :d` cannot both hold once `?o ≡ ?x`.
      expect(set.mergeGroups('o', 'x')?.conflict).toBe(true);
    });

    it('drains the merges of a merge, however deep the shapes nest', ({ expect }) => {
      const set = clusters();
      // `?o` and `?x` are both triples whose *object* is a triple, so unifying them unifies the
      // grandchildren - a merge asked for by a merge, which is why the work list may not be a recursion.
      const leftInner = set.setTriple(shapeOf(set, 'o')[2]);
      const rightInner = set.setTriple(shapeOf(set, 'x')[2]);
      if (leftInner === false || rightInner === false) {
        throw new Error('a nested object position holds a triple term');
      }
      set.setTerm(leftInner[1], termC);
      expect(set.mergeGroups('o', 'x')?.conflict).toBe(false);
      // `predicate(object(?x))` learned the term the other side carried.
      expect(set.termOf(set.childrenOf(set.childrenOf(set.getGroup('x'))![2])![1])).toEqual(termC);
    });
  });

  describe('the occurs check', () => {
    it('refuses a shape that holds the group it is pinned on', ({ expect }) => {
      const set = clusters();
      const children = shapeOf(set, 'o');
      // `object(?o) ≡ ?o` - the term would have to hold itself, so there is no such term.
      expect(set.mergeGroupIds(children[2], set.getGroup('o'))?.conflict).toBe(true);
    });

    it('refuses a cycle closed further down the shapes', ({ expect }) => {
      const set = clusters();
      const inner = set.setTriple(shapeOf(set, 'o')[2]);
      if (inner === false) {
        throw new Error('a nested object position holds a triple term');
      }
      expect(set.mergeGroupIds(inner[2], set.getGroup('o'))?.conflict).toBe(true);
    });
  });

  describe('the range of a group', () => {
    it('refuses a shape on a component no triple term can occupy', ({ expect }) => {
      const set = clusters();
      const [ subject, predicate ] = shapeOf(set, 'o');
      // Nesting only ever runs down the object chain: nothing is the triple term of a subject or of a
      // predicate, so a shape there is a contradiction rather than a deeper shape.
      expect(set.setTriple(subject)).toBe(false);
      expect(set.setTriple(predicate)).toBe(false);
    });

    it('refuses a term the narrowed range no longer admits', ({ expect }) => {
      const set = clusters();
      const group = set.getGroup('o');
      expect(set.narrowRange(group, subjectRange)).toBe(true);
      expect(set.setTerm(group, DF.literal('lit'))).toBe(false);
    });

    it('refuses to narrow a shaped group to something that is not a triple term', ({ expect }) => {
      const set = clusters();
      shapeOf(set, 'o');
      expect(set.narrowRange(set.getGroup('o'), subjectRange)).toBe(false);
    });
  });

  describe('keeping a group alive', () => {
    it('keeps a group a live pin holds as a component', ({ expect }) => {
      const set = clusters();
      const children = shapeOf(set, 'o');
      // `?s` is what `subject(?o)` is, and taking `?s` out of the group leaves the shape pointing at it.
      set.mergeGroupIds(set.getGroup('s'), children[0]);
      const componentGroup = set.groupOf('s')!;
      set.remove('s');
      // The group survives as an anonymous one: dropping it would leave the shape pointing at nothing.
      expect(set.childrenOf(set.getGroup('o'))![0]).toBe(componentGroup);
      expect(set.groupEntries().map(([ group ]) => group)).toContain(componentGroup);
      expect(set.valuesOf(componentGroup)).toEqual([]);
    });

    it('drops a group nothing points at any more', ({ expect }) => {
      const set = clusters();
      set.mergeGroups('s', 't');
      const group = set.groupOf('s')!;
      set.remove('s');
      // `?t` has nothing left to be equal to, so the group says nothing.
      expect(set.groupOf('t')).toBeUndefined();
      expect(set.groupEntries().map(([ entry ]) => entry)).not.toContain(group);
    });
  });

  it('leaves the set it was cloned from untouched', ({ expect }) => {
    const set = clusters();
    const children = shapeOf(set, 'o');
    const copy = set.clone();
    copy.setTerm(copy.childrenOf(copy.getGroup('o'))![0], termC);
    expect(copy.termOf(copy.childrenOf(copy.getGroup('o'))![0])).toEqual(termC);
    expect(set.termOf(children[0])).toBeUndefined();
  });
});
