import { AlgebraFactory } from '@traqula/algebra-transformations-1-2';

import type { MappingHead, TemplateBlank, TemplateIri, TemplateLiteral } from './types.js';
import { optimizeTemplateArray } from './utils.js';

export class AlgebraTemplateFactory extends AlgebraFactory {
  public createTemplateIri(
    template: TemplateIri['value'],
  ): TemplateIri {
    return {
      type: 'template',
      subType: 'NamedNode',
      value: optimizeTemplateArray(template),
    };
  }

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

  public createTemplateBlank(
    template: TemplateBlank['value'],
  ): TemplateBlank {
    return {
      type: 'template',
      subType: 'BlankNode',
      value: template,
    };
  }

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
