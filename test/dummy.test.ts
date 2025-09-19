import { toAlgebra } from '@traqula/algebra-sparql-1-2';
import type { Algebra as Alg } from '@traqula/algebra-transformations-1-1';
import { Parser } from '@traqula/parser-sparql-1-2';
import { describe, it } from 'vitest';
import { expectedQuery, nonTripleTermConstruct, testQuery, tripleTermConstruct } from '../lib/queries.js';
import { BgpTransformer } from '../lib/transformBgp.js';

describe('dummy', () => {
  const parser = new Parser();

  function test(name: string, userQuery: string, expectedQuery: string, mappers: string[]): void {
    it(name, ({ expect }) => {
      const mappersAlgebra = mappers.map(mapper =>
        <Alg.Construct> toAlgebra(parser.parse(mapper), { quads: true }));

      const queryMapper = new BgpTransformer(mappersAlgebra);

      expect(queryMapper.queryTransform(userQuery).trim()).toEqual(expectedQuery.trim());

      const _expectedAst = parser.parse(expectedQuery);
      const _expectedAlgebra = toAlgebra(_expectedAst, { quads: true });
    });
  }

  test('simple', testQuery, expectedQuery, [ tripleTermConstruct, nonTripleTermConstruct ]);
});
