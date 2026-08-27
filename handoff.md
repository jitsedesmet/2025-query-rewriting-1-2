# Handoff: revision-stamped memoisation on `ClusterSet`

You are taking over the verification of one feature, on one branch. Nothing else on this
branch needs your attention, and you are not being asked to extend the feature - only to
decide whether the claim it rests on is true.

## What is here

Branch `perf/cluster-set-revision-memos`, two commits on top of `main` (`8638c96`):

| commit | what it adds |
| --- | --- |
| `68d0e9d` | the stamp itself - `ClusterSet.revision` / `touch()` - and the memo on `AssertionConjunction.readingsPerGroup` |
| `8ad7bbf` | a second memo, on `AssertionConjunction.namedMembers`, keyed by the same stamp |

Both were written and reviewed once already, on the branch that became `8638c96`, then
taken back off it before merge so that the mechanism could be read on its own rather than
among a dozen unrelated fixes. These are those commits, cherry-picked. The conflict
resolution was mechanical (`groupConjuncts` and friends take a `Decomposition` on `main`,
where the original commit still passed a bare map) plus one comment on `Decomposition`
restored to the wording that made sense once the stamp exists again.

The measurements that motivated it are in `inconsistencies.md` §4.3 and §4.5. Read those
first - they are the "before" side of anything you re-measure. Their commit hashes point
at the pre-squash branch and will not resolve; the prose is still accurate.

## The claim you are checking

Not "is it faster" - that was measured, and you can re-measure it cheaply. The claim worth
your time is a negative one:

> **No caller ever has to invalidate anything.** A memo taken off a `ClusterSet` at stamp
> *r* is valid for exactly as long as the set still reports *r*, and there is no sequence
> of operations that leaves a memo stale while the stamp says otherwise.

It rests on three legs. Attack them separately.

### Leg 1 - every write moves the stamp

`touch()` is called by the method that writes, not by whoever asked for the write, and the
calls sit only on what the design claims are choke points:

- `ClusterSet`: `clear`, `copyInto`, `createEmptyGroup`, `remove`, `dropGroup`, `mergeGroupIds`
- `TermClusterSet`: `narrowRange`, `resolveAllConstraints`

Everything else that writes is claimed to be reachable only through one of those. The
non-obvious routes, which are the ones to check:

- `ClusterSet.createGroup` writes `groupToValues` and `valueToGroup` directly - it is
  claimed safe because it calls `createEmptyGroup` first.
- `TermClusterSet.place` (writes `groupToPin`) and `unite` (writes `groupMergeHistory`,
  `groupToRange`, `groupToPin`) are private and claimed reachable only from
  `resolveAllConstraints`, which touches on entry.
- `registerPinChildren` / `unregisterPinChildren` write `pinChildToOwners` and are called
  from `place` and `unite` (so, under `resolveAllConstraints`) and from `dropGroup` (which
  touches on its own account). Two different arguments, so check both.
- `TermClusterSet.createPositionGroup` writes `groupToRange` - via `createEmptyGroup`.
- `AssertionClusterSet.assertTermTypeRange` writes `groupToAssertedRange` **before**
  delegating to `narrowRange`. It touches only because that delegation happens. Decide
  whether you are comfortable with that, or whether it should touch on its own account.
- The overrides in `TermClusterSet`, `AssertionClusterSet` and `ClusterSolver` -
  `clear`, `copyInto`, `createEmptyGroup`, `createGroup`, `migrateGroupData`, `dropGroup` -
  all write subclass state and are claimed safe because each calls `super` first. One of
  them did **not**, until
  recently (`ClusterSolver.migrateGroupData`, fixed in the branch that became `main`), so
  this is a failure that has actually happened here. `TermClusterSet.carriesInformation`
  still does not chain to super - see `inconsistencies.md` §6.2 - so satisfy yourself that
  it writes nothing.

An enumeration is the honest way to do this: list every assignment to `groupToValues`,
`valueToGroup`, `cleanNumber`, `groupToPin`, `groupToRange`, `groupMergeHistory`,
`pinChildToOwners`, `acyclic`, `groupToAssertedRange`, `groupToExpressions` and
`staticExpressionValidation`, and for each one name the choke point it reaches. A single
write that does not is a bug in the feature.

### Leg 2 - the stamp is unique across sets, not just within one

`revisions` is a module-global counter (`ClusterSet.ts:9`); `touch()` takes the next value.
This is deliberate and load-bearing: `AssertionConjunction.adopt` (line 196) replaces
`this.clusters` wholesale with the clusters of a clone, and a per-set counter could hand
back a stamp the memo of the *previous* set was taken at. Check that argument, and check
the paths into `adopt` (there is one caller, at line 813).

Worth a thought each: the counter is per-process, so nothing survives a module reload -
which is fine only because no memo outlives the process either. And it is monotonic with
no wraparound handling.

### Leg 3 - each memo is a function of the clusters *alone*

This is the leg that already caught somebody out, and the most likely place for a future
bug. `AssertionConjunction` holds four pieces of state the clusters know nothing about:
`strength`, `bound`, `unbound` and `order`. A memo keyed on the stamp may not read any of
them, because `assertBound` can complete a weak member into a strong one **without any
write reaching `touch()`**.

- `readingsPerGroup` (line 1007, walk at 1022) - claimed to read only groups, members and
  shapes. Verify by reading `walkReadingsPerGroup` line by line.
- `namedMembers` (line 1085) - claimed to read only `clusters.valuesOf`.
- The per-walk memo in `conjuncts` is the counter-example, and is already on `main`: it is
  scoped to one walk precisely because what a group writes out *does* depend on the
  strengths. If you find yourself tempted to move it onto the stamp, that is the trap.

Both memos hand out their contents `readonly`, since the memo is shared. That is
compile-enforced; check for casts that would defeat it.

## How the original verification was done

Re-do this rather than trusting it. The shape that worked:

1. Keep the pre-memo implementation in the file under a temporary name.
2. On every call, run both and assert they agree - deep equality on the returned structure,
   not just its size.
3. Run the whole test suite that way, then a seeded fuzz (mulberry32 or xorshift32, so a
   failure is replayable) over randomly built conjunctions, and require the generated
   SPARQL to come out **byte-identical**.
4. Remove the scaffolding before committing.

**The suite alone is not sufficient evidence, and this is the single most important thing
to know here.** The conjunctions the tests build are tiny - elsewhere in this same body of
work the whole suite produced only 40 `isPinChild` calls and 49 `pruneValues` rows. A memo
bug needs a conjunction that is written to, read, written again and read again; the suite
mostly does not do that. The fuzz is what carries the confidence.

Counts the original runs reached, as a sanity check on your own harness:

- `readingsPerGroup`: 351 hits / 705 misses across the suite, 242 771 checked hits in fuzz.
- `namedMembers`: 4 506 hits / 1 589 misses across the suite, 40 000 fuzz queries.
- Zero disagreements in either.

### Do the negative control

A harness that never fails proves nothing. Make `touch()` a no-op and confirm the fuzz
**fails**. The original run did exactly this and it did fail; if yours passes, your harness
is not sensitive and every other number you produce is meaningless.

## Re-measuring the win

Claimed: ~3-5% end-to-end for the decomposition memo; 6-8% on the pushdown pass for the
members memo, which moved `namedMembers` from 4.9% to 0.7% of the profile. The synthetic
that produced those was a pushdown over a filter of 160 conditions, and 32/64-block
variants. Nothing about the feature depends on your reproducing the exact figures - but if
you measure a *regression*, say so.

## Commands

```
yarn install          # postinstall builds
yarn lint
yarn test             # expect 403 passed / 1 skipped, no type errors
yarn doc:check        # expect 0 errors, 3 warnings (all pre-existing)
yarn build
```

All five pass on `8ad7bbf` as handed over.

## Out of scope

- The per-walk `Decomposition` memo, and everything else already on `main`.
- The findings in `inconsistencies.md` §6, including the `cloneObj` metadata corruption
  (§6.3), which is real but unrelated.
- Whether `handoff.md` itself belongs in the repository - drop it before merge if not.
