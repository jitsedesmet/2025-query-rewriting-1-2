import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import type { Typed } from '@traqula/core';

/**
 * A term template that, when evaluated, constructs an IRI from a mix of
 * static string segments and SPARQL variables.
 *
 * Example: the construct template `<http://example.org/{?type}>` would be
 * represented with `value: ['http://example.org/', variable(?type)]`.
 */
export type TemplateIri = Typed & {
  type: 'template';
  subType: RDF.NamedNode['termType'];
  value: (string | RDF.Variable)[];
};

/**
 * A term template that, when evaluated, constructs an RDF literal from a mix
 * of static string segments and SPARQL variables, combined with a fixed datatype.
 *
 * The lexical form of the resulting literal is the concatenation of all parts
 * in {@link value} after resolving the variables, and the datatype is taken from
 * {@link TemplateLiteral.datatype}.
 */
export type TemplateLiteral = Typed & {
  type: 'template';
  subType: RDF.Literal['termType'];
  value: (string | RDF.Variable)[];
} & Pick<RDF.Literal, 'datatype'>;

/**
 * A term template that, when evaluated, creates a blank node whose identity is
 * deterministically derived from the provided SPARQL variables.
 *
 * The variables in {@link value} serve as the key material; identical variable
 * bindings always produce the same blank-node identifier (skolemisation).
 */
export type TemplateBlank = Typed & {
  type: 'template';
  subType: RDF.BlankNode['termType'];
  // Generate a new bnode based on the following vars.
  value: RDF.Variable[];
};

/**
 * A union of all non-quad term templates.
 *
 * Templates do not behave as variables. Rather they are terms that are constructed from variables.
 * This means that:
 * - They participate in query rewriting by generating SPARQL expressions (e.g. `IRI(CONCAT(...))`)
 *   rather than being substituted directly.
 * - A single template can be shared across multiple variable clusters.
 */
export type TermTemplate =
  | TemplateIri
  | TemplateLiteral
  | TemplateBlank;

/**
 * A template for an RDF quad (i.e. a quoted triple in RDF 1.2 / SPARQL 1.2).
 *
 * Each component position may be either a concrete RDF term from the algebra,
 * another {@link TermTemplate}, or (for the object position) any {@link Template}.
 * The optional {@link graph} field holds the graph component when operating on
 * named graphs.
 */
export type TemplateQuad = Typed & {
  type: 'template';
  subType: RDF.Quad['termType'];
  subject: Algebra.Pattern['subject'] | TermTemplate;
  predicate: Algebra.Pattern['predicate'] | TermTemplate;
  // Only allow MappingHead in object to comply with RDF
  object: Algebra.Pattern['object'] | Template;
  graph?: Algebra.Pattern['graph'] | TermTemplate;
};

/**
 * The head of a mapping rule – a {@link TemplateQuad} that describes the shape
 * of an RDF triple produced by the mapping.  It is used as the key against
 * which incoming SPARQL triple patterns are matched during query rewriting.
 */
export type MappingHead = TemplateQuad;

/**
 * Any template – either a {@link TermTemplate} (IRI / literal / blank node) or a
 * {@link TemplateQuad} (quoted triple).
 */
export type Template = TermTemplate | TemplateQuad;

/**
 * A complete mapping rule consisting of:
 * - {@link head} – the quad template that describes what shape of RDF data the mapping produces.
 * - {@link body} – the projected SPARQL algebra expression that retrieves the data from the
 *   underlying source.
 *
 * During query rewriting each triple pattern in the user query is matched against all available
 * {@link Mapping} rules to produce the union of sub-queries that together cover the pattern.
 */
export interface Mapping {
  head: MappingHead;
  body: Algebra.Project;
}
