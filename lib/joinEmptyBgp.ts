/**
 * Empty BGP is identify for join
 * https://www.w3.org/TR/sparql11-query/#sparqlSimplification
 */

/**
 * Empty groups emit a single binding that does not bind to anything.
 *  -> SELECT * {}  gives 1 binding
 *  -> SELECT * { {} UNION {} } gives 2 bindings
 * https://www.w3.org/TR/sparql11-query/#emptyGroupPattern
 */
