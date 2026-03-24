import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { algebraUtils } from '@traqula/algebra-transformations-1-2';
import type { DataFactory } from 'rdf-data-factory';
import { DT_INTERNAL_BNODE, EXTENSION_FUNCTION_BNODE } from '../consts.js';
import type { TransformContext } from '../transformContext.js';

/**
 * The contents of this expression is a bunch of vars:
 *   <internal://blank> ( ?m0_s , ?m0_p )
 * rewrite to:
 *   STRDT( ?m0_s, ?m0p,  <internal://bnodetype>)
 *   STRDT( CONCAT ( STR (?s), STR(?p) ), <internal://bnodetype> )
 * @param c
 * @param op
 */
export function internalBnodeAsSpecialLiteral<T extends Algebra.Operation>(c: TransformContext, op: T): T {
  const { AF, DF } = c;
  return algebraUtils.mapOperationSub<'unsafe', typeof op>(
    op,
    {},
    { expression: { named: {
      transform: (expression) => {
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
                escapeUserInput(AF.createOperatorExpression('lang', [ varAsExpr ])),
                escapeUserInput(AF.createOperatorExpression('langdir', [ varAsExpr ])),
              ]),
              AF.createOperatorExpression('if', [
                // We now know it is a literal
                AF.createOperatorExpression('haslang', [ varAsExpr ]),
                AF.createOperatorExpression('concat', [
                  expressionLiteral(',literal@,'),
                  escapeUserInput(AF.createOperatorExpression('str', [ varAsExpr ])),
                  escapeUserInput(AF.createOperatorExpression('lang', [ varAsExpr ])),
                ]),
                AF.createOperatorExpression('concat', [
                  expressionLiteral(',literal,'),
                  escapeUserInput(AF.createOperatorExpression('str', [ varAsExpr ])),
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
          value = AF.createOperatorExpression('concat', expression.args.map((expression) => {
            const casted = <Algebra.TermExpression> expression;
            return mapVariable(<RDF.Variable> casted.term);
          }));
        }

        return AF.createOperatorExpression('strdt', [
          value,
          AF.createTermExpression(DF.namedNode(DT_INTERNAL_BNODE)),
        ]);
      },
    }}},
  );
  // Now also write conditions
}
