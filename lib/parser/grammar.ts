import { ParserBuilder } from '@traqula/core';
import { sparql12ParserBuilder } from '@traqula/parser-sparql-1-2';
import { gram as g11, lex as l11 } from '@traqula/rules-sparql-1-1';
import { gram as g12, type SparqlContext } from '@traqula/rules-sparql-1-2';
import type { ViewAstFactory } from './astFactory.js';
import { viewToken, overToken, headToken, bodyToken, monotoneToken } from './tokens.js';
import type { PatternOver } from './types.js';

type ViewSparqlContext = SparqlContext & { astFactory: ViewAstFactory };

/**
 * Parses a single HEAD { triplesTemplate } BODY groupGraphPattern pair.
 */
const viewPair = {
  name: <const>'viewPair',
  impl: ({ ACTION, CONSUME, SUBRULE }: any) => (C: ViewSparqlContext) => {
    CONSUME(headToken);
    CONSUME(l11.symbols.LCurly);
    const head = SUBRULE(g11.triplesTemplate);
    CONSUME(l11.symbols.RCurly);
    CONSUME(bodyToken);
    const body = SUBRULE(g11.groupGraphPattern);
    return ACTION(() => C.astFactory.viewPair(head, body));
  },
};

/**
 * Parses a VIEW declaration:
 *   MONOTONE? VIEW iri { viewPair+ }
 */
const viewDecl = {
  name: <const>'viewDecl',
  impl: ({ ACTION, CONSUME, SUBRULE, _MANY, OPTION, AT_LEAST_ONE }: any) => (C: ViewSparqlContext) => {
    const monotone = OPTION(() => CONSUME(monotoneToken));
    CONSUME(viewToken);
    const name = SUBRULE(g11.iri);
    const open = CONSUME(l11.symbols.LCurly);
    const pairs: any[] = [];
    AT_LEAST_ONE(() => pairs.push(SUBRULE(viewPair)));
    const close = CONSUME(l11.symbols.RCurly);
    return ACTION(() => C.astFactory.viewDefinition(
      name,
      monotone !== undefined,
      pairs,
      C.astFactory.sourceLocation(monotone, open, close),
    ));
  },
};

/**
 * Patched prologue rule — extends SPARQL 1.2 prologue with VIEW declarations.
 */
const prologuePatch = {
  name: <const>'prologue',
  impl: ({ _ACTION, SUBRULE, MANY, OR }: any) => (_C: any) => {
    const result: any[] = [];
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
export const overGraphPattern = {
  name: <const>'overGraphPattern',
  impl: ({ ACTION, CONSUME, SUBRULE }: any) => (C: ViewSparqlContext): PatternOver => {
    const overKeyword = CONSUME(overToken);
    const name = SUBRULE(g11.iri);
    const pattern = SUBRULE(g11.groupGraphPattern);
    return ACTION(() => C.astFactory.patternOver(
      name,
      pattern,
      C.astFactory.sourceLocation(overKeyword, pattern),
    ));
  },
};

/**
 * Patched graphPatternNotTriples — adds OVER as an additional alternative.
 */
const graphPatternNotTriplesPatch = {
  name: <const>'graphPatternNotTriples',
  impl: ({ SUBRULE, OR }: any) => () => OR([
    { ALT: () => SUBRULE(g11.groupOrUnionGraphPattern) },
    { ALT: () => SUBRULE(g11.optionalGraphPattern) },
    { ALT: () => SUBRULE(g11.minusGraphPattern) },
    { ALT: () => SUBRULE(g11.graphGraphPattern) },
    { ALT: () => SUBRULE(g11.serviceGraphPattern) },
    { ALT: () => SUBRULE(g11.filter) },
    { ALT: () => SUBRULE(g11.bind) },
    { ALT: () => SUBRULE(g11.inlineData) },
    { ALT: () => SUBRULE(overGraphPattern) },
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
  .patchRule(graphPatternNotTriplesPatch);
