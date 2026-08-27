import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { bench, describe } from 'vitest';
import { transformFilterFalse } from '../lib/transformations/filterFalse.js';
import { nullifyJoinOverIncompatibleBounds } from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { nullifyUnbindableVars } from '../lib/transformations/nullifyUnbindableVars.js';
import { pushDownAssertions } from '../lib/transformations/pushDownAssertions.js';
import { removeProjections } from '../lib/transformations/removeProjections.js';
import { operationTransform, queryTransform } from '../lib/transformBgp.js';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext, parseQuery, transformContextFromConstructs } from '../lib/transformContext.js';
import { nonTripleTermConstruct, testQuery, tripleTermConstruct } from './queryConsts.js';

/**
 * @fileoverview How long the rewriting takes, at the three levels a change can move: the whole of
 * {@link transformBgp!queryTransform}, the pushdown on its own, and the parse the first of those
 * includes.
 *
 * Run with `yarn bench`. To measure a change rather than a number, save a baseline and compare against
 * it - the benchmarks live in `test`, so checking out another revision of `lib` alone leaves them in
 * place, and vitest reads the sources directly, so nothing needs building in between:
 *
 * ```
 * git checkout 8638c96 -- lib          # the revision to measure against
 * yarn bench --outputJson=bench-base.json
 * git checkout HEAD -- lib             # back to the working revision
 * yarn bench --compare=bench-base.json
 * ```
 *
 * `8638c96` is the commit the revision-stamp memos went on top of. Nothing here is a regression test:
 * these numbers move with the machine, so what is worth reading is the ratio the comparison prints, and
 * only when the two runs happened on the same idle machine.
 *
 * **The parse benchmarks are the control.** No revision this is likely to be run across changes
 * anything about parsing, so whatever ratio they report is the noise floor of the two runs, and nothing
 * smaller than that is worth reading anywhere else. On the run this was written from they came out at
 * 1.04x and 1.80x while the pushdown moved 1.48x to 1.62x - so the second parse figure was noise of the
 * same size as the effect being measured, and the pushdown numbers were only worth believing because
 * all three of them moved together and in the direction the memos predict.
 *
 * **What each level is for.** `queryTransform` is what a caller experiences, parse included, so it is
 * the honest end-to-end figure and the least sensitive one - the memos need a bigger conjunction than a
 * hand-written filter builds before they reach it, and on that same run it did not move at all. The
 * pushdown is where {@link utils/assertionConjunction!AssertionConjunction} does its work, and so where
 * a change to the memos shows up: it is not part of the standard chain the integration tests run, being
 * a transformation a caller opts into, so it is measured both ways below.
 */

/** The chain the integration tests run, which does not include the pushdown. */
const standardTransformations = <const>[
  operationTransform,
  transformFilterFalse,
  nullifyJoinOverIncompatibleBounds,
  nullifyUnbindableVars,
  transformFilterFalse,
  removeProjections,
];

/** The same chain with the assertion pushdown in it, which is what drives Θ. */
const withPushdown = <const>[
  operationTransform,
  pushDownAssertions,
  transformFilterFalse,
  nullifyJoinOverIncompatibleBounds,
  nullifyUnbindableVars,
  transformFilterFalse,
  removeProjections,
];

// Built once: parsing the mappers is not what any of this is measuring.
const mapped = transformContextFromConstructs([ tripleTermConstruct, nonTripleTermConstruct ]);
const bare = <TransformContext> createPartialContext();

const prefixes = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX : <https://example.com/>
`;

/** A user query whose filters make the cliques and shapes the pushdown moves around. */
const filterHeavyQuery = `${prefixes}SELECT * WHERE {
  ?t rdf:reifies <<( ?s ?p ?o )>> .
  ?s :knows ?friend .
  ?friend :name ?name .
  OPTIONAL { ?o :label ?label }
  FILTER(sameTerm(SUBJECT(?t), ?s) && sameTerm(?friend, ?s) && isIRI(?p) && sameTerm(?name, ?label))
}`;

/**
 * A join of `blocks` operands under one filter of `conditions` conditions - the shape the memo commits
 * were measured on. The conditions chain rather than pin, so the groups stay large and the walk over
 * them stays worth memoising.
 * @param blocks - How many operands to join
 * @param conditions - How many conditions to put in the filter above them
 * @returns the query text
 */
function synthetic(blocks: number, conditions: number): string {
  const names: string[] = [];
  const patterns: string[] = [];
  for (let block = 0; block < blocks; block++) {
    patterns.push(`{ ?s${block} :p ?o${block} . ?o${block} :q ?t${block} OPTIONAL { ?t${block} :r ?u${block} } }`);
    names.push(`s${block}`, `o${block}`, `t${block}`, `u${block}`);
  }
  const conds: string[] = [];
  for (let index = 0; index < conditions; index++) {
    conds.push(conditionAt(index, names));
  }
  return `${prefixes}SELECT * WHERE { ${patterns.join(' ')} FILTER(${conds.join(' && ')}) }`;
}

/**
 * One condition of the filter {@link synthetic} writes.
 * @param index - Which condition it is, which is what decides its form and the variables it names
 * @param names - Every variable the patterns bind
 * @returns the condition
 */
function conditionAt(index: number, names: readonly string[]): string {
  const here = names[index % names.length];
  switch (index % 4) {
    case 0:
      return `sameTerm(?${here}, ?${names[(index + 4) % names.length]})`;
    case 1:
      return `isIRI(?${here})`;
    case 2:
      // An accessor, which gives the group a shape and three positions of its own.
      return `sameTerm(SUBJECT(?${here}), ?${names[(index + 7) % names.length]})`;
    default:
      return `sameTerm(?${here}, ?${names[(index + 13) % names.length]})`;
  }
}

// Parsed once, so that what the pushdown benchmarks time is the pushdown.
const parsed: Record<string, Algebra.Operation> = {
  'filter of 160 conditions, 16 blocks': parseQuery(bare, synthetic(16, 160)),
  '32 blocks': parseQuery(bare, synthetic(32, 160)),
  '64 blocks': parseQuery(bare, synthetic(64, 320)),
};

describe('the whole rewriting', () => {
  bench('a mapped query, standard chain', () => {
    queryTransform(mapped, testQuery, [ ...standardTransformations ]);
  });

  bench('a filter-heavy mapped query, standard chain', () => {
    queryTransform(mapped, filterHeavyQuery, [ ...standardTransformations ]);
  });

  bench('a filter-heavy mapped query, with the assertion pushdown', () => {
    queryTransform(mapped, filterHeavyQuery, [ ...withPushdown ]);
  });
});

describe('the parse the above includes', () => {
  bench('a mapped query', () => {
    parseQuery(mapped, testQuery);
  });

  bench('a filter-heavy mapped query', () => {
    parseQuery(mapped, filterHeavyQuery);
  });
});

describe('the assertion pushdown, over a parsed plan', () => {
  for (const [ label, plan ] of Object.entries(parsed)) {
    bench(label, () => {
      pushDownAssertions(bare, plan);
    });
  }
});
