import 'vitest';
import type * as RDF from '@rdfjs/types';

interface CustomMatchers<R = unknown> {
  toEqualParsedQuery: (expected: unknown) => R;
  toEqualParsedQueryIgnoring: (selector: (obj: object) => boolean, keys: string[], expected: unknown) => R;
  toBeRdfIsomorphic: <Q extends RDF.BaseQuad = RDF.Quad>(actual: Iterable<Q>) => R;
}

declare module 'vitest' {
  interface Assertion<T = any> extends CustomMatchers<T> {}
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}
