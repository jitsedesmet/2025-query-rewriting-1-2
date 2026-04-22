import type * as RDF from '@rdfjs/types';
import { toAlgebra12Builder } from '@traqula/algebra-sparql-1-2';
import type {
  AlgebraFactory,
} from '@traqula/algebra-transformations-1-1';
import {
  translateGraphPattern,
  Algebra,
  ExpressionTypes,
  algebraUtils,
} from '@traqula/algebra-transformations-1-1';
import { createAlgebraContext } from '@traqula/algebra-transformations-1-2';
import { IndirBuilder } from '@traqula/core';
import type { TermLiteral } from '@traqula/rules-sparql-1-1';
import type { PatternBgp, TermIri, TermVariable, TripleNesting } from '@traqula/rules-sparql-1-2';
import { ViewAstFactory } from './astFactory.js';
import type { ViewDefinition, ViewPair } from './types.js';

// ---------------------------------------------------------------------------
// Extended context
// ---------------------------------------------------------------------------

type BaseAlgebraContext = ReturnType<typeof createAlgebraContext>;

export type ViewAlgebraContext = BaseAlgebraContext & {
  astFactory: ViewAstFactory;
  /** Registered views keyed by fully-resolved IRI */
  views: Map<string, ViewDefinition>;
  /** IRIs of views currently being expanded (cycle detection) */
  expandingViews: Set<string>;
};

export function createViewAlgebraContext(
  config: Parameters<typeof createAlgebraContext>[0] = {},
): ViewAlgebraContext {
  const base = createAlgebraContext(config);
  return {
    ...base,
    astFactory: new ViewAstFactory(),
    views: new Map(),
    expandingViews: new Set(),
  };
}

// ---------------------------------------------------------------------------
// Helper: apply variable substitution to an Algebra.Operation
// sigma: variable name → RDF term to replace it with
// ---------------------------------------------------------------------------

function applySubstitution(
  op: Algebra.Operation,
  sigma: Map<string, RDF.Term>,
  AF: AlgebraFactory,
): Algebra.Operation {
  if (sigma.size === 0) {
    return op;
  }
  return applySubstOp(op, sigma, AF);
}

function substTerm(term: RDF.Term, sigma: Map<string, RDF.Term>): RDF.Term {
  if (term.termType === 'Variable') {
    return sigma.get(term.value) ?? term;
  }
  return term;
}

function substExpr(expr: Algebra.Expression, sigma: Map<string, RDF.Term>, AF: AlgebraFactory): Algebra.Expression {
  if (expr.subType === ExpressionTypes.TERM) {
    const te = expr;
    const newTerm = substTerm(te.term, sigma);
    if (newTerm === te.term) {
      return expr;
    }
    return AF.createTermExpression(newTerm);
  }
  if (expr.subType === ExpressionTypes.OPERATOR) {
    const oe = expr;
    const newArgs = oe.args.map(a => substExpr(a, sigma, AF));
    return AF.createOperatorExpression(oe.operator, newArgs);
  }
  if (expr.subType === ExpressionTypes.NAMED) {
    const ne = expr;
    const newArgs = ne.args.map(a => substExpr(a, sigma, AF));
    return AF.createNamedExpression(ne.name, newArgs);
  }
  if (expr.subType === ExpressionTypes.AGGREGATE) {
    const ae = <Algebra.AggregateExpression>expr;
    if (ae.expression) {
      return AF.createAggregateExpression(
        ae.aggregator,
        substExpr(ae.expression, sigma, AF),
        ae.distinct,
      );
    }
    return expr;
  }
  return expr;
}

function applySubstOp(
  op: Algebra.Operation,
  sigma: Map<string, RDF.Term>,
  AF: AlgebraFactory,
): Algebra.Operation {
  switch (op.type) {
    case Algebra.Types.BGP: {
      const bgp = op;
      const newPatterns = bgp.patterns.map((p) => {
        const s = substTerm(p.subject, sigma);
        const pr = substTerm(p.predicate, sigma);
        const o = substTerm(p.object, sigma);
        if (s === p.subject && pr === p.predicate && o === p.object) {
          return p;
        }
        return AF.createPattern(<any>s, <any>pr, <any>o, p.graph);
      });
      return AF.createBgp(newPatterns);
    }
    case Algebra.Types.FILTER: {
      const f = op;
      return AF.createFilter(
        applySubstOp(f.input, sigma, AF),
        substExpr(f.expression, sigma, AF),
      );
    }
    case Algebra.Types.JOIN: {
      const j = op;
      return AF.createJoin(j.input.map(i => applySubstOp(i, sigma, AF)));
    }
    case Algebra.Types.UNION: {
      const u = op;
      return AF.createUnion(u.input.map(i => applySubstOp(i, sigma, AF)));
    }
    case Algebra.Types.LEFT_JOIN: {
      const lj = op;
      const [ left, right ] = lj.input;
      const newLeft = applySubstOp(left, sigma, AF);
      const newRight = applySubstOp(right, sigma, AF);
      if (lj.expression) {
        return AF.createLeftJoin(newLeft, newRight, substExpr(lj.expression, sigma, AF));
      }
      return AF.createLeftJoin(newLeft, newRight);
    }
    case Algebra.Types.EXTEND: {
      const e = op;
      const newInput = applySubstOp(e.input, sigma, AF);
      const newExpr = substExpr(e.expression, sigma, AF);
      // Only substitute the EXTEND target variable if sigma maps it to a Variable.
      // Substituting with a NamedNode/Literal would produce invalid algebra.
      const mappedTarget = sigma.get(e.variable.value);
      const newVar = (mappedTarget?.termType === 'Variable') ?
        mappedTarget :
        e.variable;
      return AF.createExtend(newInput, newVar, newExpr);
    }
    case Algebra.Types.GRAPH: {
      const g = op;
      return AF.createGraph(
        applySubstOp(g.input, sigma, AF),
        <RDF.Variable | RDF.NamedNode>substTerm(g.name, sigma),
      );
    }
    case Algebra.Types.SERVICE: {
      const s = op;
      return AF.createService(
        applySubstOp(s.input, sigma, AF),
        <RDF.Variable | RDF.NamedNode>substTerm(s.name, sigma),
        s.silent,
      );
    }
    case Algebra.Types.MINUS: {
      const m = op;
      const [ left, right ] = m.input;
      return AF.createMinus(applySubstOp(left, sigma, AF), applySubstOp(right, sigma, AF));
    }
    case Algebra.Types.ORDER_BY: {
      const ob = op;
      return AF.createOrderBy(
        applySubstOp(ob.input, sigma, AF),
        ob.expressions.map(e => <any>substExpr(<any>e, sigma, AF)),
      );
    }
    default:
      // For operations not explicitly handled, return as-is
      return op;
  }
}

// ---------------------------------------------------------------------------
// OVER expansion
// ---------------------------------------------------------------------------

/** Extracts all TripleNesting nodes from a PatternBgp (ignoring collections for simplicity) */
function extractBgpTriples(bgp: PatternBgp): TripleNesting[] {
  return <TripleNesting[]>bgp.triples.filter((t: any) => t.type === 'triple');
}

/** Extracts BGP triples from a PatternGroup (first-level PatternBgp only) */
function extractOverTriples(pattern: any): TripleNesting[] {
  const triples: TripleNesting[] = [];
  for (const sub of pattern.patterns ?? []) {
    if (sub.subType === 'bgp') {
      triples.push(...extractBgpTriples(<PatternBgp>sub));
    }
  }
  return triples;
}

/**
 * Expands a single HEAD/BODY pair against the OVER pattern.
 * Returns the expanded algebra operation, or null if the pair doesn't match.
 */
function expandPair(
  $: any,
  c: ViewAlgebraContext,
  pair: ViewPair,
  overTriples: TripleNesting[],
): Algebra.Operation | null {
  const headTriples = extractBgpTriples(pair.head);

  if (headTriples.length !== overTriples.length) {
    return null;
  }

  const sigma = new Map<string, RDF.Term>();
  // Track OVER variables bound to HEAD constants; keyed by OVER variable name
  const extendMap = new Map<string, { variable: RDF.Variable; term: RDF.Term }>();

  for (const [ i, headTriple ] of headTriples.entries()) {
    const overTriple = overTriples[i];
    const positions: ('subject' | 'predicate' | 'object')[] = [ 'subject', 'predicate', 'object' ];

    for (const pos of positions) {
      const headNode = <any>headTriple[pos];
      const overNode = <any>overTriple[pos];

      // Resolve AST nodes to RDF terms for comparison
      const headRdf: RDF.Term = (headNode).type === 'term' ?
        resolveAstTerm(c, headNode) :
        null!;
      const overRdf: RDF.Term = (overNode).type === 'term' ?
        resolveAstTerm(c, overNode) :
        null!;

      if (!headRdf || !overRdf) {
        // Could not resolve — skip pair (e.g., path predicates)
        return null;
      }

      if (headRdf.termType === 'Variable') {
        // HEAD has a variable → map it to whatever is in OVER at this position
        const existing = sigma.get(headRdf.value);
        if (existing !== undefined && !existing.equals(overRdf)) {
          // Same head variable appears twice with conflicting OVER terms — conflict
          return null;
        }
        sigma.set(headRdf.value, overRdf);
      } else if (overRdf.termType === 'Variable') {
        // HEAD has a constant; OVER has a variable where HEAD has a constant → bind the OVER var
        const overVarName = overRdf.value;
        const existing = extendMap.get(overVarName);
        if (existing !== undefined && !existing.term.equals(headRdf)) {
          // Same OVER var bound to different HEAD constants — conflict, skip pair
          return null;
        }
        extendMap.set(overVarName, { variable: overRdf, term: headRdf });
      } else if (overRdf.equals(headRdf)) {
        // Constants match — OK
      } else {
        // Constant mismatch → pair doesn't match
        return null;
      }
    }
  }

  // Translate the BODY pattern to algebra
  let bodyAlgebra: Algebra.Operation = $.SUBRULE(translateGraphPattern, pair.body);

  // Apply sigma substitution to the body algebra
  bodyAlgebra = applySubstitution(bodyAlgebra, sigma, c.algebraFactory);

  // Add EXTEND operations for OVER vars that were bound to HEAD constants
  for (const { variable, term } of extendMap.values()) {
    bodyAlgebra = c.algebraFactory.createExtend(
      bodyAlgebra,
      variable,
      c.algebraFactory.createTermExpression(term),
    );
  }

  return bodyAlgebra;
}

/** Resolves an AST term node to an RDF term using the current prefixes/base */
function resolveAstTerm(c: ViewAlgebraContext, astTerm: any): RDF.Term {
  if (c.astFactory.isTermVariable(astTerm)) {
    return c.dataFactory.variable((<TermVariable>astTerm).value);
  }
  if (c.astFactory.isTermNamed(astTerm)) {
    const iri = <TermIri>astTerm;
    if (c.astFactory.isTermNamedPrefixed(iri)) {
      const expanded = c.currentPrefixes[(<any>iri).prefix];
      if (!expanded) {
        throw new Error(`Unknown prefix: ${(<any>iri).prefix}`);
      }
      return c.dataFactory.namedNode(expanded + iri.value);
    }
    // Full IRI — resolve against current base if set
    const resolved = c.currentBase ?
      algebraUtils.resolveIRI(iri.value, c.currentBase) :
      iri.value;
    return c.dataFactory.namedNode(resolved);
  }
  if (c.astFactory.isTermLiteral(astTerm)) {
    const lit = <TermLiteral><unknown>astTerm;
    if (lit.langOrIri === undefined) {
      return c.dataFactory.literal(lit.value);
    }
    if (typeof lit.langOrIri === 'string') {
      return c.dataFactory.literal(lit.value, lit.langOrIri);
    }
    // TermIri for datatype
    const dtIri = <RDF.NamedNode>resolveAstTerm(c, lit.langOrIri);
    return c.dataFactory.literal(lit.value, dtIri);
  }
  throw new Error(`Cannot resolve AST term: ${JSON.stringify(astTerm)}`);
}

// ---------------------------------------------------------------------------
// Patched rules
// ---------------------------------------------------------------------------

const originalRegisterContextDefs = toAlgebra12Builder.getRule('registerContextDefinitions');

const registerContextDefsView = {
  name: <const>'registerContextDefinitions',
  fun: ($: any) => (c: ViewAlgebraContext, definitions: any[]) => {
    // Run the original (handles base, prefix, version)
    originalRegisterContextDefs.fun($)(c, definitions);

    // Now also handle view definitions (prefixes are already registered above)
    for (const def of definitions) {
      if (c.astFactory.isViewDefinition(def)) {
        const viewDef = def;
        const resolvedIri = <RDF.NamedNode>resolveAstTerm(c, viewDef.name);
        c.views.set(resolvedIri.value, viewDef);
      }
    }
  },
};

const originalTranslateGraphPattern = toAlgebra12Builder.getRule('translateGraphPattern');

const translateGraphPatternView = {
  name: <const>'translateGraphPattern',
  fun: ($: any) => (c: ViewAlgebraContext, pattern: any): Algebra.Operation => {
    if (!c.astFactory.isPatternOver(pattern)) {
      return originalTranslateGraphPattern.fun($)(c, pattern);
    }

    const overPattern = pattern;
    const viewIri = (<RDF.NamedNode>resolveAstTerm(c, overPattern.name)).value;

    // Cycle detection
    if (c.expandingViews.has(viewIri)) {
      throw new Error(`Circular VIEW reference detected for: ${viewIri}`);
    }

    const viewDef = c.views.get(viewIri);
    if (!viewDef) {
      throw new Error(`Unknown VIEW: ${viewIri}`);
    }

    const overTriples = extractOverTriples(overPattern.pattern);
    c.expandingViews.add(viewIri);

    try {
      const results: Algebra.Operation[] = [];
      for (const pair of viewDef.pairs) {
        const expanded = expandPair($, c, pair, overTriples);
        if (expanded !== null) {
          results.push(expanded);
        }
      }

      if (results.length === 0) {
        // No pair matched → empty result
        return c.algebraFactory.createValues([], []);
      }
      if (results.length === 1) {
        return results[0];
      }
      return c.algebraFactory.createUnion(results);
    } finally {
      c.expandingViews.delete(viewIri);
    }
  },
};

// ---------------------------------------------------------------------------
// Builder + exported toAlgebra function
// ---------------------------------------------------------------------------

export const viewAlgebraBuilder = IndirBuilder
  .create(toAlgebra12Builder)
  .widenContext<ViewAlgebraContext>()
  .patchRule(registerContextDefsView)
  .patchRule(translateGraphPatternView)
  .typePatch();

/**
 * Translates a SPARQL AST (that may contain VIEW and OVER) to SPARQL algebra.
 */
export function toAlgebra(
  query: any,
  options: Parameters<typeof createAlgebraContext>[0] = {},
): Algebra.Operation {
  const c = createViewAlgebraContext(options);
  const transformer = viewAlgebraBuilder.build();
  return (<any>transformer).translateQuery(c, query, (<any>options).quads, (<any>options).blankToVariable);
}
