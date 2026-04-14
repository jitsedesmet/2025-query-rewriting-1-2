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
    // TODO: generalize this case
    if (op.input.length === 2) {
      const [ values, service ] = op.input;
      if (values.type === Algebra.Types.VALUES && service.type === Algebra.Types.SERVICE) {
        service.input = AF.createJoin([ values, service.input ], true);
        return service;
      }
    }
    return op;
  }

  return algebraUtils.mapOperation<'unsafe', typeof op>(
    op,
    {
      [Algebra.Types.JOIN]: { transform: (join) => {
        const pushed = valuesDistributionOfJoin(join);
        if (pushed !== join) {
          return pushed;
        }
        return pushUpServiceFromMulti(join);
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
