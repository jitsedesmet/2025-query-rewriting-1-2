import { AlgebraFactory } from '@traqula/algebra-transformations-1-2';

import type { MappingHead } from './types.js';

export class AlgebraTemplateFactory extends AlgebraFactory {
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
