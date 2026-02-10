import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import type { Typed } from '@traqula/core';

export type TemplateIri = Typed & {
  type: 'template';
  subType: RDF.NamedNode['termType'];
  value: (string | RDF.Variable)[];
};

export type TemplateLiteral = Typed & {
  type: 'template';
  subType: RDF.Literal['termType'];
  value: (string | RDF.Variable)[];
} & Pick<RDF.Literal, 'datatype'>;

export type TemplateBlank = Typed & {
  type: 'template';
  subType: RDF.BlankNode['termType'];
  // Generate a new bnode based on the following vars.
  value: RDF.Variable[];
};

/**
 * Templates do not behave as variables. Rather they are terms that are constructed from variables.
 * This means that:
 */
export type TermTemplate =
  | TemplateIri
  | TemplateLiteral
  | TemplateBlank;

export type TemplateQuad = Typed & {
  type: 'template';
  subType: RDF.Quad['termType'];
  subject: Algebra.Pattern['subject'] | TermTemplate;
  predicate: Algebra.Pattern['predicate'] | TermTemplate;
  // Only allow MappingHead in object to comply with RDF
  object: Algebra.Pattern['object'] | Template;
  graph?: Algebra.Pattern['graph'] | TermTemplate;
};
export type MappingHead = TemplateQuad;

export type Template = TermTemplate | TemplateQuad;

export interface Mapping {
  head: MappingHead;
  body: Algebra.Project;
}
