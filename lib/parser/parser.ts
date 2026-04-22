import { sparqlCodepointEscape } from '@traqula/rules-sparql-1-1';
import { completeParseContext, copyParseContext } from '@traqula/rules-sparql-1-2';
import type { Query, Update } from '@traqula/rules-sparql-1-2';
import { ViewAstFactory } from './astFactory.js';
import { viewParserBuilder } from './grammar.js';
import { viewLexerBuilder } from './tokens.js';

/** Complete parse context including our custom ViewAstFactory */
function completeViewParseContext(
  partial: Record<string, any> = {},
): ReturnType<typeof completeParseContext> & { astFactory: ViewAstFactory } {
  const base = completeParseContext(partial);
  return { ...base, astFactory: new ViewAstFactory() };
}

type ViewParserInstance = ReturnType<typeof viewParserBuilder.build>;

/**
 * Extended SPARQL 1.2 parser that supports VIEW definitions and OVER patterns.
 */
export class ViewParser {
  private readonly parser: ViewParserInstance;
  private readonly defaultContext: ReturnType<typeof completeViewParseContext>;

  public constructor(args: Record<string, any> = {}) {
    this.defaultContext = completeViewParseContext(args.defaultContext ?? {});
    this.parser = <ViewParserInstance><unknown>viewParserBuilder.build({
      ...args,
      queryPreProcessor: sparqlCodepointEscape,
      tokenVocabulary: viewLexerBuilder.tokenVocabulary,
      // Unicode-flag regexes cannot be first-char optimized by Chevrotain;
      // disable the strict check so the lexer falls back to unoptimized mode.
      lexerConfig: { ensureOptimizations: false, ...(<any>args).lexerConfig },
    });
  }

  /**
   * Parse a SPARQL query string (supports VIEW in prologue and OVER in WHERE).
   */
  public parse(query: string, context: Record<string, any> = {}): Query | Update {
    const ctx = copyParseContext(<any>{ ...this.defaultContext, ...context });
    const ast = <Query | Update>(<any> this.parser).queryOrUpdate(query, ctx);
    return ast;
  }
}
