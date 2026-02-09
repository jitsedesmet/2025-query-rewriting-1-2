import { GeneratorBuilder } from '@traqula/core';
import { Generator, sparql12GeneratorBuilder } from '@traqula/generator-sparql-1-2';
import type { Query, SparqlGeneratorContext, Update } from '@traqula/rules-sparql-1-2';
import { datatypeBoolean } from '../utils.js';

/**
 * Since we generate a lot of `false` literals, let's make sure we print it as small as possible.
 */

const literalRule = sparql12GeneratorBuilder.getRule('rdfLiteral');

const alternativeLiteralGenerator: typeof literalRule = {
  name: 'rdfLiteral',
  gImpl: $ => (ast, c) => {
    const type = ast.langOrIri;
    const value = ast.value.toUpperCase();
    if (typeof type === 'object' && type.value === datatypeBoolean.value && (
      value === 'TRUE' || value === 'FALSE'
    )) {
      c.astFactory.printFilter(ast, () => $.PRINT_WORD(value));
    } else {
      literalRule.gImpl($)(ast, c);
    }
  },
};

const ownGeneratorBuilder = GeneratorBuilder.create(sparql12GeneratorBuilder)
  .patchRule(alternativeLiteralGenerator);
type OwnGenerator = ReturnType<(typeof ownGeneratorBuilder)['build']>;

export class MyGenerator extends Generator {
  private readonly myGenerator: OwnGenerator = ownGeneratorBuilder.build();

  public override generate(ast: Query | Update, context?: Partial<SparqlGeneratorContext>): string {
    return this.myGenerator.queryOrUpdate(ast, { ...this.defaultContext, ...context });
  }
}
