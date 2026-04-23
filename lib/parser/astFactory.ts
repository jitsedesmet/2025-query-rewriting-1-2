import type { SourceLocation } from '@traqula/core';
import { AstFactory as Sparql12AstFactory } from '@traqula/rules-sparql-1-2';
import type { TermIri, PatternBgp, PatternGroup } from '@traqula/rules-sparql-1-2';
import type { ContextDefinitionView, ViewPair, PatternOver } from './types.js';

/**
 * Extended AstFactory that adds support for VIEW definitions and OVER patterns.
 */
export class ViewAstFactory extends Sparql12AstFactory {
  public viewDefinition(
    name: TermIri,
    monotone: boolean,
    pairs: ViewPair[],
    loc: SourceLocation,
  ): ContextDefinitionView {
    return { type: 'contextDef', subType: 'view', name, monotone, pairs, loc };
  }

  public isViewDefinition(obj: object): obj is ContextDefinitionView {
    return this.isOfSubType(obj, 'contextDef', 'view');
  }

  public patternOver(name: TermIri, pattern: PatternGroup, loc: SourceLocation): PatternOver {
    return { type: 'pattern', subType: 'over', name, pattern, loc };
  }

  public isPatternOver(obj: object): obj is PatternOver {
    return this.isOfSubType(obj, 'pattern', 'over');
  }

  /** Creates a VIEW pair (HEAD + BODY) */
  public viewPair(head: PatternBgp, body: PatternGroup): ViewPair {
    return { head, body };
  }
}
