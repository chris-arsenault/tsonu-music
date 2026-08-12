# 0018 — A leftover branch becomes an argument; a mixer is what is left when it cannot

- Status: Accepted
- Date: 2026-08-12

## Context

Assembly draws a set of plugins and wires them into a chain. Whatever the chain does not consume
is a leftover branch, and the builder's only answer to a leftover was a mixer: one two-input
compositor per branch beyond the first, appended to the plugin list and wired by the ordinary
producer search.

The standing direction is that a scene's layers should feed each other — given branches `f`, `g`
and `h`, the scene should read as `f(g(h()))` rather than `f() + g() + h()`. Mixers cannot express
that. They put two pictures side by side and leave the eye to find a relation that the graph does
not contain.

The mechanism was also unsound. A mixer appended to the plugin list went back through wiring, and
wiring answers "which two outputs does this read" with the same newest-and-unconsumed search it
uses for every other input. Once the unread outputs ran out, that search handed a mixer one branch
twice. Measured over 240 builds: 306 of 850 derived joins read a branch together with material
already inside it, in 72% of scenes. Two such mixers in series multiply a bright figure by four
and the tone map clamps the rest, which is the scene that came back black with white flashes.

Repairing the mixer derivation in place had failed three times. The reason was upstream of it: the
fold-back loop was drawn on every wiring pass, the draw reads the whole node list, and the
join-and-prune rounds re-wired between draws — so each round re-derived joins for a graph the next
round changed again. Only 45 of 200 builds settled on their first candidate.

## Decision

**The loop is drawn once, last.** Wiring takes a `drawLoop` option and skips the draw while a scene
is settling; the builder calls `closeSceneLoop` on the graph it finished with. Within each group a
free loop sink comes before an occupied one.

**Leftover branches are placed before any mixer is considered.** A branch nothing consumes is
offered to an open input on a stage already in the picture, preferring a generator's structural
input — an edge, an interior, a domain, a profile — over a later stage's, and an earlier target
over a later one, so a placed branch passes through as much of the chain as possible. A target the
branch can already reach is refused; where a scene remembers is the loop draw's decision.

**Inputs and outputs both carry `structural`, and the pairing is enforced.** A structural output is
data — the spectrum's band strip is one bar per bin — and may satisfy only a structural input. A
structural input is an argument rather than material, so data and pictures are both welcome there.

**A mixer that is still needed is spliced into an edge, never appended to the plugin list.** Its
operands are the edge's own producer and the leftover branch, at the earliest point that survives
a check on the result: every mixer in the proposed graph — not only the new one — must still read
two pictures with no forward colour path between them, and the graph must stay acyclic. Checking
the result rather than the moment is the load-bearing part: two branches entering the same chain
put the second splice upstream of the first, so a join that read two pictures when it was placed
reads one picture twice afterwards.

Colour paths only. A branch steering another branch's motion field or cutting its stencil is
composition; treating that as doubling refuses legal splice points for no gain.

Assembly is monotone as a result. Placement and joining are functions of the wired graph rather
than definitions handed back to wiring, so nothing in the settling loop can add a plugin and the
connectivity prune alone decides when it ends.

## Alternatives

Excluding a branch's ancestors during wiring was tried and rejected: it blocks branches fed through
motion edges, and restricting it to colour left the surplus joins in place. Limiting a join's
inputs to unconsumed outputs starves on terminals that sort after the joins. Pruning surplus joins
after the fact leaves the wiring that produced them, and measured a lower build rate than the
baseline because the prune and the draw disagreed about the graph. Each of these treats the join
derivation as the fault; the fault was that the derivation ran against a graph that had already
changed.

Rejecting scenes with leftover branches was rejected as a policy: a scene with three generators is
what the grammar asks for, and the leftovers are material to compose, not a defect to fail on.

## Consequences

Joins whose operands share material: 0 of 567 across 300 builds, from 306 of 850. Derived joins per
scene 3.54 to 1.95, with placement absorbing what the drop accounts for: 139 of 240 scenes carry at
least one branch nested inside another generator. Builds settling on their first candidate 45 to 71
per 200, and the build rate is unchanged at 240 of 240.

Two failure classes moved from the compiler to the decision that caused them. A trail transport may
no longer take its steering field from below the loop it sits in, which was closing a forward
cycle; a scene that never converged now reports how many colour outputs are loose instead of
reporting that the catalog has no state operators.

The scene-state combine is excluded from the branch-joiner predicate by contract rather than by a
zero activation weight: it has a mixer's shape and is the graph's memory, and spliced as a join it
would be handed a branch where last frame's state belongs.
