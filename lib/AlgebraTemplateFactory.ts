import { AlgebraFactory } from '@traqula/algebra-transformations-1-2';

import type { MappingHead, TemplateIri } from './types.js';
import { optimizeTemplateArray } from './utils.js';

export class AlgebraTemplateFactory extends AlgebraFactory {
  public createTemplateIri(
    template: TemplateIri['value'],
  ): TemplateIri {
    return {
      type: 'template',
      subType: 'iri',
      value: optimizeTemplateArray(template),
    };
  }

  public createMappingHead(
    subject: MappingHead['subject'],
    predicate: MappingHead['predicate'],
    object: MappingHead['object'],
    graph?: MappingHead['graph'],
  ): MappingHead {
    return {
      type: 'mappingHead',
      subject,
      predicate,
      object,
      graph,
    };
  }
}
