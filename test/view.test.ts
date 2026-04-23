import { Algebra } from '@traqula/algebra-transformations-1-2';
import { describe, it, expect } from 'vitest';
import { ViewParser } from '../lib/parser/parser.js';
import { toAlgebra } from '../lib/parser/toAlgebra.js';

describe('vIEW parser and toAlgebra', () => {
  const parser = new ViewParser();

  describe('parsing', () => {
    it('parses a simple VIEW definition in the prologue', () => {
      const ast = parser.parse(`
        PREFIX ex: <https://example.org/>
        VIEW ex:v {
          HEAD { ?s ex:p1 ?o }
          BODY { ?s ex:p ?o }
        }
        SELECT * WHERE { ?s ?p ?o }
      `);
      const context = <any[]>(<any>ast).context;
      const viewDef = context.find((c: any) => c.subType === 'view');
      expect(viewDef).toBeDefined();
      expect(viewDef.subType).toBe('view');
      expect(viewDef.monotone).toBe(false);
      expect(viewDef.pairs).toHaveLength(1);
    });

    it('parses a MONOTONE VIEW definition', () => {
      const ast = parser.parse(`
        PREFIX ex: <https://example.org/>
        MONOTONE VIEW ex:v {
          HEAD { ?s ?p ?o }
          BODY { ?s ?p ?o }
        }
        SELECT * WHERE { ?s ?p ?o }
      `);
      const context = <any[]>(<any>ast).context;
      const viewDef = context.find((c: any) => c.subType === 'view');
      expect(viewDef.monotone).toBe(true);
    });

    it('parses a VIEW with multiple HEAD/BODY pairs', () => {
      const ast = parser.parse(`
        PREFIX ex: <https://example.org/>
        MONOTONE VIEW ex:c {
          HEAD { ?s ?p ?o }
          BODY { ?s ?p ?o }
          HEAD { ?s ?p ?o }
          BODY { ?s ?p ?o }
        }
        SELECT * WHERE { ?s ?p ?o }
      `);
      const context = <any[]>(<any>ast).context;
      const viewDef = context.find((c: any) => c.subType === 'view');
      expect(viewDef.pairs).toHaveLength(2);
    });

    it('parses an OVER query operation', () => {
      const ast = parser.parse(`
        PREFIX ex: <https://example.org/>
        VIEW ex:v {
          HEAD { ?s ex:p1 ?o }
          BODY { ?s ex:p ?o }
        }
        SELECT * WHERE {
          OVER ex:v { ?x ex:p1 ?y }
        }
      `);
      const where = (<any>ast).where;
      expect(where).toBeDefined();
      const patterns = <any[]>where.patterns;
      const overPattern = patterns.find((p: any) => p.subType === 'over');
      expect(overPattern).toBeDefined();
      expect(overPattern.subType).toBe('over');
    });

    it('parses OVER without a VIEW definition (lookup fails later in toAlgebra)', () => {
      // Parser should succeed; the missing VIEW is a toAlgebra-time error
      expect(() => parser.parse(`
        PREFIX ex: <https://example.org/>
        SELECT * WHERE {
          OVER ex:missing { ?s ex:p ?o }
        }
      `)).not.toThrow();
    });
  });

  describe('toAlgebra — basic VIEW expansion', () => {
    it('expands OVER to the substituted BODY algebra', () => {
      const ast = parser.parse(`
        PREFIX ex: <https://example.org/>
        VIEW ex:v {
          HEAD { ?s ex:p1 ?o }
          BODY { ?s ex:p ?o }
        }
        SELECT * WHERE {
          OVER ex:v { ?x ex:p1 ?y }
        }
      `);
      const algebra = toAlgebra(ast);

      // The result should be a Project over a BGP with ?x ex:p ?y
      expect(algebra.type).toBe(Algebra.Types.PROJECT);
      const inner = (<Algebra.Project>algebra).input;

      // Find the BGP somewhere in the algebra tree
      const bgp = findBgp(inner);
      expect(bgp).not.toBeNull();
      expect(bgp!.patterns).toHaveLength(1);

      const triple = bgp!.patterns[0];
      expect(triple.subject.termType).toBe('Variable');
      expect(triple.subject.value).toBe('x');
      expect(triple.predicate.termType).toBe('NamedNode');
      expect(triple.predicate.value).toBe('https://example.org/p');
      expect(triple.object.termType).toBe('Variable');
      expect(triple.object.value).toBe('y');
    });

    it('produces an empty result for mismatched constants', () => {
      const ast = parser.parse(`
        PREFIX ex: <https://example.org/>
        VIEW ex:v {
          HEAD { ?s ex:p1 ?o }
          BODY { ?s ex:p ?o }
        }
        SELECT * WHERE {
          OVER ex:v { ?x ex:p2 ?y }
        }
      `);
      const algebra = toAlgebra(ast);

      // Constant mismatch (ex:p1 vs ex:p2) → empty result
      const inner = (<Algebra.Project>algebra).input;
      expect(containsValues(inner)).toBe(true);
    });

    it('extends OVER variable when HEAD has a constant at that position', () => {
      const ast = parser.parse(`
        PREFIX ex: <https://example.org/>
        VIEW ex:v {
          HEAD { ?s ex:p1 ?o }
          BODY { ?s ex:p ?o }
        }
        SELECT * WHERE {
          OVER ex:v { ?x ?pred ?y }
        }
      `);
      const algebra = toAlgebra(ast);

      // The algebra should contain an EXTEND binding ?pred = ex:p1
      const inner = (<Algebra.Project>algebra).input;
      expect(containsExtend(inner, 'pred')).toBe(true);

      // And also a BGP with ?x ex:p ?y
      const bgp = findBgp(inner);
      expect(bgp).not.toBeNull();
      const triple = bgp!.patterns[0];
      expect(triple.subject.value).toBe('x');
      expect(triple.predicate.value).toBe('https://example.org/p');
      expect(triple.object.value).toBe('y');
    });

    it('unions multiple matching HEAD/BODY pairs', () => {
      const ast = parser.parse(`
        PREFIX ex: <https://example.org/>
        MONOTONE VIEW ex:c {
          HEAD { ?s ?p ?o }
          BODY { ?s ex:p1 ?o }
          HEAD { ?s ?p ?o }
          BODY { ?s ex:p2 ?o }
        }
        SELECT * WHERE {
          OVER ex:c { ?x ?y ?z }
        }
      `);
      const algebra = toAlgebra(ast);
      const inner = (<Algebra.Project>algebra).input;

      // Should produce a UNION of the two BODY results
      expect(containsUnion(inner)).toBe(true);
    });

    it('only matches pairs where constants agree', () => {
      const ast = parser.parse(`
        PREFIX ex: <https://example.org/>
        VIEW ex:v {
          HEAD { ?s ex:p1 ?o }
          BODY { ?s ex:bodyPred1 ?o }
          HEAD { ?s ex:p2 ?o }
          BODY { ?s ex:bodyPred2 ?o }
        }
        SELECT * WHERE {
          OVER ex:v { ?x ex:p1 ?y }
        }
      `);
      const algebra = toAlgebra(ast);
      const inner = (<Algebra.Project>algebra).input;

      // Only pair 1 matches (ex:p1 = ex:p1), pair 2 doesn't (ex:p1 ≠ ex:p2)
      // So result should be a BGP, not a UNION
      expect(containsUnion(inner)).toBe(false);
      const bgp = findBgp(inner);
      expect(bgp).not.toBeNull();
      const triple = bgp!.patterns[0];
      expect(triple.predicate.value).toBe('https://example.org/bodyPred1');
    });

    it('throws for unknown VIEW IRI in OVER', () => {
      const ast = parser.parse(`
        PREFIX ex: <https://example.org/>
        SELECT * WHERE {
          OVER ex:missing { ?s ex:p ?o }
        }
      `);
      expect(() => toAlgebra(ast)).toThrow(/Unknown VIEW/u);
    });

    it('supports OVER within a larger WHERE clause', () => {
      const ast = parser.parse(`
        PREFIX ex: <https://example.org/>
        VIEW ex:v {
          HEAD { ?s ex:p1 ?o }
          BODY { ?s ex:p ?o }
        }
        SELECT * WHERE {
          ?x ex:name ?name .
          OVER ex:v { ?x ex:p1 ?y }
        }
      `);
      // Should not throw
      const algebra = toAlgebra(ast);
      expect(algebra).toBeDefined();
      expect(algebra.type).toBe(Algebra.Types.PROJECT);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers for traversing the algebra tree in tests
// ---------------------------------------------------------------------------

function findBgp(op: Algebra.Operation): Algebra.Bgp | null {
  if (op.type === Algebra.Types.BGP) {
    const bgp = op;
    if (bgp.patterns.length > 0) {
      return bgp;
    }
  }
  if ('input' in op) {
    const inputs = Array.isArray(op.input) ? op.input : [ op.input ];
    for (const child of inputs) {
      const found = findBgp(child);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function containsValues(op: Algebra.Operation): boolean {
  if (op.type === Algebra.Types.VALUES) {
    const vals = op;
    return vals.bindings.length === 0;
  }
  if ('input' in op) {
    const inputs = Array.isArray(op.input) ? op.input : [ op.input ];
    return inputs.some(i => containsValues(i));
  }
  return false;
}

function containsExtend(op: Algebra.Operation, varName: string): boolean {
  if (op.type === Algebra.Types.EXTEND) {
    const e = op;
    if (e.variable.value === varName) {
      return true;
    }
  }
  if ('input' in op) {
    const inputs = Array.isArray(op.input) ? op.input : [ op.input ];
    return inputs.some(i => containsExtend(i, varName));
  }
  return false;
}

function containsUnion(op: Algebra.Operation): boolean {
  if (op.type === Algebra.Types.UNION) {
    return true;
  }
  if ('input' in op) {
    const inputs = Array.isArray(op.input) ? op.input : [ op.input ];
    return inputs.some(i => containsUnion(i));
  }
  return false;
}
