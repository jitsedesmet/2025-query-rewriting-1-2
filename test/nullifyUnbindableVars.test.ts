import { describe, it } from 'vitest';
import { nullifyUnbindableVars } from '../lib/transformations/nullifyUnbindableVars.js';
import type { TransformContext } from '../lib/transformContext.js';
import { createPartialContext } from '../lib/transformContext.js';
import { isFilterFalse } from '../lib/utils/operationhelpers.js';

const c = <TransformContext> createPartialContext();
const x = c.DF.variable('x');
const g = c.DF.variable('g');
const iri = c.AF.createValues([ x ], [{ x: c.DF.namedNode('ex://c') }]);
const literal = c.AF.createValues([ x ], [{ x: c.DF.literal('l') }]);

describe('nullifyUnbindableVars', () => {
  it('nullifies a join whose operands certainly bind incompatible term types', ({ expect }) => {
    // Neither side names the *term* the other must equal, so the term-level check cannot see this.
    expect(isFilterFalse(c, nullifyUnbindableVars(c, c.AF.createJoin([ iri, literal ], false)))).toBe(true);
  });

  it('nullifies a GRAPH named by something no graph can be named by', ({ expect }) => {
    const named = c.AF.createGraph(c.AF.createValues([ g ], [{ g: c.DF.literal('l') }]), g);
    expect(isFilterFalse(c, nullifyUnbindableVars(c, named))).toBe(true);
  });

  it('nullifies a VALUES with no rows, whose columns are vacuously certain', ({ expect }) => {
    expect(isFilterFalse(c, nullifyUnbindableVars(c, c.AF.createValues([ x ], [])))).toBe(true);
  });

  it('nullifies `FILTER(bound(?x))` over something that cannot bind it, which is (FBndII)', ({ expect }) => {
    const filtered = c.AF.createFilter(
      c.AF.createBgp([]),
      c.AF.createOperatorExpression('bound', [ c.AF.createTermExpression(x) ]),
    );
    expect(isFilterFalse(c, nullifyUnbindableVars(c, filtered))).toBe(true);
  });

  it('leaves a join an UNDEF row keeps satisfiable alone', ({ expect }) => {
    // The UNDEF mapping is compatible with the literal one, so the join binds `?x` to `"l"`.
    const undefCol = c.AF.createValues([ x ], [{}]);
    const join = c.AF.createJoin([ undefCol, literal ], false);
    expect(isFilterFalse(c, nullifyUnbindableVars(c, join))).toBe(false);
  });

  it('leaves a GRAPH whose name only an OPTIONAL disagrees with alone', ({ expect }) => {
    const inner = c.AF.createLeftJoin(
      c.AF.createBgp([]),
      c.AF.createValues([ g ], [{ g: c.DF.literal('l') }]),
    );
    expect(isFilterFalse(c, nullifyUnbindableVars(c, c.AF.createGraph(inner, g)))).toBe(false);
  });

  it('nullifies only the branch of a union that is empty', ({ expect }) => {
    const union = c.AF.createUnion([ c.AF.createJoin([ iri, literal ], false), literal ], false);
    const result = nullifyUnbindableVars(c, union);
    expect(isFilterFalse(c, result)).toBe(false);
    expect(isFilterFalse(c, (result).input[0])).toBe(true);
    expect(isFilterFalse(c, (result).input[1])).toBe(false);
  });
});

describe('nullifyUnbindableVars on a SERVICE', () => {
  const endpoint = c.DF.namedNode('ex://endpoint');

  it('nullifies one whose pattern is unsatisfiable, the endpoint evaluating the same algebra', ({ expect }) => {
    const impossible = c.AF.createJoin([ iri, literal ], false);
    expect(isFilterFalse(c, nullifyUnbindableVars(c, c.AF.createService(impossible, endpoint, false)))).toBe(true);
  });

  it('leaves a SILENT one alone, a failing endpoint still yielding an empty solution', ({ expect }) => {
    const impossible = c.AF.createJoin([ iri, literal ], false);
    expect(isFilterFalse(c, nullifyUnbindableVars(c, c.AF.createService(impossible, endpoint, true)))).toBe(false);
  });

  it('nullifies one whose pattern forces a non-IRI endpoint - on the assumption, not the spec', ({ expect }) => {
    // See the TODO on `serviceNameRange`. This is the case that assumption decides.
    const variable = c.DF.variable('e');
    const inner = c.AF.createValues([ variable ], [{ e: c.DF.literal('l') }]);
    expect(isFilterFalse(c, nullifyUnbindableVars(c, c.AF.createService(inner, variable, false)))).toBe(true);
  });
});
