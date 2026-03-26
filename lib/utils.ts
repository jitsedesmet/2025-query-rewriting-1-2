import type * as RDF from '@rdfjs/types';
import type { AlgebraFactory } from '@traqula/algebra-transformations-1-2';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { Typed } from '@traqula/core';
import { DataFactory } from 'rdf-data-factory';
import type { RangedVar } from './RangeSet.js';
import type { TransformContext } from './transformContext.js';
import type { MappingHead, Template, TemplateBlank, TemplateIri, TemplateLiteral, TemplateQuad } from './types.js';

export const DF = new DataFactory();

export const xsd = 'http://www.w3.org/2001/XMLSchema#';
export const datatypeBoolean = DF.namedNode(`${xsd}boolean`);
export const datatypeString = DF.namedNode(`${xsd}string`);
/** The RDF literal `"false"^^xsd:boolean`, used as the sentinel value for `FILTER(false)`. */
export const termFalse = DF.literal('false', datatypeBoolean);

/**
 * Returns `true` when `op` is a `FILTER(false)` algebra node –
 * i.e. a FILTER whose expression is the term `"false"^^xsd:boolean`.
 *
 * This sentinel is used throughout the pipeline to represent algebraic
 * "empty result set" operations that can be simplified away.
 *
 * @param c - The transformation context (currently unused but kept for API symmetry).
 * @param op - The algebra operation to inspect.
 */
export function isFilterFalse(c: TransformContext, op: Algebra.Operation): boolean {
  return op.type === Algebra.Types.FILTER && op.expression.subType === Algebra.ExpressionTypes.TERM &&
    op.expression.term.equals(termFalse);
}

/**
 * Creates a `FILTER(false)` algebra node, optionally wrapping an existing operation.
 * When `op` is omitted the filter wraps an empty BGP, producing the canonical
 * "empty result" sentinel used by all simplification passes.
 *
 * @param c - The transformation context.
 * @param op - An optional inner operation to wrap; defaults to an empty BGP.
 */
export function createFilterFalse(c: TransformContext, op?: Algebra.Operation): Algebra.Filter {
  return c.AF.createFilter(op ?? c.AF.createBgp([]), c.AF.createTermExpression(termFalse));
}

/**
 * Type guard: returns `true` and narrows the type to {@link RDF.Term} when `obj`
 * has a `termType` string property (the canonical marker of an RDF/JS term).
 *
 * @param obj - Any object to test.
 */
export function isRdfTerm(obj: object): obj is RDF.Term {
  return 'termType' in obj && typeof obj.termType === 'string';
}

/**
 * Type guard: returns `true` and narrows the type to {@link RDF.Quad} when `obj`
 * is an RDF term whose `termType` is `'Quad'` (i.e. a quoted / nested triple).
 *
 * @param obj - Any object to test.
 */
export function isRdfQuad(obj: object): obj is RDF.Quad {
  return isRdfTerm(obj) && obj.termType === 'Quad';
}

/**
 * Type guard: returns `true` and narrows the type to {@link RangedVar} when `obj`
 * is an RDF term whose `termType` is `'Variable'`.
 *
 * The return type is {@link RangedVar} rather than `RDF.Variable` because variables
 * encountered during rewriting may carry an optional positional range annotation.
 *
 * @param obj - Any object to test.
 */
export function isRdfVar(obj: object): obj is RangedVar {
  return isRdfTerm(obj) && obj.termType === 'Variable';
}

/**
 * Type guard: returns `true` and narrows the type to {@link RDF.DefaultGraph} when
 * `obj` is an RDF term whose `termType` is `'DefaultGraph'`.
 *
 * @param obj - Any object to test.
 */
export function isRdfDefaultGraph(obj: object): obj is RDF.DefaultGraph {
  return isRdfTerm(obj) && obj.termType === 'DefaultGraph';
}

/**
 * Type guard: returns `true` and narrows the type to {@link Typed} when `obj`
 * carries a `type` string property (and an optional `subType` string property).
 * This is used to distinguish algebra/template nodes from raw RDF terms.
 *
 * @param obj - Any object to test.
 */
export function isTyped(obj: object): obj is Typed {
  return 'type' in obj && typeof obj.type === 'string' && (
    !('subType' in obj) || typeof obj.subType === 'string'
  );
}

/**
 * Type guard: returns `true` and narrows the type to {@link MappingHead} when `obj`
 * is a typed object whose `type` is `'mappingHead'`.
 *
 * @param obj - Any object to test.
 */
export function isMappingHead(obj: object): obj is MappingHead {
  return isTyped(obj) && obj.type === 'mappingHead';
}

/**
 * Returns `true` when `term` contains no variables at any nesting level.
 *
 * For a quoted triple (`Quad`) the check recurses into subject, predicate, and object.
 * All other non-variable term types (`NamedNode`, `Literal`, `BlankNode`,
 * `DefaultGraph`) are considered static.
 *
 * @param term - The RDF term to inspect.
 */
export function termIsStaticTerm(term: RDF.Term): boolean {
  if (term.termType === 'Quad') {
    return termIsStaticTerm(term.subject) && termIsStaticTerm(term.predicate) && termIsStaticTerm(term.object);
  }
  return term.termType !== 'Variable';
}

/**
 * Collects all top-level `BIND(<literal-or-IRI> AS ?var)` assignments that appear
 * as a linear chain of `Extend` nodes directly inside `op`.
 *
 * Only assignments where the bound expression is a static {@link RDF.NamedNode} or
 * {@link RDF.Literal} are included; assignments that reference variables or use
 * computed expressions are ignored.
 *
 * This is used by the join-incompatibility and bind-push-up optimisations to
 * discover which variables are statically known at a given point in the algebra.
 *
 * @param c - The transformation context (currently unused but kept for API symmetry).
 * @param op - The operation to scan.
 * @returns A map from variable name to its statically bound term.
 */
export function directExtensions(c: TransformContext, op: Algebra.Operation): Record<string, RDF.Term> {
  const assignments: Record<string, RDF.Term> = {};

  const findAssignments = (op: Algebra.Operation): void => {
    if (op.type === 'extend') {
      if (op.expression.subType === Algebra.ExpressionTypes.TERM && (
        op.expression.term.termType === 'Literal' || op.expression.term.termType === 'NamedNode')) {
        assignments[op.variable.value] = (op.expression).term;
      }
      findAssignments(op.input);
    }
  };

  findAssignments(op);
  return assignments;
}

/**
 * Removes `Extend` nodes for the given variable names from a linear chain of
 * `Extend` operations, mutating the chain in place.
 *
 * If `vars` is empty the operation is returned unchanged.  Otherwise the function
 * walks the `Extend` chain and prunes any `Extend` whose variable name is in `vars`,
 * replacing it with its inner input.
 *
 * @param c - The transformation context (currently unused but kept for API symmetry).
 * @param op - The root of the extend chain to prune.
 * @param vars - Variable names whose `Extend` nodes should be removed.
 * @returns The (possibly modified) operation.
 */
export function deleteVarExtensionsInPlace(
  c: TransformContext,
  op: Algebra.Operation,
  vars: string[],
): Algebra.Operation {
  if (vars.length === 0) {
    return op;
  }
  const pruneExtensions = (op: Algebra.Operation): Algebra.Operation => {
    if (op.type === 'extend') {
      if (vars.includes(op.variable.value)) {
        return pruneExtensions(op.input);
      }
      op.input = pruneExtensions(op.input);
      return op;
    }
    return op;
  };
  return pruneExtensions(op);
}

/**
 * Concat string following each other in the array
 * @param arr
 */
export function optimizeTemplateArray<T>(arr: T[]): (T | string)[] {
  const optimizedTemplate: (T | string)[] = [];
  for (const val of arr) {
    if (typeof val === 'string' && typeof optimizedTemplate.at(-1) === 'string') {
      const prev = <string> optimizedTemplate.pop();
      optimizedTemplate.push(prev + val);
    } else {
      optimizedTemplate.push(val);
    }
  }
  return optimizedTemplate;
}

/**
 * Converts an {@link TemplateIri} to a SPARQL algebra expression that, when evaluated,
 * produces the corresponding IRI term.
 *
 * The generated expression is: `IRI(CONCAT(STR(?var1), "str2", ...))`.
 *
 * @param AF - Algebra factory used to build expression nodes.
 * @param DF - Data factory used to create literal nodes for static string segments.
 * @param template - The IRI template to convert.
 */
export function templateIriToExpr(AF: AlgebraFactory, DF: DataFactory, template: TemplateIri): Algebra.Expression {
  return AF.createOperatorExpression('iri', [
    AF.createOperatorExpression(
      'concat',
      template.value.map((val) => {
        if (typeof val === 'string') {
          return AF.createTermExpression(DF.literal(val));
        }
        return AF.createOperatorExpression('str', [ AF.createTermExpression(val) ]);
      }),
    ),
  ]);
}

/**
 * Converts a {@link TemplateLiteral} to a SPARQL algebra expression that, when
 * evaluated, produces the corresponding typed literal.
 *
 * The generated expression is: `STRDT(CONCAT(STR(?var1), "str2", ...), <datatype>)`.
 *
 * @param AF - Algebra factory used to build expression nodes.
 * @param DF - Data factory used to create literal nodes for static string segments.
 * @param template - The literal template to convert.
 */
export function templateLiteralToExpr(AF: AlgebraFactory, DF: DataFactory, template: TemplateLiteral):
Algebra.Expression {
  return AF.createOperatorExpression('stdt', [
    AF.createOperatorExpression(
      'concat',
      template.value.map((val) => {
        if (typeof val === 'string') {
          return AF.createTermExpression(DF.literal(val));
        }
        return AF.createOperatorExpression('str', [ AF.createTermExpression(val) ]);
      }),
    ),
  ]);
}

/**
 * Converts a {@link TemplateBlank} to a SPARQL algebra expression that, when
 * evaluated, produces a skolemised blank-node identifier.
 *
 * The generated expression calls the internal named function
 * `internal://blank(?var1, ?var2, ...)`, which is later rewritten by
 * {@link internalBnodeAsSpecialLiteral} or {@link internalBnodeAsSpecialIri}.
 *
 * @param AF - Algebra factory used to build expression nodes.
 * @param DF - Data factory used to create the `internal://blank` named node.
 * @param template - The blank-node template to convert.
 */
export function templateBlankToExpr(AF: AlgebraFactory, DF: DataFactory, template: TemplateBlank): Algebra.Expression {
  return AF.createNamedExpression(
    DF.namedNode('internal://blank'),
    template.value.map(val => AF.createTermExpression(val)),
  );
}

/**
 * Converts a {@link TemplateQuad} to a SPARQL algebra expression using the `triple()`
 * operator, recursively converting each component (subject, predicate, object).
 *
 * @param AF - Algebra factory used to build expression nodes.
 * @param DF - Data factory forwarded to component conversion helpers.
 * @param template - The quad template to convert.
 */
export function templateQuadToExpr(AF: AlgebraFactory, DF: DataFactory, template: TemplateQuad): Algebra.Expression {
  return AF.createOperatorExpression('triple', [ template.subject, template.predicate, template.object ]
    .map(x => templateToExpr(AF, DF, x)));
}

/**
 * Dispatches to the appropriate template-to-expression converter based on the
 * concrete type of `template`.
 *
 * If `template` is a plain {@link RDF.Term} it is wrapped in a term expression
 * directly.  Otherwise the `subType` discriminant is used to call the matching
 * helper:
 * - `'NamedNode'` → {@link templateIriToExpr}
 * - `'Literal'`   → {@link templateLiteralToExpr}
 * - `'BlankNode'` → {@link templateBlankToExpr}
 * - `'Quad'`      → {@link templateQuadToExpr}
 *
 * @param AF - Algebra factory used to build expression nodes.
 * @param DF - Data factory forwarded to component conversion helpers.
 * @param template - The template or plain RDF term to convert.
 */
export function templateToExpr(AF: AlgebraFactory, DF: DataFactory, template: Template | RDF.Term): Algebra.Expression {
  if (isRdfTerm(template)) {
    return AF.createTermExpression(template);
  }
  switch (template.subType) {
    case 'NamedNode':
      return templateIriToExpr(AF, DF, template);
    case 'Literal':
      return templateLiteralToExpr(AF, DF, template);
    case 'BlankNode':
      return templateBlankToExpr(AF, DF, template);
    case 'Quad':
      return templateQuadToExpr(AF, DF, template);
  }
}
