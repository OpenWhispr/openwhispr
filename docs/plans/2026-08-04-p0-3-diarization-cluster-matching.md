# Plan: P0-3 — Diarization speaker matching, corrected

Date: 2026-08-04
Branch: off `fix/retranscription-preserves-transcripts`
Status: revision 2, after adversarial review. Awaiting confirm-only re-review.

**Two previous attempts at this fix were wrong.** The first (shipped in the unreleased
1.12.1) reduced the policy to bare nearest-neighbour. The second contradicted a shipped
test and re-opened the original runaway. This plan implements the rule adopted in
`2026-08-04-open-issues-plan.md` revision 3 after the second review, and nothing else.

---

## Symptom

A 3-person call produced `speaker_23`, `speaker_27`, `speaker_28` — dozens of clusters
for three people. Once one person had two clusters, both scored high for that person's
voice, the top-two gap fell under the margin, no match was accepted, and another
duplicate was minted. Every duplicate made the next match harder.

---

## Verified state of the code

`liveSpeakerMatching.js:32-38`:

```js
function acceptsMatch(bestSimilarity, secondBestSimilarity) {
  if (!Number.isFinite(bestSimilarity) || bestSimilarity < MATCH_THRESHOLD) return false;
  if (bestSimilarity >= CONFIDENT_MATCH_THRESHOLD) return true;
  const runnerUp = Number.isFinite(secondBestSimilarity) ? secondBestSimilarity : 0;
  return bestSimilarity - runnerUp >= MATCH_MARGIN;
}
```

`MATCH_THRESHOLD = 0.65`, `MATCH_MARGIN = 0.03`, `CONFIDENT_MATCH_THRESHOLD = 0.8`.

1.12.1's backstop, `liveSpeakerIdentifier.js:718-729`:

```js
  _assignOrForceCluster(embedding) {
    const nearest = this._findNearestTransientAbove(embedding, MATCH_THRESHOLD);
    if (nearest) {
      this._updateCentroid(nearest, embedding);
      return nearest;
    }
    return this._assignSpeakerId(embedding);
  }
```

This absorbs the embedding into the nearest cluster above 0.65 with **no margin**, so
the effective policy is bare nearest-neighbour at 0.65 and both `MATCH_MARGIN` and most
of `CONFIDENT_MATCH_THRESHOLD` are dead. It can collapse two genuinely distinct people.
It also only absorbs the *embedding* — the duplicate clusters both survive, so the same
near-tie re-triggers on every later utterance.

### Why `(best, second)` cannot decide this

A near-tie has two possible causes and the pair alone cannot separate them:

- two similar-sounding **different** people → splitting is right
- one person's **duplicate** clusters → merging is right

The discriminating signal is the similarity **between the two candidate clusters
themselves**, which `_performRecluster` (`liveSpeakerIdentifier.js:246-247`) already
uses at `>= MATCH_THRESHOLD`.

---

## Fix

Replace `_assignOrForceCluster` with a rule that never mints while a real candidate
exists, and that merges duplicates rather than only absorbing into them:

1. Find the best and second-best transient clusters for the embedding.
2. If `best < MATCH_THRESHOLD` → mint a new speaker (unchanged).
3. If `acceptsMatch(best, second)` → assign to `best` (unchanged policy).
4. Otherwise — margin failure with `best >= MATCH_THRESHOLD`:
   - if `similarity(clusterBest, clusterSecond) >= MATCH_THRESHOLD` → **merge the two
     clusters**, then assign to the surviving id
   - else → assign to `best` anyway
5. **Never mint a new speaker when `best >= MATCH_THRESHOLD`.**

Merging the clusters (not just the embedding) is what stops the duplicate pair
re-triggering on every subsequent utterance.

Merge semantics reuse `_performRecluster`'s existing choice of survivor
(`liveSpeakerIdentifier.js:250-256`): a named cluster beats an unnamed one, otherwise
the higher utterance count wins; centroids combine count-weighted. Extract that into a
shared `_mergeTransientSpeakers(keepId, removeId)` used by both, rather than writing a
second merge.

### Identity conflicts are an exception to "never mint" (review CRITICAL C1)

Revision 1 claimed the stored-profile path was covered because it is the same function.
**It is not**, and the claim contradicted revision 1's own test 5. `_resolveSpeakerForEmbedding`
stamps the matched profile onto whatever comes back, unconditionally
(`liveSpeakerIdentifier.js:700-702`):

```js
this.transientProfileIds.set(speakerId, matchedProfile.id);
this.transientDisplayNames.set(speakerId, matchedProfile.display_name);
```

So if profile "Alice" matches and the best transient is a cluster already named "Bob",
assigning to Bob's cluster renames Bob to Alice and
`_findTransientSpeakerForProfile(bobId)` returns null forever after.

**Decision: identity conflict beats similarity.** A stored profile or a user-assigned
name is stronger evidence of a distinct human than a 0.70 cosine score.

- Never merge two clusters that carry **conflicting** identities (different
  `transientProfileIds`, or different non-empty `transientDisplayNames`). Fall through
  to 4b instead.
- On the stored-profile path, when the best cluster carries a *different* identity,
  **mint** rather than assign. This is the one explicit exception to rule 5, and it is
  narrow: it needs positive identity evidence on both sides, not merely a near-tie.

### Merges must be propagated, or ids go stale (review CRITICAL C2)

Revision 1 left this as an open question. The answer is that merges performed inside
`_assignOrForceCluster` reach **nothing**: the only propagation path is the 30-second
timer at `ipcHandlers.js:4949-4972`, which consumes the merges *returned by*
`recluster()`, rewrites `meetingDiarizationSegments` (`:4962-4968`) and sends
`meeting-speakers-merged` (`:4971`). A merge done outside that call is invisible, and a
later `_performRecluster` cannot rediscover it because the removed id no longer exists —
every earlier segment under that id is orphaned in the live UI and in the saved
transcript.

So merge propagation is part of this design, not a follow-up:

- `_mergeTransientSpeakers` pushes a `{ keep, remove, displayName, similarity }` record
  onto `this.pendingMerges`.
- `recluster()` drains `pendingMerges` and returns them alongside its own merges, so the
  existing timer remaps segments and notifies the renderer with no changes at the call
  site (and both ids pass through `meetingSpeakerRemapper`, `ipcHandlers.js:4619-4629`,
  for free).
- `stop()` must drain them too: `stopLiveSpeakerIdentification` clears the timer
  **before** calling `stop()` (`ipcHandlers.js:4868-4874`), so merges from the final
  <30s window would otherwise be lost.

### What the shared merge helper must maintain (review IMPORTANT I3)

Every per-speaker map, or ids go stale in a new way: `transientEmbeddings`,
`transientCounts`, `transientDisplayNames`, `transientProfileIds`, and
**`transientNoteIds`** (`liveSpeakerIdentifier.js:138`, maintained at `:284-287` — revision
1 never named it), plus `currentSegmentSpeakerId` (`:289-291`). Also fix what
`_performRecluster` misses today: `currentSegmentSpeakerName` is never updated, so a stale
name can be stamped at `_finalizeSpeechSegment` (`:598-599`).

Note `_assignOrForceCluster` is reached from the live-preview path roughly once a second
(`_identifyActiveSpeechSegment` → `_resolveSpeakerForEmbedding(embedding, { updateCentroid: false })`,
`:555` → `:709`) and mutates state regardless of `updateCentroid`. Merges will therefore
fire from previews, which is exactly why propagation has to work.

### Ambiguous assignment does not move the centroid (review IMPORTANT I2)

Step 4b is 1.12.1's nearest-neighbour absorption, which this plan criticises above. It is
kept because the alternative — minting — reopens the runaway, and it is bounded by
current shipped behaviour. But the residual risk is real: a genuinely new speaker scoring
0.66/0.655 against two dissimilar clusters is absorbed and can never be minted. To stop
that compounding, **4b does not call `_updateCentroid`** — otherwise the absorbed voice
drags the cluster toward itself and every later utterance matches harder. 4a (a confirmed
duplicate merge) still updates normally.

### Why 4a adds no new collapse risk

`sim(clusterBest, clusterSecond) >= MATCH_THRESHOLD` is *exactly* `_performRecluster`'s
condition (`:246-247`), which already runs unconditionally every 30 seconds. Any pair 4a
can collapse, the shipped recluster would collapse anyway within 30s. 4a only moves an
inevitable merge earlier and makes it permanent.

### `maxSpeakers` — deferred, not done here

Revision 1 planned to delete it. The review showed removal is not local: `setMaxSpeakers`
is called from the `meeting-set-session-speaker-config` IPC handler
(`ipcHandlers.js:6902`) and `maxSpeakers` is passed at `:4942`, so a naive removal makes
that handler throw (swallowed at `:6904`, silently returning `success: false`).

It is genuinely never *read*, so it masks nothing — the tests below assert exact cluster
counts against the real class, and no cap is applied. Removing it is dead-code cleanup,
not correctness, so it does not belong in a P0 fix. Deferred to its own change.

### Dead code that this change does create

`_findNearestTransientAbove` (`:733-744`) has one caller (`:725`) and becomes dead —
remove it. `_findNearestTransient` (`:746-757`) is already dead today (no callers) —
remove it in the same pass. The new rule needs a scan returning best **and** second-best
*ids*, which `_findTransientMatch` does not provide (it tracks the runner-up similarity
only).

### Three implementation decisions the review required

1. **Single source of truth for merge records.** Since `_performRecluster` will now merge
   through the shared helper, which pushes to `pendingMerges`, returning
   `[...drained, ...performReclusterReturn]` would report every recluster merge twice.
   So `pendingMerges` is the **only** record: `_performRecluster` stops building its own
   array and `recluster()` simply drains. (Both consumers happen to be idempotent, but
   that is not the thing to rely on.)
2. **The stop path applies merges before the snapshot.** `stopLiveSpeakerIdentification`
   (`ipcHandlers.js:4863-4875`) is called at `:5850`, before
   `captureMeetingDiarizationState()` (`:5867`, `:5894`) snapshots
   `meetingDiarizationSegments` for the saved note. Extract the timer's merge-application
   body (`:4955-4971`) into a local `applyLiveSpeakerMerges(merges, win)` and call it from
   both the timer and one final `recluster()` inside `stopLiveSpeakerIdentification`,
   **before** `stop()`. Test 5c asserts the segment snapshot, not just the return value.
3. **`_assignOrForceCluster` takes the incoming identity.** It cannot detect "different
   identity" today; the stored-profile branch must pass the matched profile in, e.g.
   `_assignOrForceCluster(embedding, { profileId })`.

## Tests — integrated, not predicate-only

Predicate-only tests passed for both previous wrong fixes. These drive the **real**
`LiveSpeakerIdentifier` with synthetic embeddings, mocking only
`speakerEmbeddings.cosineSimilarity`-level inputs:

1. **The reported runaway**: a duplicate-heavy voice interleaved with a third distinct
   speaker mid-stream yields exactly 3 clusters, not dozens.
2. Two genuinely distinct speakers whose clusters are dissimilar are **not** merged,
   even when an embedding is near-tied between them.
3. One speaker's two duplicate clusters (mutually similar) **are** merged, and the merge
   is permanent — a later utterance does not re-trigger the same decision.
4. A voice below `MATCH_THRESHOLD` still mints a new speaker.
5. Stored-profile path: a profile match never renames a cluster that carries a different
   identity — it mints instead (the C1 exception).
5b. Two clusters with conflicting identities are never merged by 4a.
5c. A merge performed by `_assignOrForceCluster` is surfaced through `recluster()`, and
    through `stop()` for the final window — otherwise segments orphan under a dead id.
5d. A merge from the preview path leaves `currentSegmentSpeakerId`/`Name` valid.
6. Test 1's near-ties must land in **[0.65, 0.72)** — that is the band attempt 2 reopened,
   and a test outside it would not have caught attempt 2. Note test 2 would *not* have
   caught attempt 1 (which absorbed embeddings without merging clusters); test 3 is the
   one that catches it.
7. Existing `liveSpeakerMatching.test.js` still passes unchanged — in particular
   `acceptsMatch(0.72, 0.70) === false` (`:48-49`), which the second attempted fix
   contradicted.

Gate: `npm run typecheck && npm run lint && npm test`.

---

## Open questions

1. **The thresholds are guesses.** 0.65/0.03/0.8 were never validated against real CAM++
   output. The honest check is to run stored profile embeddings and saved meeting audio
   through the real model (`speakerEmbeddings.js:13`) and read the similarity histograms.
   Not doing that here; this change makes the *policy* coherent without re-tuning the
   numbers, which is a separable piece of work.
2. ~~Are merges propagated?~~ **Answered: no.** Now designed in — see "Merges must be
   propagated" above.
3. ~~Does anything depend on `maxSpeakers`?~~ **Answered: yes**, `ipcHandlers.js:6902`
   and `:4942`. Removal deferred to its own change.
4. Step 3 (`acceptsMatch` inside `_assignOrForceCluster`) is unreachable on every real
   path — both entries are only reached *after* `_findTransientMatch` ran the same
   predicate over the same clusters. Kept for defensive symmetry; no test asserts it
   fires.
