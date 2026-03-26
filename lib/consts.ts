/**
 * The datatype IRI used to tag literals that represent skolemised blank nodes.
 * When blank-node expressions are rewritten to literals (see {@link internalBnodeAsSpecialLiteral}),
 * the resulting literal carries this datatype so the engine can distinguish them from ordinary literals.
 */
export const DT_INTERNAL_BNODE = 'https://sparql-extension.knows.idlab.ugent.be/bnode';

/**
 * The named-expression identifier for the internal blank-node construction function.
 * Inside mapping bodies, `BNODE(?x, ?y, ...)` is compiled to a call of this named expression so that
 * subsequent rewrites can recognise and transform it consistently.
 */
export const EXTENSION_FUNCTION_BNODE = 'internal://blank';

/**
 * The IRI prefix used when blank nodes are skolemised to IRIs (see {@link internalBnodeAsSpecialIri}).
 * A hash of the blank-node key is appended to this prefix to form a globally unique IRI.
 */
export const IRI_PREFIX_BNODE = 'https://myInternalBnode.example.org/';
