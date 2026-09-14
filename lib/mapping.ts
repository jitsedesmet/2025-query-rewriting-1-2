/* eslint-disable jsdoc/check-param-names */
import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import {
  EXTENSION_FUNCTION_BNODE,
  EXTENSION_FUNCTION_BNODE_PUBLIC,
  VAR_PREFIX_MAPPING,
  VAR_PREFIX_MERGED_HEAD,
} from './consts.js';
import type { TransformContext } from './transformContext.js';
import { createPartialContext, parseQuery, prefixVarsInOperation } from './transformContext.js';
import type { Mapping, MappingHead } from './types.js';
import { withCpVars } from './utils/certainlyBoundVars.js';
import { unstableOperators } from './utils/expressionHelpers.js';
import { collectVariableNames } from './utils.js';

/**
 * @fileoverview Building the {@link Mapping} the unfolding runs on, out of SPARQL CONSTRUCT queries.
 *
 * A mapping is a GAV expression: its *head* is one RDF 1.2 triple pattern and its *body* the RDF 1.1 query
 * producing the values that head is instantiated with. The unfolding wants exactly one triple in that head,
 * which is a restriction on the internal shape rather than on what a caller may write: a CONSTRUCT
 * instantiates every triple of its template once per solution of its body, so a template of N triples
 * denotes precisely the union of the N single-triple CONSTRUCTs over that same body, and
 * {@link mappingFromConstructQueries} performs that split itself.
 *
 * Several mappings are merged into a single one over the generic `?m_s ?m_p ?m_o` head, each body binding
 * those three variables to the head it came from and the bodies joined by a UNION. **A lone mapping keeps
 * its own head**, which pins the positions the head writes constants in and so lets the unfolding decide
 * far more about a pattern than the generic head ever could.
 *
 * Two restrictions live here rather than in the passes, because they are properties of the mapping and can
 * be checked once, when it is built:
 *
 * - **No unstable function in the body** ({@link unstableOperators}). The unfolding evaluates a body once
 *   per user pattern it is unfolded into, so a function that answers differently on two evaluations makes
 *   the unfolded query disagree with the mapped graph it stands for. `NOW` is deliberately allowed, SPARQL
 *   1.1 §17.4.5.1 fixing it per query execution.
 * - **Only the head positions RDF admits**, checked per triple of the template.
 */

/** The factories building a mapping needs; the solver and the generator of a full context play no part. */
type MappingConstructionTools = Pick<TransformContext, 'parser' | 'AF' | 'DF' | 'astTransformer'>;

/** The term types each position of a mapping head admits, in subject / predicate / object order. */
const admissibleHeadTermTypes: [
  MappingHead['subject']['termType'][],
  MappingHead['predicate']['termType'][],
  MappingHead['object']['termType'][],
] = [
  [ 'Variable', 'NamedNode' ],
  [ 'Variable', 'NamedNode' ],
  [ 'NamedNode', 'Variable', 'Literal', 'Quad' ],
];

/**
 * Asserts that every position of a template triple holds a term that position admits, recursing into a
 * triple term the object writes.
 * @param templateTriple - The template triple to check
 * @throws Error naming the position and the term type it cannot hold
 */
function assertTemplateTriplePositionsAreAdmissible(templateTriple: RDF.BaseQuad): void {
  const positionTerms = [ templateTriple.subject, templateTriple.predicate, templateTriple.object ];
  for (const [ positionIndex, positionTerm ] of positionTerms.entries()) {
    if (!(<string[]> admissibleHeadTermTypes[positionIndex]).includes(positionTerm.termType)) {
      throw new Error(`Invalid Template, cannot use ${positionTerm.termType} in this position.`);
    }
    if (positionTerm.termType === 'Quad') {
      assertTemplateTriplePositionsAreAdmissible(positionTerm);
    }
  }
}

/**
 * Asserts that a mapping body calls no function whose value is not a function of its arguments.
 * @param body - The mapping body to check
 * @throws Error naming the offending function
 */
function assertBodyCallsNoUnstableFunction(body: Algebra.Operation): void {
  algebraUtils.visitOperationSub(body, {}, {
    expression: { operator: { visitor: (operatorExpression) => {
      if (unstableOperators.has(operatorExpression.operator)) {
        throw new Error(`The ${operatorExpression.operator.toUpperCase()} function cannot be used in a mapping body: it answers differently each time the body is evaluated, while the mapping has to denote one fixed graph.`);
      }
    } }},
    // A mapping body may contain any path.
  });
}

/**
 * Rewrites the public `bnodeConsistent` extension function to the internal IRI every pass recognises.
 * @param tools - The factories to build with
 * @param body - The mapping body to rewrite
 * @returns the body, calling {@link EXTENSION_FUNCTION_BNODE} where it called the public IRI
 */
function withPublicBnodeFunctionRewrittenToInternal<T extends Algebra.Operation>(
  { AF, DF }: Pick<MappingConstructionTools, 'AF' | 'DF'>,
  body: T,
): T {
  return algebraUtils.mapOperationSub<'unsafe', T>(body, {}, {
    expression: { named: { transform: (namedExpression) => {
      if (namedExpression.name.value === EXTENSION_FUNCTION_BNODE_PUBLIC) {
        return AF.createNamedExpression(DF.namedNode(EXTENSION_FUNCTION_BNODE), namedExpression.args);
      }
      return namedExpression;
    } }},
  });
}

/**
 * Builds the mapping one triple of a CONSTRUCT template denotes over that CONSTRUCT's body.
 * @param tools - The factories to build with
 * @param templateTriple - The one template triple becoming the head
 * @param constructBody - The WHERE clause of the CONSTRUCT, shared with the template's other triples
 * @returns the mapping
 * @throws Error if the template triple holds a term one of its positions does not admit
 */
function mappingOfSingleTemplateTriple(
  { AF, DF, astTransformer }: MappingConstructionTools,
  templateTriple: Algebra.Pattern,
  constructBody: Algebra.Operation,
): Mapping {
  assertTemplateTriplePositionsAreAdmissible(templateTriple);
  const head: MappingHead = <MappingHead> AF
    .createPattern(templateTriple.subject, templateTriple.predicate, templateTriple.object);

  const headVariableNames = [ ...collectVariableNames(astTransformer, head) ];
  // A CONSTRUCT only instantiates its template when every variable in that template is bound,
  // so solutions leaving a head variable unbound do not belong to the mapping.
  // Variables that are certainly bound already need no filter.
  const certainlyBoundVariableNames = withCpVars(constructBody).metadata.cVars;
  const variableNamesToAssertBound = headVariableNames
    .filter(name => !certainlyBoundVariableNames.has(name));
  let body: Algebra.Operation = constructBody;
  if (variableNamesToAssertBound.length > 0) {
    body = AF.createFilter(body, variableNamesToAssertBound
      .map(name => AF.createOperatorExpression('bound', [ AF.createTermExpression(DF.variable(name)) ]))
      .reduce((conjunction, expression) => AF.createOperatorExpression('&&', [ conjunction, expression ])));
  }
  return {
    head,
    body: AF.createProject(body, headVariableNames.map(name => DF.variable(name))),
  };
}

/**
 * Builds every single-triple mapping a CONSTRUCT query denotes.
 * @param tools - The factories to build with
 * @param constructQuery - The SPARQL CONSTRUCT query string
 * @returns one mapping per triple of the CONSTRUCT template
 * @throws Error if the body calls an unstable function, or the template holds an inadmissible term
 */
function mappingsOfConstructQuery(tools: MappingConstructionTools, constructQuery: string): Mapping[] {
  const construct = <Algebra.Construct> parseQuery(tools, constructQuery);
  const body = withPublicBnodeFunctionRewrittenToInternal(tools, construct.input);
  assertBodyCallsNoUnstableFunction(body);
  // The mappings share this body object, which is safe because `prefixVarsInOperation` copies what it
  // renames, so every mapping leaving `mappingFromConstructQueries` owns its own tree.
  return construct.template.map(templateTriple => mappingOfSingleTemplateTriple(tools, templateTriple, body));
}

/**
 * Merges several mappings into one over the generic `?m_s ?m_p ?m_o` head, each body binding those three
 * variables to the head it came from.
 * @param tools - The factories to build with
 * @param mappings - The mappings to merge, at least two
 * @returns the merged mapping
 */
function mergeMappingsOverGenericHead(
  { AF, DF }: MappingConstructionTools,
  mappings: readonly Mapping[],
): Mapping {
  const genericHeadVariables = [ 's', 'p', 'o' ]
    .map(position => DF.variable(`${VAR_PREFIX_MERGED_HEAD}${position}`));
  const [ genericSubject, genericPredicate, genericObject ] = genericHeadVariables;

  const bodiesBindingTheGenericHead = mappings.map(({ head, body }) => {
    const headPositionTerms = [ head.subject, head.predicate, head.object ];
    let bodyWithGenericHead: Algebra.Operation = body;
    for (const [ positionIndex, genericHeadVariable ] of genericHeadVariables.entries()) {
      bodyWithGenericHead = AF.createExtend(
        bodyWithGenericHead,
        genericHeadVariable,
        AF.createTermExpression(headPositionTerms[positionIndex]),
      );
    }
    return bodyWithGenericHead;
  });

  return {
    head: <MappingHead> AF.createPattern(genericSubject, genericPredicate, genericObject),
    body: AF.createProject(AF.createUnion(bodiesBindingTheGenericHead), genericHeadVariables),
  };
}

/**
 * Builds the {@link Mapping} a set of SPARQL CONSTRUCT queries denotes, splitting a template of several
 * triples into a mapping per triple and merging what is left into one generic head.
 * @param constructQueries - The SPARQL CONSTRUCT query strings defining the mappings
 * @returns the mapping, keeping its own head where there is exactly one and merged behind
 * `?m_s ?m_p ?m_o` otherwise
 * @throws Error if no CONSTRUCT is given, if a body calls an unstable function, or if a template holds a
 * term one of its positions does not admit
 * @example
 * const mapping = mappingFromConstructQueries([
 *   'CONSTRUCT { ?t rdf:reifies <<( ?s ?p ?o )>> } WHERE { ... }',
 *   'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o . FILTER(!isTriple(?o)) }',
 * ]);
 */
export function mappingFromConstructQueries(constructQueries: readonly string[]): Mapping {
  const tools = createPartialContext();
  const mappings = constructQueries
    .flatMap(constructQuery => mappingsOfConstructQuery(tools, constructQuery))
    .map(mapping => prefixVarsInOperation(tools, mapping, VAR_PREFIX_MAPPING));

  if (mappings.length === 0) {
    throw new Error('A mapping needs at least one CONSTRUCT query with at least one template triple.');
  }
  if (mappings.length === 1) {
    return mappings[0];
  }
  return mergeMappingsOverGenericHead(tools, mappings);
}
