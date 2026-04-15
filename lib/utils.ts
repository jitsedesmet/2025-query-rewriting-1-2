import type * as RDF from '@rdfjs/types';
import type { AlgebraFactory } from '@traqula/algebra-transformations-1-2';
import { Algebra } from '@traqula/algebra-transformations-1-2';
import type { Typed } from '@traqula/core';
import { DataFactory } from 'rdf-data-factory';
import { EXTENSION_FUNCTION_BNODE } from './consts.js';
import type { RangedVar } from './RangeSet.js';
import type { TransformContext } from './transformContext.js';
import type { MappingHead, Template, TemplateBlank, TemplateIri, TemplateLiteral, TemplateQuad } from './types.js';

/**
 * Thrown when a triple pattern cannot be matched to a mapper — i.e. a normal,
 * expected "no-match" outcome.  Only this error class is caught during the
 * UNION-of-JOINs DFS; all other exceptions (TypeError, etc.) propagate so
 * genuine bugs are never silently swallowed.
 */
export class RewriteNoMatchError extends Error {
  public override name = 'RewriteNoMatchError';
}

/** Shared DataFactory instance for creating RDF terms */
export const DF = new DataFactory();

/** XSD namespace URI */
export const xsd = 'http://www.w3.org/2001/XMLSchema#';

/** XSD boolean datatype as a NamedNode */
export const datatypeBoolean = DF.namedNode(`${xsd}boolean`);

/** XSD string datatype as a NamedNode */
export const datatypeString = DF.namedNode(`${xsd}string`);

/** The literal `false` with xsd:boolean datatype, used for FILTER(FALSE) patterns */
export const termFalse = DF.literal('false', datatypeBoolean);

/**
 * Checks if an operation is a FILTER(FALSE) pattern.
 * FILTER(FALSE) is used as a sentinel to represent patterns that will never match.
 * @param c - Transform context
 * @param op - The operation to check
 * @returns True if the operation is FILTER(FALSE)
 */
export function isFilterFalse(c: TransformContext, op: Algebra.Operation): boolean {
  return op.type === Algebra.Types.FILTER && op.expression.subType === Algebra.ExpressionTypes.TERM &&
    op.expression.term.equals(termFalse);
}

/**
 * Creates a FILTER(FALSE) operation, used to represent an empty result set.
 * In SPARQL algebra, FILTER(FALSE) is equivalent to the empty multiset
 * and is absorbing for JOIN and identity for UNION.
 * @param c - Transform context
 * @param op - Optional input operation (defaults to empty BGP)
 * @returns A Filter operation with FALSE as the condition
 */
export function createFilterFalse(c: TransformContext, op?: Algebra.Operation): Algebra.Filter {
  return c.AF.createFilter(op ?? c.AF.createBgp([]), c.AF.createTermExpression(termFalse));
}

/**
 * Type guard to check if an object is an RDF term.
 * @param obj - Object to check
 * @returns True if the object has a termType property
 */
export function isRdfTerm(obj: object): obj is RDF.Term {
  return 'termType' in obj && typeof obj.termType === 'string';
}

/**
 * Type guard to check if an object is an RDF Quad (triple term).
 * @param obj - Object to check
 * @returns True if the object is a Quad term
 */
export function isRdfQuad(obj: object): obj is RDF.Quad {
  return isRdfTerm(obj) && obj.termType === 'Quad';
}

/**
 * Type guard to check if an object is an RDF Variable (potentially with range).
 * @param obj - Object to check
 * @returns True if the object is a Variable term
 */
export function isRdfVar(obj: object): obj is RangedVar {
  return isRdfTerm(obj) && obj.termType === 'Variable';
}

/**
 * Type guard to check if an object is the default graph.
 * @param obj - Object to check
 * @returns True if the object is the DefaultGraph
 */
export function isRdfDefaultGraph(obj: object): obj is RDF.DefaultGraph {
  return isRdfTerm(obj) && obj.termType === 'DefaultGraph';
}

/**
 * Type guard to check if an object is a Typed structure.
 * @param obj - Object to check
 * @returns True if the object has type (and optionally subType) string properties
 */
export function isTyped(obj: object): obj is Typed {
  return 'type' in obj && typeof obj.type === 'string' && (
    !('subType' in obj) || typeof obj.subType === 'string'
  );
}

/**
 * Type guard to check if an object is a MappingHead.
 * @param obj - Object to check
 * @returns True if the object is a mapping head template
 */
export function isMappingHead(obj: object): obj is MappingHead {
  return isTyped(obj) && obj.type === 'template' && 'subType' in obj && obj.subType === 'Quad';
}

/**
 * Checks if a term is fully static (contains no variables).
 * For Quads, recursively checks all components.
 * @param term - The term to check
 * @returns True if the term contains no variables
 */
export function termIsStaticTerm(term: RDF.Term): boolean {
  if (term.termType === 'Quad') {
    return termIsStaticTerm(term.subject) && termIsStaticTerm(term.predicate) && termIsStaticTerm(term.object);
  }
  return term.termType !== 'Variable';
}

/**
 * Extracts direct variable assignments from EXTEND operations.
 * Only collects assignments where the expression is a simple term (Literal or NamedNode).
 * @param c - Transform context
 * @param op - The operation to search
 * @returns A record mapping variable names to their assigned terms
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
 * Removes EXTEND operations for specified variables from an operation tree.
 * Modifies the tree in place.
 * @param c - Transform context
 * @param op - The operation to modify
 * @param vars - Variable names whose extensions should be removed
 * @returns The modified operation
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
 * Optimizes a template array by concatenating adjacent string values.
 * This reduces the number of CONCAT operations needed when generating SPARQL.
 * @param arr - Array of template components (strings and variables)
 * @returns Optimized array with adjacent strings merged
 * @example
 * optimizeTemplateArray(['http://', 'example.org/', varX])
 * // Returns: ['http://example.org/', varX]
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
 * Converts a TemplateIri to a SPARQL IRI() expression.
 * Creates: IRI(CONCAT(str1, STR(?var1), str2, ...))
 * @param AF - Algebra factory for creating expressions
 * @param DF - Data factory for creating RDF terms
 * @param template - The IRI template to convert
 * @returns An Expression that constructs the IRI at runtime
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
 * Converts a TemplateLiteral to a SPARQL STRDT() expression.
 * Creates: STRDT(CONCAT(str1, STR(?var1), ...), datatype)
 * @param AF - Algebra factory for creating expressions
 * @param DF - Data factory for creating RDF terms
 * @param template - The literal template to convert
 * @returns An Expression that constructs the typed literal at runtime
 */
export function templateLiteralToExpr(AF: AlgebraFactory, DF: DataFactory, template: TemplateLiteral):
Algebra.Expression {
  return AF.createOperatorExpression('strdt', [
    AF.createOperatorExpression(
      'concat',
      template.value.map((val) => {
        if (typeof val === 'string') {
          return AF.createTermExpression(DF.literal(val));
        }
        return AF.createOperatorExpression('str', [ AF.createTermExpression(val) ]);
      }),
    ),
    AF.createTermExpression(template.datatype),
  ]);
}

/**
 * Converts a TemplateBlank to an internal blank node expression.
 * Creates: <internal://blank>(?var1, ?var2, ...)
 * This internal function will be further transformed by bnode transformation passes.
 * @param AF - Algebra factory for creating expressions
 * @param DF - Data factory for creating RDF terms
 * @param template - The blank node template to convert
 * @returns A NamedExpression representing the blank node construction
 */
export function templateBlankToExpr(AF: AlgebraFactory, DF: DataFactory, template: TemplateBlank): Algebra.Expression {
  return AF.createNamedExpression(
    DF.namedNode(EXTENSION_FUNCTION_BNODE),
    template.value.map(val => AF.createTermExpression(val)),
  );
}

/**
 * Converts a TemplateQuad to a SPARQL TRIPLE() expression.
 * Creates: TRIPLE(subject_expr, predicate_expr, object_expr)
 * @param AF - Algebra factory for creating expressions
 * @param DF - Data factory for creating RDF terms
 * @param template - The quad template to convert
 * @returns An Expression that constructs the triple term at runtime
 */
export function templateQuadToExpr(AF: AlgebraFactory, DF: DataFactory, template: TemplateQuad): Algebra.Expression {
  return AF.createOperatorExpression('triple', [ template.subject, template.predicate, template.object ]
    .map(x => templateToExpr(AF, DF, x)));
}

/**
 * Converts any template or RDF term to its corresponding SPARQL expression.
 * Dispatches to the appropriate template-to-expression function based on type.
 * @param AF - Algebra factory for creating expressions
 * @param DF - Data factory for creating RDF terms
 * @param template - The template or term to convert
 * @returns An Expression representing the template or a simple TermExpression
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
