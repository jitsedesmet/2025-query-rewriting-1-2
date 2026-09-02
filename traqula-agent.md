# Traqula, as this repo finds it

Upstream behaviours of [Traqula](https://github.com/comunica/traqula) that shape the code here. Each one
is written down so that the next agent does not rediscover it, and — more to the point — does not "fix"
one of our passes to work around something that is not our defect.

Every entry is reproducible with `createPartialContext()` and nothing else.

## 1. `toAst` lifts an `EXTEND` out of a `GRAPH` — a bug

`toAst` writes an `EXTEND` at the top of a graph pattern as a `SELECT` expression, which puts it
**outside** the `GRAPH` it was inside. The round trip does not preserve the algebra:

```sparql
SELECT * WHERE { GRAPH ?g { OPTIONAL { ?g :q ?w } BIND(?g AS ?x) } }
```

```text
parsed:   project(graph(extend(leftjoin(bgp, bgp))))     cVars = {g}
printed:  SELECT ?g ?w ( ?g AS ?x ) WHERE { GRAPH ?g { OPTIONAL { ?g <ex://q> ?w . } } }
reparsed: project(extend(graph(leftjoin(bgp, bgp))))     cVars = {g, x}
```

**Why it is wrong, not merely different.** `Graph(?g, P)` evaluates `P` against each named graph and
*then* joins `{?g ↦ u}` on, so `?g` is bound **outside** the pattern and not inside it. In the parsed
tree the bind reads a `?g` the `OPTIONAL` leaves unbound on the rows where it missed, so `?x` is unbound
there; in the re-parsed tree it reads the graph name, which is always bound. `SELECT *` therefore returns
a value for `?x` on rows where the original returns none — the differing `cVars` above is this repo's own
analysis saying so.

A ground bind (`BIND(:a AS ?x)`) survives the same round trip unharmed, which is why the bug is easy to
miss: it only bites when the expression reads a variable whose binding differs inside and outside the
`GRAPH`, and the graph variable is exactly such a variable.

**What we do about it.** Nothing in `lib/` — the algebra `pullUpExtends` produces is correct, and its
`GRAPH` rule already refuses precisely the hoist this bug performs (`?g ∈ vars(e)` requires
`?g ∈ cVars(A)`). What it costs us is *testing*: the generated string cannot tell a bind that stayed
inside a `GRAPH` from one that rose out of it, so the `GRAPH` cases in `test/pullUpExtends.test.ts`
assert on the algebra — `peelExtends` at the node, plus the scope invariant — rather than on the printed
query. Do not "simplify" them back into string comparisons.

## 2. `toAst` cannot render an `EXTEND` as the root of a query — not a bug

`Extend(Project(…), ?x, e)` throws `Unknown Operation type extend`. This is correct: SPARQL has nowhere
to write a `BIND` above a `SELECT`, or between it and its `LIMIT`, so there is no query for that tree.

**What we do about it.** `pullUpExtends` seals the query's solution-modifier chain
(`ASK`/`CONSTRUCT`/`DESCRIBE`/`PROJECT`/`DISTINCT`/`REDUCED`/`SLICE`/`FROM`) against rises. Drops still
fire there. See §A.7 and the phase-1 deviations in `agent-task.md`.

## 3. `toAst` writes an `EXTEND` in the top-level chain as a `SELECT` expression — benign

The same flattening as entry 1, in the place it belongs. `Project(Extend(OrderBy(P), ?x, e))` prints as
`SELECT … (e AS ?x) … ORDER BY …`, which re-parses to `Project(OrderBy(Extend(P, ?x, e)))`.

That is faithful rather than lucky: SPARQL's own algebra (§18.2.4.1) applies the `EXTEND`s of the select
expressions *before* it orders, so an alias is in scope for `ORDER BY` and the two trees agree — an
`EXTEND` is element-wise and order-preserving, so moving one across an `ORDER BY` that does not read its
variable changes nothing. It is why `ORDER_BY` is deliberately **not** on the sealed chain of entry 2, and
why a test whose expected output shows a `BIND` as a `SELECT` expression is not evidence that the bind
moved. Where the same flattening crosses a `GRAPH` instead, it is entry 1.
