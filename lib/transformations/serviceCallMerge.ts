import { Algebra, algebraUtils } from '@traqula/algebra-transformations-1-2';
import { termToString } from 'rdf-string';
import type { TransformContext } from '../transformContext.js';

export function transformServiceCallPushUp(c: TransformContext, op: Algebra.Operation): Algebra.Operation {
  const { AF } = c;
  // A join branches of the multi
  function pushUpServiceFromMulti(op: Algebra.Operation & Algebra.Multi): Algebra.Operation {
    let canOptimize = false;
    const distinctServices: Record<string, Algebra.Service[]> = {};
    for (const service of op.input) {
      if (service.type === Algebra.Types.SERVICE) {
        const strName = termToString(service.name);
        distinctServices[strName] = distinctServices[strName] ?? [];
        distinctServices[strName].push(service);
        if (distinctServices[strName].length > 1) {
          canOptimize = true;
        }
      }
    }

    if (!canOptimize) {
      return op;
    }
    // Group the service calls under the same operation type
    const handledServices = new Set<string>();
    const newInput: Algebra.Operation[] = [];
    for (const subOp of op.input) {
      if (subOp.type === Algebra.Types.SERVICE) {
        const strName = termToString(subOp.name);
        if (!handledServices.has(strName)) {
          handledServices.add(strName);
          const services = distinctServices[strName];
          // Create a single service for both
          // TODO: WHAT ABOUT SILENT SERVICES?
          newInput.push(<Algebra.Service>{
            ...services[0],
            input: <typeof op>{
              ...op,
              input: services.map(x => x.input),
            },
          });
        }
      } else {
        newInput.push(subOp);
      }
    }
    if (newInput.length === 1) {
      return newInput[0];
    }
    return <typeof op> {
      ...op,
      input: newInput,
    };
  }

  function pushOpServiceFromSingle(op: Algebra.Operation & Algebra.Single): Algebra.Operation {
    const subOp = op.input;
    if (subOp.type === Algebra.Types.SERVICE) {
      op.input = subOp.input;
      subOp.input = op;
      return subOp;
    }
    return op;
  }

  function valuesDistributionOfJoin(op: Algebra.Join): Algebra.Operation {
    // Partition the join inputs into VALUES clauses and SERVICE calls.
    // If every non-VALUES input is a SERVICE call, we can push all VALUES
    // clauses inside each service.  This creates a less complex outer join
    // (the VALUES are removed from the join level) while letting each service
    // endpoint apply the bindings as an early filter.
    const valueClauses: Algebra.Values[] = [];
    const serviceClauses: Algebra.Service[] = [];

    for (const input of op.input) {
      if (input.type === Algebra.Types.VALUES) {
        valueClauses.push(input);
      } else if (input.type === Algebra.Types.SERVICE) {
        serviceClauses.push(input);
      } else {
        // A non-VALUES, non-SERVICE branch is present: removing VALUES from
        // the outer join would change semantics, so abort.
        return op;
      }
    }

    if (valueClauses.length === 0 || serviceClauses.length === 0) {
      return op;
    }

    // Push every VALUES clause into each SERVICE branch as an inner join.
    const newServices = serviceClauses.map((service): Algebra.Service => ({
      ...service,
      input: AF.createJoin([ ...valueClauses, service.input ], true),
    }));

    if (newServices.length === 1) {
      return newServices[0];
    }
    return {
      ...op,
      input: newServices,
    };
  }

  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    {
      [Algebra.Types.JOIN]: { transform: (join) => {
        // Flatten any nested JOINs that are direct children so that VALUES and
        // SERVICE siblings become visible at the same level.  This normalises
        // structures produced by bgpTransform, which wraps even a single-pattern
        // BGP inside a JOIN, before applying the push-down optimisations.
        const flatJoin = AF.createJoin(join.input, true);
        const pushed = valuesDistributionOfJoin(flatJoin);
        if (pushed !== flatJoin) {
          return pushed;
        }
        return pushUpServiceFromMulti(flatJoin);
      } },
      [Algebra.Types.UNION]: { transform: pushUpServiceFromMulti },
      [Algebra.Types.FILTER]: { transform: pushOpServiceFromSingle },
      [Algebra.Types.EXTEND]: { transform: pushOpServiceFromSingle },
      [Algebra.Types.PROJECT]: { transform: pushOpServiceFromSingle },
      [Algebra.Types.GRAPH]: { transform: pushOpServiceFromSingle },
      [Algebra.Types.ORDER_BY]: { transform: pushOpServiceFromSingle },
      [Algebra.Types.REDUCED]: { transform: pushOpServiceFromSingle },
      [Algebra.Types.SLICE]: { transform: pushOpServiceFromSingle },
      // TODO: investigate if others work the same way.
    },
  );
}
