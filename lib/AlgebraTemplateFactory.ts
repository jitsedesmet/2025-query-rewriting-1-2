import { AlgebraFactory } from '@traqula/algebra-transformations-1-2';

import type { MappingHead, TemplateBlank, TemplateIri, TemplateLiteral } from './types.js';
import { optimizeTemplateArray } from './utils.js';

/**
 * Extends the base {@link AlgebraFactory} with factory methods for the additional
 * template node types introduced by the query-rewriting layer:
 * {@link TemplateIri}, {@link TemplateLiteral}, {@link TemplateBlank}, and
 * {@link MappingHead}.
 *
 * Adjacent static string segments in template value arrays are merged by
 * {@link optimizeTemplateArray} to keep generated expressions compact.
 */
export class AlgebraTemplateFactory extends AlgebraFactory {
  /**
   * Creates an {@link TemplateIri} node whose value is the concatenation of the
   * provided string segments and variable references.
   *
   * Adjacent string literals in `template` are merged automatically.
   *
   * @param template - Alternating static strings and SPARQL variables that form the IRI.
   */
  public createTemplateIri(
    template: TemplateIri['value'],
  ): TemplateIri {
    return {
      type: 'template',
      subType: 'NamedNode',
      value: optimizeTemplateArray(template),
    };
  }

  /**
   * Creates a {@link TemplateLiteral} node whose lexical form is the concatenation of
   * the provided string segments and variable references, with a fixed `datatype`.
   *
   * Adjacent string literals in `template` are merged automatically.
   *
   * @param template - Alternating static strings and SPARQL variables forming the lexical form.
   * @param datatype - The datatype IRI for the resulting literal.
   */
  public createTemplateLiteral(
    template: TemplateLiteral['value'],
    datatype: TemplateLiteral['datatype'],
  ): TemplateLiteral {
    return {
      type: 'template',
      subType: 'Literal',
      value: optimizeTemplateArray(template),
      datatype,
    };
  }

  /**
   * Creates a {@link TemplateBlank} node that will produce a skolemised blank node
   * whose identity is determined by the provided variables.
   *
   * @param template - The variables whose bindings are used as the key for blank-node identity.
   */
  public createTemplateBlank(
    template: TemplateBlank['value'],
  ): TemplateBlank {
    return {
      type: 'template',
      subType: 'BlankNode',
      value: template,
    };
  }

  /**
   * Creates a {@link MappingHead} (a {@link TemplateQuad}) that represents the head
   * of a mapping rule.
   *
   * @param subject   - The subject position: an algebra term or a {@link TermTemplate}.
   * @param predicate - The predicate position: an algebra term or a {@link TermTemplate}.
   * @param object    - The object position: an algebra term or any {@link Template}.
   * @param graph     - Optional graph position: an algebra term or a {@link TermTemplate}.
   */
  public createMappingHead(
    subject: MappingHead['subject'],
    predicate: MappingHead['predicate'],
    object: MappingHead['object'],
    graph?: MappingHead['graph'],
  ): MappingHead {
    return {
      type: 'template',
      subType: 'Quad',
      subject,
      predicate,
      object,
      graph,
    };
  }
}
