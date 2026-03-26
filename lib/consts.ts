/**
 * Datatype IRI used for representing skolemized blank nodes as typed literals.
 * When blank nodes are represented as literals, they use this datatype to be identifiable.
 */
export const DT_INTERNAL_BNODE = 'https://sparql-extension.knows.idlab.ugent.be/bnode';

/**
 * Extension function IRI used internally to represent blank node construction.
 * This function takes variable arguments and produces a consistent blank node identity.
 */
export const EXTENSION_FUNCTION_BNODE = 'internal://blank';

/**
 * IRI prefix used when skolemizing blank nodes as named nodes (IRIs).
 * Combined with a hash of the blank node's identifying values to create unique IRIs.
 */
export const IRI_PREFIX_BNODE = 'https://myInternalBnode.example.org/';
