import { AlgebraFactory } from '@traqula/algebra-transformations-1-2';

import type { MappingHead, TemplateBlank, TemplateIri, TemplateLiteral } from './types.js';
import { optimizeTemplateArray } from './utils.js';

/**
 * Extended AlgebraFactory with methods for creating template types.
 * Templates are used in mapping heads to represent terms that are
 * constructed from variable bindings at query execution time.
 */
export class AlgebraTemplateFactory extends AlgebraFactory {
  /**
   * Creates an IRI template that constructs an IRI from string parts and variables.
   * The template parts will be concatenated, with variables converted to strings.
   * @param template - Array of strings and variables to concatenate into an IRI
   * @returns A TemplateIri object
   * @example
   * AF.createTemplateIri(['http://example.org/person/', varId])
   * // Creates: IRI(CONCAT("http://example.org/person/", STR(?id)))
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
   * Creates a Literal template that constructs a typed literal from string parts and variables.
   * @param template - Array of strings and variables to concatenate into the literal value
   * @param datatype - The datatype IRI for the literal
   * @returns A TemplateLiteral object
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
   * Creates a BlankNode template that generates consistent blank nodes from variables.
   * The same combination of variable values will always produce the same blank node identity.
   * @param template - Array of variables whose values determine the blank node identity
   * @returns A TemplateBlank object
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
   * Creates a mapping head (quad template) from its components.
   * @param subject - The subject term or template
   * @param predicate - The predicate term or template
   * @param object - The object term or template (can include nested quad templates)
   * @param graph - Optional graph term or template
   * @returns A MappingHead (TemplateQuad) object
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
