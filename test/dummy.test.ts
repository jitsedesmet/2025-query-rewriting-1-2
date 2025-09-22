import { toAlgebra } from '@traqula/algebra-sparql-1-2';
import { Parser } from '@traqula/parser-sparql-1-2';

// eslint-disable-next-line ts/ban-ts-comment
// @ts-expect-error 7016
import unify from 'unify';
import { describe, it } from 'vitest';
import { expectedQuery, nonTripleTermConstruct, testQuery } from '../lib/queries.js';
import { BgpTransformer } from '../lib/transformBgp.js';

describe('dummy', () => {
  const parser = new Parser();

  function test(name: string, userQuery: string, expectedQuery: string, mappers: string[]): void {
    it(name, ({ expect }) => {
      const queryMapper = new BgpTransformer(mappers);
      expect(queryMapper.queryTransform(userQuery).trim()).toEqual(expectedQuery.trim());

      const _expectedAst = parser.parse(expectedQuery);
      const _expectedAlgebra = toAlgebra(_expectedAst, { quads: true });
      const _me = 2;
    });
  }

  test('simple', testQuery, expectedQuery, [
    // TripleTermConstruct,
    nonTripleTermConstruct,
  ]);

  it.skip('reifiaction', () => {
    const varA = unify.variable('A');
    const varB = unify.variable('B');
    const varC = unify.variable('C');
    const left = unify.box([
      [ varA ],
      [ varB ],
      [ varB ],
    ]);
    const right = unify.box([
      [ varB ],
      [ 2 ],
      [ varC ],
    ]);
    const solved = left.unify(right);
    // eslint-disable-next-line no-console
    console.log(solved);
  });
});
