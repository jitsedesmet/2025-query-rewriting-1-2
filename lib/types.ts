import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import type { Typed } from '@traqula/core';

export type TemplateIri = RDF.NamedNode;
export type TemplateLiteral = RDF.Literal;
export type TemplateBlank = RDF.BlankNode;
export type Templates = TemplateIri | TemplateBlank | TemplateLiteral;
export type MappingHead = Typed & {
  type: 'mappingHead';
  subject: Algebra.Pattern['subject'] | Templates;
  predicate: Algebra.Pattern['predicate'] | Templates;
  object: Algebra.Pattern['object'] | Templates | MappingHead;
  graph?: Algebra.Pattern['graph'] | Templates;
};

export interface Mapping {
  head: MappingHead;
  body: Algebra.Project;
}
