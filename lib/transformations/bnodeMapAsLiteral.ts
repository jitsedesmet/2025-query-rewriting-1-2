import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { DataFactory } from 'rdf-data-factory';
import { DT_INTERNAL_BNODE, EXTENSION_FUNCTION_BNODE, IRI_PREFIX_BNODE } from '../consts.js';
import type { TransformContext } from '../transformContext.js';

/**
 * Rewrites the internal blank-node named-expression into an expression that produces
 * a deterministic string key encoding the types and values of all key variables.
 *
 * The generated expression uses a big nested `IF` chain per variable to serialise each
 * possible term kind (IRI, language-direction literal, language literal, typed literal)
 * into a comma-separated string.  Commas and backslashes that appear in user values are
 * escaped with a backslash so the separator is unambiguous.
 *
 * If `hashFunc` is provided the resulting string is hashed before use.
 *
 * @param c          - The transformation context providing the algebra and data factories.
 * @param expression - The named expression to inspect and potentially rewrite.
 * @param hashFunc   - Optional hash function to apply to the concatenated key string.
 * @returns The rewritten expression, or the original expression unchanged when
 *          `expression.name` does not match `{@link EXTENSION_FUNCTION_BNODE}`.
 */
function expressionForConsistentConstruction(
  c: TransformContext,
  expression: Algebra.NamedExpression,
  hashFunc?: 'md5' | 'sha1' | 'sha256' | 'sha384' | 'sha512',
): Algebra.Expression {
  const { AF, DF } = c;

  /// ================== Helper functions ==============================
  function expressionLiteral(...args: Parameters<(typeof DataFactory)['prototype']['literal']>):
  Algebra.TermExpression {
    return AF.createTermExpression(DF.literal(...args));
  }

  // Return a big if
  function mapVariable(variable: RDF.Variable): Algebra.Expression {
    const varAsExpr = AF.createTermExpression(variable);
    // We assume the var is never bound to a bnode since we explicitly disallow BNODES.
    return AF.createOperatorExpression('if', [
      AF.createOperatorExpression('isiri', [ varAsExpr ]),
      AF.createOperatorExpression('concat', [
        expressionLiteral(',iri,'),
        escapeUserInput(AF.createOperatorExpression('str', [ varAsExpr ])),
      ]),
      AF.createOperatorExpression('if', [
        // We now know it is a literal
        AF.createOperatorExpression('haslangdir', [ varAsExpr ]),
        AF.createOperatorExpression('concat', [
          expressionLiteral(',literal@D,'),
          escapeUserInput(AF.createOperatorExpression('str', [ varAsExpr ])),
          expressionLiteral(','),
          escapeUserInput(AF.createOperatorExpression('lang', [ varAsExpr ])),
          expressionLiteral(','),
          escapeUserInput(AF.createOperatorExpression('langdir', [ varAsExpr ])),
        ]),
        AF.createOperatorExpression('if', [
          // We now know it is a literal
          AF.createOperatorExpression('haslang', [ varAsExpr ]),
          AF.createOperatorExpression('concat', [
            expressionLiteral(',literal@,'),
            escapeUserInput(AF.createOperatorExpression('str', [ varAsExpr ])),
            expressionLiteral(','),
            escapeUserInput(AF.createOperatorExpression('lang', [ varAsExpr ])),
          ]),
          AF.createOperatorExpression('concat', [
            expressionLiteral(',literal,'),
            escapeUserInput(AF.createOperatorExpression('str', [ varAsExpr ])),
            expressionLiteral(','),
            escapeUserInput(AF.createOperatorExpression('str', [
              AF.createOperatorExpression('datatype', [ varAsExpr ]),
            ])),
          ]),
        ]),
      ]),
    ]);
  }

  /**
   * Assert that the input does not use our value separator: `,` -> `\,`
   * Know that this means a string should not end in `\` since then we would also get `\,`
   */
  function escapeUserInput(val: Algebra.Expression): Algebra.Expression {
    const backslashEscaped = AF.createOperatorExpression('replace', [
      val,
      // Regex: matches one backslash
      expressionLiteral('\\\\'),
      // Replacement: outputs two backslashes
      expressionLiteral('\\\\\\\\'),
    ]);
    return AF.createOperatorExpression('replace', [
      backslashEscaped,
      expressionLiteral(','),
      expressionLiteral('\\\\,'),
    ]);
  }

  // ====================== Implementation ========================

  // Ignore non matching
  if (expression.name.value !== EXTENSION_FUNCTION_BNODE) {
    return expression;
  }

  // In case no vars are provided, we always make a new one (you likely never want this though....)
  let value = AF.createOperatorExpression('struuid', []);
  if (expression.args.length > 0) {
    // Make a big concat of conditionals
    value = AF.createOperatorExpression('concat', (<Algebra.TermExpression[]>expression.args)
      .sort((a, b) => (<RDF.Variable> a.term).value.localeCompare((<RDF.Variable> b.term).value))
      .map(expression => mapVariable(<RDF.Variable> expression.term)));
  }

  if (!hashFunc) {
    return value;
  }
  return AF.createOperatorExpression(hashFunc, [ value ]);
}

/**
 * Transforms all internal blank-node named expressions in `op` into SPARQL expressions
 * that produce a **typed literal** carrying the {@link DT_INTERNAL_BNODE} datatype.
 *
 * The generated expression is `STRDT(<key>, <DT_INTERNAL_BNODE>)` where `<key>` is
 * the deterministic concatenation produced by {@link expressionForConsistentConstruction}.
 *
 * Additionally, any `ISBLANK(?var)` operator is rewritten to
 * `DATATYPE(?var) = <DT_INTERNAL_BNODE>` so that blank-node checks continue to work
 * against the skolemised representation.
 *
 * @param c  - The transformation context.
 * @param op - The algebra operation to transform.
 * @returns The transformed operation.
 */
export function internalBnodeAsSpecialLiteral<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  const { AF, DF } = c;
  return algebraUtils.mapOperationSub<'unsafe', typeof op>(
    op,
    {},
    { expression: { named: {
      transform: (expression) => {
        const value = expressionForConsistentConstruction(c, expression);
        if (expression === value) {
          return expression;
        }
        return AF.createOperatorExpression('strdt', [
          value,
          AF.createTermExpression(DF.namedNode(DT_INTERNAL_BNODE)),
        ]);
      },
    }, operator: {
      transform: (expression) => {
        if (expression.operator !== 'isblank') {
          return expression;
        }

        return AF.createOperatorExpression('=', [
          AF.createOperatorExpression('datatype', expression.args),
          AF.createTermExpression(DF.literal(DT_INTERNAL_BNODE)),
        ]);
      },
    }}},
  );
}

/**
 * Transforms all internal blank-node named expressions in `op` into SPARQL expressions
 * that produce an **IRI** by hashing the key with SHA-1 and prepending
 * {@link IRI_PREFIX_BNODE}.
 *
 * The generated expression is `IRI(CONCAT(<IRI_PREFIX_BNODE>, SHA1(<key>)))`.
 *
 * Additionally, any `ISBLANK(?var)` operator is rewritten to
 * `ISIRI(?var) && STRSTARTS(STR(?var), <IRI_PREFIX_BNODE>)` so that blank-node checks
 * continue to work against the IRI-based skolemised representation.
 *
 * @param c  - The transformation context.
 * @param op - The algebra operation to transform.
 * @returns The transformed operation.
 */
export function internalBnodeAsSpecialIri<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  const { AF, DF } = c;
  return algebraUtils.mapOperationSub<'unsafe', typeof op>(
    op,
    {},
    { expression: { named: {
      transform: (expression) => {
        const value = expressionForConsistentConstruction(c, expression, 'sha1');
        if (expression === value) {
          return expression;
        }
        return AF.createOperatorExpression('iri', [
          AF.createOperatorExpression('concat', [
            AF.createTermExpression(DF.literal(IRI_PREFIX_BNODE)),
            value,
          ]),
        ]);
      },
    }, operator: {
      transform: (expression) => {
        if (expression.operator !== 'isblank') {
          return expression;
        }

        return AF.createOperatorExpression('&&', [
          AF.createOperatorExpression('isiri', expression.args),

          AF.createOperatorExpression('STRSTARTS', [
            AF.createOperatorExpression('str', expression.args),
            AF.createTermExpression(DF.literal(IRI_PREFIX_BNODE)),
          ]),
        ]);
      },
    }}},
  );
}
