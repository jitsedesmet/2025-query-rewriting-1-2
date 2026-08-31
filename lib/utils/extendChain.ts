import type * as RDF from '@rdfjs/types';
import type { Algebra } from '@traqula/algebra-transformations-1-2';
import { Types } from '@traqula/algebra-transformations-1-2';
import type { TransformContext } from '../transformContext.js';
import { collectVariableNames } from '../utils.js';

/**
 * One `BIND(expression AS variable)` lifted out of an EXTEND chain.
 *
 * The unit a pull-up decides about is the *bind*, not the node that carries it: a chain is peeled, its binds
 * are partitioned, and the ones that stay are re-planted around a core that the ones that left are no longer
 * part of. So a bind travels as its three parts plus the node it was read off, and nothing here holds a
 * reference to the chain it came out of.
 */
export interface ChainBind {
  /** The variable the bind writes. */
  variable: RDF.Variable;
  /** The expression it writes into it. */
  expression: Algebra.Expression;
  /** `vars(e)`, cached: every licence reads it. */
  reads: Set<string>;
  /**
   * The EXTEND this was read off, kept so that a caller can ask
   * {@link utils/certainlyBoundVars!cpMetaOf} what holds *where the bind is evaluated* rather than at the
   * top of the chain.
   *
   * The difference is load-bearing for the "same inputs" side condition: `?y ∈ cVars` of the whole input is
   * satisfied by a bind further up the chain writing `?y`, which is precisely a `?y` this bind reads
   * *unbound*. Reading `extendNode.input` answers the question the licence is actually about, and reading
   * `extendNode` itself answers whether this bind can leave its own variable unbound.
   */
  extendNode: Algebra.Extend;
}

/** An operation split into the maximal EXTEND chain at its top and what is left below it. */
export interface PeeledChain {
  /** The first operation that is not an EXTEND: everything the chain stands on. */
  core: Algebra.Operation;
  /** The binds of the chain, in evaluation order: `binds[0]` is the innermost, closest to {@link core}. */
  binds: ChainBind[];
}

/**
 * Splits the maximal EXTEND chain at the top of `op` off its core.
 *
 * Evaluation order is how every ordering argument in the pull-up is written: `binds[0]` is the innermost
 * bind, the one closest to the core, and a bind may only read what stands *before* it in the list.
 * @param c - The transformation context, for collecting the variables of an expression
 * @param op - The operation to peel
 * @returns its core and the binds above it, innermost first
 */
export function peelExtends(c: TransformContext, op: Algebra.Operation): PeeledChain {
  const binds: ChainBind[] = [];
  let deepestSoFar = op;
  while (deepestSoFar.type === Types.EXTEND) {
    binds.push({
      variable: deepestSoFar.variable,
      expression: deepestSoFar.expression,
      reads: collectVariableNames(c.astTransformer, deepestSoFar.expression),
      extendNode: deepestSoFar,
    });
    deepestSoFar = deepestSoFar.input;
  }
  // Collected top-down, wanted bottom-up.
  return { core: deepestSoFar, binds: binds.reverse() };
}

/**
 * Rebuilds an EXTEND chain around `core`, the inverse of {@link peelExtends}.
 *
 * Fresh nodes throughout, never the {@link ChainBind.extendNode} the bind was read off: that one carries a
 * cached `CPMeta` describing a chain this one no longer is.
 * @param c - The transformation context
 * @param core - The operation to plant the chain on
 * @param binds - The binds to plant, `binds[0]` innermost; an empty list gives `core` back unchanged
 * @returns the rebuilt operation
 */
export function replantExtends(
  c: TransformContext,
  core: Algebra.Operation,
  binds: readonly ChainBind[],
): Algebra.Operation {
  return binds.reduce<Algebra.Operation>(
    (plantedSoFar, bind) => c.AF.createExtend(plantedSoFar, bind.variable, bind.expression),
    core,
  );
}
