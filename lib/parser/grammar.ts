import type { ParserRule, Wrap } from '@traqula/core';
import { ParserBuilder } from '@traqula/core';
import { sparql12ParserBuilder } from '@traqula/parser-sparql-1-2';
import { gram as g11, lex as l11 } from '@traqula/rules-sparql-1-1';
import { gram as g12 } from '@traqula/rules-sparql-1-2';
import type { SparqlContext } from '@traqula/rules-sparql-1-2';
import type { ViewAstFactory } from './astFactory.js';
import { viewToken, overToken, bodyToken, monotoneToken, headToken } from './tokens.js';
import type * as TV from './types.js';

export type ViewSparqlContext = SparqlContext & { astFactory: ViewAstFactory };
export type SparqlGrammarRule<
  /**
   * Name of grammar rule, should be a strict subtype of string like 'myGrammarRule'.
   */
  NameType extends string = string,
  /**
   * Type that will be returned after a correct parse of this rule.
   * This type will be the return type of calling SUBRULE with this grammar rule.
   */
  ReturnType = unknown,
  /**
   * Function arguments that can be given to convey the state of the current parse operation.
   */
  ParamType extends any[] = [],
> = ParserRule<ViewSparqlContext, NameType, ReturnType, ParamType>;

/**
 * Parses a single HEAD { triplesTemplate } BODY groupGraphPattern pair.
 */
const viewPair: SparqlGrammarRule<'viewPair', Wrap<TV.ViewPair>> = {
  name: 'viewPair',
  impl: ({ ACTION, CONSUME, SUBRULE }) => (c) => {
    const headT = CONSUME(headToken);
    CONSUME(l11.symbols.LCurly);
    const head = SUBRULE(g11.triplesTemplate);
    CONSUME(l11.symbols.RCurly);
    CONSUME(bodyToken);
    const body = SUBRULE(g11.groupGraphPattern);
    return ACTION(() => c.astFactory.wrap(c.astFactory.viewPair(head, body), c.astFactory.sourceLocation(headT, body)));
  },
};

/**
 * Parses a VIEW declaration:
 *   MONOTONE? VIEW iri { viewPair+ }
 */
const viewDecl: SparqlGrammarRule<'viewDecl', TV.ContextDefinitionView> = {
  name: 'viewDecl',
  impl: ({ ACTION, CONSUME, SUBRULE, OPTION, AT_LEAST_ONE }) => (c) => {
    const monotone = OPTION(() => CONSUME(monotoneToken));
    const view = CONSUME(viewToken);
    const name = SUBRULE(g11.iri);
    CONSUME(l11.symbols.LCurly);
    const pairs: Wrap<TV.ViewPair>[] = [];
    AT_LEAST_ONE(() => pairs.push(SUBRULE(viewPair)));
    const close = CONSUME(l11.symbols.RCurly);
    return ACTION(() => c.astFactory.viewDefinition(
      name,
      monotone !== undefined,
      pairs.map(x => x.val),
      c.astFactory.sourceLocation(monotone, view, close),
    ));
  },
};

const prologuePatch: SparqlGrammarRule<typeof g12.prologue['name'], TV.ContextDefinition[]> = {
  name: 'prologue',
  impl: ({ SUBRULE, MANY, OR }) => () => {
    const result: TV.ContextDefinition[] = [];
    MANY(() => OR([
      { ALT: () => result.push(SUBRULE(g11.baseDecl)) },
      { ALT: () => result.push(SUBRULE(g11.prefixDecl)) },
      { ALT: () => result.push(SUBRULE(g12.versionDecl)) },
      { ALT: () => result.push(SUBRULE(viewDecl)) },
    ]));
    return result;
  },
};

/**
 * Parses an OVER operation: OVER iri groupGraphPattern
 */
export const overGraphPattern: SparqlGrammarRule<'overGraphPattern', TV.PatternOver> = {
  name: 'overGraphPattern',
  impl: ({ ACTION, CONSUME, SUBRULE }) => (c): TV.PatternOver => {
    const overKeyword = CONSUME(overToken);
    const name = SUBRULE(g11.iri);
    const pattern = SUBRULE(g11.groupGraphPattern);
    return ACTION(() => c.astFactory.patternOver(
      name,
      pattern,
      c.astFactory.sourceLocation(overKeyword, pattern),
    ));
  },
};

/**
 * Patched graphPatternNotTriples — adds OVER as an additional alternative.
 */
export const graphPatternNotTriples: SparqlGrammarRule<typeof g11.graphPatternNotTriples['name'], TV.Pattern> = {
  name: 'graphPatternNotTriples',
  impl: $ => c => $.OR2([
    { ALT: () => $.SUBRULE(overGraphPattern) },
    { ALT: () => <TV.Pattern> g11.graphPatternNotTriples.impl($)(c) },
  ]),
};

/**
 * Extended parser builder that adds VIEW and OVER support on top of SPARQL 1.2.
 */
export const viewParserBuilder = ParserBuilder
  .create(sparql12ParserBuilder)
  .widenContext<ViewSparqlContext>()
  .addRule(viewPair)
  .addRule(viewDecl)
  .addRule(overGraphPattern)
  .patchRule(prologuePatch)
  .patchRule(graphPatternNotTriples)
  .typePatch<{
    /// GeneralFile
    queryOrUpdate: [ TV.SparqlQuery];
    /// Query Unit file
    [g11.selectQuery.name]: [Omit<TV.QuerySelect, g11.HandledByBase>];
    [g11.subSelect.name]: [ Omit<TV.SubSelect, 'prefixes'>];
    [g11.selectClause.name]: [Wrap<Pick<TV.QuerySelect, 'variables' | 'distinct' | 'reduced'>>];
    [g11.constructQuery.name]: [Omit<TV.QueryConstruct, g11.HandledByBase>];
    [g11.describeQuery.name]: [Omit<TV.QueryDescribe, g11.HandledByBase>];
    [g11.askQuery.name]: [Omit<TV.QueryAsk, g11.HandledByBase>];
    [g11.valuesClause.name]: [TV.PatternValues[] | undefined];
    [g11.constructTemplate.name]: [Wrap<TV.PatternBgp>];
    [g11.constructTriples.name]: [TV.PatternBgp];
    /// Update Unit file
    [g11.update1.name]: [TV.UpdateOperation];
    [g11.load.name]: [TV.UpdateOperationLoad];
    [g11.clear.name]: [TV.UpdateOperationClear];
    [g11.drop.name]: [TV.UpdateOperationDrop];
    [g11.create.name]: [TV.UpdateOperationCreate];
    [g11.add.name]: [TV.UpdateOperationAdd];
    [g11.move.name]: [TV.UpdateOperationMove];
    [g11.copy.name]: [TV.UpdateOperationCopy];
    [g11.quadPattern.name]: [Wrap<TV.Quads[]>];
    [g11.quadData.name]: [Wrap<TV.Quads[]>];
    [g11.insertData.name]: [TV.UpdateOperationInsertData];
    [g11.deleteData.name]: [TV.UpdateOperationDeleteData];
    [g11.deleteWhere.name]: [TV.UpdateOperationDeleteWhere];
    [g11.modify.name]: [TV.UpdateOperationModify];
  }>();
