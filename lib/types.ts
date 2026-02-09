import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import type { Typed } from '@traqula/core';

export type TemplateIri = Typed & {
  type: 'template';
  subType: 'iri';
  value: (string | RDF.Variable)[];
};

export type TemplateLiteral = Typed & {
  type: 'template';
  subType: 'literal';
  value: (string | RDF.Variable)[];
} & Pick<RDF.Literal, 'datatype'>;

export type TemplateBlank = Typed & {
  type: 'template';
  subType: 'blankNode';
  // Generate a new bnode based on the following vars.
  value: RDF.Variable[];
};

/**
 * Templates do not behave as variables. Rather they are terms that are constructed from variables.
 * This means that:
 */
export type Template =
  | TemplateIri
  | TemplateLiteral
  | TemplateBlank;

export type MappingHead = Typed & {
  type: 'mappingHead';
  subject: Algebra.Pattern['subject'] | Template;
  predicate: Algebra.Pattern['predicate'] | Template;
  // Only allow MappingHead in object to comply with RDF
  object: Algebra.Pattern['object'] | Template | MappingHead;
  graph?: Algebra.Pattern['graph'] | Template;
};

export interface Mapping {
  head: MappingHead;
  body: Algebra.Project;
}
