import type { RangeSet } from '../RangeSet.js';
import { objectRange, rangeOfPosition, tripleTermRange } from '../RangeSet.js';
import { ClusterSet } from './ClusterSet.js';

/**
 * What a group is *pinned* to: the shape every value in it has.
 *
 * - `term` is the fully decided one - every value of the group equals this term.
 * - `triple` says only that the values are triple terms, and that their components are the values of
 *   three groups of their own. Those children are group *ids*, so a position nobody named is an
 *   anonymous group: it exists and it unifies, and it holds whatever is known about that position
 *   without a variable having to be coined for it.
 *
 * The two make a lattice rather than an equality: meeting them ({@link MeetPins}) is syntactic
 * unification - equal, contradiction, or *decompose* into the unification of the children.
 */
export type Pin<Term> =
  | { kind: 'term'; term: Term }
  | { kind: 'triple'; children: readonly [number, number, number]};

/** The three positions of a triple pin, in the order its children are held. */
export const pinPositions = <const> [ 'subject', 'predicate', 'object' ];

/**
 * The meet of two pins on one group: the pin that says both, plus the group unifications that says the
 * rest of it - or `false` when nothing can say both.
 */
export type MeetPins<Term> = (a: Pin<Term>, b: Pin<Term>) =>
{ pin: Pin<Term>; pending: [number, number][] } | false;

/**
 * The standard meet, for terms compared by `equals`.
 *
 * Two triple pins decompose: the shape is the same, and what the two say about it is the unification of
 * their children, one position at a time. Surviving as the *first* pin keeps the children of the group
 * that already had them stable, so nothing that points at them has to be told.
 *
 * A term meeting a triple pin is a contradiction. That is only true because a term pin never holds a
 * triple *term*: whoever pins one decomposes it into a triple pin over ground children first, which is
 * what makes a ground triple term unify with a shape rather than fail against it.
 */
export function meetPinsOf<Term>(equals: (a: Term, b: Term) => boolean): MeetPins<Term> {
  return (a, b) => {
    if (a.kind === 'term' && b.kind === 'term') {
      return equals(a.term, b.term) ? { pin: a, pending: []} : false;
    }
    if (a.kind === 'triple' && b.kind === 'triple') {
      return { pin: a, pending: a.children.map((child, index) => [ child, b.children[index] ]) };
    }
    return false;
  };
}

/**
 * A {@link ClusterSet} whose groups may be *pinned* to a shape: every value in the group has it.
 *
 * The two users of this differ in what a pin conflict means, which is why {@link setPin} reports one
 * rather than raising it. For the unfolding ({@link ClusterSolver}) a group asked to be two terms at once
 * is a broken mapping, and it throws; for an assertion conjunction it is an ordinary contradiction, and it
 * becomes the empty operation. They also differ in the terms they allow - the solver narrows to a
 * {@link RawBasicTerm} by the range of the triple position - hence the second type parameter.
 *
 * **A failed pin or merge leaves the structure half-changed**, exactly as it always has: a caller that
 * gets `false` has a contradiction on its hands and holds no state worth keeping.
 */
export class TermClusterSet<T, Term> extends ClusterSet<T> {
  /** Maps group ID to the shape the group is pinned to (if any) */
  public groupToPin: Record<number, Pin<Term> | undefined>;
  /** Maps group ID to the term types its values may still have. A missing entry is the top, `objectRange`. */
  protected groupToRange: Record<number, RangeSet>;
  /**
   * The unifications a meet asked for, drained by the merge that is running rather than recursed into.
   *
   * Merging children can merge further children, and re-entering {@link mergeGroupIds} from inside
   * {@link migrateGroupData} would corrupt the merge that called it - it is halfway through moving values.
   */
  private pendingMerges: [ number, number ][];
  /** Whether a merge is running, so that a meet inside it queues rather than recurses. */
  private merging = false;

  public constructor(
    toId: (value: T) => string,
    protected readonly meetPins: MeetPins<Term>,
    /**
     * The term types a term pin admits, when the caller wants a pin to narrow the range of its group.
     * Leaving it out keeps the range the business of the caller, which is what the unfolding wants.
     */
    protected readonly rangeOfTerm?: (term: Term) => RangeSet,
  ) {
    super(toId);
    this.clear();
  }

  public override clear(): void {
    super.clear();
    this.groupToPin = {};
    this.groupToRange = {};
    this.pendingMerges = [];
  }

  public override clone(): TermClusterSet<T, Term> {
    const copy = new TermClusterSet<T, Term>(this.toId, this.meetPins, this.rangeOfTerm);
    this.copyInto(copy);
    return copy;
  }

  protected override copyInto(target: ClusterSet<T>): void {
    super.copyInto(target);
    const casted = <TermClusterSet<T, Term>> target;
    // The children of a triple pin are rewritten in place by a merge, so the pins are copied as well.
    casted.groupToPin = Object.fromEntries(Object.entries(this.groupToPin)
      .map(([ group, pin ]) => [ group, pin?.kind === 'triple' ? { ...pin, children: [ ...pin.children ]} : pin ]));
    casted.groupToRange = { ...this.groupToRange };
    casted.pendingMerges = [];
  }

  /** The shape the group is pinned to, or `undefined` when nothing is known about its values. */
  public pinOf(group: number): Pin<Term> | undefined {
    return this.groupToPin[group];
  }

  /** The term the group is pinned to, or `undefined` when it is anchorless or only known to be a triple. */
  public termOf(group: number): Term | undefined {
    const pin = this.groupToPin[group];
    return pin?.kind === 'term' ? pin.term : undefined;
  }

  /** The groups of the three components of a group known to hold triple terms. */
  public childrenOf(group: number): readonly [ number, number, number ] | undefined {
    const pin = this.groupToPin[group];
    return pin?.kind === 'triple' ? pin.children : undefined;
  }

  /** The term types the values of a group may still have. */
  public rangeOf(group: number): RangeSet {
    return this.groupToRange[group] ?? objectRange;
  }

  /** Replaces what is known about the term types of a group, unconditionally. */
  protected setRangeOf(group: number, range: RangeSet): void {
    this.groupToRange[group] = range;
  }

  /**
   * Narrows the term types the values of a group may have.
   * @returns `false` when nothing is left for them to be, or when the pin the group carries is no longer
   * one of the things they may be.
   */
  public narrowRange(group: number, range: RangeSet): boolean {
    const narrowed = this.rangeOf(group).disjunct(range);
    this.groupToRange[group] = narrowed;
    if (narrowed.size === 0) {
      return false;
    }
    const pin = this.groupToPin[group];
    return pin === undefined || this.pinAdmittedBy(pin, narrowed);
  }

  /** Whether a range still admits a pin - the check a narrowing has to repeat against what is pinned. */
  protected pinAdmittedBy(pin: Pin<Term>, range: RangeSet): boolean {
    if (pin.kind === 'triple') {
      return range.has('Quad');
    }
    return this.rangeOfTerm === undefined || range.disjunct(this.rangeOfTerm(pin.term)).size > 0;
  }

  /**
   * Pins a term onto a group, or reports that the group already carries something else.
   * @returns `false` when the two cannot both hold.
   */
  public setTerm(group: number, term: Term): boolean {
    return this.setPin(group, { kind: 'term', term });
  }

  /**
   * Pins the group to a triple shape, creating an anonymous group per position that nothing names yet.
   * @returns the groups of the three components, or `false` when the group cannot hold a triple term.
   */
  public setTriple(group: number): readonly [ number, number, number ] | false {
    const known = this.childrenOf(group);
    if (known !== undefined) {
      return known;
    }
    const children = <[ number, number, number ]> pinPositions.map((position) => {
      const child = this.createEmptyGroup();
      // A component may only hold what its position admits, which is what confines the nesting of triple
      // terms to the object chain: a triple pin on a subject or a predicate child empties its range.
      this.setRangeOf(child, rangeOfPosition(position));
      return child;
    });
    return this.setPin(group, { kind: 'triple', children }) ? children : false;
  }

  /**
   * Conjoins what a pin says with what the group already carries, draining the unifications the meet of
   * the two asks for.
   * @returns `false` when the two contradict, or when the pin would make the group hold itself.
   */
  public setPin(group: number, pin: Pin<Term>): boolean {
    const current = this.groupToPin[group];
    if (current !== undefined) {
      const met = this.meetPins(current, pin);
      if (met === false) {
        return false;
      }
      this.groupToPin[group] = met.pin;
      return this.drainPending(met.pending);
    }
    // A group holding a shape that holds the group would have to be an infinite term, and resolving it
    // to one would not terminate: `?o ≡ <<( ?o :p :q )>>` is unsatisfiable rather than deep.
    if (pin.kind === 'triple' && pin.children.some(child => child === group || this.reaches(child, group))) {
      return false;
    }
    if (!this.narrowRange(group, pin.kind === 'triple' ? tripleTermRange : this.rangeOfTermPin(pin))) {
      return false;
    }
    this.groupToPin[group] = pin;
    return true;
  }

  /** Whether the shape of `from` holds the values of `to`, at any depth. */
  public reaches(from: number, to: number): boolean {
    const children = this.childrenOf(from);
    return children !== undefined &&
      children.some(child => child === to || this.reaches(child, to));
  }

  /** A pinned group still constrains its last remaining member, so it survives {@link remove}. */
  protected override carriesInformation(group: number): boolean {
    return this.groupToPin[group] !== undefined;
  }

  /**
   * A group a live pin holds as a component has to survive losing its last named member: the shape goes
   * on pointing at it, and what is known about that position is held nowhere else.
   */
  protected override isReferencedBy(group: number): boolean {
    return this.isComponent(group);
  }

  protected override createGroup(value: T): number {
    const group = super.createGroup(value);
    this.groupToPin[group] = undefined;
    return group;
  }

  protected override dropGroup(group: number): void {
    super.dropGroup(group);
    delete this.groupToPin[group];
    delete this.groupToRange[group];
  }

  /** Merges the groups of two values, reporting the pin conflict {@link mergeGroupIds} found. */
  public override mergeGroups(from: T, to: T):
    { oldGroup: number; newGroup: number; conflict: boolean } | undefined {
    return this.mergeGroupIds(this.getGroup(from), this.getGroup(to));
  }

  /**
   * Merges two groups, carrying over everything the disappearing one held.
   * @returns `conflict` when the two carried pins that cannot both hold - or when merging them would
   * close a cycle in the shapes, which is the same contradiction read over two groups instead of one.
   * What the two callers do about that is up to them.
   */
  public override mergeGroupIds(fromGroup: number, toGroup: number):
    { oldGroup: number; newGroup: number; conflict: boolean } | undefined {
    if (fromGroup !== toGroup && (this.reaches(fromGroup, toGroup) || this.reaches(toGroup, fromGroup))) {
      // One of the two is a component of the other, so equating them asks for an infinite term.
      return { oldGroup: fromGroup, newGroup: toGroup, conflict: true };
    }
    const merged = super.mergeGroupIds(fromGroup, toGroup);
    if (merged === undefined) {
      return undefined;
    }
    // Everything pointing at the group that is going away has to be told where it went, *before* the data
    // is migrated: what the migration unifies may point at it too.
    this.redirectComponents(merged.oldGroup, merged.newGroup);
    const migrated = this.migrateGroupData(merged.oldGroup, merged.newGroup);
    delete this.groupToPin[merged.oldGroup];
    delete this.groupToRange[merged.oldGroup];
    return { ...merged, conflict: !(migrated && this.drainPending([])) };
  }

  /**
   * Moves everything the disappearing group carried besides its values onto the surviving one.
   * Subclasses that give a group more state migrate it here.
   */
  protected migrateGroupData(oldGroup: number, newGroup: number): boolean {
    if (!this.narrowRange(newGroup, this.rangeOf(oldGroup))) {
      return false;
    }
    const oldPin = this.groupToPin[oldGroup];
    return oldPin === undefined || this.setPin(newGroup, oldPin);
  }

  /** Whether a live pin holds this group as one of its components. */
  private isComponent(group: number): boolean {
    return Object.entries(this.groupToPin).some(([ owner, pin ]) =>
      Number(owner) !== group && pin?.kind === 'triple' && pin.children.includes(group));
  }

  /** Points every pin holding `oldGroup` as a component at `newGroup` instead. */
  private redirectComponents(oldGroup: number, newGroup: number): void {
    for (const [ owner, pin ] of Object.entries(this.groupToPin)) {
      if (pin?.kind === 'triple' && pin.children.includes(oldGroup)) {
        this.groupToPin[Number(owner)] = {
          kind: 'triple',
          children: <[ number, number, number ]> pin.children
            .map(child => child === oldGroup ? newGroup : child),
        };
      }
    }
  }

  /**
   * Runs the unifications a meet asked for to completion, as a work list.
   *
   * Never as a recursion: a merge running inside another one would move values out from under it. So a
   * meet that happens *during* a merge only queues its children, and the merge drains the queue once it
   * is done with them - which is also why this is called with an empty list at the end of a merge.
   */
  private drainPending(pending: [ number, number ][]): boolean {
    this.pendingMerges.push(...pending);
    if (this.merging) {
      // The merge that is running owns the queue and will drain what we added.
      return true;
    }
    this.merging = true;
    try {
      while (this.pendingMerges.length > 0) {
        const [ left, right ] = this.pendingMerges.shift()!;
        if (this.mergeGroupIds(left, right)?.conflict === true) {
          return false;
        }
      }
      return true;
    } finally {
      this.merging = false;
    }
  }

  /** The range a term pin narrows its group to, or the top where the caller keeps ranges to itself. */
  private rangeOfTermPin(pin: Pin<Term> & { kind: 'term' }): RangeSet {
    return this.rangeOfTerm === undefined ? objectRange : this.rangeOfTerm(pin.term);
  }
}
