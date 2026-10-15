# Open tickets

Things found while building, deliberately not built, and picked up cold from here. Each one
says WHERE, WHAT, WHY IT IS ONLY A TICKET, the FIX and the TEST, because a ticket without those
is a rumour.

Two are worth promoting above the rest:

- **T-F1-1** — `Reco._rowById` can hand back the wrong row after an in-place re-order of
  `sess.data`. Latent today (nothing re-orders in place; every real route replaces the array),
  but the correction, find-and-replace and five row-level writers now all address rows by `_id`
  through it, so it is a shared single point of failure in a 200k-row hot path.
- **T-F2-1** — the second pane's extra filter+sort pass at 200k rows. The cost is confirmed and
  BOTH proposed remedies were measured unsafe; this records what a safe one would need.

Also still open from earlier rounds, listed here so there is one place to look:

- The AEG `''` vs grid `'#ERR'` divergence on a broken formula, which **posts a zero** today.
  Raise its priority: once the override and carry-forward work lands it is the only remaining
  disagreement between what the grid shows and what the journal receives.
- `saveTemplate`'s read-modify-write race, properly fixed (partially mitigated by the rename
  detection and stale-template warning).
- `loadVersionedFile` does not replay `correctionMaster` or the `_corrected_` flags, so
  reopening a file from history makes already-corrected rows look wrong again.
- `applyCorrection` does not go through `applyEdits` and writes no `Cn` row — the root of the
  above, and changing it changes what a correction *means*.
- Renaming a column in step 1 silently drops it from `primaryKeys` / `displayColumns` /
  `displayOrder`, and the `primaryKeys` half silently changes row identity.
- Excel View per pane (lift the four jspreadsheet singletons).
- The general `Store.save` merge for every `PERSIST_KEY`, now that the one merge-write primitive
  exists. Three named callers, not a sweep.
- The Excel export's dropdown list is built from `d.options` only, so a carried or overridden
  value outside the option list exports as a cell outside its own list.
- Context columns on the Master List of Corrections, modelled on `openGroupDetails`.
- A sticky `right: 0` Apply cell in the correction table.

---

# From the two-panes round


<!-- fixer 1 -->

## T-F1-1  `Reco._rowById` hands back the WRONG ROW after an in-place re-order
            of `sess.data`  (found while mutation-testing B2's `_id` re-find)

**Where** apps/Reco.html `_rowById(sess, rowId)` and `_buildRowIdxMap(sess)`.

**What** The id -> index map is memoised on `(array identity, array length)`:

    if (c && c.data === data && c.len === data.length) return c.map;

so `sess.data.reverse()` or `sess.data.sort(...)` — same array, same length —
leaves the memo pointing at the wrong index and `_rowById` returns a DIFFERENT
ROW. Everything that addresses a row by id goes through it: `setTag`,
`bulkMarkOffset`, `smartUnmark`, `_repaintRow`, and now `_replaceOne` and
`applyCorrection`. A wrong row here is a wrong number on the share.

**Why it is only a ticket** Nothing in the tree re-orders `sess.data` in
place today — I checked (`grep -n 'data\.sort(\|data\.reverse(\|\.data\.splice(\|
data\.unshift('` over apps/Reco.html is empty). Every real route that
invalidates an index (ingest, Excel load-back, Clear, Restore) REPLACES the
array, which busts the memo correctly. So this is latent, and the honest fix
is a verification rather than a guess — but it sits in a 200k-row hot path and
does not belong in a blocker round.

**Fix** In `_rowById`, verify and re-build once rather than scan every time:

    const r = (i === undefined) ? null : data[i];
    if (r && r._id === rowId) return r;
    Reco._idxCache = null;                       // the memo is about another order
    const j = Reco._buildRowIdxMap(sess).get(rowId);
    return j === undefined ? null : (data[j] || null);

O(n) once when the memo is wrong, free on every common-path call.

**Test** Section [22]'s `frOne` fixture, with `sess.data.reverse()` (IN PLACE)
instead of the `slice().reverse()` it uses now. I hit this exact failure
building that test: with the in-place form, the by-`_id` fix looks broken.

---

## T-F1-2  The pane key is still missing from five row-level writers
            (= finding A6, LOW — fixer 2's list, named here so it is done in
            ONE pass with the `_id` half)

**Where** `Reco.editCell` (apps/Reco.html), `Reco.setTag`, `Reco.manualOffset`,
`Reco.unmarkOffset`, `Reco.toggleRowSelect`; emitters at `_renderEditableCell`
(the `onchange` string), the two `editCell` selects in `_renderOneRow` /
`_renderExtraCell`, and the two `setTag` emitters in `_renderExtraCell`.

**What** I fixed B1 at the ONE chokepoint (`Panes.focus` flushes the pending
commit-on-blur before the ownership moves), which is what closes it today and
what the triage measured as sufficient for BOTH faces and BOTH triggers. The
belt-and-braces half the triage also recommended — bake `pkey` into the five
emitters and resolve through `Reco._paneSel` — I did NOT do, on purpose:

  * A6 asks for exactly those five call sites AND for addressing the row by
    `row._id` instead of by an index into `sess.data`. Those two edits are the
    same edit at the same anchors. Doing the pane-key half now would leave
    fixer 2 re-opening five lines I had just touched, for no measurable gain.
  * `editCell(rowIdx, ...)` is the one where the index half MATTERS more than
    the pane half: with the chokepoint in place the pane is right, and the
    remaining hazard is `sess.data[rowIdx]` going stale.

**Fix** A6's remedy verbatim, with the pane key and `row._id` together:
`Reco.editCell(<i>,'<col>',this.value,<pkey>,'<rid>')`, and
`Reco.setTag('<rid>','<col>',this.value,<pkey>)`, each resolving through
`Reco._paneSel(paneKey)`. `const pkey = U.jsq(((typeof Panes !== 'undefined' &&
Panes.owner()) || {}).key || 'p0')` is the pattern — it is in
`_renderRecoTableInner` and now in `_renderCorrectionInner` too.

**Test** Section [21] already has the fixture. Add one assertion in the shape
of [20]'s `progCorr`: with the LEFT pane owning the screen, call
`Reco.editCell(2,'Status','PROG','p1')` and assert it reached LEDGER and not
BANK. That is the only assertion that bites, because on the click path
`activeRecoId` is already correct (which is why `a1_global_pane` survived my
first mutation pass until I added the programmatic call).

---

## T-F1-3  `_replaceAll` re-scans instead of using the list it showed

**Where** `FindReplace._replaceAll`.

**What** It never reads `s.matches`; it re-walks `sess.data` with a matcher
rebuilt from the dialog's current Find box. Before this round the result list
on screen could therefore be about a different template entirely — that half
is fixed (both the search and the replace now resolve through
`FindReplace._target()`, the pane the dialog was opened from). What is left is
narrower: the user can edit the Find box or the column AFTER pressing Find All
and then press Replace All, and the count in the toast is about the new search,
not the list they are looking at.

**Why it is only a ticket** It is not a cross-pane or cross-template fault any
more, and `_readState()` at the top of `_replaceAll` means the re-scan is
honest about what it is doing. Making Replace All use `s.matches` changes a
behaviour that predates panes (and changes what happens to rows that have come
to match since the search).

**Fix** Either refuse when `_readState()` shows the search terms have changed
since `_runSearch`, naming the stale list, or replace only the listed
`rowId`s. The first is the smaller change and matches how this app refuses.

---

## T-F1-4  `AppState.activeSubSection` / `_correctionCol` / `_activeReport`
            are still global  (spec_panes T12-T14; both builders reported it)

**What** Two panes on the Correction tab share the chosen COLUMN, and
switching one pane to Pivot View switches both. Named in `VIEW_KEYS_PENDING`
and already whitelisted by `_restoreView`, so moving them onto the session is a
drop-in.

**Why it matters more now** Section [20] in run_panes_e2e pins both panes on
the Correction tab as a supported state, and with the `corr_*` id gone that
state is now actually safe. The shared column is the last thing about it that
will look like a bug to a user — pane 1 cannot fix a Ref while pane 0 fixes a
Date.

**Not v1 scope** The Step 9 split assigns it to no commit and the ask said
nothing about it. It is a "make it good", and it is one ticket, not four.

<!-- fixer 2 -->

## T-F2-1  B4's memo, and B4's repaint-rule change — BOTH measured, NEITHER built

**Where** `Reco.applyTableFiltersSort` (apps/Reco.html, `const all =
sess.data.slice();`), and the repaint rule in `Panes.renderReco`
(`if (p !== owner && (built || p.tplId === owner.tplId)) Panes.renderPane(p);`).

**What B4 asked for** "Build the memo PLAN2 specified, keyed by the view
object (a WeakMap, same shape and invalidation point as Reco._virtStates and
Reco._invalidateIdx), before the ⨷ Split button goes in front of a team
working 200k-row extracts." The triage then offered a smaller alternative:
repaint the second pane with `Reco._refreshVirtBody(p)` instead of a full
`Panes.renderPane(p)` whenever `_virtRowsState` / `_virtColsStale` say its
rows, page and column signature are still valid.

**Why neither is built**

1. **The cost claim is confirmed and the cause is not the one named.**
   Measured here (run_panes_e2e [26], 200,000 rows, best of 3, only the
   synchronous `App.navigate('reco')` on the clock): one pane 171 ms with
   ONE pipeline pass of 111 ms; two panes on one template 267 ms with TWO
   passes totalling 159 ms. So the second pane is real, and it is ~1.6x, not
   2.45x. But with no filter and no sort the whole pipeline is under a
   millisecond of the navigate (the triage measured 0.6 ms of 32 ms), so on
   an extract as loaded the memo would recover about 1% — and a memo keyed by
   the VIEW OBJECT cannot make the second pane's pass a hit at all, because
   the two panes are two different view objects, and once they carry
   different filters (the entire point of the feature) they can never share
   an entry. The triage measured that directly: `{"pipelinePasses":2,
   "memoWouldHit":1,"memoWouldMiss":1}`. The memo is a real SINGLE-PANE win
   for repeated passes over one view; it does not pay for the repaint rule,
   which is what B4 claims for it.

2. **The invalidation the finding specifies is not safe.** `{ dataRef, len,
   filtersHash, sortHash }` does not include `sess.offsets`, and
   `_invalidateIdx` — the "same place" the remedy points at — has exactly ONE
   call site in the file. `applyTableFiltersSort`'s first filter is
   `if (sess.statusFilter === 'open') filtered = filtered.filter(r =>
   !sess.offsets?.[r._id])`, so a Mark Offset or a `recalcOffsets` would be
   served a HIT and draw rows that are now offset as still open.

3. **And the cheaper alternative has the same defect.** I shimmed it in at
   the exact chokepoint it names, with the repo file untouched
   (`/tmp/claude-0/-home-user-arunsasi813/abbca681-4dd1-5eac-a122-e5ada9e583fe/scratchpad/panes/fix/f2/p4_b4hazard.mjs`, port 20384): two
   panes on one template, both filtered to open rows, Mark Offset in the
   owner, then the ordinary navigate.
   * today: owner `[m2,m3,m4,m5]`, other pane `[m2,m3,m4,m5]` — both drop it.
   * with the remedy: owner `[m2,m3,m4,m5]`, other pane `[m1,m2,m3,m4,m5]`
     — the unfocused pane goes on drawing a row that has just been offset.
   `_virtRowsState` tests array identity, page and page size. It says nothing
   about whether the pane's own filters still select the same rows, and
   `_refreshVirtBody` reuses the pane's PUBLISHED filtered list. In a
   reconciliation workbench a pane that lists an offset row as open is a
   double-posting invitation, bought for ~40% of one navigate.

**What IS built instead** the counter, in run_panes_e2e [26]: at most one
pipeline pass per pane and no more, so the asymmetric repaint rule cannot
quietly grow a third; a VIEW-only change still runs one pass; a ratio guard
(two panes under 3x one pane, measured 1.6x) that is a ratio against the same
machine and never an absolute.

**If it is wanted later** the memo is safe only with the offsets-and-extras
generation in the key, or restricted to `statusFilter === 'all'`, and the
release note has to say plainly that it does not make the second pane free.
The correctness guard that must ship with it is the one the triage wrote:
statusFilter 'open', 200k rows, note the filtered length, `Reco.recalcOffsets`,
assert the filtered length CHANGED. The repaint-rule half needs a membership
signature, not a row-array identity check — which is a bigger change than
either finding describes.

---

## T-F2-2  The column order cannot be per pane without one of two real changes

**Where** `Reco.setUserOrder` -> `Reco.userPref(tpl.id, 'columnOrder', ...)`,
`Reco._prefKey` (`'reco.view.v1.' + tplId + '.' + key`), `Panes.DATA_KEYS`.

**What** B6 is right that PLAN2's v1 list says "independent ... widths /
order / hidden" and that the order is not per pane. I made the decision
VISIBLE (the ⨷ Split tooltip now says the order is shared and stored per
reconciliation per PC; the DATA_KEYS comment says why, and run_panes_e2e [25]
pins it) rather than making it per pane, because both ways of doing that are
bigger than the finding:

* **Add `columnOrder` to VIEW_KEYS** collides head-on with commit (a)'s
  deliberate classification: that key is the LEGACY TEAM order that arrives
  off the shared folder and is read by `Reco._legacyTeamOrder`. Per-pane it
  defaults to null in the second pane, which then silently renders its
  columns in a different order from the first — which is the failure the
  classification comment already describes.
* **Key the localStorage pref by pane as well** (`reco.view.v1.<tpl>.<pane>.
  columnOrder`) loses a person's order the moment they close the pane, and
  leaves two stored orders for one reconciliation on one PC with no rule for
  which one a single pane should read.

Either is a design decision for whoever owns the v1 scope, not a fix. What
the tooltip now promises is exactly what the code does.

---

## T-F2-3  `openGroupMenu`'s dropdown outlives the pane it was opened from

**Where** `Reco.openGroupMenu(anchorBtn, paneKey)` — the `.col-dropdown` it
appends to the button's parent, and the three buttons inside it.

**What** A5 is closed: the pane key is baked into the three emitted handlers,
and each action refuses a selection that reaches outside that pane. What is
NOT closed is the dropdown's LIFETIME. It is appended to the DOM and closed
by a document-level click listener, so it can survive a `Panes.renderPane` of
its own pane (the anchor is replaced and the detached dropdown stays on
screen), and it carries a pane key that may by then name a pane showing
another template. The refusal catches the dangerous case — the write is
refused with a sentence, because `Reco._paneSel` re-resolves through
`Panes.ctx(paneKey)` and the selection check runs against the pane's CURRENT
template — so what is left is a stale menu that says "no", not a wrong write.

**Fix** The same stamp FindReplace and the slicer got from fixer 1: carry the
tplId on the dropdown (`data-tpl`), and have the three actions refuse with a
sentence naming both reconciliations when it no longer matches. Or remove the
dropdown in `Panes.renderPane`. Not done now because it is a third copy of a
pattern that should be one helper, and because the damage today is a refusal.

---

## T-F2-4  `_repaintRow` is now cross-pane; the other row-level DOM writers in
            that family are not

**Where** `Reco._updateVisualRow` / `Reco._syncSelectAllBox` are already
per-pane (sanctioned exceptions 2 and 3). `Reco._ssApplyHighlight` and
`Reco._applyRowFlash` now take the pane's own wrapper from `_repaintRowIn`,
but their OTHER callers still default to `document.querySelector('.reco-table-
wrap')`, i.e. the owner pane.

**What** Harmless today and I checked why: sheet mode and Excel View are
refused while a split is open (commit (b) enforces it, run_panes_e2e [11]
asserts it), so `_ssApplyHighlight` has nothing to paint in a split, and
`_applyRowFlash`'s only split-reachable caller is the scroll-to-row path,
which is the owner's by construction.

**Why it is a ticket and not a fix** The day either of those restrictions is
lifted — which the Excel-View-per-pane note in the VIEW_KEYS comment
anticipates — these two become the same bug A2 was. A grep for
`document.querySelector('.reco-table-wrap` is the sweep, and it should be
done with that feature, not before it.

---

## T-F2-5  `AppState.flush()` serialises every loaded template on every save
            (= B8, which asked for a number rather than a fix)

**Where** `AppState._persistValue('recoSessions')` -> the whole of
`AppState.recoSessionsOwned`; `AppState.flush`.

**Measured** run_panes_e2e [26], this machine, best of 3 of the real
`await AppState.flush()` with a real bridge write:

| loaded | serialised | flush (best of 3) |
|--------|-----------|-------------------|
| one 200,000-row template  | 24.6 MiB | 1,787 ms |
| two 200,000-row templates | 49.3 MiB | 3,693 ms |

Linear in the number of loaded TEMPLATES and flat in the number of panes — a
split adds nothing to it, it just makes holding two of them the normal way to
work. (The reviewer measured 7,234 ms for the two-template case on their
machine; same shape, slower disk.) The suite now guards the two-template
figure at 30,000 ms — far above the measurement on purpose, because what the
guard is for is a change in the SHAPE of the cost, not this machine's disk —
and asserts the size ratio stays at 2x, which is the part that cannot flake.

**Not a fix** Nothing here is caused by the pane feature. It is the argument
for S10 (moving `manualTags` and friends off the session into a pk-keyed
store), as B8 itself says, and it belongs in the release note: a two-big-
template split makes every debounced save slower, against a file several
people on the folder are writing.

---

## T-F2-6  `Reco._selectedPks()` with no pane key still reads the global

**Where** `Reco._selectedPks(paneKey)`.

**What** It resolves through `Reco._paneSel(paneKey)` now, so the three group
actions are correct. With NO argument it falls back to the owner, which is
right for the single-pane path and is what keeps `run_panes_e2e [24]`'s
no-split assertion true. There is no caller left without a key — I checked
apps/, tests/ and docs/ — so this is only a shape note for the next caller
someone adds: pass the key, the way the three actions above do.

**Why not now** Making the parameter mandatory would mean throwing from a
function whose only no-key caller is a test of the no-split path. It is a
lint, not a defect.

---

## T-F2-7  The row-level writers carry a pane key and a row id, but not the
            template the markup was rendered for

**Where** the emitters `Reco.editCell(<i>,'<col>',this.value,'<pkey>','<rid>')`
and `Reco.setTag('<rid>','<col>',this.value,'<pkey>')`, and
`Reco._paneSel(paneKey)`.

**What** A6 asked for the pane key and `row._id`, and that is what is built.
The residual is narrow and worth writing down: `_paneSel('p0')` resolves p0's
template AT COMMIT TIME, so if that pane has been pointed at ANOTHER template
between the render and the commit, the edit is looked up by `_id` in the new
template's rows. A row `_id` is minted per load and two templates can carry
the same one (the builders say so, and the suites' fixtures do), so in that
window the edit could land on a same-id row of the other reconciliation —
which is B1's damage one step further along, needing one more coincidence.

**Why it is only a ticket** No ordinary gesture reaches it. Pointing a pane at
another template means clicking that pane's own `<select>`, which moves focus
out of the cell and fires `change` — i.e. the commit happens first, as
measured in run_panes_e2e [21]. The route left is a PROGRAMMATIC
`Panes.setPaneTemplate` (or `onDataReplaced`) while a cell is dirty. Also,
with no pane key at all this hazard was unconditional, so what is in the tree
now is strictly better than what A6 described.

**Fix** Bake the template into the emitters as well and have the writers
refuse when it has moved — the pattern `commitEntryFromPreview` uses
(`pending.tplId || AppState.activeRecoId`) and the one fixer 1 gave
FindReplace and the slicer (`_state.paneKey` + `_state.tplId`, refuse with a
sentence). It is one more argument in six emitters plus one comparison in
three writers; it wants doing with T-F2-3 so the file ends up with ONE
"this handler's pane has moved on" helper rather than four copies.

**Also covered by that fix** `Reco.applyCorrection(rowIdx, colName, newVal,
paneKey, rowId)` — fixer 1's A1 fix — resolves its pane and re-finds its row
exactly the same way, so it has the same residual and wants the same stamp. It
already SAYS SO when the row is not found ("That row is no longer in this
pane's data — nothing was corrected"), which is the sentence the editCell
family should borrow; see T-F2-8.

---

## T-F2-8  A dropped row-level edit is silent

**Where** `Reco.editCell` — `const row = rowId ? Reco._rowById(sess, rowId) :
sess.data[rowIdx]; if (!row) return;`

**What** With the row addressed by `_id` (A6), there is now a path where the
row genuinely is not in that pane's data any more: a reload, a restore, an
Excel load-back or a programmatic template switch between the render and the
commit. The edit is then correctly NOT written — and nothing is said, so the
user's typing disappears. B1's lesson was precisely that a silently lost value
is as bad as a wrongly placed one.

**Fix** The sentence fixer 1 already wrote for the same case in
`applyCorrection`: `U.toast('That row is no longer in this pane\'s data —
nothing was changed.', 'error')`. Two lines in `editCell`, and the same in
`manualOffset` / `unmarkOffset`.

**Why not now** It is a behaviour change on the hot typing path (`editCell`
runs on every cell commit in the app) and it would land after the fourteen
suites had already been run green against the file as it is. It is worth one
deliberate change with its own assertion — "a dropped edit says so" — rather
than a drive-by at the end of a round.
