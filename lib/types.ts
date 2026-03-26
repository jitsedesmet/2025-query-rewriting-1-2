import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import type { Typed } from '@traqula/core';

/**
 * A template for constructing an IRI term from variable values.
 * The value array contains string literals and variables that will be concatenated to form the IRI.
 * @example
 * // Creates IRI like: <http://example.org/person/123>
 * const template: TemplateIri = {
 *   type: 'template',
 *   subType: 'NamedNode',
 *   value: ['http://example.org/person/', varId]
 * }
 */
export type TemplateIri = Typed & {
  type: 'template';
  subType: RDF.NamedNode['termType'];
  value: (string | RDF.Variable)[];
};

/**
 * A template for constructing a Literal term from variable values.
 * The value array contains string literals and variables that will be concatenated,
 * with a specific datatype applied.
 */
export type TemplateLiteral = Typed & {
  type: 'template';
  subType: RDF.Literal['termType'];
  value: (string | RDF.Variable)[];
} & Pick<RDF.Literal, 'datatype'>;

/**
 * A template for constructing a BlankNode consistently from variable values.
 * The value array contains the variables whose combination will determine
 * the identity of the blank node (same variables = same blank node).
 *
 * Note: Since blank nodes cannot be consistently referenced across datasets,
 * this template produces a skolemized representation (IRI or typed literal)
 * rather than an actual blank node.
 */
export type TemplateBlank = Typed & {
  type: 'template';
  subType: RDF.BlankNode['termType'];
  // Generate a new bnode based on the following vars.
  value: RDF.Variable[];
};

/**
 * Union type of all term templates.
 * Templates are used in mapping heads to construct terms from variable bindings.
 *
 * Unlike raw variables, templates describe how to construct a new term from variables.
 * This means the resulting term's value depends on the runtime binding of the variables.
 */
export type TermTemplate =
  | TemplateIri
  | TemplateLiteral
  | TemplateBlank;

/**
 * A template for constructing a Quad (triple term) from its components.
 * Used in mapping heads to represent RDF 1.2 triple terms that need to be constructed.
 *
 * The subject, predicate, object (and optionally graph) can be either:
 * - Regular RDF terms (NamedNode, Literal, Variable)
 * - Templates that construct terms from variables
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
 * The head (template) of a mapping construct query.
 * Represents the single triple pattern that will be constructed from matching data.
 */
export type MappingHead = TemplateQuad;

/**
 * Union of all template types that can appear in a mapping.
 */
export type Template = TermTemplate | TemplateQuad;

/**
 * A mapping between RDF data representations (e.g., RDF 1.1 to RDF 1.2).
 * Defined using SPARQL CONSTRUCT query semantics:
 * - `head`: The template pattern to be constructed (CONSTRUCT clause)
 * - `body`: The query pattern to match source data (WHERE clause)
 *
 * @example
 * // A mapping that converts RDF 1.1 reification to RDF 1.2 triple terms:
 * // CONSTRUCT { ?t rdf:reifies <<( ?s ?p ?o )>> }
 * // WHERE { ?t rdf:reifies [ a rdf:tripleTerm; rdf:ttSubject ?s; ... ] }
 */
export interface Mapping {
  /** The template pattern to construct (single triple) */
  head: MappingHead;
  /** The projected query body pattern that matches source data */
  body: Algebra.Project;
}
