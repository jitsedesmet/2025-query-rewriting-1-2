# Inconsistencies, code quality and optimization notes

Findings from reviewing the code on `main` after the triple-term pushdown work (`b52ae3f..22fee37`),
collected while condensing the documentation. Nothing here has been fixed - the documentation pass
changed comments only. Each item says what is wrong and where.

## 1. Correctness / soundness hazards

### 1.3 `AssertionConjunction.of` ignores the result of `assert`

```
public static of(conjuncts) {
  const result = new AssertionConjunction();
  for (const { access, assertion } of conjuncts) {
    result.assert(access, assertion);   // <- return value discarded
  }
  return result;
}
```

Everywhere else in the class a `false` from `assert` means "this conjunction holds no meaningful
state and must be discarded". Here a contradiction produces a silently broken object that callers go
on to use. The comment argues it cannot happen because the input is a subset of a satisfiable
conjunction - but `placeOverTargets` (`pushDownAssertions.ts`) does **not** hand it a subset: it hands
it weakened conjuncts and the `entailedByReading` conjuncts. Those are entailed by the original and so
still satisfiable, but the argument in the comment no longer covers the actual callers.

Fix: either have `of` throw on a contradiction (this is an unreachable state, like `rootVarOfBare`), or
have it return `undefined` and make the callers deal with it.

### 1.4 A weak assertion with an access target is silently dropped

`AssertionConjunction.assert`, case `'weak'`:

```
if (targetIsAccess(assertion.term)) {
  return true;          // asserts nothing, reports success
}
```

Reporting success while storing nothing means the conjunct disappears from Θ *and* from the residual,
which **adds solutions** - the one direction of unsoundness this pass must never have. It is
unreachable today (`asWeakAssertion` requires a ground term, `asWeakenedConjunct` returns `undefined`
for edges), but the handling is inconsistent with the analogous unreachable state in `rootVarOfBare`,
which throws. Make it throw.

Related: `AssertionConjunction.get` returns `assertStrong(access(representative))` for any member of an
unpinned group without consulting `this.strength`. That is correct only under the "weak ⇔ sole member
of a pinned group" invariant. If that invariant is ever violated, `get` silently reports a strong edge
for a weak member, which is the same class of error. Consider an assertion in `assertWeakly` that the
group it lands in is pinned.

### 1.5 Ignored booleans

`pushIntoGraph` (`pushDownAssertions.ts`) discards the result of
`graphIndependentAssertions.assertTerm(graphVar, term, false)`. It cannot currently fail (the
conjunction was split so that it does not mention `graphVar`), but a `false` there would leave the
conjunction in the unreadable state the class documents, and it would be pushed into the pattern.

## 2. Naming and API inconsistencies

### 2.1 `RangeSet.disjunct` computes the *conjunction*

`lib/RangeSet.ts`. The method returns the intersection of two ranges - its own doc says so, and every
caller (`narrowRange`, `VRanges.narrow`, `admitsRange`, `decidedByAccess`) uses it as a meet. The name
says the opposite. Rename to `meet` or `intersect`.

### 2.2 The package's public API does not include its entry points

`lib/index.ts` is `export * from './transformations/index.js'`. So `transformContextFromConstructs`,
`queryTransform` and `operationTransform` - the functions the module documentation and every test use -
are **not** exported from the package root. The published `exports` map points at `dist/esm/lib/index.js`,
so a consumer cannot reach them at all. Either export them from `lib/index.ts` or document the deep
import paths as supported. (The `@example` in the fileoverview was updated to use deep imports so it is
at least not actively wrong, but the export surface is the real problem.)

Similarly, `lib/transformations/index.ts` re-exports 8 of the 12 transformation modules;
`transformServiceCallPushUp`, `rewriteNonRecursivePaths`, `transformExtendsToValues` and the
blank-node passes
are reachable only by deep import, with no stated reason.

### 2.3 Stale symbol references in documentation (fixed, but symptomatic)

Three `{@link}` targets pointed at symbols that do not exist, i.e. the prose had drifted from renames:

| reference | in | reality |
|---|---|---|
| `completePatternRewrite` (×2) | `pushDownAssertions.ts` | the function is `rewritePattern` |
| `weakenedTerms` | `assertions.ts` | no such symbol anywhere |
| `BoundVariablesOptions.filterImpliesBound` | `certainlyBoundVars.ts` | no such symbol anywhere |

All three were removed in the documentation pass. Worth a lint rule (`jsdoc/no-undefined-types` /
`typedoc --validation.invalidLink`) so the next rename is caught.

### 2.4 `'uq'` prefix test is one character short

`ClusterSolver.mappingVarsOf` classifies variables as mapping-or-user with
`!value.value.startsWith('uq')`, while `transformBgp.rewritePatternWithUniqueScope` uses `'uq_'` and
`transformContext` prefixes mapping variables with `'mi_'`/`'m_'`. A user query variable named `?uqx`
is therefore misclassified as a *mapping* variable. Both prefixes should be shared constants
(`consts.ts` already exists), and the test should be `startsWith('uq_')`.

`ClusterSolver.sortClusters` relies on the same convention implicitly: it is a plain `localeCompare`
that happens to put `mi_*` before `uq_*` only because `'m' < 'u'`. If the prefixes ever change, the
ordering that `mappingVarsOf` and `collectTriplePatternBinds` depend on silently changes with them.

### 2.5 `ClusterSolver.migrateGroupData` does not call `super`

`AssertionClusterSet.migrateGroupData` calls `super.migrateGroupData(...)` first; `ClusterSolver`'s
override does not. The base implementation is a no-op today, so nothing breaks - but the two overrides
of the same hook disagree, and the solver will silently drop whatever the base class migrates the day
it migrates anything.

### 2.6 Unused `TransformContext` parameters

`lib/utils.ts`: `directExtensions(c, op)` and `deleteVarExtensionsInPlace(c, op, vars)` never use `c`.
Three call sites pass it. Either drop the parameter or use the context's `astTransformer` instead of
the hand-rolled recursion in those functions.

### 2.7 `createJoin` flatten flag is inconsistent

`pushDownAssertions.mergeBGPsOfJoin` calls `c.AF.createJoin([...])` with no flatten argument, while
every other call in the same file passes `true` or `false` explicitly. Relatedly, `mergeBGPsOfJoin`
slices `notBgps` with `indexOfFirst`, an index into `join.input`. It is correct (everything before the
first BGP is a non-BGP, so the two indices coincide) but it reads like a bug; slice on the array the
index came from, or track the insertion point separately.

## 3. Open questions left in the code

- `AssertionConjunction.intoPattern` carries a `TODO` questioning whether `asWritten` is needed at all
  ("I thought we concluded that coining the variables indeed break cVars/pVars"). This is the D6
  question from `task-for-agent.md` and is still unresolved; either the view is load-bearing (in which
  case the argument belongs in the code) or it can go.
- `pushIntoLeftJoin`: `// TODO: the substitution in the filter might reveal more information that we
  could use!`
- `ClusterSolver.register` / `registerExpressionToGroup`: two TODOs about deciding statically whether an
  expression can produce a term, instead of deferring every pair to the emitted `sameTerm`.
- `substituteInExpression`: `EXISTENCE` expressions are returned untouched - assertions never propagate
  into an `EXISTS` pattern.
- `RangeSet.serviceNameRange` is documented as an *assumption* rather than something a spec states.

## 4. Runtime optimizations

Ordered by expected payoff. None of these are correctness issues.

### 4.1 `TermClusterSet.hasCycle()` runs after every single constraint

`resolveAllConstraints` ends with a full DFS over **every group in the set**, and it is called once per
`setPin`, per `unifyGroups` and per `setTerm`. Building a conjunction of *n* assertions is therefore
O(n · groups) ≈ O(n²), even for a query with no triple terms at all, where no pin can ever create a
child edge. Two cheap fixes: skip the check entirely when no group carries a `triple` pin, and
otherwise start the DFS only from the groups the work list actually touched.

### 4.2 `TermClusterSet.isPinChild` is a linear scan per removal

`isLive` → `isPinChild` scans `Object.keys(this.groupToPin)` and rebuilds `childrenOf` for each. It runs
on every `ClusterSet.remove`, which `AssertionConjunction.removeMember` calls per variable in
`normalisedFor` and `transferred`. A reverse index (child group → owning groups), maintained in `place`
and `unite`, makes it O(1).

### 4.3 `AssertionConjunction` recomputes its decomposition several times per operation

`conjuncts()` runs `readingsPerGroup()` (a full BFS over the group graph, plus a sort per group) and is
called from `unaryConjuncts()`, `split()`, `boundImpliedBy()` (indirectly through `names()`/`get()`) and
`toExpression()`. `equatedReadings()` and `patternValues()` each run `readingsPerGroup()` again. In
`placeOverTargets` alone that is at least three full traversals, and `swapWith` then builds a fresh
`AssertionConjunction.of(...)` per target, re-asserting everything.

Cache `readingsPerGroup()` / `conjuncts()` on the conjunction and invalidate on any `assert*` /
`removeMember`. The class is already treated as immutable-after-construction by most callers (they
`clone()` before asserting), so the invalidation surface is small.

### 4.4 `groupConjuncts` ↔ `writesAnything` recursion is exponential in shape depth

`groupConjuncts(g)` → `termTypeToState(g)` → `shapeIsWitnessed(g)` → `writesAnything(child)` →
`groupConjuncts(child)` → … Each node's conjuncts are recomputed once per ancestor *and* once per
`writesAnything` visit, giving roughly 2^depth work. Shapes only nest down the `object` chain so depth
is small in practice, but memoizing `groupConjuncts` per group (for one `accessesPerGroup` map) removes
it outright.

### 4.5 `namedMembers` sorts on every call

`readingsPerGroup` calls it twice per group, `representativeMemberOf` once more, `groupConjuncts` again.
Sort once per group per decomposition (falls out of 4.3), or keep group members sorted on insertion.

### 4.6 Every pass copies the whole tree twice

`pushDownAssertions` and `nullifyUnbindableVars` each call `withoutCpVars` on entry *and* on exit, and
`withoutCpVars` is a full `mapOperation` copy. A pipeline of *k* such passes copies the tree 2k times
and recomputes all `cVars`/`vRanges` from scratch between each. A pipeline runner that strips once
before the first pass and once after the last would halve it; the passes would then only need to
guarantee they leave no stale metadata behind (which they already try to).

### 4.7 `rowSatisfies` clones the full conjunction per VALUES row

O(rows × |Θ|) clones. Cheap pre-filter: check the rows against the *term* pins of Θ (plain
`term.equals`) before paying for a clone, since a row that disagrees with a pin can never survive.

### 4.8 `collectAssertions` has an unbounded fixpoint loop

`while (learned)` re-substitutes every residual and rebuilds `rebuildingSubstitution()` (which walks all
names) each round. Termination rests on the substitution growing monotonically; that is true but not
stated anywhere and not enforced. Worth either an argument in the code or a defensive iteration bound.

## 5. Documentation pass - what changed

For the record, since it touches nearly every file:

- Every function/method now has a short summary (1-2 sentences) plus `@param`/`@returns`. Detail that
  is about *how* a body works moved into the body as line comments; detail that restated an invariant
  three times over was cut.
- Long-form prose was kept only where the argument is genuinely load-bearing and non-obvious:
  the `@fileoverview` of `pushDownAssertions.ts` and `assertionConjunction.ts`, the class docs of
  `AssertionConjunction`, `TermClusterSet` and `AssertionClusterSet`, and
  `AssertionConjunction.intoPattern` / `normalisedFor` / `transferred`.
- `@param` tags were dropped (rather than expanded) on functions taking a destructured options object,
  because `jsdoc/check-param-names` then demands one tag per property.
- The notation the codebase already used (`Θ`, `A⟨?x ≡ c⟩`, `W⟨…⟩`, `T⟨a : τ⟩`, `B⟨?x⟩`, `U⟨?x⟩`,
  `σ_{…}`) was kept and made consistent across the files that had drifted into spelling it out.
- Net effect: `lib/` went from 8270 to 8033 lines, comment lines from 3301 to 3063 - and that is *net*
  of the docs added to previously undocumented functions. No behaviour change - `yarn lint` and
  `yarn test` (401 passing, 1 skipped, no type errors) are unchanged.
