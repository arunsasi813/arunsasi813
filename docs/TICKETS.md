# Open tickets

Things found while building, deliberately not built, and picked up cold from here. Each one
says WHERE, WHAT, WHY IT IS ONLY A TICKET, the FIX and the TEST, because a ticket without those
is a rumour.

Six are worth promoting above the rest:

- **T-S10-31** — `reco/recoSessions.json` is written **whole** by every window, so one window's
  boot copy of a template it never opened overwrites another window's morning of work on it,
  unconditionally and in silence. It is **T-S10-10's shape on a different file**, and a bigger one
  (24.6 MiB for one 200,000-row template). **READ OFF THE CODE AND NOT YET MEASURED** — which is
  why it is the one entry on this list without a number beside it, and the first thing to do with
  it is the two-page fixture its **Test** paragraph names. Promoted because it is the largest
  unexamined **silent loss of a colleague's committed work** left, and because it is no longer
  blocked on anything: the primitive it needs exists (`write_file_if_unchanged`, T-S10-10). What it
  needs is a decision about what merging two windows' sessions means — last-write-wins per template
  id, probably, which is a rule about the operator's work and not a detail.

> **T-S10-28 and T-S10-10 WERE the first two entries on this list and are both FIXED.** The bridge
> now has an OS advisory file lock across both branches of `append_csv_rows` (the colleague's
> append survives the widening rewrite at every timing, where it was lost at 0.00 s and 0.15 s)
> and a conditional write behind `Store._mergeJob`'s compare-and-swap loop (1,002 of 1,002 ledger
> entries survive two processes pressing Generate together, where one was lost at every stagger
> including 0 ms). Handover §20.


- **T-S10-25** — a template whose key names **no added column** gets no key-rule signature, so a day
  file written before its `primaryKeys` **list** was edited still hands those rows back writable
  under their old keys. This is the measured remainder of T-S10-19 after round 8 closed it for
  derived keys, and it is promoted because it is the one shape of that harm still open, and because
  closing it means widening the day-file header of **every** template on the folder — which is the
  cost round 8 declined to pay silently. `run_store_e2e` **[88] R19j** measures it rather than
  claiming it shut.

- **T-S10-17** — `AppState.flush()` can now wait on a template settle, so the three rules that
  keep that safe are invariants nothing enforces. It is here because of how it fails: not a wrong
  number and not a lost value, but a **HANG** — `run_store_e2e` stopped dead at section [28] for
  fourteen minutes and a checkpoint was committed in that state. The next engineer to make a settle
  path wait for a write will rediscover it the same way.

- **T-S10-10** — the ledger merge is atomic inside ONE page and not BETWEEN pages. Two people
  pressing Generate within one read-write cycle of each other can still lose a journal entry, and
  the loser's own write SUCCEEDS so nothing tells them. The money round narrowed the window twice
  and measured what is left; closing it needs a **write-if-unchanged in the bridge**, which is the
  one thing none of these rounds could edit. It is the only open ticket whose harm is a lost
  journal entry.
- **T-F1-1** — `Reco._rowById` can hand back the wrong row after an in-place re-order of
  `sess.data`. Latent today (nothing re-orders in place; every real route replaces the array),
  but the correction, find-and-replace and five row-level writers now all address rows by `_id`
  through it, so it is a shared single point of failure in a 200k-row hot path.
- **T-F2-1** — the second pane's extra filter+sort pass at 200k rows. The cost is confirmed and
  BOTH proposed remedies were measured unsafe; this records what a safe one would need.

**Filed late, in the pending-work sweep after round 7** — the attack reported both and no round
wrote them down, which is the one failure mode this file exists to prevent:

- **T-S10-23** — a backup carrying pk-keyed records WITHOUT the templates that key them is
  accepted and restored, so the records land under a rule that is not on this folder. `importBackup`
  is one of the two paths deliberately allow-listed out of the dead-key chokepoint, and the reason
  given ("refusing would make a backup unrestorable on the day it is needed") is right for a WHOLE
  backup and does not hold for a partial one.
- **T-S10-24** — the owed-write replay's confirm names the row key in every line but never says
  that key may no longer be the one this reconciliation computes, so the operator presses Yes on
  key strings they have no way to judge. T-S10-19's signature now EXISTS (round 8, handover §19),
  so the honest version of this is a clause in a dialog rather than a schema round.

Also still open from earlier rounds, listed here so there is one place to look:

- ~~The AEG `''` vs grid `'#ERR'` divergence on a broken formula, which **posts a zero** today.~~
  **CLOSED (Z1).** Reproduced first — an FX column `NUM({Base})/NUM({Rate})` with one row's rate
  0 read `#ERR` on the grid, the ladder, the report, the CSV, the workbook *and* the AEG source
  row, and posted **Dr 150.00** where two of the three rows are worth 150, with the third — the
  largest — stamped `POSTED` and nothing behind it. And the divergence named here was **not the
  mechanism**: the loop's `catch` is unreachable because `Formula.evaluate` catches internally and
  *returns* `'#ERR'`, so what posted the zero is `U.num('#ERR') === 0` in `_buildEntryLines`.
  Both shapes are built — the loop now says `'#ERR'` (so the refusal has one sentinel to key on)
  **and** `previewEntryFromSelection` refuses the posting, naming the key, the column and the
  formula, scoped to the columns the entry reads and judged pre-filter for the keyword column.
  Handover §16.1, `run_store_e2e` section [49].
  **AND THEN TWO DOORS WERE FOUND STRAIGHT THROUGH IT**, each putting the same wrong number into
  the ledger, both now closed as **MR-1** (`run_store_e2e` [54]):
  (a) **an override on the '#ERR' cell**, which is the one thing the refusal's own message sends
  the operator to do. The override gate in the AEG extras loop runs *before* the formula arm, so
  an overridden cell never entered `badFx`, and RC-8 only fired when `rec.prev` was numeric —
  which for an '#ERR' cell it is not. Measured: `'500` posted **Dr 150** for three rows worth
  150 + INV-3, and `1.234,50` posted **Dr 151.23**, both with the row stamped POSTED.
  (b) **a Special JV bucket**: the read set held the AEG template's columns only, while the split
  that buckets a row ran *below* both refusals. Measured: Reco handed the JV page `"AED":"#ERR"`
  and an aggregating JV posted **Dr 150** for three rows worth 650. The read set is now built
  once, PER ROW, above both refusals, and a bucketed row is judged on its own JV's
  `inputColumns`.
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
  value outside the option list exports as a cell outside its own list. **Now reachable**: #30
  ships carried dropdown values, and the grid already keeps and marks a stale option.
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

## T-F2-8  ~~A dropped row-level edit is silent~~  **FIXED** (reopened by the review, closed again)

**THE REVIEW OF THIS ROUND FOUND FIVE MORE DOORS, and one of them LOST the edit rather than
dropping it.** Findings B4 (HIGH) and B6 (MEDIUM): the Fix paragraph named three functions and its
last sentence said "the same in its siblings", so it was applied to a LIST OF FUNCTIONS rather
than to a RULE. `Reco.setTag` at a vanished row wrote the typed value into the legacy
`sess.manualTags` under the dead `_id` and `AppState.save()` put it on the shared folder — keyed on
an id `U.uid()` mints fresh on every load, so the `manualTags` read fallback can never find it
again, and it was not journalled either, so T-S10-9's replay cannot recover it. It is also the door
most typing goes through: `editCell` serves FILE columns, `setTag` serves every ADDED one.
`setOverride`, `revertOverride`, `confirmCarried` and `ssToggleRowSingleUse` were silent too, two of
them about a DELETE that did not happen. The dead-id write is gone, the five sentences are in, and
`run_store_e2e` **[76]** is the gate. The legacy `manualTags` READ fallback is untouched and
`run_reports_e2e` still seeds and reads it unedited.

**CLOSED.** `Reco.editCell`, `Reco.manualOffset` and `Reco.unmarkOffset` now carry the sentence
`applyCorrection` already used for the same case. Section [66] (F28a-F28d); F28d is the control
that matters — a row that IS there still commits, the value is in the store and on the shared
folder, and NOTHING is said, because `editCell` runs on every cell commit in the app. Handover
§18.4.


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

---

# From the #27 correction-context round


## T-C27-1  The correction tab validates the RAW value; the grid validates the
            DISPLAYED one — and the context columns now put the two side by side

**Where** `apps/Reco.html` `_renderCorrectionInner` (`!FMT.validate(row[col.name],
col.formats)`, and the `<td class="cell-error">` that prints `U.esc(row[col.name])`)
against `_renderOneRow` (`let val = Reco.displayCellValue(...)` then
`!FMT.validate(val, colDef.formats)`).

**What** For a column whose name contains "date", `displayCellValue` runs
`U.formatExcelDate` first, so the grid validates `01/01/24` while the correction tab
validates `45292`. A format rule of `DD/DD/DD` passes in the grid and fails on this
tab — the same cell, red in one place and fine in the other — and the Correction
section tab's own count is computed the tab's way, so the number beside the tab name
disagrees with the number of red cells in the grid.

**Why it is only a ticket** It is pre-existing and it cuts both ways: whichever reader
is changed, somebody's format rules start matching or stop matching overnight, and the
rule that moves also moves `anyFormatErrors`, the section-tab counts and the red cells
in the grid together. #27 makes it VISIBLE rather than worse — pick that same date
column as a context column from another format tab and the row shows `45292` under
Current Value and `01/01/24` two cells to the left — but #27 deliberately did not
touch the Current Value cell or the counts (decisions C and D), so changing the reader
here would have put a format-rule change inside a view-preference commit.

**Fix** One reader. `FMT.validate(Reco.displayCellValue(tpl, sess, row, col.name),
col.formats)` in all three places (the error collection, the five count passes and
`anyFormatErrors`), and the Current Value cell printed through `displayCellValue` as
well so what is validated is what is shown.

**Test** A template with a `Posting Date` column holding serials and
`formats: ['DD/DD/DD']`: assert the grid's red-cell count, the section tab's count
and the correction tab's row count are the SAME number, and that the value in the
Current Value cell is the value that was validated. It fails today on all three.


## T-C27-2  A keyless template can show the bad value twice

**Where** `apps/Reco.html` `_renderCorrectionInner`:
`const idCols = pks.length ? [] : (tpl.columns || []).slice(0, 3)...`

**What** Decision H's fallback shows the first three template columns as identifying
columns, because with no primary key there is nothing else on the row to tell the rows
apart. When the active format column is one of those three — and on a small template
it usually is — its value appears both as an identifying cell and as Current Value, the
second time in red. Harmless, and it looks like a bug.

**Why it is only a ticket** The decision says "the first three template columns", in
those words, and the alternative is a rule ("the first three that are not the active
format column") that makes the identifying cells move as the operator switches format
tabs — the exact instability decision F exists to avoid for the chip row.

**Fix** Keep the trio stable and drop the DUPLICATE CELL instead: skip an identifying
column that equals `col.name` when emitting the row, and emit the `<th>` for it as
"Current Value" only. Four lines, one rule, nothing moves between tabs.

**Test** A keyless template whose first column carries the format rule: assert the bad
value appears in exactly one cell of the row, and that the identifying `<th>`s are the
same list on every format tab.

**Note, fix round** The KEYED half of this is now closed and the shape is there to copy:
`_renderCorrectionInner` builds `ctxShown = ctx.cols.filter(n => !already.has(n))` where
`already` is `pks` plus the active format column, and emits the `<th>` and the `<td>` from
that while the chip row keeps the whole stored list (decision F). Only the keyless trio
still duplicates, and it needs the same four lines against `idCols`.


## T-C27-3  The "Show 200 more" cap is keyed on a GLOBAL format column

**Where** `apps/Reco.html` `Reco._corrSig(tpl, colName, cols)`, called with
`col.name` resolved from `AppState._correctionCol`.

**What** The cap is per pane and resets when the format column changes, which is
decision B. But the format column itself is `AppState._correctionCol`, a global — see
**T-F1-4** — so switching the format tab in ONE pane changes it for both, and the
other pane's expansion is reset although nothing the operator did concerned that pane.

**Why it is only a ticket** It is entirely a consequence of T-F1-4, which already has
the fix written: `correctionCol` is named in `Panes.VIEW_KEYS_PENDING` and already
whitelisted by `_restoreView`, so moving it onto the session is a drop-in. Fixing it
here would mean doing T-F1-4 inside this commit, and T-F1-4 changes what the section
tabs do in both panes — which wants its own assertions, not a rider.

**Fix** T-F1-4: move `_correctionCol` onto the session as a per-pane VIEW key. `_corrSig`
then needs no change at all — it is handed `col.name`, and `col` is already resolved
per pane inside the render.

**Test** Two panes, two templates, both on the Correction tab, both over the cap:
press "Show 200 more" in the right pane, switch the LEFT pane to its other format tab,
and assert the right pane still shows 400 rows. (The per-pane half of this is already
pinned in `run_correction_e2e` [13]; this is the half that needs T-F1-4.)

## T-C27-4  A per-user context list keeps names of deleted columns for ever

**Where** `apps/Reco.html` `Reco.correctionCols` (the `dropped` filter) and
`Reco.userPref(tplId, 'correctionCols', …)` — the per-user store in `localStorage`.

**What** `tpl.correctionContextCols` is pruned against `allNames` on every
`saveTemplate` (decision I), so the team list cannot hold a dead name for long. Nothing
prunes the per-user list: it is written whole by the picker, by `Clear` and by the chip
`×`, and read through a filter that drops dead names at read time without ever writing
the shorter list back. So an operator who chose `Narrative` keeps `Narrative` in their
own store after the column is deleted from the template — and if a column of that name
is ever added again, a choice they made months ago silently comes back.

**Why it is only a ticket** The read deliberately does not write: a preference the
operator has not set must stay unset, or the first person to open the tab becomes the
author of whatever the team default happened to be that morning — the comment above
`correctionCols` says so, and the fix round's F5 change rests on it (a list that lost
every name now falls THROUGH to the team default, which it could not do if the read had
rewritten it to `[]`). Pruning therefore has to happen on a WRITE, and the write that
should do it is the picker's `Done` — which is a change to `_corrColsDone`, not to the
reader, and wants its own assertions about what `dropped` then counts.

**Fix** In `Reco._corrSet`, store `cols.filter(n => Reco._corrKnown(S.tpl, S.sess).has(n))`
rather than `cols`, so every per-user write lands pruned. The read-time filter stays as
the belt for lists written before this.

**Test** Choose `Centre` and `Narrative`; delete `Narrative` from the template; reopen the
picker and press Done; assert the stored array is `['Centre']` and not
`['Centre','Narrative']`; then re-add a column called `Narrative` and assert it does NOT
reappear beside the bad value.


## T-C27-5  The Excel view is a third reader of the per-cell number format

**Where** `apps/Reco.html` `Reco._xlRender` (the `else if (fmt && fmt.numFmt && !empty)`
branch), against `Reco._ssFmtApply`, which the grid's read-only cell and the correction
tab's context cells now both go through.

**What** The fix round made the per-cell number format ONE rule for the two readers that
disagreed. The Excel view still has its own: it applies `numFmt` in a branch of an
if/else chain, so a cell with a `numFmt` never reaches the `XlSchema.dateLabel` branch
below it, and it never runs `U.formatExcelDate` first the way `displayCellValue` does.
For every format the probes exercised the three screens agree; the orderings differ, so
there is no guarantee they go on agreeing — a date column with a `numFmt` of `percent`,
or a `recoDisplay` date format plus a `date_short` cell format, are the shapes to check.

**Why it is only a ticket** It is the Excel view's branch chain, not the correction tab's,
and the branch order is load-bearing for the status column and the dropdown labels either
side of it. Changing it belongs with the Excel-view-per-pane work, which already has to
touch `_xlRender`.

**Fix** Give `_xlRender` the same two steps in the same order as `displayCellValue` +
`_ssFmtApply`: resolve the display value by role first, then apply `fmt` last, so one
rule decides and the chain only decides what the value IS.

**Test** The same row and column read off all three screens — grid `<td>`, Excel view
`<td>`, correction context `<td>` — for a date column carrying a `numFmt`, asserted
character for character. `run_correction_e2e` section `[F1]` is the two-screen half of
exactly this comparison and is the pattern to extend.


## T-C27-6  `App.importBackup` replaces the sessions wholesale and writes BOTH legacy view fields

**Where** `apps/Reco.html` `App.importBackup` (`AppState.recoSessionsOwned = d.recoSessions`),
against `Reco.restoreSession`, which now carries the STORED `columnOrder` **and**
`correctionExtraCols` across untouched.

**What** `restoreSession` is one of the two routes that used to write the read-only legacy
view fields; `importBackup` is the other, and it has no guard for either. A backup taken
while somebody had hand-edited `correctionExtraCols` — or taken from a build with a
different `columnOrder` — republishes both to the one shared `recoSessions.json`, for
every template in the file at once. Measured by the triage round: it writes
`correctionExtraCols` AND the `columnOrder` twin that `keepLegacy` exists to protect, so
it bypasses #25's patch as well as the one #27 needed.

**Why it is only a ticket** `importBackup` is wholesale BY DESIGN and its confirm says so
in those words — "It REPLACES the templates, sessions, masters and entry history shared by
everyone using this folder". It is pre-existing house behaviour, identical for #25's
field, and narrowing it is a decision about what a whole-folder restore MEANS, not a #27
defect. Folding it into `restoreSession`'s one-line fix would make a wholesale restore
quietly partial, which is worse than either honest answer.

**Fix** Decide, then do one of two things. If view fields are never restored: after the
assignment, walk `AppState.recoSessionsOwned` and re-apply the stored value of every
`Panes.VIEW_KEYS` field from the sessions that were there before — one loop over the
whitelist, so the next legacy field is not forgotten the way this one was. If they are
restored: leave the code and extend the confirm to enumerate the team settings a
whole-folder restore replaces.

**Test** Export a backup; hand-edit `recoSessions[id].correctionExtraCols` to two names and
`columnOrder` to two others; import it with the confirm accepted; assert whichever decision
was taken — either both fields hold the STORED values and the Correction tab shows no
context column, or the confirm names them. Read the shared file back off the bridge, as
`run_correction_e2e` `[R2-F5]` does, rather than trusting memory.


## T-C27-7  `Reco._extraValueForRow` stops the extras walk by NAME, so a duplicate added-column name gives a wrong value to Find/Replace, exports, filters and the slicer

**Where** `apps/Reco.html` `Reco._extraValueForRow` (`Reco.rowFull(tpl, sess, row, ac.name)`)
and `_rowWithExtras`'s name branch.

**What** The mechanism of the correction tab's R2-F12, in the caller that was NOT changed.
With `additionalColumns` = [`Dup` = `"A"`, `Mid` = `"M"`, `Dup` = `CONCAT("x",{Mid})`],
`Reco._extraValueForRow(…, extras[2])` returns `x` where the whole-row walk the grid uses
returns `xM` — measured on this build and on `d9957fc`, so it is pre-existing. That helper
feeds Find/Replace, the export type sniff, the grid filters and the slicer, so the
consequence is a filter that hides a row it should show and a wrong value in an exported
file, not just a blank cell.

**Why it is only a ticket** Pre-existing and outside this tab, and the honest fix changes
the CONTRACT of a helper with nine callers: `_rowWithExtras` would have to compare the
extras ENTRY rather than its name. #27's path needed only an unambiguous stop and got one
(an index); widening the contract wants its own commit and its own assertions across all
nine callers.

**Fix** Accept the entry itself, which is the real chokepoint — it closes the name
ambiguity for every caller at once, this tab included:
`if (upto != null && (typeof upto === 'number' ? i > upto : (typeof upto === 'object' ? ac === upto : ac.name === upto))) break;`
with `_extraValueForRow` passing `ac`.

**Test** That three-extra fixture: assert `Reco._extraValueForRow(tpl, sess, row, extras[2])`
=== `'xM'` and equal to `Reco.rowFull(tpl, sess, row)['Dup']` character for character; then
a grid filter on that column, asserting the row it should match is matched. Keep
`run_correction_e2e` `[R2-F12]`'s assertions as the guard that the correction path stays
right whichever form the stop takes.

**CLOSED — AND THE "What" PARAGRAPH ABOVE MISATTRIBUTES ITS OWN CONSEQUENCE,** which is the more
useful half of the round. The entry stop is built and gated; the four surfaces named above are not
what it fixes.

**The correction.** "That helper feeds Find/Replace, the export type sniff, the grid filters and
the slicer, so the consequence is a filter that hides a row it should show and a wrong value in an
exported file" is true of the STATE but not of the name-matched stop. Every one of those readers
resolves the column through `Reco._extraDef`, which searches `tpl.additionalColumns` and returns
the **first** match — and asking `_extraValueForRow` about the first entry stops before the first
entry, which is correct, so it answers that entry's own value either way. Measured
(`scratchpad/dup/probes/p1_repro.mjs`, arm A) on the reachable collision, extras
`[Mid, Dup(template formula), Dup(session)]`:

```
the grid cell            ''      <- the whole-row walk's LAST writer wins
every helper reader      'xM'    <- _extraDef resolves the FIRST entry
filter "is empty"        0 rows  <- a filter hiding a row it should show
the slicer offered       ['xM']  <- a value no row on screen showed
Find/Replace             1 hit   <- in a column the screen showed blank
```

Those five lines are the ticket's stated harm, and they are produced by **two entries with one
name and last-writer-wins in the walk**, not by the stop. `R27f`/`R27n` are the checks that pin
it: `_extraDef` still answers the template entry after the fix, and that entry still answers `'A'`
on arm B's fixture. **T-C27-9 is what closes them**, and it is closed in the same commit.

**What the entry stop DOES fix** is the ticket's own measurement, which is confirmed exactly
(`R27m`, and `P1g` before the fix): on `[Dup="A", Mid="M", Dup=CONCAT("x",{Mid})]`, asking
`_extraValueForRow` about the **third** entry answered `'x'` where the whole-row walk answered
`'xM'`, because the walk stopped at the first entry sharing the name and `{Mid}` was never
evaluated. That state is **not reachable through the editor** (`R27l`): `saveTemplate` refuses its
own duplicate — *"Added column "Dup" is defined twice"* — so it arrives from a hand-edited
`recoTemplates.json`, `App.importBackup` or a different build. Which is a smaller harm than the
ticket thought, and still worth closing, because the ambiguity was in the CONTRACT of a helper
with nine callers.

**The shape, and it is not the ticket's one-liner.** `_rowWithExtras` resolves its stop to an
**index once**, at the top, rather than testing three ways inside the loop:

```js
let stopAfter = -1, stopBefore = -1;
if (typeof upto === 'number') stopAfter = upto;
else if (upto && typeof upto === 'object') {
  stopBefore = extras.indexOf(upto);
  if (stopBefore < 0) stopBefore = extras.findIndex(a => a && a.name === upto.name);
} else if (upto != null) stopBefore = extras.findIndex(a => a && a.name === upto);
```

A NUMBER stops **after** that index (`_corrUpto`), an ENTRY stops **before** that exact entry, a
NAME stops before the first entry carrying it. An entry that is not in the list falls back to its
name rather than throwing or walking everything, which is what a detached clone would do; no
caller in the file passes one — every def comes from `_extraDef`, `_storeColumn` or the live list
— and `R27f` is the gate that says identity, not the fallback, is what resolves the duplicate
fixture.

**Both name-form callers now pass the entry.** `_extraComputedValue` holds `ac`.
`_extraBaseValue` holds the entry `_storeColumn` just resolved, and passing it means those two
adjacent lines cannot disagree about which `Dup` is meant. **That second change is deliberately
unmeasurable and is recorded as such:** `_storeColumn` searches `tpl.additionalColumns` only and
returns the first match, and template entries come first in the concat, so the name stop and the
entry stop resolve the same index for every input. The mutation grid reports `red=NONE` for it,
which is the honest result rather than a probe fault — it is there so a future session-aware
`_storeColumn` cannot silently desynchronise them.

**`rowFull`'s parameter was renamed `uptoName` → `upto`**, which T-C27-8 asked for: it describes a
single-shaped argument that stopped existing when `_corrUpto` began passing a number, and is now
three-shaped. The two sentences above it about a row memo are still wrong and are still T-C27-8's,
which the comment now says.

**Gated by `[96] R27` in `run_store_e2e`** (24 checks) and one added check in
`run_correction_e2e` `[R2-F12x]`. **Mutation grid 11** in `scratchpad/dup/mut/run.py` — nine
against the round's own probe (`scratchpad/dup/probes/p2_fix.mjs`) and two pane ones against
`scratchpad/dup/probes/p3_split.mjs`.

---


## T-C27-10  An OVER-CAP chosen list can show chips and cells that are different sets

**Where** `apps/Reco.html` `Reco.correctionCols` (`const cols = seen.slice(0, Reco.CORR_CTX_CAP)`)
feeds the chip row, while `_renderCorrectionInner`'s `ctxShown` loop builds the rendered set
from `ctx.all` minus the names the row already prints.

**What** Two lists, by necessity, and when the chosen list is BOTH over the cap AND contains a
name the row prints elsewhere they can name different columns. Measured with a nine-name list
whose first two are the key and the column under correction: the chip row shows
[Doc, Ref, Centre, Description, Second Ref, Note] and the table renders
[Centre, Description, Second Ref, Note, Acct, Calc] — so Acct and Calc render with no chip, and
Doc and Ref have a chip but no column of their own. The panel's two counts still account for
every name ("1 more not shown (up to 6 columns)" and "2 already on the row as the key or the
value being corrected"), so nothing is unexplained; it is the chip MEMBERSHIP that is odd.

**Why it is only a ticket** The state is not reachable through the app: the picker enforces
`CORR_CTX_CAP`, so a list longer than six can only arrive from a hand-edited recoTemplates.json,
`App.importBackup`, or a build with a different cap. At six or fewer — every state a user can
create — the chip row is exactly the chosen list and the cells are that list minus what the row
already prints, which is coherent and is what the two counts describe. And the two constraints
that force two lists are both load-bearing: decision F requires the chip row to be panel-wide
and STABLE ACROSS FORMAT TABS (the column under correction changes per tab, so a skip-filtered
chip row makes a chip the operator never removed vanish when they switch — this is exactly what
T9 and F2 caught when it was tried), and R2-F6R requires the chip row to be capped.

**Fix** A third list: chips from the live chosen names capped at `CORR_CTX_CAP` but with the
RENDERED names preferred — i.e. cap the renderable ones first, then fill the remaining slots
with the skipped ones, so chips ⊇ cells always. About six lines in `correctionCols`, returning
`{ cols, chips, all, dropped, capped, elsewhere }`.

**Test** Section R2-F6R's own fixture, extended: assert every rendered `td[data-col]` name has a
chip, and that the chip row is byte-identical on both format tabs (the T9 assertion) in the same
run — the two halves must pass together or the fix has traded one for the other.

## T-C27-8  The `rowFull` comments and the handover doc both describe a memo that has never existed

**Where** `apps/Reco.html` `_fullPass()` (its whole body is `Reco._fullCache = { ctx: {} }`),
the comment above `_fullCache` ("holds two things: the memo, keyed by row._id, and the
Masters.indexFor context"), the comment above `rowFull` ("memoised for this pass"), and
`docs/RECO_ARCHITECTURE_HANDOVER.md:166` ("there is deliberately **no** whole-row memo:
uptoName is set on every real call").

**And now stale in a second way.** The #27 correction round made `uptoName` polymorphic:
`Reco._corrUpto` returns `{ upto: <index> }`, so the correction path passes a NUMBER while
`_extraValueForRow`'s path passes a NAME, and two callers still pass neither
(`apps/Reco.html:17355` and the suite's own whole-row read). Whoever fixes this ticket must
correct that too — the handover line describes a single-shaped argument that no longer
exists, which is worse than describing a memo that does not exist, because a reader will
write `uptoName === someName` against it.

**What** There is no row memo and there never was: two `rowFull(tpl, sess, row)` calls on
the same row inside one pass pay two walks and two sets of per-extra evaluations. The two
comments say there is one; the handover doc documents the absence with a reason that is
itself false, because `apps/Reco.html:17340` and the correction panel's own no-`upto`
branch both call `rowFull` with no `uptoName`. So the next person reads a contradiction in
which both sides are partly wrong. Byte-identical on `d9957fc` — pre-existing, and #27
added none of this text.

**Why it is only a ticket** It is a documentation defect with no behaviour attached (the
triage verdict on it is OUT_OF_SCOPE for this round), and the other way of resolving it —
adding the memo — buys about 1 ms per render: 200 rows with one master_lookup over a
50,000-row master and one formula measured 18 ms for one whole-row reader, 19 ms for two
and 23 ms for three, against this suite's own T11 threshold of 1,500 ms for that shape.
The pass already shares the expensive thing, which is the 50,000-entry index. A memo on
the `uptoName` path would also hand a PARTIAL row to a caller that asked for a whole one,
which is the one property the present comment gets right.

**Fix** Cut the claims down to the code, in three places and with no behaviour change:
`_fullCache`'s comment to "holds one thing: the Masters.indexFor context"; `rowFull`'s
"memoised for this pass" to "threading this pass's Masters context; there is no whole-row
memo"; and the handover line to keep "no whole-row memo" while dropping the `uptoName`
justification, naming instead the two callers that pass none. Leave the
`_fullPass()`/`_fullEnd()` pairing exactly as it is — a master index that outlives its
render is a stale chart of accounts.

**Test** Not a timing assertion. If anyone ever adds the memo, assert it by COUNT: two
`rowFull(tpl, sess, row)` calls in one pass with `window.__evals` unchanged after the
second, plus a negative assertion that `rowFull(tpl, sess, row, upto)` is never served
from it — compare the returned object's key set against the full walk's.


## T-C27-9  `saveTemplate` cannot see the session, so a template save can create two added columns with one name

**Where** `apps/Reco.html` `RecoTemplate.saveTemplate`'s duplicate checks (over `t.columns`
+ `t.additionalColumns`) against `Reco.ssCommitAddCol`'s check (over those PLUS
`sess.extraColumns`).

**What** Two ordinary gestures reach a state that neither check refuses: **+ Col** adds a
session-only column called `Note` (accepted — the template has no such name), and then the
template editor adds an added column called `Note` (accepted — `saveTemplate` has no
session in scope to look at). `_rowWithExtras` then evaluates both entries in turn,
`visibleBase` de-duplicates so the grid draws one column, `_extraDef` resolves the first,
and #27's early stop had to be re-based on a POSITION so that it stops at the right one
(`run_correction_e2e` `[R2-F12]`, which builds the state from those two gestures).

**Why it is only a ticket** The correction tab is correct in that state now, and the
duplicate itself is pre-existing: the grid, the Excel view and every export have always
collapsed it to one column. Refusing it means either making `saveTemplate` session-aware —
which it is not, by design, and is the same reason F3's prune could not be widened — or
refusing at a third place. Both are decisions about the template write path, which carries
its own "KNOWN AND UNMITIGATED" staleness note and wants its own commit.

**Fix** Refuse it where a session IS in scope. `Reco.ensureSessionShape` runs on every open
of a reco: when a session extra's name is now held by a template column or an added column,
say so with a toast naming the column and either drop the session entry or rename it to
`<name> (session)`. That is one place, it is the only place that can see both lists, and it
repairs an existing share on the next open rather than only refusing new ones.

**Test** The two gestures of `[R2-F12]`: assert whichever refusal is chosen, with the toast
naming the column, and keep `[R2-F12]`'s own assertions (the chosen context cell equals the
grid's cell, character for character) as the guard for the state if it is allowed to stand.

**CLOSED — as a repair on the open, which also fixes shares already in this state.**

**The state is exactly as the ticket describes it** and is asserted rather than assumed (`R27a`):
"+ Col" adds a session-only column called `Dup` — accepted, because `ssCommitAddCol` checks
`tpl.columns`, `tpl.additionalColumns` **and** `sess.extraColumns`, and the template has no such
name — and then the template editor adds an added column called `Dup`, accepted because
`saveTemplate` has no session in scope. `saveTemplate` does refuse its OWN duplicates (`R27l`), so
this one gesture pair is the whole reachable route.

**AND IT IS THIS TICKET, NOT T-C27-7, THAT CLOSES THE HARM T-C27-7 CLAIMED.** Measured
(`scratchpad/dup/probes/p1_repro.mjs`, arm A): the grid cell read `''` while every helper reader
read `'xM'`, so filtering **"is empty"** on a visibly empty cell matched **nothing**, the slicer
offered a value no row on screen showed, and Find/Replace matched inside a column the screen
showed blank. T-C27-7's entry stop cannot move any of that, because each reader resolves the name
through `Reco._extraDef` to the first TEMPLATE entry and that entry answers its own value
correctly. T-C27-7's own closing block carries the correction.

**`Reco._dedupeSessionExtras(sess, tpl)`, from `ensureSessionShape`.** The template is a new
optional second parameter, passed by `Reco.render` and `Reco.ingestData` — the two callers that
have one — and deliberately **not** by `Panes._viewFor`, whose `extraColumns` is a DATA key that
would write through to the owner and repeat the work `Reco.render` does a moment later with the
real template in hand. `makeSession()` passes none and a fresh session has no extras to collide.

**RENAME, NOT DROP, AND THE OPERATOR'S WORK MOVES WITH IT.** The ticket offered either. The
session entry is the operator's own column and may already carry values they typed, so dropping it
discards their work to tidy a collision they were never told about. `<name> (session)`, then
`<name> (session 2)` and up, so a second collision cannot land on the name the first rename wanted
(`R27q` — and the other session extra, which does not collide, is left alone).
`Reco._reKeyColumnName` moves `sess.manualTags` (keyed `row._id + '||' + name`, so the suffix is
what moves), `columnFilters`, `columnWidths`, `slicers`, `hiddenCols`, `columnSorts.col`, and the
inner keys of `cellFormats` / `cellFormulas`, which are keyed by row first. **Nothing on a shared
pk-keyed master is touched**, because a session-only extra's value never reaches one — decision P,
only a persisted template column's typed value becomes a durable shared record. `R27d` is the
check, and the mutation that removes the re-key turns `R27d` red **and** `R27h`/`R27i`/`R27j`,
because `hiddenCols` left naming `Dup` then hides the TEMPLATE column instead.

**THE TEMPLATE ENTRY IS NEVER TOUCHED** (`R27e`). It is the shared one; a repair that renamed it
would change what every colleague sees. The mutation that renames it instead turns ten checks red.

**And it is said** (`R27c`, `R27p`), in one sentence per collision naming both names and why —
the operator typed that name and the heading in front of them has just changed. One sentence for
the one column that moved, not one per session extra (`R27r`). Deferred by a `setTimeout(0)` so it
does not fire inside a render that has not drawn the new heading yet.

**The standard columns count too** (`R27o`): a session extra whose name a template **column**
holds is renamed on the same open. `ssCommitAddCol` checks that list at the gesture, so this is
the shape a template that GAINS the column later produces, and it is the half of the `taken` set
arm A cannot reach.

**`run_correction_e2e` `[R2-F12]` builds this exact collision and is still green**, because it
reads its extras list immediately after `saveTemplate` and before the first `App.navigate` — the
one window in which the state exists. Its header now says so and `[R2-F12x]` asserts the rename,
so nobody reads that fixture as evidence the duplicate survives an open.

**AND THE PANE HALF, WHICH THE FIRST VERSION OF THE REPAIR GOT WRONG TWICE.** `extraColumns`,
`manualTags`, `cellFormats` and `cellFormulas` are **DATA** keys — one copy, on the owner — so
renaming them through the session Reco.render holds reaches both panes. `columnFilters`,
`slicers`, `columnWidths`, `hiddenCols` and `columnSorts` are **VIEW** keys, one per pane. Left
alone, the other pane's filter or hidden-column setting would keep naming `Dup`, which after the
rename resolves to the **template** column — so that pane would be filtering and hiding somebody
else's column. That is precisely what the grid shows when the re-key is dropped altogether, one
pane along.

So the repair walks `Panes.panesFor(tpl.id)` — and asks **`Panes.viewFor(pn.key, tpl.id)`, not
`pn.view`**. Measured (`scratchpad/dup/probes/p3_split.mjs`): after `openSplit()` the panes read
`p0:noview p1:view`, because the **owning** pane has no view object at all — its VIEW keys live on
the owner session itself, and only the second pane gets a proxy. `pn.view` missed the owning pane
every time.

**And the mutation that proves `viewFor` is load-bearing rather than defensive only went red once
the arm rendered the right thing.** With `App.navigate('reco')` the repair fires on p0's render,
`sess` is then the owner — i.e. the owning pane's own object — and `pn.view` picks up p1, so both
panes move and the mutation measured nothing. Three app sites render the **non-owner pane alone**,
each guarded by `pane !== Panes.owner()`: `Reco._slicerRepaint`, `Reco._corrRepaint` and the
virt-cols escalation in `refreshGrid`. On that render `sess` is p1's view and nothing but
`Panes.viewFor` names p0's object. `R27u` asserts the arm rendered that way, which is what gives
`R27v` its teeth.

**Gated by `[96] R27`** (24 checks) plus `[R2-F12x]`, and a **mutation grid of 11** —
nine mutations against `p2_fix.mjs` and two pane ones against `p3_split.mjs`.

---


## T-24R2-1  ~~`saveTemplate`'s read-modify-write race now splits ROW IDENTITY~~  **FIXED** (and the refusal's own blind spot closed after the review)

**THE REFUSAL WAS RIGHT AND ITS RECOVERY SENTENCE WAS HALF TRUE.** The review's finding A4 (HIGH):
`_abandonSave` refreshes `AppState.recoTemplates`, `_openedWith` and the posted index, and nothing
re-keys the rows this window already has LOADED, whose `_pk` was minted under the rule that has just
gone. So the operator was told, in so many words, that their window was now correct, and everything
they typed afterwards reached the shared folder under a key the folder's rule no longer computes:
they read it back fine, no colleague ever saw it, and it was gone from their own grid at the next
reload. Measured: B did exactly what the sentence said, typed into `Vendor`, the record landed under
`D1`, and A's upload of the same business row under the folder's rule read `D1-X` and showed blank —
no toast anywhere. The round had traded a silent revert of a colleague's key rule for a silent loss
of this operator's typing. Fixed with a per-window latch (`Reco._keyStale`, never on the session so
it cannot be serialised to a colleague who has nothing wrong), the refusal's new sentence about the
rows on screen, and typing doors that refuse with a sentence until the rows are read again; lifted
by `Reco._keyStaleLift` once no row on screen is left under the old rule. `run_store_e2e` **[71]**
and **[79]**, with a control that typing works normally after Clear Loaded Data and a load — a
latch, not a dead end. (This paragraph said "cleared by `Reco._mintKeysSync`, which every re-keying
route goes through" until round 5. `_mintKeysSync` has one caller, `Reco.ingestData`, and clearing
the latch there lifted it for rows the upload had never touched — handover §18.10.)
**The refusal itself stands, and T-S10-7's general merge must not be allowed to swallow it:** a key change is not a
field, it decides what every other record is filed under. **T-S10-16 took the latch from three
doors to eighteen, and round 5 fixed the LIFT, which was coming off while the rows it guarded were
still dead-keyed; T-S10-18 (also CLOSED) was the group, comment and attachment doors.
T-S10-20 (CLOSED) stopped it being a list at all: the question is asked at the WRITE, by the one
pair of functions through which a row becomes a key for a record the folder holds, and
`run_store_e2e` [82] enumerates those writers from the source. "Every operator gesture that writes
under a row key" was claimed after round 2 and after round 3 and was false both times — eight more
controls were open. T-S10-19 is the same harm from the other direction — a day file written before
the change, in a window that did nothing wrong — and it is **CLOSED in round 8** for a derived key.
Round 6 closed it by comparing each row's stored key against a fresh recompute; round 7 removed that
because the comparison cannot tell *"the rule moved"* from *"this row's own data moved"* and it
refused five measured pieces of ordinary work (T-S10-21). Round 8 records the key rule's
**SIGNATURE** on the row at mint time (`_pksig`, a hash of `RecoTemplate._keyDefOf`), carries it
through the day file's control columns, and compares signature to signature — never value to value.
A row with **no** signature is not refused, which is the migration. The remainder, a key that names
no added column, is **T-S10-25**.

**CLOSED, AND AS A REFUSAL RATHER THAN A MERGE.** T-S10-7's general merge would have kept the
folder's key definition silently, and the share would even have ended with one scheme — but B's
session is keyed under the OLD scheme and B's NEXT UPLOAD would mint under a rule B never chose,
which is the trap the ticket names. So `RecoTemplate._keyDefOf` reads `primaryKeys` plus the
definitions of the columns in `Reco._keyDepNames` (the whole closure, from both sides) and any
difference between the share and `_openedWith` refuses the save with this ticket's sentence,
whatever this editor did; nothing is stored, and `_abandonSave` refreshes the window from the
folder so "close it and open it again" is a recovery and not a loop. MEASURED on this tree, one
upload from each of two pages: **8 distinct `_pk` for 4 business rows before, 4 after**
(`run_store_e2e` S241e). Section [64] (S241–S241g). Handover §18.2.


**Where** `apps/Reco.html` `RecoTemplate.saveTemplate`, the `KNOWN AND UNMITIGATED`
comment above `if (!t.dataFolder) t.dataFolder = Versioning.folderFor(orig || t);`, against
`RecoTemplate._openedWith`, which is captured at the end of the same function specifically so
such a check could exist and is never consulted.

**What** `AppState.recoTemplates` is read once at boot, `RecoTemplate.edit()` deep-clones, and
this function replaces the whole stored object — so a field a colleague saved at 10:00 is
reverted when a save goes out from a 09:00 clone. Pre-existing, and it affects every template
field. #24 changes what it costs: `additionalColumns` is now part of what IDENTIFIES a row, so
page A can edit a key formula and save (its confirm fires correctly), page B can then save a
name change from its earlier clone and silently revert that formula, and the two of them start
minting different `_pk` for the same invoice. One day file then holds two incompatible key
schemes for the same business rows, reopening it from history gives one row per key, and the
open-item total doubles with each half carrying only its own offsets and corrections. Nothing
notices: B's clone and the stored template agree, so `defsMoved` is false, no confirm fires and
`tplSignature` moves for neither of them.

**Why it is only a ticket** Closing even the identity half means re-reading the stored template
from the shared folder before writing, and every read of the share is a `fetch` through the
bridge — so this is an `await` inside `saveTemplate`, i.e. the async template write path the
existing comment already defers to its own commit. Every e2e fixture in the repo calls
`RecoTemplate.saveTemplate()` synchronously and reads `AppState.recoTemplates` on the next line;
making it async is a change to that contract and wants its own round with its own regression
run. #24's own fix for the same hazard class — the definition-change confirm and the signature —
is in and works for one page.

**Fix** Bounded, not the whole race: before writing, re-read the stored template's
`primaryKeys` plus the definitions of the columns in `Reco._keyDepNames(stored)`, and if they
differ from `RecoTemplate._openedWith`'s, refuse the save with "someone else changed how this
reconciliation identifies its rows while this editor was open — close it and open it again"
rather than overwriting. Two fields, one read, no merge.

**Test** Two pages on one share with the same template open in the editor; A edits a key
formula and saves; B saves a NAME change from its earlier clone. Assert B is refused by that
sentence, that `reco/recoTemplates.json` still holds A's formula, and then that one upload from
each page writes ONE key scheme into `reco_data/<folder>/<MMM-YY>/<DD>.csv` — the measurement to
beat is the 12 history rows for 4 business rows under two schemes that this race produces today.


## T-24R2-2  A row added in the grid has no frozen key: on a DERIVED key it has no key at all, and on a typed key the key moves when the cell is edited

**Where** `apps/Reco.html` `Reco.rowKey`'s `_ssAdded` branch
(`if (row && row._ssAdded) return Reco.getRowPK(tpl, row) || null;`) against
`Reco._ssBlankRow`, which deliberately writes no `_pk`.

**What** Round 2 made a row typed in with **+ Row** answerable: `rowKey` works its key out
from the key cells, which is the same key `Reco.applyEdits` already writes that row's history
under, so its manual offset and its correction reach the shared masters and are applied when the
extract next contains that key. Two things are still true of such a row and of no other row:

1. **Its key is not frozen.** `getRowPK` reads the cells every time, so editing a key cell after
   filing a correction leaves that correction under the old key, unreachable from the grid. This
   is also what the build before #24 did, so it is not a regression — but #24 is the ticket that
   made every other row's key immovable, and this is the one row shape where it still moves.
2. **On a DERIVED key it has no key at all.** `getRowPK` reads `row[k]`, and a formula or lookup
   column's value is not on the row — so on exactly the templates this ticket was about, a
   hand-added row answers null and its offset, correction, group and comment are refused (the
   row menu says "Row has no primary key", which is at least honest).

**Why it is only a ticket** Both need a mint on the EDIT path: `_pk` written once, when the
row's key cells are first complete, which for (2) also means running the dependency closure
(`Reco._keyScratch`) for one row inside `Reco.applyEdits` / `Reco.ssSetCell`. That is new
behaviour on the one path #24 was told not to widen, and decision F is explicit that `rowKey`
itself must never mint. It also needs a decision the UI does not currently ask for: a hand-added
row with a derived key is a row the operator is inventing, so the app has to say whether the
derived columns are computed for it at all.

**Fix** In the edit path, when a row carries `_ssAdded` and no `_pk`, and the edited column is in
`tpl.primaryKeys` (or in the closure of a key extra), and every component is then non-blank:
mint `_pk` once from `Reco._keyScratch`, move any `manualOffsetMaster` / `correctionMaster` /
`groupMaster` / `commentMaster` entry already filed under the previous answer, and from then on
treat the row like any other — frozen. Do NOT write `_pk` before that point: four version
writers are guarded by nothing but `if (row._pk)` and a session-only row must not append change
rows to the shared day file.

**Test** (1) Keyed template, `Reco.ssAddRow(false)`, type the key cell, `Reco.applyCorrection`,
then edit the key cell again: assert the correction is still reachable from the row (today it is
not). (2) A template keyed on a formula extra: add a row, fill the columns the formula reads,
and assert `Reco.rowKey` answers with the formula's value and that the offset reaches
`manualOffsetMaster.json` — today it answers null. Keep G19's assertion that nothing is appended
to `reco_data/<folder>/` for a session-only row.

**CLOSED — and the decision the ticket left open is taken (yes, the derived columns are computed),
plus a third arm the ticket does not mention and a stale comment found by copying it.**

**Three arms, all measured** (`scratchpad/ar/probes/a1_repro.mjs`):

| arm | the key a `+ Row` row answered | the harm |
| --- | --- | --- |
| A — a typed key | `NEW-1`, then `NEW-2` after the key cell was edited | the correction stayed under `NEW-1`, unreachable from the row that owns it, with nothing said |
| B — a single DERIVED key component | `null` | every door refused the row — *"Row has no primary key"* — while the grid showed `L-D9` for the same column |
| C — a MULTI-component key with a derived part | `'D9||'` | truthy, so `Reco.storeKey` accepts it and every door takes a key that is **not** what the extract computes (`D9||L-D9`); two invented rows sharing a `Doc` share it |

**Arm C is not in the ticket, and it is worse than it looks:** the SCREEN agreed with the wrong key
rather than with the formula. Decision G recovers a key extra's value out of the key, `'D9||'`
splits into exactly `primaryKeys.length` parts, and the part for `Look` was `''` — so the derived
cell rendered **blank**. Arm B shows `L-D9` for the identical formula only because there the key is
null, so there is nothing to recover and the value is computed.

**What was built:** `Reco._freezeAddedRowKey`, called from `Reco.applyEdits` over the rows that edit
touched.

**It freezes into `_bk`, not `_pk`, and that is the whole care of the fix.** `Reco.writeVerKey`
returns `row._pk` and is the key a version row in the shared day file goes under, so a `_pk` here
would start appending change rows for a row the operator chose *not* to persist — erasing the
difference between **+ Row** and **+ Persistent Row**. `R29l2` asserts the **chokepoint**
(`writeVerKey` answers null for all three frozen rows) and `R29l` the consequence (not one version
row in `reco_data/` across every arm). The chokepoint assertion is the one that carries the
weight: an empty day file alone would also pass on a build that never wrote one, and T-S10-20's
whole point is that the question is asked at the write. The mutation that freezes into `_pk` turns
`R29l2` red and left `R29l` green, which is exactly why both exist.

**The decision the ticket left open.** *"a hand-added row with a derived key is a row the operator
is inventing, so the app has to say whether the derived columns are computed for it at all"* — they
are, through `Reco._keyScratch` over `Reco._keyClosureUpto`: the **same machinery the upload mint
uses**. So a hand-added invoice is keyed by the rule the file would have keyed it by, and the
correction filed on it is applied when the extract next contains that key. That is the whole point
of letting the row have a key, and the grid already showed those values (arm B's premise), so
nothing new is put on screen.

**When it freezes:** every component non-blank and none of them `#ERR`. A half-filled row keeps
answering off its cells and its key still **moves** (`R29q`, `R29r`) — round 2's behaviour, and
what keeps a row being typed in answerable at all. A broken formula does not freeze a key minted
from an error (`R29s`), which no later correction of the formula could undo.

**And it moves what was already filed.** Arm C's shape is reachable, so a correction can be filed
under `'D9||'` before the key is complete; the four pk-keyed masters the ticket names are re-filed
under the frozen key (`R29o`). **An entry already under that key wins** (`R29o2`): the frozen key is
the one the extract carries, so what is already there belongs to the real row and the hand-added
row's partial-key entry is the one to drop.

**`R29p` and `R29p2` are a pair, and the first looks like a gap until the second is read.** A key of
plain template columns gets **no** `_pksig`, because `Reco.keyRuleSig` returns null unless the key
names an added column — only a *definition* can be redefined, and an uploaded row on such a
template carries no signature either. On a key that does name an added column the row carries it,
equal to `keyRuleSig` for the template, so T-S10-19's machinery reads this row exactly as it reads
an uploaded one.

**A BUG THIS ROUND HAD, AND THE PROBE CAUGHT IT.** The freeze first read the pre-freeze answer with
`Reco.getRowPK`, which reads the cells **as they are now** — i.e. the new key — so `was === key`
and the move never happened: `R29o` red with the correction left under `'D9||'`. `applyEdits` now
captures the answer **before** the edit lands and passes it in, because only the caller can know
it. The mutation that puts `getRowPK` back is in the grid.

**A STALE COMMENT FOUND BY COPYING IT.** `_ssBlankRow`'s note named *"_ssFillColumn's two,
_ssCommitCell and _ssClearCell"* as the four writers guarded by `if (row._pk)`. **None of those
three functions exists** — T-S10-20 folded them into `Reco.writeVerKey` and the list was never
corrected. I copied it into my own comment before checking, found it when the day-file control
would not go red, and both notes now name the chokepoint and its real callers (`_ssCommit`'s two,
`_ssClearActive`'s, and the fill at the paste door).

**Gated by `[98] R29` in `run_store_e2e`** (24 checks). **Mutation grid of 10** in
`scratchpad/ar/mut/run.py` against the round's own probe (`scratchpad/ar/probes/a2_fix.mjs`), every
one measuring.

---


## T-24R2-3  Renaming a key component drops it from the key instead of carrying it over

**Where** `apps/Reco.html` the name input in `RecoTemplate._renderAdditionalColumnsEditor`
(`oninput="RecoTemplate._editing.additionalColumns[i].name=this.value"`) against the prune in
`saveTemplate`.

**What** Rename a key extra from `Ref` to `Ref2` and save: `primaryKeys` goes from
`['Doc','Ref','Look']` to `['Doc','Look']`. Since round 2 the confirm NAMES what it dropped and
why ("there is no column with this name"), so the operator is told — but they are told about a
deletion they did not ask for, and the obvious intent (the same key, under the new name) is not
offered. PLAN2's S18 lists rename detection as part of `saveTemplate`'s one validation gate; it
is not built.

**Why it is only a ticket** Detecting a rename means pairing `RecoTemplate._openedWith.additionalColumns`
POSITIONALLY against `t.additionalColumns`, and a positional pairing is wrong whenever the editor
also added, removed or reordered a column in the same session — which the Eval arrows make easy.
Getting that wrong carries the key over to the wrong column, which is worse than dropping it.
It also wants the same treatment for `displayOrder`, `correctionContextCols`, `aggregateBy` and
`editableColumns`, i.e. it is S18's job and not a key-specific patch.

**Fix** In `saveTemplate`, pair old and new `additionalColumns` by position ONLY when the two
lists have the same length and the same types in the same order; for each pair whose name
changed and whose old name is in `primaryKeys` (or in any of the four lists above), ask once —
"`Ref` is now called `Ref2`. Keep it as part of the row key?" — and rewrite the reference on yes.
On no, keep the drop and the reason the confirm already carries.

**Test** The rename fixture above: assert the question is asked, that yes gives
`primaryKeys ['Doc','Ref2','Look']` with `tplSignature` unmoved, and that no gives
`['Doc','Look']` with the dropped-component sentence. Plus a negative: the same rename in a save
that also deletes a column asks nothing and drops as it does today.


## T-24R2-4  Custom masters are identified by their position in the list, so they cannot be key sources

**Where** `apps/Reco.html` `Masters.catalog` (`out.push({ id: 'custom:' + idx, … })`) against
`AppState.customMasters.splice(idx, 1)` in `deleteCustomMaster`, and
`RecoTemplate._pkEligible`'s refusal of `custom:*`.

**What** A `master_lookup` into a custom list stores `source: 'custom:1'`, a POSITION. Delete a
different custom master and every `custom:1` config silently re-points at another table, with
`additionalColumns` byte-identical — so #24's definition-change confirm cannot fire and
`tplSignature` cannot move. #24 therefore refuses a custom-master lookup as a key component
outright, with that as the stated reason (decision B), which is the right call and also a
feature the user asked for that they cannot have.

**Why it is only a ticket** Giving custom masters stable ids is a migration of stored template
JSON (`custom:<idx>` → `custom:<uid>`) plus a legacy resolver for configs already on the share,
plus a re-validation pass in `deleteCustomMaster`. That is its own commit with its own
migration test, and #24 stands without it.

**Fix** Mint `cm.uid` on creation and on first read of an existing master; emit
`'custom:' + cm.uid` from `Masters.catalog`; resolve a legacy `custom:<digits>` by index once
and rewrite it; in `deleteCustomMaster`, re-run `RecoTemplate._pkEligible` for every template
whose key names a lookup into the deleted master and refuse (or warn and prune, naming it, the
way the save-time prune now does). Then drop the `custom:*` arm from `_pkEligible`.

**Test** Two custom masters, a template keyed on a lookup into the second, delete the first:
assert the key still resolves to the same table (the stored config now names a uid), that the
minted `_pk` is unchanged across the delete, and that deleting the master the key DOES read is
refused by name.

**CLOSED — all four parts, and the decision the ticket left open is taken: a custom master IS a
legitimate key source once its id is stable.**

**The harm, measured** (`scratchpad/cm/probes/c1_repro.mjs`): three custom masters answering
`FROM-VENDORS` / `FROM-CENTRES` / `FROM-REGIONS` for one match value, a template whose
`master_lookup` names `custom:1` reading `FROM-CENTRES`, `Home.deleteCustomMaster(0)` accepted in
**total silence**, and the same cell of the same row then reading `FROM-REGIONS`.
`additionalColumns` byte-identical throughout, and **both** signatures unmoved —
`XlSchema.tplSignature`, which a linked workbook compares against, and `Reco.keyRuleSig`, stamped
on every row as `_pksig`. The ticket named only `tplSignature`; the second one matters more,
because it is what the dead-key refusals read.

**What was built**

1. **`Masters.ensureCustomUids`** mints `cm.uid` on any master without one, **and re-mints a
   duplicate**: merging two backups can bring one uid in twice, which is this ticket's bug wearing
   a different hat. The first holder keeps it, so a config already naming it still resolves
   (`R28u`). `AppState.load` calls it **after** its `_snap` loop, deliberately — minting before
   would make the snapshot match the minted bytes and the uids would never reach the file. Since
   `customMasters` is in `PERSIST_KEYS`, a template saved with a `custom:<uid>` source and the uid
   itself land in **one** save and cannot be durable apart.
2. **`Masters.catalog` emits `custom:<uid>`** (`R28b`), and **`Masters._customAt` resolves either
   form** — a uid by search, a bare index by position — so a config written by any earlier build
   still reads the table it always read (`R28c`). That back-compatibility is the whole risk of this
   change, and it is asserted rather than assumed. The `|| idx` in `catalog` is not a second
   scheme: it is what the function answers if something assigns `AppState.customMasters` without
   going through load.
3. **`Home.deleteCustomMaster` is the dangerous moment**, and does three things before anything is
   removed: mints uids; **rewrites every legacy `custom:<digits>` source to that master's uid
   against the list as it still is** (`R28f` — the last moment the index is correct); then names
   what reads the master going away. A lookup in a template's **key** is a **refusal** with a
   modal naming the reconciliation, the column and the consequence (`R28m`–`R28p`); any other
   lookup is a warning in the confirm **before** the delete and a toast after it (`R28i`, `R28j`),
   because a column going blank is the operator's business and not something to refuse.
4. **`_pkEligible` allows a custom-master lookup in the row key, in its stable form only**
   (`R28q`). A bare index is still refused with the same sentence plus what to do about it
   (`R28r`), and a uid naming nothing is refused for what it is (`R28s`).

**Why a custom master is a legitimate key source — the decision this ticket left open.** Nothing
separated it from the Accounts Master except the identity. Both are shared tables anyone may edit;
both are frozen into `_pk` at mint by decision G; both mark a recalculated cell with `keyDrift`;
and `Masters.indexFor` builds an index for **any** source, so there is no per-row scan of the kind
the legacy `type:'master'` arm refuses by name. The two sources that stay refused are refused for
reasons that genuinely do not apply here: `docNumbers` grows as the team posts, and `corrections`
is keyed **by** the row key. `R28t` is the control over all four.

**Why the rewrite lives only in the delete, and not in a load or a render.** It writes
`recoTemplates`, the shared file, so it belongs to a gesture the operator chose — a background
rewrite of a shared template file is the shape T-24R2-1 is about. The delete is also the only
moment it matters, because a position only moves when the list does. The `custom:<digits>` resolver
is therefore kept for good, not as a one-run migration.

**The index-based `Home.editCustomMaster(idx)` / `deleteCustomMaster(idx)` call sites are left as
they are.** Those indexes are minted and consumed inside one render and never stored; the ticket is
about an index that reaches a stored template config.

**The repro probe is kept as the before/after.** Run against this build, `c1_repro.mjs` goes red on
exactly three of its eight checks — the wrong value, the unmoved definition, and the refusal of the
feature. Its `C1a` still passes, for a different reason worth recording: that fixture assigns
`customMasters` directly without the migration, so `catalog` falls back to `|| idx`. That is the
documented fallback, not the old scheme.

**Gated by `[97] R28` in `run_store_e2e`** (22 checks). **Mutation grid of 12** in
`scratchpad/cm/mut/run.py` against the round's own probe (`scratchpad/cm/probes/c2_fix.mjs`).

**TWO OF THOSE TWELVE MUTATIONS WERE WRONG ON THE FIRST PASS AND THE GRID SAID SO**, which is the
grid earning its keep against the test rather than the code: *"the rewrite happens after the
splice"* **added** a second call instead of moving the first, so the original still did the right
thing and nothing went red; and the warning mutation was named for the confirm **and** the toast
while only emptying the confirm. The runner now takes a **list** of edits for one mutation, which
is what moving a call needs, and the toast has a mutation of its own.

**AND A PROBE FAULT THAT COST FOUR RUNS, recorded because it will happen again.** A probe that
throws before its own `bridge.proc.kill()` leaves the bridge listening, and the next run then dies
with `OSError: Address already in use` — which masks the real error behind a port complaint. Two
genuine faults were hidden that way: `AppState.recoSessions` is the per-pane **view** table and can
be repointed between two `page.evaluate` calls (the read must use `AppState.recoSessionsOwned`),
and **`page.evaluate(STRING, arg)` ignores `arg`** — a string first argument is an expression, not
a function to call with the second, so the whole fixture never ran. `scratchpad/cm/probes/lib.mjs`
now frees the port before spawning.

---


## T-24R2-5  A key component whose value contains `'||'` cannot be split back out of `_pk`

**Where** `apps/Reco.html` `Reco.getRowPK` (`primaryKeys.map(...).join('||')`, which escapes
nothing) against `Reco._keyFrozenPart`'s split guard and `Reco._pkLabel`'s.

**What** `_pk` is the components joined with `'||'`. When a component's own value contains that
separator, `_pk.split('||')` does not give the components back, so the frozen value of that
component cannot be recovered from storage. Round 2 made this honest rather than silent: the
mint counts such rows, `_keyIngestCheck` asks before the day file is written, and `keyDrift`
marks the cell ⚠ recalculated so the screen says the value it is printing is a recalculation
and not the stored key. What it does not do is make the frozen value recoverable.

**Why it is only a ticket** Every fix is a storage-format change: escaping the separator at mint
(`'||'` → `'\\|\\|'`), or a separator that cannot occur in data, or storing the parts. All three
change the bytes of `_pk`, which round-trips the CSV control column, the manual-offset master,
the correction master, the group and comment masters, the Special JV claims and the posted-JV
index — a migration across every file on the share, for a shape the operator is now warned
about before it reaches the share at all.

**Fix** Escape at mint and unescape at split, in `getRowPK` and the two split sites only, with a
one-off migration that rewrites `_pk` in the version files and re-keys the five masters — or
decide the warning is the answer and say so in the handover doc. Do not do half: an escaped mint
with an unescaped reader is worse than today.

**Test** A key component holding `'A||B'`: assert the minted `_pk` splits back into exactly
`primaryKeys.length` parts, that `keyCellValue` returns `'A||B'` and that the drift marker is
NOT painted when nothing has drifted (today it is, correctly, because the value cannot be
recovered).


## T-24R2-6  (LANDED with #26) The AEG editor's input-column RENAME is the one arm of S11 still ungated

**LANDED in the same commit as #26's `allowOverride` box, which is what this ticket asked for.**
`aeg.inputColumns` joined the existing arm of `RecoTemplate._exclusiveRoleConflict` (one arm
extended, not a second gate), `AEG.updateInputCol` asks it when the NAME changes and the name
input moved from `oninput` to `onchange`, and `AEG.selectInputCol`'s two inline writes
(`currencyColumn`, `valueColumn`) now go through `AEG.setEditingPath` — the one writer that asks.
`currencyColumn` and `valueColumn` are covered transitively, because both are the NAME of an
input column. Test: `run_store_e2e` O14 (the refusal, the unchanged name, and the control that an
ordinary rename is silent). The text below is kept for the reasoning.


**Where** `apps/Reco.html` `AEG.updateInputCol` and `AEG.selectInputCol` (which writes
`AEG.editingTemplate.<key>=this.value` inline) against `AEG._roleClash`, which round 2 added and
wired into `AEG.setEditingPath` and `AEG.toggleAggregateBy`.

**What** `RecoTemplate._exclusiveRoleConflict` is now asked in both editors, in both directions,
for the roles that matter today: the To Account input column, the From Account input column and
the club-by set. Renaming an AEG input column into the name of a column a linked reconciliation
holds a role on is not asked about, and neither are the two fields `selectInputCol` still writes
inline (`currencyColumn`, `valueColumn`).

**Why it is only a ticket** With override and carry-forward not built, the matrix refuses
NOTHING on those paths today — `_exclusiveRoleConflict` returns null for every rename, so the
gate would be a call that cannot fire. **STILL TRUE AFTER THE S10 STORE ROUND:** phase 1 added no
flag, so `ac.allowOverride` and `ac.carryForward` are falsy on every template that exists. This
becomes live work the moment either flag can be set — i.e. in the SAME commit as #26's
`allowOverride` box or #30's `carryForward` box, not after it. `updateInputCol` is also called per keystroke, so a
refusal there needs debouncing or a move to `onchange` before it can toast anything. #26 and
#30 are the tickets that make those roles exist, and the function they are told to write into is
now whole.

**Fix** When #26 or #30 lands, add the `aeg.inputColumns` call to `updateInputCol` (on change,
not on input) and convert `selectInputCol`'s two inline writes to `AEG.setEditingPath` so they
pass through the gate that already exists.

**Test** With an override-enabled column in a linked reconciliation, rename an AEG input column
onto it and assert the refusal sentence and that the name is unchanged; and the control, that an
ordinary rename is silent.

# From the S10 store round (#26 / #30 phase 1)

## T-S10-1  (CLOSED for the boot-time clobber; the CROSS-PAGE window is T-S10-10) `Store.mergeWrite` is built but `entryHistory` and `docNumberMaster` still blind-write

**CLOSED for what it was filed about, and the first version of this paragraph claimed more than
was true.** It said the clobber was gone. What is gone is the **boot-time** clobber — a window
whose in-memory map predated a colleague's entry no longer writes a file without it — and that is
measured both ways round. The **cross-page** window is not gone: `Store._queues` serialises a
read-merge-write inside ONE page and nothing serialises it between pages, so two people pressing
Generate within one read-write cycle still produced one file holding one of the two entries, with
the loser's write having SUCCEEDED so nothing told them. **That residual is now T-S10-10**, where
it is measured; the fix round narrowed it further (a settle-and-replay after each Generate, which
makes a clobber inside the settle window heal itself) and `run_store_e2e` [57] drives two pages
with `Promise.all` instead of `await`-then-`await`, so nobody can widen it unnoticed again.

**THE FIX ROUND ALSO FOUND FIVE THINGS, all closed.** The first one is OLDER than this
conversion — it is in the merge primitive itself, so it has been dropping values out of the
VALUES store since phase 1, and it is the same harm as the one this ticket was filed about:

- **MR-8, A VALUE WRITTEN WHILE A MERGE WRITE IS IN FLIGHT WAS DROPPED.** `Store._mergeJob`
  applied `m.intents`, awaited `Store._writeJsonFile`, and then did `m.intents = []` — clearing
  anything that had been pushed during the await WITHOUT EVER APPLYING IT. A write of a shared
  file is hundreds of milliseconds (600 ms at 50,000 records on local disk, plus the wire), so
  that window is an ordinary typing burst. And it was not merely late: `mergeWrite` had already
  armed a fresh timer for the new intent, so a second job ran, took the disk as the authority
  (`Store._takeDisk`) and wrote a file without the value — and because `_takeDisk` replaces
  memory from that same file, the value was gone from the SCREEN too. No error, no toast, no
  second copy anywhere. It is now `m.intents.slice(answering)`: intents are only ever appended,
  so the newcomers are exactly the tail and the next job carries them. Found while chasing a
  document-number correction that never landed, which is the only reason anybody looked;
  `run_store_e2e` [62] holds a 500 ms write with a value typed into the middle of it.

And four that belong to this conversion:
- **MR-2** a ledger write that FAILED was never retried: `Store._retryLater` was called only in
  the unreadable-READ branch, and `m.intents` is cleared only on success, so a posted journal
  entry stayed in memory for the rest of the session while its rows were stamped POSTED on the
  share. The catch retries now, and `Store.idle()` re-arms any write still owed — a ledger has no
  "next keystroke" the way the values store does. The same root lost a whole **contra entry**
  (Dr 60 / Cr 60) and a reversal mark, with the app's own "reverse again" instruction then
  refused by its own in-memory mark; both land now, and the "already reversed" refusal says when
  the mark is still owed to the share instead of leaving no route out of the app.
- **MR-2** `Store._enqueue` wiped `Store.lastError` the instant a merge write failed (it catches
  and does not rethrow), so the reversal dialog's own "The last save error was:" sentence could
  never appear. It is cleared only by a successful save OF THE SAME KEY now, and a failed ledger
  write also leaves a `Store.loadProblems` line that outlives the four-second toast.
- **MR-4** neither key was latched read-only at BOOT when its file was damaged, so the boot said
  "starting it empty" — honest for a whole-file `PERSIST_KEY`, which `flush()` re-creates, and
  untrue the moment these two left it. Both now pass `mergeManaged` like `extraValueMaster`, the
  file is quarantined once rather than twice, and **MR-6** refuses Generate outright on a latched
  ledger rather than stamping rows POSTED for an entry that can never be written.
- **MR-7** nothing tested whether a document number typed by hand was already taken. Two
  colleagues could both be told "Document numbers saved" and leave the master naming one entry
  while both claimed the number, so a row carrying it resolved to the wrong accounting reference.
  `Reco.saveAllocation` now refuses a number this window already knows is held, and — the
  authoritative half — re-tests inside the `docNumberMaster` merge intent, which is the only test
  that runs on a file nobody has moved since. The shared master is therefore single-valued at
  once, and the losing entry's own claim is taken back off by a correction intent within one
  further save cycle (`run_store_e2e` MR7a and MR7c pin both halves separately, and MR7c says why
  there are two). **`saveAllocation` is deliberately SYNCHRONOUS**: two existing callers do not
  await it, and awaiting a share read moved its `App.closeModal()` to a later tick, which closed
  the reverse dialog out from under `Reco.reverseEntry()` and silently refused every reversal
  (`run_reverse_e2e` 254 -> 235). Registering the entry's claim from inside the master's intent
  instead delays it by one debounce cycle, which made the reverse dialog and a re-plan from the
  share disagree about the entry's document numbers and refused every reversal again (254 -> 236).
  Both are written down in the function, because both look like improvements.

The original closure: both keys are out of `PERSIST_KEYS`, assigned in `AppState.load` as the
values store is, and every one of the nine write sites goes through `AppState.ledgerFlush` →
`Store.mergeWrite(key, mutate, {depth: 0})`. The reverse feature's residual-risk paragraph in
§12.2 is replaced by the fix. Reproduced first: two pages on one share left ONE accountingId out
of two in `reco/entryHistory.json`, both ways round. Handover §16.4, `run_store_e2e` [52],
[55]-[58].
Consequence worth knowing: mutating `AppState.entryHistory` IN MEMORY is no longer a way to
change what the app reads, so six fixtures in `run_reverse_e2e` / `run_specialjv_e2e` now publish
the share state they were simulating (no assertion changed). The original ticket:

**Where** `apps/Reco.html` `Store.mergeWrite` (built, three rules, used by the store),
`AppState.flush` / `AppState.saveKeys` (the whole-file writers), and the entry-history write path
around `if (Store.readOnlyKeys.entryHistory) {`.

**What** PLAN2's S13 names **three** callers of the read-merge-write primitive: the new values
store, `entryHistory` at its one pre-write re-read site, and `docNumberMaster` — the last of which
is what would let the reverse feature delete its "residual risk, named" paragraph instead of
documenting it. Phase 1 built the primitive and converted **only the values store**, because that
is the key step 6 enumerates and the only one with NO second copy of its data anywhere.

**Why it is only a ticket** `entryHistory` and `docNumberMaster` are in `PERSIST_KEYS`, so they
are written by `AppState.flush` as whole files on a timer that is not the store's. Converting them
means taking them OUT of `PERSIST_KEYS` (or teaching `flush` to route them), which changes when
and how the ledger's own records reach the share — a change to the money path, with its own
review, not a line in a plumbing commit. The hazard it leaves is the one the reverse spec already
names: two clients generating entries minutes apart can lose one client's `docNumberMaster`
entries, and the later writer's `entryHistory` can drop an entry the earlier one added.

**Fix** Remove the two keys from `PERSIST_KEYS`, assign them in `AppState.load` as the store is,
and route every write through `Store.mergeWrite(key, mutate)` with `depth: 0` (their top-level
values are arrays and plain maps, so per-template granularity is the right unit). Delete the
reverse feature's residual-risk paragraph in the same commit.

**Test** Two browser contexts on one share: A generates an entry, B (whose in-memory history
predates it) generates another, and both entries plus both document numbers are in the files
afterwards. The control: the same test against the build before, which loses one.

## T-S10-2  The reverse dialog still says a tag un-stamp "affects your session only"

**Where** `apps/Reco.html`, the reversal explanation at `if (st.kind === 'tag' || st.kind ===
'sessionOnly') {` — *"is not a template column, so the stamp was never written to the shared
history in the first place … Clearing it affects your session only."*

**What** The sentence is still TRUE of the stamp — the stamp is a plain row property and no `Cn`
row is written for it — but it is now misleading about what is revealed underneath. Before S10 the
value the un-stamp uncovered was in `sess.manualTags` and really was this session's alone. It is
now a record in `reco/extraValueMaster.json` on the shared folder, so what the operator sees after
the reverse is **the team's** value for that key, which a colleague may have typed.

**Why it is only a ticket** Nothing is wrong: the reverse writes nothing to the store, and
`run_reverse_e2e` pins the behaviour (the row property goes, the stored value is the value again).
It is a wording change on a dialog, and the right wording depends on #26's Overrides panel and
#30's Values panel existing, so that the sentence can point somewhere.

**Fix** When the post-entry column resolves to a store-served added column
(`Reco._storeEligible(tpl, col)` and a non-null `Reco.storeKey`), say instead that the column goes
back to the value stored against the row key, naming who typed it (`rec.by`, `rec.at`).

**Test** A reversal on a template whose post-entry column is an added column with a stored value
typed by another user: assert the dialog names that user and the stored value, and the control,
that a template whose post-entry column is a file column is worded as it is today.

## T-26-1  An overridden cell has no mark in the in-app Excel view

**Where** `apps/Reco.html` `Reco._xlRender` / `Reco._xlJssColumn`, against the grid's
`.ov-cell.ov-set` accent and the `↺` revert control in `Reco._renderExtraCell`.

**What** In the grid an overridden cell is accented, carries a `title` naming who overrode it and
what the formula said, and has a revert control beside it. In the Excel view the same cell is an
ordinary editable cell: the number is right (it comes through the same ladder) but nothing says it
is a person's value rather than the formula's, and there is no way to revert from there.

**Why it is only a ticket** The view is a spreadsheet surface, and the decision list for #26 asks
for the override to be *listed* (the Overrides panel) and *reverted* (the grid and the panel),
both of which it is. Adding a per-cell decoration means a `_xlRender` branch and a style, and
`_xlRender` is on the hot path for every visible cell of a 200k-row sheet — measured work, not a
line. Nothing is wrong on screen today; something is merely unsaid.

**Fix** In `_xlRender`, when `C.S.byName.get(col).writeTo === 'override'` and
`Reco._extraOverride(...)` answers for the row, add a class (reuse `.ov-set`) and the same title
the grid builds. Reuse `Reco.badgeIndex`-style per-pass memoisation rather than asking per cell.

**Test** With an override on a row, open the Excel view and assert the cell carries the class and
the title; and the control, that a cell with no override carries neither.

## T-26-2  The column-header override count only refreshes from the grid's own two handlers

**Where** `apps/Reco.html` `Reco._refreshOverrideBadge`, called by `Reco._afterOverride`
(`setOverride` / `revertOverride`), against the `<th>`'s `.ov-count` span.

**What** The count in the column header is patched after an override typed **in the grid**. An
override applied from the in-app Excel view, from an Excel-link load-back, or by a colleague whose
write arrives in the merged file leaves that number stale until the next full render.

**Why it is only a ticket** The number is an honest map-key count with a tooltip that says it may
include keys that are not loaded, so a stale one is wrong in the same direction as the thing it
already admits to; and `_repaintRow` swaps one `<tr>` while `_refreshVirtBody` writes only
`tbody.innerHTML`, so there is no existing path that touches the `<thead>` at all. The right fix
is the one PLAN.md names — `_repaintRow` patches the one `<th>` as well — which is a change to the
shared repaint path and belongs with #25's render work, not inside #26.

**Fix** Give `_repaintRow` an optional column name, patch that `<th>` through
`_refreshOverrideBadge`, and call it from `_xlApply`'s resolution and from `ExcelLink`'s apply.

**Test** Type an override in the Excel view and assert the grid's `<th>` count moved without a
navigate.

## T-26-3  Turning the override box OFF leaves its records applying, with no way to clear them in bulk

**Where** `apps/Reco.html` `Reco._extraOverride` (which does not consult `ac.allowOverride`),
`Reco._overrideColumn` (which does), and the Overrides panel's per-row Revert.

**What** A record written while the box was ticked keeps being read if the box is later cleared —
deliberately: the value is still a decision somebody made about that invoice, and silently
recomputing a number a preparer signed off is worse. The panel marks such a column **box off** and
each record can be reverted one at a time. What is missing is "clear every override on this
column", which is what a template owner who just turned the box off actually wants.

**Why it is only a ticket** It is a bulk action over shared records, so it needs a confirm naming
the count and the column, and it belongs beside #30's Values panel (where the same shape is needed
for typed values) rather than as a second one-off dialog.

**Fix** With the Values panel: a per-column row with its record count and a "clear all for this
column" action writing through `Reco._dropExtraValueCols` (which already exists and already goes
through S13).

**Still open after #30.** The Values panel landed (`Reco.openValuesModal`) with per-record Remove
and "remove all for keys not in the current data", but **not** the per-column clear-all this
ticket asks for — that is a different axis (every key, one column) and it applies equally to a
carry column whose box was turned off. `Reco._dropExtraValueCols` is still the primitive to use.

**Test** Two overrides on one column, box turned off, clear-all run: both records gone, a record
on ANOTHER column of the same key untouched, and the file written once.

## T-30-1  (CLOSED — fixed by RC-14) A spreadsheet-mode fill drag over an added column bypasses the store

**FIXED in `a824485` (reviewer finding F18), and the WHAT below was wrong in the one way that
mattered.** This ticket said the drag "writes the value **onto the row**" and that "the value
does show". It did not show. The source value was read as `srcRow[fd.srcCol]`, and an added
column's value is not on the row (`applyEdits`' tag branch ends in `delete s.row[s.col]` — one
truth per cell), so the drag wrote an EMPTY STRING: the operator dragged a vendor name down
fifty rows, read "Filled 50 cells", nothing was filled, and the shared day CSV — the team's
audit trail — gained one C-version row per key recording a change that never happened. A
control that reports success having done nothing is worse than one that refuses, which is why
this was closed as a defect and not as the enhancement it was filed as.

`Reco._ssCommitFill` now reads the source value through the ladder (`Reco.rowFull`), routes a
`custom`/`dropdown` column through `Reco.applyEdits` — the one door that writes the store and
obeys every refusal typing obeys — refuses a COMPUTED added column by name ("N cell(s) in
"Calc" were not filled: that column is computed in Reco"), and says "Filled N cells" once,
after the store write has answered, so the count is a count of cells that changed.
Test: `run_store_e2e` section [46], X6a-X6e (the three cells on screen AND on the share, no row
property written, no version row invented, and the computed-column refusal with every row still
reading its own formula). Verified independently in the verification round (`verify/v_f18.mjs`).
What is deliberately NOT done is in **T-30-5**: the drag refuses an overridable column rather
than offering to override it. The text below is kept for the reasoning.

**Where** `apps/Reco.html` `Reco._ssCommitFill`, which does `row[col] = srcVal;` for every column
in the dragged rectangle, and `Reco._ssVisibleCols()`, which reads `thead th[data-col]` — and that
includes **added** columns.

**What** A fill drag over a `custom` or `dropdown` added column writes the value **onto the row**.
It therefore bypasses `applyEdits`, bypasses `Reco._setExtraTyped` and bypasses `sess.manualTags`.
The value does show, because the ladder's dropdown/custom tail gives a row value priority — but it
is not in the store, so it does not survive a reload, it is not carried forward, it is not in the
Values panel, and a colleague never sees it. The same drag over a template column writes a `Cn`
row and is durable, so two cells that look identical behave differently.

**Why it is only a ticket** It is pre-existing (it predates S10 and #30) and it is on the money
path: `Versioning.appendChangesBatch` is called with those rows, so changing what `_ssCommitFill`
writes changes what reaches `reco_data/`. It is a write-path change with its own review, not a
line inside a UI commit — the same reason the AEG source-row loop keeps its own copy of the ladder.

**Fix** Split the loop by descriptor: a cell whose `XlSchema` descriptor has `writeTo:'tag'` (or
`'override'`) collects into an `applyEdits` batch with the cached schema, exactly as a paste in the
Excel view does; only `writeTo:'row'` cells keep today's direct assignment and the
`appendChangesBatch` call. The store write is then one debounced merge write for the whole drag.

**Test** Fill a `custom` added column down 50 rows on a keyed template: 50 records in
`AppState.extraValueMaster`, **one** `write_file` for `reco/extraValueMaster.json`, nothing written
onto any row for that column, and no new `Cn` row. Plus the control: the same drag over a template
column still writes its `Cn` rows.

## T-30-2  The in-app Excel view does not mark a carried cell, and cannot confirm one

**Where** `apps/Reco.html` `Reco._xlRender` / `_xlApply`, against `Reco._extraCarried` and
`Reco.setTag`'s `{force:true}` branch.

**What** A carried value reaches the Excel view through the same ladder, so the number is right and
the cell is editable — but there is no accent, no audit title and no `✓`, and because `_xlApply`
routes through `applyEdits` without `force`, **re-entering the same value there is a no-op**: `ds`
is never re-stamped, so an operator who confirms every carried cell in the Excel view finds them
all still marked when they go back to the grid. The twin of T-26-1.

**Why it is only a ticket** `_xlRender` is on the hot path for every visible cell of a 200k-row
sheet, so a per-cell `_extraCarried` call is measured work rather than a line, and the confirm half
needs a control the jspreadsheet cell model does not have today.

**Fix** Build the carried set once per render (one sparse walk of the template's records, which
`_overrideValuesFor` already shows the shape of) and use it for the cell class and comment. For the
confirm, give `_xlApply` the same question `Reco.setTag` asks: if the cell is carried, set
`force: true` on that edit.

**Test** A carried cell in the Excel view carries the mark; re-entering the same value there
re-stamps `ds` and clears the mark in the grid as well; and the render cost of a 200k-row sheet
with no records is unchanged.

## T-30-3  (CLOSED) The promotion picks arbitrarily between two legacy values on a duplicate key

**CLOSED — and this paragraph was WRONG in three places, which the fix round measured.** What is
right: conflicts are collected in the same pass, the non-conflicting cells are promoted, the
conflicting keys are named in one confirm, neither legacy value is deleted, declining promotes
nothing, and a duplicate key whose rows hold the SAME value is not a conflict.

What was wrong, now fixed (`run_store_e2e` [60]):
1. **"BEFORE anything is written" was true of the store and false of the TEMPLATE.** The confirm
   was asked from inside `Reco._promoteCarryForward`, i.e. after `AppState.recoTemplates[i] = t`,
   and the decline returned from the promotion only — so Cancel **saved the template with
   carry-forward ON**. And because the promotion is offered exactly once per column, ever
   (`was[name]`), it was then never offered again: the operator declined, went and sorted the
   duplicate rows out as the dialog told them to, came back and saved, and the feature they had
   switched on was silently off for that column for good, with the box reading as ticked. The
   only recovery was untick, save, re-tick, save. The confirm is now asked ABOVE the swap and
   Cancel **abandons the save**, the way the primary-key warning twenty lines above it does: the
   flag is not stored and the promotion is still owed the next time they save.
2. **the dialog named every newly-ticked column, not the conflicting ones**, and said "two
   different values" where there were three. It is built from the conflicts now, and says "two or
   more".
3. **it asked about (key, column) pairs that were never promotion candidates.** The conflict scan
   applied neither of the two guards the pending loop applies twenty lines below it, so a key
   that already HAS a stored record — one that has been serving both rows all along — still
   raised the dialog, which then said those keys "are therefore being LEFT ALONE" about values
   that were already not in use. The scan is now `Reco._cfScan`, with the pending loop's own
   guards, so a conflict means "two values were both going to be promoted and I cannot pick".

**AND ONE THING THE TICKET'S OWN REMEDY COSTS, now said out loud rather than fixed.** "Both
values stay exactly where they are and nothing is deleted" is true of the FILE and false of the
SCREEN: their only home is `sess.manualTags`, keyed `row._id + '||' + name`, and `row._id` is
re-minted on every load — so the conflicting key's cells read BLANK the next time anybody opens
that file, where before this feature one of the two values survived. The confirm and the
follow-up toast both say so now, and making those values reachable again is **T-26-11**.
Handover §16.5 (which still says "nothing is gone whichever way the operator answers" and needs
the same correction — T-S10-12). The original ticket:

**Where** `apps/Reco.html` `Reco._promoteCarryForward`.

**What** A duplicate `_pk` is a tolerated state, and a `k:'typed'` record deliberately broadcasts
to every row with the key (the policy table: only an **override** refuses, because broadcasting a
number multiplies money into a journal entry). But the promotion walks `sess.data` in order and
writes one record per key, so if two rows share a key and hold **different** legacy values, the
last row silently wins and the other value is gone — with no warning and no second copy, because
the legacy entry it came from is deleted in the same pass.

**Why it is only a ticket** It needs a decision about what to show, not code: the honest options
are to refuse the promotion for that key and say so, or to promote and list the conflicts. Both are
a dialog in `saveTemplate`, which is where the primary-key warning already lives, and that dialog's
wording is a user-facing decision.

**Fix** Collect conflicts in the same pass (`pk` seen with a different `v`), and when there are
any, promote the non-conflicting cells and name the conflicting keys in one confirm — reusing
`Reco._pkLabel` and `Reco._dupPkCountFor`, both of which exist.

**Test** Two rows sharing `INV-7` with `Alice` and `Bob` in the same column, box ticked, template
saved: the conflict is named, neither value is deleted from `sess.manualTags` without being
reported, and a template with no duplicate keys promotes silently as it does now.

## T-S10-3  The main values file is never pruned of records whose key is in no file

**Where** `apps/Reco.html` `AppState.extraValueMaster`, and `Store.loadAll`'s read of
`reco/extraValueMaster.json`.

**What** A record is kept for ever under its `_pk`, by design: that is what makes a value survive
a reopen, and an orphan is deliberately NOT deleted because the key may come back in next
month's extract. So the file only grows. At **144-148 bytes a record** — re-measured on the shipped
tree at 2,000 / 50,000 / 200,000 records (287,797 B / 7,327,799 B / 29,577,801 B), superseding
the ~135 bytes this ticket was filed with — a share that types two columns onto 200,000 rows a
month reaches tens of MB in a year, and the file is re-read on every merge write.

**Why it is only a ticket** The escape hatch is already in the loader (decision G): `loadAll`
reads `reco/extraValueMaster.json` and then merges `reco/extraValues/*.json`, and
`Reco._extraValueFile` already routes a split template's writes to its own file, so nothing has
to be converted. What is missing is the UI that *moves* a template — and a count the operator can
see before they need it.

**Fix** With #30's Values panel: show the record count and the boot size, offer "move this
template's values into their own file" (write `reco/extraValues/<tplId>.json`, remove that
template from the main file in the same `Store.mergeWrite` pair), and offer "remove all for keys
not in the current data" as a separate, explicitly confirmed action.

**Test** A template with records in the main file is moved: assert the split file holds them, the
main file no longer does, a reload reads the same values, and a `Store.mergeWrite` for a second
template does not touch either.

**MEASURED (reviewer finding F15, re-measured by fixer 2 on this build).** Through the test
bridge on LOCAL disk, best of 3 taking the minimum
(`scratchpad/store/fix2/out/p7_size.post.txt`, reviewer B's own `skB/p7_size.mjs`):

| records | file | per record | boot (load→ready) | the read a merge write does | ONE merge write |
|---|---|---|---|---|---|
| 2,000 | 288 KB | 144 B | 672 ms | 12 ms | 67 ms |
| 50,000 | 7.3 MB | 147 B | 987 ms | 213 ms | 600 ms |
| 200,000 | 29.6 MB | 148 B | 1,825 ms | 741 ms | 2,730 ms |

Those are parse, serialise and IPC costs only. `Store._mergeJob` reads AND writes the whole file
for every 150 ms typing burst, so on a shared folder at 10 MB/s a 200,000-record file is about
6 s of transfer on top of ~3 s of work PER BURST, and `Store._enqueue` serialises per file, so
bursts queue behind each other and two colleagues each move 30 MB. **The usable ceiling is about
50,000 records per file**, which is now `Store.VALUE_FILE_CEILING`: past it the boot names the
file, the count, the MB and the biggest template in it, and says that moving that template into
`reco/extraValues/<tplId>.json` by hand works today because the loader reads it and writes there
from then on (`run_store_e2e` section 48, X8a-X8c). What is still missing is this ticket's
BUTTON. Sharding automatically past a threshold was the reviewer's other suggestion and is worse:
it decides where everybody's data lives, in the middle of a typing burst, with no one asked.

## T-26-4  ~~A row that is already posted can be posted a SECOND time~~  **FIXED** (the banner's cap closed after the review)

**THE BANNER STOPPED NAMING THEM PAST EIGHT.** The review's finding A8 (LOW): with more than eight
already-posted rows the list was truncated with nothing saying there were more — 8 of 10 named.
The render now discloses the remainder. `run_store_e2e` **[77]**.

**CLOSED AS WARN-AND-OFFER, which is the user decision taken — never a hard refusal.** Preview
Entry still OPENS; `previewEntryFromSelection` splits the post-keyword-filter `sourceRows` by
`Reco.isRowPosted` above both ledger-write refusals, names each posted row with the accounting
reference it is already in (`Reco._postedRefForPk`), and offers "Leave them out" in the
preview's own banner (`Reco.previewIncludePosted`, one press and not a mode). WHAT THE ENTRY POSTS
IS UNCHANGED UNTIL SOMEBODY PRESSES IT: dropping them by default was built first and run_jv_gen,
run_jv_engine and Z1h all caught it — every one of those is a workflow that deliberately re-posts,
and Z1's own comment settles the principle ("an entry quietly smaller than the selection the
operator ticked is the harm, not the remedy"). Z1h2 asserts both halves: the warning fires and the
rows stay in. A reversed or cancelled entry needs no special case — `isRowPosted` already
answers false for one, and T264j-T264k are the control. Generate on a selection where EVERY row is
already posted now refuses with a sentence instead of closing the modal on an entry nobody wrote
(T264l). Section [67] (T264–T264l); the pre-fix run read `entryHistory` as
`["AE…S1:INV-1","AE…KS1:INV-1+INV-2"]`. Handover §18.6.


**Where** `apps/Reco.html` `Reco.previewEntryFromSelection` — nothing in it asks
`Reco.isRowPosted`, and `commitEntryFromPreview` does not either. The only control is the AEG
keyword filter, which is a value the operator maintains.

**What** Select a row that is already in the general ledger, press Preview Entry, Generate: a
second entry is written for the same key and `entryHistory` ends up with two entries whose
`postedPks` both name it. Reviewer finding F3's probe (`scratchpad/store/skA/p5_repost.mjs`) did
exactly this.

**Why it is only a ticket** It is PRE-EXISTING and has nothing to do with the value store: it
behaves the same on `e9851b4`, before any of these three features. What F3 made expensive was the
*number* the second entry posted — a person could type 999999 over an already-posted row because
the posted mark had evaporated after a reload, and RC-5 closed that (the override is refused, and
`run_store_e2e` R1e/R1f pin it). The remaining act — posting the same row twice with its real
value — is a workflow question with a settled answer somewhere else (the Posted-JV Tracking card
exists to find it), and adding a refusal to the preview would change what every existing template
can post. That belongs in its own review.

**Fix** In `previewEntryFromSelection`, after the keyword filter, split `sourceRows` into posted
and open by `Reco.isRowPosted` and refuse — or warn and offer to drop them — naming the
accounting reference of each, the way the override refusal does. `Reco._postedRefForPk` already
answers from the posted index.

**Test** Post one row, reload the day file from history, select it again and preview: assert the
preview refuses (or that the posted row is not among `Reco._pendingEntry.sourceRows`), and assert
`AppState.entryHistory` still holds ONE entry for that key. A control must assert that a row whose
entry was REVERSED can be posted again, because that is the documented way back.

## T-26-5  (CLOSED) A non-numeric override still reads as a number in a report TOTAL

**CLOSED.** `Reco._reportColumnTotal` is now the one place the total's arithmetic lives and
returns the COUNT of cells it could not add; the total cell carries `data-total-sum` /
`data-total-excluded` and a `*`, and the report footer names the count, the column and the
characters. A blank cell is deliberately not counted. Handover §16.2, `run_store_e2e` [50].
**MR-5 closed the last case of it**: a column where EVERY cell was excluded rendered `0.00 *` — a
number that is not a total of anything — while the Sum card for the same column on the same
screen already said `—`. The total cell gives the card's answer now, with the `*` and the
footnote kept and the figures still on the cell as `data-` attributes (`run_store_e2e` [61]).
The sibling on the SUMMARY CARDS and the pivot is still T-26-10.
The ORIGINAL TICKET, kept because its measurement is the evidence:

**Where** `apps/Reco.html` `Reco.runReport`'s totals and every other `U.num` reader of an added
column's value.

**What** RC-8 refuses a non-numeric override at the one door into a journal entry, so it can no
longer reach the ledger. It can still reach a SCREEN total: with `Net` overridden to `1.234,50`,
the report cell shows `1.234,50` and the report total adds `1.2345` to it, so the column does not
add up to what the column says. Measured by reviewer A's own probe
(`scratchpad/store/skA/p3_canon.mjs`, re-run after the fix:
`scratchpad/store/fix/f1/out/p3_canon.1.txt`, REPORT TOTAL 101.2345 for rows worth 100).

**Why it is only a ticket** The number is on a screen and not in a journal entry, the cell beside
the total shows the characters that were typed, and the operator cannot post the entry at all
until they correct it — so the state is loud and short-lived rather than silent and durable.
Changing what `U.num` does to a non-numeric value is a change to the amount parser every surface
in this app shares, which is its own review.

**Fix** Either exclude a cell `U.isNumeric` rejects from a total and footnote the count ("3
cell(s) are not numbers and are not in this total"), or mark the total itself. The report
footer already renders counts, so there is a place to say it.

**Test** Three rows worth 100, one overridden to `1.234,50`: assert the total is NOT 101.2345,
assert whatever it becomes is accompanied by the count, and keep a control where a canonicalised
override (`1,234.50`) is fully in the total.

## T-26-6  (CLOSED — the panel now says so) A POSTED row whose key later becomes duplicated shows its computed value while the ledger holds the override

**CLOSED as the ticket's own Fix specifies** — the suppression stands (it is the lesser harm and
the right call) and the *Duplicate primary keys* panel now names those keys, the column, the
amount the ledger holds and the accounting reference, through `Reco._postedRefForPk`. The deeper
fix — a record that can name a ROW — was NOT attempted, as the ticket says it should not be.
Handover §16.3, `run_store_e2e` [51].

**THE FIX ROUND CLOSED TWO THINGS THAT PANEL BROUGHT WITH IT:**
- **MR-3, and it was a 1,077x regression on the slowest path in the app.** The new per-key
  `Reco._postedRefForPk` call re-entered `_postedAuditIndex` once per duplicated key, and that
  function's memo KEY contained `Object.keys(AppState.docNumberMaster[tplId]).length` — one array
  of every voucher the template has ever had, allocated on every call, with the memo then
  HITTING. Measured on 2,000 overridden keys and 50,000 document numbers, the same file loaded
  twice by Add Data: **15 ms at 9a597da, 16,164 ms on the review build, 22 ms after the fix**
  (`scratchpad/money/skA/probes/p8_baseline.mjs`). The count is out of the memo key (a generation
  counter already existed and every writer bumps it — including `Store._mergeJob` now, which was
  the one writer that did not, and that also closes reviewer A's unreproduced residual about the
  memo outliving a colleague's in-place reversal), and the index is built once above the loop.
- **the sentence did not reach the reader it was written for.** `AppState.entryHistory` is read
  once, at boot, so the colleague who loads next week's extract — usually not the person who
  posted last week's entry — had an empty history and got no posted block at all, while the
  sentence they DID get pointed at a key already posted at the typed value. The panel now asks
  `reco/entryHistory.json` (the same read and merge the reversal uses), only when there is a
  suppressed override to resolve, and fills the block in when the answer arrives. `ingestData`
  stays SYNCHRONOUS on purpose — it is called without `await` from two places and from the
  suites. Until the answer arrives the box says so, and if the read fails the block carries
  "checked against this window's copy … press Load" rather than reading as the whole truth
  (`run_store_e2e` [59]).

The original ticket:

**Where** `apps/Reco.html` `Reco._extraOverride` — RC-6's duplicate test, which returns null for
every row sharing the key.

**What** RC-6 stops a stored override being served when more than one loaded row shares its key,
because the record cannot say which row it is about (finding F1: the entry posted 3000 where the
rows are worth 2030). If that key had already been POSTED with the override, the suppression also
changes what the reports, the CSV and the workbook say about a row that is in the ledger: the
ledger holds 1000 and the screen now reads 20.

**Why it is only a ticket** It is the lesser of two harms and the louder of the two. The
alternative — keep serving the record — multiplies a number into a NEW journal entry, which is
the blocker. The suppression only misreports a row that is already posted, and the duplicate-key
panel fires on the same load and names the suppressed records (RC-6's second half), so the
operator is told the moment it happens. Resolving it properly needs a record that can name a ROW
and not only a key, which is a data-shape change to `extraValueMaster`.

**Fix** The honest shape is to name the posted keys in that same panel ("2 of these are posted to
the general ledger under AEG-…; the ledger holds the override and the screen now shows the
computed value") using `Reco._postedRefForPk`, which exists. The deeper fix — a per-row record —
should not be attempted without the duplicate-key policy being reopened.

**Test** Post a row with an override, bring a duplicate of its key in by Add Data, and assert the
panel names that key as posted AND names the accounting reference; assert the stored record is
still there.

## T-30-4  The Clear's confirm promises typed values "come back when a file with those keys is loaded again", and only one route does that

**Where** `apps/Reco.html` `Reco.confirmClearSession` (the sentence `run_store_e2e` C9 asserts) and
`Reco._dsInScope`.

**What** The Clear says the typed values "are stored against the row key in the shared values file
and come back when a file with those keys is loaded again". With carry-forward OFF — the default,
and a settled decision — that is true for exactly ONE route: reopening from version history the
day file they were typed into. A fresh upload of a different extract does not bring them back
(that is decision M, and RC-9 is what made it true after a Clear too), and neither does next
month's file. So the sentence promises the cross-file carry the default exists to prevent.

**Why it is only a ticket** It is a wording change on a string an existing gate asserts (C9), so
the replacement assertion has to be written with it, and the right sentence depends on how the
Values panel ends up describing scope. It is also not wrong in the direction that loses work:
nothing is deleted by a Clear either way.

**Fix** Say which route brings them back: "…and come back when this day file is reopened from
version history. A new upload is a new file, so they are not applied to it unless the column's
carry-forward box is ticked." Strengthen C9 to assert both halves rather than the one it asserts
now.

**Test** C9's own fixture plus `run_store_e2e` R6: the confirm names version history, and R6a/R6d
already pin the two behaviours the sentence would then describe.

## T-S10-4  The e2e suites never remove their temp share, and that has killed the container twice

**Where** every `tests/e2e/run_*.mjs` — each calls `fs.mkdtempSync(path.join(os.tmpdir(),
'reco-<suite>-'))` once per app root and nothing ever removes it.

**What** A run of the full net leaves one directory per root under `/tmp`, each holding a copy of
`apps/Reco.html` (1.7 MB) plus its vendor libs, and the big fixtures leave hundreds of MB. 5,177
of them had accumulated by `29cb95d` — 23 GB, and the disk reached 90% with 4 GB free, which
killed the container in the middle of a review round and again in the middle of a fix round. Both
rounds were lost.

**Why it is only a ticket** It is test infrastructure, not the app, and the change touches every
suite — so it wants doing once, deliberately, rather than inside a fix round for something else.

**Fix** A shared helper: register every root in a module-level list and remove it in the same
`finally` that kills the bridges (`fs.rmSync(base, { recursive: true, force: true })`), with
`KEEP_TMP=1` to keep them when a failure needs inspecting. The suites already have the `finally`
block; the roots are already collected in `procs`-shaped arrays in most of them.

**Test** Run one suite twice and assert the count of `/tmp/reco-*` directories is unchanged, and
that `KEEP_TMP=1` leaves exactly the roots the run made.

## T-S10-5  ~~A column that is renamed AND moved is read as a removal, not a rename~~  **FIXED**

**CLOSED.** An added column gets a stable `_cid` when it is CREATED (`RecoTemplate.addExtraCol`,
`Reco.ssAddColumn`'s persist branch, `Reco.ssPromoteCol`) and F12's diff pairs on it before falling
back to the slot. Never backfilled: minting one lazily on edit would make `kxDef`'s comparison
differ from the stored template's and fire the primary-key confirm on a save that changed nothing.
The SLOT RULE STAYS for columns written by older builds, and S105g-S105h pin it — such a column
renamed-and-moved is still read as a removal and still asks. `typeAway` pairs the same way, so a
rename that also changes the type still gets its type question. Section [65] (S105–S105h), and
X3a-X3g are unchanged. Handover §18.3.


**Where** `apps/Reco.html` `RecoTemplate.saveTemplate`, the F12 diff — `renamedCols` pairs
`prevExtras[idx]` with `t.additionalColumns[idx]`, i.e. the SAME SLOT in the editor's list.

**What** Renaming "Vendor" to "Supplier" in place migrates its stored values (`run_store_e2e`
X3a-X3c). Renaming it AND dragging it to a different position in the same save looks exactly like
"Vendor was removed and Supplier was added", so the operator gets the removal confirm — which
offers to DELETE the values rather than move them — and the records stay filed under "Vendor" if
they cancel. The same is true of a rename that also changes the column's type.

**Why it is only a ticket** The confirm is the safe side of the fork: it says how many values are
at stake, says they go for everyone, and says in so many words "if you meant to RENAME the
column, cancel and change its name in place instead — that keeps the values". So the worst case
is an operator doing it in two saves. Guessing which added column became which across a reorder
needs an identity that does not exist yet: `additionalColumns` entries have no id, and inventing
one is a data-shape change to every stored template.

**Fix** Give an added column a stable `_cid` when it is created, keep it through the editor, and
pair `prevExtras` to `t.additionalColumns` by `_cid` before falling back to the slot. Columns
written by older builds have no `_cid`, so the slot rule has to stay as the fallback.

**Test** Rename and reorder in one save: assert the three values move with the column and that no
confirm was shown; keep X3d-X3g as they are, because a genuine removal must still ask.

## T-S10-6  (HALF LANDED) Typing that could not be saved is kept in memory and nothing on screen says so

**THE GATE LANDED in `a824485`; the replay did not.** `AppState.pendingCount()` is now read by
`App._pendingLeaveOk` (the hub button asks: "N change(s) have not reached the shared folder
yet … Leave anyway and lose them?") and by `App._wireLeaveGuard` (a best-effort `beforeunload`
on the window), so the "nothing on screen says so" half of this ticket is closed and the
**Where** line below is out of date on that one point. What is left — the local journal this
ticket calls its honest stretch goal — is now **T-S10-9**, written out with the replay guard
that makes it safe. The text below is kept for the reasoning.

**Where** `apps/Reco.html` `Store._retryLater` (4 attempts, 300/600/1,200/2,400 ms) and
`AppState.pendingCount()`, which nothing in the UI reads.

**What** When the shared folder stops answering, RC-10 now says so (one toast per 4 s plus a
`Store.loadProblems` entry) and retries the buffered intents, so a share that drops for a few
seconds loses nothing (`run_store_e2e` X1a-X1e). After the four attempts the intents stay in
memory until the next keystroke re-arms the timer with a fresh budget — and if the operator
closes the window in that state, the typing goes with it. The same is true of a write refused
because its own file could not be read at boot (F17/X2): the value is refused rather than written
into the wrong file, and refused is the right answer, but it is not kept anywhere either.

**Why it is only a ticket** The operator is now TOLD, twice over and in two places, which is the
difference between this and the finding it came from (F11: not one word). What is left is a
smaller, slower harm: somebody who reads neither sentence and closes the app.

**Fix** Something in the UI reads `AppState.pendingCount()` — the saving indicator already has a
home — and the window asks before closing while it is non-zero (`beforeunload`). The honest
stretch goal is a local journal of unwritten intents (`localStorage`, this session's own) that a
later boot can offer to replay, which is a new durable store and its own review.

**Test** With reads failing, type, exhaust the retry budget, and assert `pendingCount()` is
non-zero and that whatever reads it says so; then let the folder answer and assert it returns to
zero without anything being typed again (X1d/X1e already pin the second half).

## T-S10-7  ~~Every template field except the two flags is still last-writer-wins~~  **FIXED** (four more holes closed after the review)

**THE MERGE WAS RIGHT AND THE SAVE AROUND IT WAS NOT.** Four of the review's fourteen findings are
this ticket's fix, and all four are now closed:

- **A1 (BLOCKER)** an abandoned save had ALREADY deleted the typed values for everyone, then said
  "Nothing was saved" — share values before 3, after 0. **A2 (HIGH)** the rename arm ORPHANED the
  records under a name the folder's template does not have, after a green *"3 value(s) … now belong
  to Supplier"* one toast before *"Nothing was saved"*. The three store side-effects and the
  sentences that announce them are now STAGED into a closure only the success path invokes;
  the confirms stay above the swap, where Cancel means what it says. **[69]**.
- **A3 (HIGH)** from the swap until the folder answers, `AppState.recoTemplates` holds the editor's
  UN-MERGED clone and ANY write of that key publishes it — one ordinary `AppState.save()` from a
  tag, an offset or a group, 250 ms later, was enough. Measured: a colleague's `displayOrder` on the
  share, `null` after this window's own flush, under two green "Template saved to database" toasts.
  Now the key is HELD out of every write until the settle resolves (`RecoTemplate._tplHold`,
  `AppState._keyHeld`), and held rather than dropped: `_snap` is left alone so the key still reads
  as owed. **[70]**.
- **B5 (HIGH)** the editor closed and the screen went home before the write was decided and neither
  leave guard knew — 120 ms after Save: page `home`, `pendingCount` 0, `leaveOk` true, no toast, and
  the share's description `null` afterwards. `pendingCount()` counts a held key, so both gates ask;
  `pagehide` force-releases. **[70]** R2d/R2e.
- **A5 (MEDIUM) / A7 (LOW)** the merge had no mirror for a column the FOLDER removed (silently
  resurrected, and blank, because the record delete had already run) and said nothing when BOTH
  sides changed the same field. **[72]**.

**AND THE HOLD OPENED TWO HOLES OF ITS OWN**, both caught by existing gates and both fixed: a held
write that is merely SKIPPED is a DROPPED write (`saveTemplate(); await AppState.flush();` published
nothing at all, so the next share read described the folder's past and the merge unticked the flag
this editor had just set — C6h and X5's premise), and waiting for the settle inside `flush()` is
CIRCULAR unless the settle's write comes off the 250 ms debounce (`run_store_e2e` hung dead at
[28] C6h). The settle now writes its one key directly (`AppState._writeKeyNow`) and the share read
waits for that write on every path. Handover §18.8. **See T-S10-17.**

**CLOSED.** `saveTemplate` re-reads the stored template off `reco/recoTemplates.json` before its
write and merges it field by field against `RecoTemplate._openedWith`: a field this editor did not
touch keeps the FOLDER's value, a field it did touch is the operator's decision, and everything
kept is named in ONE confirm whose Cancel abandons the save (`_settleShared` / `_mergeShared` /
`_askMerged` / `_abandonSave`). It runs inside `additionalColumns` as well, per column and per
field. **BOTH DELETIONS WERE MADE:** RC-12's two-field special case is gone (`_flagsOf`,
`_readSharedExtraFlags`, `_reconcileSharedFlags` deleted, the two flags now merged by the general
rule, X5a-X5d still green), and so is the `AppState.pendingCount() === 0` skip — the condition for
C6h's hazard is a write owed FOR THAT FILE, which `RecoTemplate._tplWriteOwed()` asks exactly, and
an owed write is landed first. `run_store_e2e` section [63] (S107–S107m); S107j–S107m are the
deleted skip's own gate. Reproduced first in `scratchpad/dataloss/build/p1_s107.mjs`. Handover
§18.1. A key-definition change is the one field that REFUSES instead — T-24R2-1.


**Where** `apps/Reco.html` `RecoTemplate.saveTemplate` — `if (i!==-1) AppState.recoTemplates[i] = t;`
replaces the whole stored object, and `AppState.load()` runs once at boot.

**What** RC-12 asks the shared folder for `carryForward` and `allowOverride` and keeps the
folder's answer for whichever of the two this editor did not touch, naming the column
(`run_store_e2e` X5a-X5d). It does that for those two and nothing else, because they are the only
template fields whose loss changes whether a record already on the folder is READ. A colleague's
display order, correction context, AEG roles, formulas and column list are all still overwritten
silently by a save from a stale clone — which is what the function's own comment has said since
the feature landed. RC-12 is also SKIPPED while this session owes the share a write
(`AppState.pendingCount() !== 0`), because the file may then hold this session's own past rather
than a colleague's present — `run_store_e2e` C6h caught exactly that and the skip is what makes
it safe.

**Why it is only a ticket** The general case means re-reading the stored template inside
`saveTemplate` and merging field by field, which makes the whole template write path async (every
caller today assumes the swap has happened by the time it returns) and needs a conflict dialog
that can describe any field. `RecoTemplate._openedWith` is already captured for it.

**Fix** Re-read `reco/recoTemplates.json` before the swap, diff the stored template against
`_openedWith`, keep the share's value for every field the editor did not touch, and name them in
one confirm. Then RC-12's special case can be deleted and the pendingCount skip with it.

**Test** Two pages, one share: A changes the display order, B (booted earlier) saves a
description. Assert A's order is still on the share and that B was told; and keep a control where
B deliberately changes the same field and B's value wins.

## T-30-5  The fill drag refuses a computed column rather than offering to override it

**Where** `apps/Reco.html` `Reco._ssCommitFill` — `isComputedCol(col)` cells are counted into
`skipped` and named in the toast.

**What** RC-14 makes the drag fill a store-served added column properly and refuses a computed
one by name, because filling it would mean writing an override onto every row the drag covered.
An operator who genuinely wants to put the same number on fifty overridable rows has to type it
fifty times.

**Why it is only a ticket** A bulk write of overridden numbers is a money action: `_setOverride`
refuses a posted row, a duplicated key and a pk-less row one cell at a time, and a fill would
have to report each refusal and still leave the rest applied. That is a confirm-with-a-count
design, not a drag behaviour.

**Fix** When every column in the dragged rectangle is overridable, ask once — "set N cells in
"Net" to 1,234.50? This replaces the computed value on N rows for everyone" — and route the
accepted cells through `Reco.applyEdits`, which already enforces every refusal per cell; then
report applied and refused with their reasons.

**Test** A drag over an overridable column with one posted row in the rectangle: assert the
confirm names the count, that the posted row is refused by its accounting reference, that the
others are applied, and that the toast says both numbers.

---

# From the adversarial review of the store round (findings F1-F20)

Two reviewers, twenty findings, seven blockers; fixed, then re-verified against the reviewers' own
reproductions. Eighteen findings are shut. These four are what the round found and deliberately
did not build — three of them are not regressions of the three features at all, which is why they
are tickets and not fixes. The findings as written are in `scratchpad/store/reports/FINDINGS.md`
and the re-measurement in `scratchpad/store/docs/VERIFIER.md`.

## T-26-7  `XlSchema.build` is 18x slower at 200,000 rows once a template holds ONE override record

**Where** `apps/Reco.html` `XlSchema.build` — `const rows = opts.rows || (sess && sess.data) || [];`
and the `livePkSet()` closure under it, which walks `rows` to collect `_pk` into a Set.

**What** F6's fix scoped decision J.8's store walk to the keys of the rows being exported: one
orphan record, from a key nobody had loaded since April, was downgrading a whole numeric column to
text, so 2,000 good numbers reached a colleague's workbook as strings and their SUM read 0. The Set
that answers "is this record about a row in front of me?" is lazy and built at most once per
build — a template with NO records never builds it, which is every template that existed before
#26 — but one record arms it, and from then on every build pays an O(rows) pass.

**MEASURED on this tree** (the verification round's `verify/v_xlschema.mjs`, same fixture, runs back
to back, best of three): at 200,000 rows with 30 override records, **60.8 ms against 3.4 ms** at
`4b8fd90`. With no records, 3.7 ms against 3.0 ms — unchanged, so F6's "no walk at all for a
template with no records" claim holds.

Who pays is per caller, and that is the useful half:

- **SAFE.** The grid: `Reco.setOverride`, `Reco.revertOverride` and `Reco.setTag` all pass the
  memoised `Reco._ovSchema(tpl, sess)`, so a keystroke-blur does not rebuild. `Reco.columnCatalog`
  passes `rows: []` deliberately (a catalog is a question about the template), so every column
  picker and `pickerCatalog` through it pay nothing; `ExcelLink.canExport` passes `rows: []` too,
  and it runs on every render.
- **PAYS.** `ExcelLink.schemaFor` (the export schema), `ExcelLink.diff` (the load-back plan),
  `Reco._xlInit` (the in-app Excel view's schema), `Reco._reversePlan` (the reversal plan) and
  **every `Reco.applyEdits` caller that passes no `schema`** — `Reco._ssCommitFill` calls
  `applyEdits(..., { source: 'grid', trusted: true })` with none, so the fill drag is one of them.

**Why it is only a ticket** 60 ms on a one-off action — opening a workbook, loading back, reversing
an entry — is tolerable, and a cache here is not a line: invalidating it needs the question
`Reco._ovSchema`'s memo already answers for the grid (array identity is not enough, because
`applyEdits` mutates rows in place), and that memo got its own review where it lives. What is NOT
tolerable is leaving the handover's cost argument (§5c) standing on this function being ~2 ms.

**Fix** Memoise the key Set the way the grid memoises the schema: a `WeakMap` keyed on the array
`opts.rows || sess.data`, with `Reco._ovSchema`'s signature as the invalidation, so repeated builds
over one unchanged data set pay the walk once. Cheaper where it applies: hand the cached schema
down the paths that have one (`_ssCommitFill` is the clear case).

**Test** 200,000 rows, one override record, three builds over the same unchanged `sess.data`:
assert the Set is built once (count it), that builds two and three are within noise of the
no-record cost, and that mutating `sess.data` rebuilds it. Keep F6's own control beside it: the
orphan record must still not turn a numeric column into text.

## T-26-8  An AEG left holding keyword VALUES with no keyword COLUMN posts EVERY row

**Where** `apps/Reco.html` `Reco.previewEntryFromSelection` —
`if (aeg.keywordColumn && aeg.keywordValues)` is the only thing that narrows `sourceRows` to the
rows the operator meant — and `RecoTemplate.setAegRole`, which on a refusal returns `false` and
leaves the field at `''`, against the keyword-values input, which is written straight into the
editing template by `oninput` with no gate at all.

**What** The AEG keyword filter is a PAIR. With both fields set, only rows whose keyword column
reads one of the listed values are posted. With the values set and the column empty the `&&` is
false, no filter runs, and **every selected row posts** — `dr 1007` on reviewer A's own
`scratchpad/store/skA/p6b_role.mjs` fixture, which is the number F5 was filed about reached a
different way. The AEG never validated the pair; it behaves the same on `e9851b4`.

It matters now because the new role refusal walks an operator into exactly that state. S11's matrix
refuses a column that holds override records as the AEG keyword column ("… is a column that still
holds 1 manual override(s) typed against row keys …, so it cannot also be an AEG column"), and the
untick says the stored overrides KEEP APPLYING. So: type the values, be refused the column, dismiss
the toast, save — and the template now posts every row it is given, with nothing on the Generate
screen saying the filter is not running. The operator's only protection is a toast they have
already dismissed.

**Why it is only a ticket** It is not a regression of these three features and the refusal is the
right answer; what is missing is a validation the AEG never had, and it carries a user-facing
decision (refuse the save, or post behind a confirm that names the count). That belongs with the
AEG's own editor, which this round did not open.

**Fix** Ask in both places. In `RecoTemplate.saveTemplate`, when `aegIntegration.keywordValues` is
non-empty and `keywordColumn` is `''`, say so and do not save silently — the stale-template and
primary-key confirms are already there to sit beside. And in `Reco.previewEntryFromSelection`,
before the entry is built, refuse by name: the filter names values but no column, so every selected
row would post.

**Test** A template with `keywordValues: 'POST'` and `keywordColumn: ''` and five selected rows of
which one carries POST: assert the preview is refused by name and nothing is posted; then set the
column and assert the entry posts that one row only. Control: both fields empty must stay
unfiltered, which is today's deliberate behaviour and not the bug.

**CLOSED — ASKED AT THE SAVE, REFUSED AT THE LEDGER DOOR.** The ticket's two options are both
taken, in the two places it names, and the split is what makes the pair coherent:

- **`RecoTemplate.saveTemplate` asks**, beside its own stale-template and primary-key confirms. A
  template may legitimately be half set up mid-edit, so OK still saves; Cancel abandons the save
  like every other confirm there (**R23p**).
- **`Reco.previewEntryFromSelection` refuses**, by name, before the entry is built — naming the
  values (or the column), that the other half is missing, **how many rows it would have been
  handed instead**, and the one edit in the template that fixes it. So nothing can post out of
  this state whatever was answered at the save.

**A refusal here, where T-26-4 and T-26-9 chose warn-and-offer at the same door.** Those two name
a judgement the operator could genuinely have intended — re-post a row on purpose, close a row
that produced no line — so the preview opens and they choose. This one is a template that
*contradicts itself*: it names values to match and no column to match them in, and there is no
reading under which "post every row instead" is what it was asked to do.

**Both directions**, because half a pair is a question either way: a column with no values is a
filter that was set up and never finished and posts everything just the same (**R23j–R23l**). And
**both readers trim**, which is behavioural and not tidiness: untrimmed, a values box of spaces is
*truthy*, so the old `&&` read it as a filter in force, split it into an empty allow-list and
answered *"No selected rows match the keyword filter"* — a sentence about the rows, on a selection
where every row would have matched a filter that had been finished (**R23q–R23r**).

**Measured before the fix** (`scratchpad/kw/probes/k1_repro.mjs`): five rows worth 1, 2, 4, 8 and
1000, a filter naming the one value `POST` that only the row worth 4 carries, all five ticked. The
entry posted `dr 1015`, all five keys in `entry.postedPks`, all five cells stamped POSTED, and
`/keyword/i` matched nothing in the rendered preview. **K1h–K1i measured the walk in** the ticket
describes: `setAegRole` returns `false` with the matrix's own sentence, leaves `keywordColumn` at
`''`, and the typed values are already in the editing template — one dismissed toast was the whole
of the protection.

**Gated by `[92] R23a–R23t` in `run_store_e2e`** (20 checks over five templates). **R23n–R23o** are
the control the ticket asks for and the point of the narrowness: both fields empty still posts
every selected row unfiltered — `dr 1015`, deliberately — which is what nearly every template in
the folder does. Mutation grid 7 × 19 in `scratchpad/kw/mut/run.py` against the round's own probe,
each of the seven turning exactly the checks it should and no others.

**And the gate found a suite fixture sitting in the state the ticket is about.** `[31] C6f` empties
`keywordColumn` so that `Vendor` can be offered *as* the keyword column without clashing with
itself, and saves — leaving `keywordValues: 'go'` behind. That template then posted every row it
was given, and `C6h` (which is about a *carried* value and nothing to do with the keyword filter)
was quietly relying on it; with the door refusing, it read `ctx.sourceRows` of `null`. The fixture
now clears both fields, which says what it means: no keyword filter. Every other `aegIntegration`
fixture across all sixteen suites already had `keywordValues: ''`, and the one other non-empty
value (`Status`/`Closed`) is a complete pair.

## T-26-9  A row whose amount works out to a legitimate ZERO is stamped Posted with no journal line

**Where** `apps/Reco.html` `Reco._buildEntryLines` (`if (value === 0) return;`) and
`commitEntryFromPreview`'s post-entry stamp.

**What** A group whose value totals 0 produces **no lines at all**, and every standard row in the
selection is still stamped with the post-entry value and still goes into `entry.postedPks`. So a
row can be closed, audited as posted under an accounting reference, and have nothing behind it in
the ledger. Found while reproducing Z1: the un-aggregated fixture posted four lines for three
rows and stamped all three (`scratchpad/money/out/z1_repro_before.txt`).

**Why it is only a ticket** Z1 closes the case where the zero is a FAILURE (`#ERR`), which is the
money bug. A genuinely zero row is a different question with a real answer on both sides — a
zero-value line is legitimately not worth a journal entry, and some templates rely on that — so
refusing or warning changes what every existing template can post. Same family as **T-26-4**, and
it should be decided with it.

**Fix** Either leave the stamp off a row that produced no line (which changes what `postedPks`
means for every existing entry), or name the dropped rows in the preview before the entry is
generated, which is where the operator can still act. The preview already renders the lines, so
there is a place to say *"3 row(s) in this selection produce no journal line and will still be
marked posted"*.

**Test** Three rows, one worth 0: assert the entry has no line for it, and assert whatever is
chosen — it is NOT in `postedPks`, or the preview names it — and keep a control where every row
is worth something.

**CLOSED — AS WARN-AND-OFFER, THE SHAPE THIS TICKET ASKED TO BE DECIDED WITH T-26-4.** The
ticket's two options are not equal and the measurement says which: leaving the stamp off a row
that produced no line changes what `entry.postedPks` means for every entry already on the share,
and T-26-4's round recorded three suites going red when that default was flipped for its sibling.
So the default is **unchanged** — the rows are still stamped — and what is new is that it is said
and that there is a way out.

`Reco._buildEntryLines` gained a fifth `audit` out-param, reported **from the line that drops the
group** (`if (value === 0)`), because that is the only place the group's total is known and a
caller that re-derived this grouping would be a second copy of it to get wrong.
`previewEntryFromSelection` resolves each dropped input back to its row through an identity `Map`
(`aegInputs` is built by index from `standardRows`, so the map is identity and there is no index
arithmetic to get wrong, and nothing is stamped onto the input objects — `AEG.buildLine` reads
them and an output-column mapping could pick a bookkeeping property up). The preview banner names
every dropped row with **its own amount and its group's total**, because those answer different
questions: a row worth zero is a data problem on that row, a row worth something inside a group
worth zero means the rows ticked with it cancel it out, and only the second is fixed by reticking.
*"Leave them unmarked"* / *"Mark them anyway"* is one press and not a mode — `Reco._dropZero` is
consumed by the preview it reopens, exactly as T-26-4's flag is.

**And the round found one thing it did not set out to find.** Both drop flags are consumed by the
ONE rebuild the banner buttons trigger, so pressing *"Leave them out"* on the posted banner put
the zero rows back **into** the stamp behind an operator who had already pressed *"Leave them
unmarked"* — with the banner on screen back to reading "Marked posted by this entry". Each handler
now carries the other banner's answer off `Reco._pendingEntry`, which is what that banner is
displaying, so the two cannot drift (**R22s**).

**Gated by `[91] R22a–R22x` in `run_store_e2e`** (24 checks: the unchanged default, the banner and
its one button, the toast, the drop across `standardRows`/`sourceRows`/`aegInputs`, `postedPks`
without the row, a control where every row is worth something, both banners at once, and the
all-dropped case). **Mutation grid 7 × 26** in `scratchpad/zero/mut/run.py` — seven mutations
against the 26 checks of the round's own probe (`scratchpad/zero/probes/z2_fix.mjs`, the same
assertions over the same four fixtures; the grid runs against the probe because a probe can be
pointed at a mutated copy of `apps/Reco.html` through `APP_FILE` and a suite section cannot).
Each of the seven turned exactly the checks it should and no others.

**One correction this round owes T-26-4.** T-26-4's guard comment and §18 of the handover both
said Generate "closed the modal having written nothing and said nothing" when every row had been
dropped. It did not: the lines-less guard in `commitEntryFromPreview` already caught it, wrote
nothing and left the preview open — it just said `Nothing to post`, three words naming no row, no
reason and nothing to do next. Measured with both all-dropped guards disabled. Both sentences are
corrected, and `R22v` is the control that keeps them honest.

## T-26-10  The report SUMMARY CARDS have T-26-5's silence too

**Where** `apps/Reco.html` `Reco.renderCustomReport`'s summary-card loop (`Sum`, `Avg`, `Min`,
`Max` all `continue` on `!U.isNumeric(v)`).

**What** T-26-5 gave the total row a count of the cells it could not add, and a footnote naming
them. The cards beside it still drop the same cells in silence, so a `Sum` card and its column
can disagree for the same reason the total used to.

**Why it is only a ticket** The ticket's own **Fix** names the total and the report footer, and
that is what was built; the cards want the same treatment, but a card has no footer of its own and
where the count goes is a user-facing decision (a `*` on the card, a tooltip, or one combined
footnote for the whole report).

**Fix** Reuse `Reco._reportColumnTotal` for the `Sum` card and feed its `excluded` into the same
`totalNotes` list the footer already renders, so there is one sentence per column rather than one
per place that adds it up. `Count` is already a filled-cell count and is unaffected.

**Test** The T-26-5 fixture with a `Sum` card on `Net`: assert the card's value is 100, assert the
count reaches the footer once (not twice), and keep the canonicalised control fully in both.

**CLOSED — AND `Reco._reportColumnTotal` IS NOW THE ONE READER FOR A REPORT COLUMN.** The cards
each ran their own pass with their own `U.isNumeric` test; `mn`/`mx` moved into the helper, so the
total row and every card come out of the same arithmetic. Two implementations of *"what this column
adds up to"* is what T-26-5's own comment warned about: the count lives **with** the arithmetic so
the figure and the sentence cannot disagree about how many.

**All four, not only `Sum`.** The Fix names `Sum` because that is where the helper was reusable,
but the **What** names all four and all four drop the cell. `Avg` is the worst of them for being
less obviously a sum — `50.00` is the average of *two* cells where the column shows three. `Min`
and `Max` silently rank only the cells they could read, and the dropped cell may be either extreme
(**R24k** makes that concrete: override the cell to the largest value and `Max` picks it up).
`Count` is untouched, as the ticket asks — a cell holding characters that are not a number is still
a **filled** cell — and it is exempt *by construction* at the one place the mark is decided
(`func !== 'Count'`), not by a special case bolted on later.

**The mark follows the total row's convention**, so there is one thing to learn: a `*` on the
figure, the count in the tooltip, and one sentence in the footer naming the characters. The counts
are also on the card as `data-card-excluded` / `data-card-col` / `data-card-func`, for the reason
the total row's are: a figure is the one thing a test must read as a **value** and not as a
sentence.

**One sentence per column** (`noteFor`, keyed by column): five figures on `Net` all dropped the
same cell and the footer carries **one** sentence. Without that the operator reads the same
sentence five times and learns to skip it — **R24f** pins it.

**And it is FEWER passes, not more** — an operation count, never a wall clock (§16.4a). The card
loop memoises the helper per **column**, so five cards on `Net` plus a total row on `Net` walk the
rows **twice** where the old loop walked them **six** times (**R24l**). **R24m** shows the memo is
per column, and **R24n** is the clause that catches one keyed wrongly: a single global slot would
hand one column's cards another column's figures and both counts would still pass.

**Measured before the fix** (`scratchpad/cards/probes/c1_repro.mjs`, on T-26-5's own fixture as the
Test asks): `Net` reads 40, 60 and `1.234,50`; the total row said `100.00 *` with one footer
sentence, and the cards said `100.00`, `50.00`, `40.00`, `60.00` with no asterisk and no tooltip.

**Gated by `[93] R24a–R24o` in `run_store_e2e`** (15 checks). Mutation grid 7 × 14 in
`scratchpad/cards/mut/run.py` against the round's own probe, each of the seven turning exactly the
checks it should and no others.

## T-S10-8  `pytest` and `run_panes_e2e` read the temp root's PATH SHAPE, so a long `TMPDIR` goes red

**Where** `tests/test_excel_link.py` (every fixture built on pytest's `tmp_path`) and
`tests/e2e/run_panes_e2e.mjs` (`fs.mkdtempSync(path.join(os.tmpdir(), 'reco-panes-'))`), against
`excel_link.py` `_choose_target`: `if len(str(p)) > LONG_PATH_LIMIT` (`LONG_PATH_LIMIT = 200`),
which returns `("local", None, …)` with a `pathTooLong` warning instead of `("shared", rel, …)`.

**What** Both suites build their share under the system temp root, so the ABSOLUTE LENGTH of
`TMPDIR` decides whether the engine calls that share "shared" or falls back to the local work area.
Point `TMPDIR` at a long contained scratch directory — which is the sane way to make cleanup one
`rm -rf`, i.e. the remedy T-S10-4 asks for — and `pytest` comes back **69 passed / 6 failed**, all
in `tests/test_excel_link.py`: `TypeError: unsupported operand type(s) for /: 'PosixPath' and
'NoneType'` where the test does `root / res["rel"]` and `rel` is now `None`, plus assertions where
the engine answered `local` and the test wanted `shared`. `run_panes_e2e` comes back **163 passed /
1 failed and then crashes** — "two workbooks on the share with different names" gets `[null, null]`
and `xl_edit.py` dies on `FileNotFoundError: 'null'`. With the default temp root both are green:
**75 passed / 1 skipped** and **304 / 0**. Measured both ways in the verification round.

Nothing is wrong with the code under test either time. The harm is to the next person: the README
says a count that has gone down is a regression, and a contained temp root produces a lower count
on a machine where nothing has regressed — invisibly, because the failures name Excel paths and not
the temp root.

**Why it is only a ticket** It is test infrastructure, and the fix has a choice in it. Making the
suites independent of the temp root is test-only; making the engine's local-vs-shared answer
independent of path length is not — `LONG_PATH_LIMIT` exists because Windows refuses long paths,
and the fallback is shipping behaviour a finance share depends on.

**Fix** Give both suites a short root of their own instead of `os.tmpdir()` / `tmp_path` (a
`RECO_TEST_ROOT` honoured by both harnesses, defaulting to something short), and assert it short at
STARTUP with the reason named — so a long root fails one loud assertion at the top instead of six
Excel assertions in the middle. Leave the `pathTooLong` behaviour exactly as it is, and keep the
one test that monkeypatches `LONG_PATH_LIMIT` down to prove the fallback.

**Test** Run `pytest tests/test_excel_link.py` and `run_panes_e2e` twice, once under a short root
and once under a 180-character one: assert identical counts both times, and assert the startup
check fires and names the root when the root is over the limit.

## T-S10-9  ~~The last typing of the day is still lost if the folder is down and the operator leaves anyway~~  **FIXED** (three more holes closed after the review)

**THE REPLAY WAS RIGHT AND THE JOURNAL'S OWN BOOKKEEPING WAS NOT.** Three of the review's findings
are this ticket's fix:

- **B1 (BLOCKER) two windows of Reco on one PC destroyed each other's journal.** `journalPersist()`
  wrote one window's whole in-memory Map over the shared `localStorage` list with no re-read, and
  `_jrnlMap()` reads the disk only while `_jrnlMem === null`, so a window with a live map never saw
  the other's entries again. Measured, two pages in one origin: A typed INV-1 with the folder down
  (journal `["INV-1/Vendor=A-typed-this"]`), B then typed a DIFFERENT cell and the journal read
  `["INV-2/Vendor=B-typed-this"]` — INV-1 gone; the boot replayed one value under a green toast and
  the share ended with `INV-1=undefined`. Nobody was ever told. **The handover said the opposite**
  (§18.7 limitation 3: "the per-cell guard makes that safe rather than destructive") — the cells are
  keyed per window IN MEMORY, the persist was a blind whole-list write, and the guard runs at
  replay, long after the loss. `journalPersist()` is now a read-merge-write, newest `at` winning,
  with `Store._jrnlGone` stopping a cell this window has settled coming back. **[73]**.
- **B2 (HIGH) the replay DELETED the journal of the folder it refused to replay into.**
  `journalClear()` took no argument and spared nothing, and the "nothing belongs here" `return` sat
  ABOVE the `discarded` toast. Measured: four values typed against the folder the team had just
  moved off — journal `[]` after the boot and NOT ONE TOAST; with one of four belonging elsewhere,
  the toast said "Point Reco back at that folder to put them on it" about an entry the same function
  had just deleted. The same wipe fired whenever `get_folder_info()` was transiently unavailable.
  Now `journalClear(keep)` takes a predicate, the sentence is said from above the early return, and
  an UNKNOWN base is no longer read as a different folder. **[74]**.
- **B3 (HIGH) `journalDone()` was O(n²) inside the queued write job** — the whole Map walked with no
  early exit, once per intent, synchronously, inside `Store._mergeJob`'s job for the SHARED
  `reco/extraValueMaster.json`, so that file's queue was held by a loop doing no I/O. 10 / 171 /
  3,585 / **19,305 ms** at 1k / 5k / 20k / 50k cells; a 50,000-cell fill-down went from ~0.95 s to
  **21.9 s**. The quadratic §18.5 says the Map was introduced to kill had MOVED, not gone, and the
  suite could not see it: C3b counts writes (still one) and C3e only reports a clock. Fixed with a
  `_jrnlById` index; **[75]** counts the SCANS.

**CLOSED, WITH THE PER-CELL TIMESTAMP GUARD THE TICKET SPECIFIES.** Each unwritten intent is
journalled on THIS PC (`Store.journalIntent`, cleared by intent id when its write resolves) and the
next boot offers the replay BY COUNT, naming the cells (`App._replayJournal`), through the same
`Store.mergeWrite`. An intent is applied only where the share holds no record for that cell or
holds one whose `at` is OLDER; every skipped cell is named with who holds the newer value, what it
says and what this window had. The journal carries the base folder each entry was typed against.
THE OWED SET LIVES IN MEMORY and `localStorage` is written when a write resolves not-written, on
`pagehide`/`beforeunload`, and when the leave gate asks — journalling per keystroke made C3's
50,000-cell fill-down quadratic and hung the suite for eleven minutes. The leave gate no longer
says "lose them" about values it is keeping. THE CLEAR IS INSIDE THE WRITE PATH
(`Store._mergeJob`, one journal id per intent): hung off the promise `_extraValueFlush` returns, a
failed write resolves it while the value is still owed and the RETRY that lands resolves nothing —
so a folder that recovered on its own left the journal full and the next boot re-offered values
already on the share, naming the operator as the colleague holding the newer one. Section [68]
(S109–S109p), which tests the LOSING case as hard as the winning one and pins both ends of the
journal's life. Handover §18.5. **This closes T-S10-6's remaining half too.**


**Where** `apps/Reco.html` `App._pendingLeaveOk` and `App._wireLeaveGuard` (both reading
`AppState.pendingCount()`), `Store._retryLater` behind them (`_RETRY_MAX` 4, at
`MERGE_DELAY * 2**n` = 300 / 600 / 1,200 / 2,400 ms), and `Store.mergeWrite`, which REFUSES rather
than writes when it cannot read the file it has to merge into.

**What** T-S10-6's first half landed: the operator is told while typing, and both doors out now ask
("N change(s) have not reached the shared folder yet … Leave anyway and lose them?" on the hub
button, plus a best-effort `beforeunload`). What is left is the answer **yes**. The folder is down
on the last write of the day, the four retries are spent, the operator reads the question, answers
"leave anyway", and the typing is gone — the store keeps ONE truth per cell and deliberately no
second copy, so there is nothing to recover from afterwards (`App._pendingLeaveOk`'s own comment
says exactly that). Reviewer B's `skB/p3_share` P3f is the measurement: four typed values, cells
`["INV-1=","INV-2=","INV-3=","INV-4="]`, store `{}`. The same holds for a value refused because its
own file could not be read at boot (F17/X2) — refused is the right answer, and it is not kept
anywhere either.

**Why it is only a ticket** The operator is now told twice and asked twice, which is the difference
between this and the finding it came from (F11: not one word). What is left needs a NEW DURABLE
STORE, and the review question is not the writing but the REPLAY: a colleague may have typed the
same cell while this window was offline, and a blind replay would overwrite a newer value with an
older one and call it recovery. That is worse than the loss it fixes, which is why it is not a line
inside somebody else's fix round.

**Fix** Journal each unwritten intent to this PC's own storage as it is buffered (`localStorage`,
scoped per base folder and template, carrying the cell's own `at`). On the next boot, if the
journal is not empty, offer the replay by count and name the cells — never silently. Replay through
`Store.mergeWrite` with a PER-CELL TIMESTAMP GUARD: apply only where the share holds no record for
that cell or holds one whose `at` is OLDER than the journalled one; list every cell skipped and who
holds the newer value; clear the journal entry either way.

**Test** With writes failing, type four values, exhaust the retry budget, answer the leave gate
with "leave anyway", and reload: assert the journal held four intents, that the boot offers them by
count, and that accepting puts all four on the share. Then the guard: plant a NEWER record for one
of those cells on the share first and assert that cell is skipped and named while the other three
apply — and that a second boot replays nothing.

---

# From the money round's fix pass

<!-- the blocker fixer, after the two reviews of T-S10-1 / Z1 / T-26-5 / T-26-6 / T-30-3 -->

## T-S10-10  ~~The ledger merge is atomic inside ONE page and not BETWEEN pages — two colleagues pressing Generate together can still lose an entry~~  **FIXED** — the bridge has a conditional write and `Store._mergeJob` is a compare-and-swap

> **FIXED, and the thing to read is WHICH HALF DID IT.** The bridge gained an
> OS advisory file lock (`flock` on POSIX, `LockFile` on Windows, on one file
> per path under `ROOT/.locks/`) **and** a content token: `LauncherAPI.read_file_with_token` brings
> the file and the sha256 of its bytes back in ONE read, and
> `write_file_if_unchanged(rel, text, token)` writes only while the file still
> holds what that token describes, with the check and the write inside the lock
> so it is a real compare-and-swap. `Store._mergeJob` now loops: on a `changed`
> refusal it re-reads, takes the share as the authority again and **replays the
> same intents on top**, up to `Store._CAS_TRIES` (8) times.
>
> **THE LOCK IS NOT THE FIX, AND THE PROBE SAYS SO IN BOTH DIRECTIONS.** Both
> pages have already READ before either writes, so serialising the writes just
> decides which one wins. Measured in two real processes on a 1,000-entry
> ledger (`scratchpad/bridge/probes/p2_jsonrace.py`): with the plain
> `write_file` an entry is lost at **every** stagger tried, 0 ms included, with
> both writers reporting success; with the token, **1,002 of 1,002 entries
> survive** and exactly one process refuses once and succeeds on the retry.
> It is the TOKEN that closes it; the lock is what stops two processes both
> passing the check and both replacing.
>
> **THE LOCK-FILE SHAPE THIS TICKET RULED OUT IS STILL RULED OUT, and that
> objection is why the OS's own lock was used instead.** A lock whose
> EXISTENCE is the lock is only advisory (`write_file` cannot fail on "already
> exists") and a stale one left by a page that crashed would block the ledger
> for everybody. An advisory file lock has no stale state at all: the kernel
> drops it when the handle closes or the process dies. So there is no staleness
> timeout to decide and nothing to break by hand — only a WAIT (ten seconds),
> and a wait that runs out answers `busy`, which `_mergeJob` treats as a failed
> write: the operator is told, the intent stays buffered, the next flush
> retries. A share that cannot lock at all degrades to unlocked, which is no
> worse than before this change and far better than refusing to save.
>
> **Gates.** `tests/test_launcher.py`
> `test_the_ledger_clobber_between_two_processes` (subprocess, not threads — a
> threaded version passes on the broken code and proves nothing),
> `test_write_file_if_unchanged_refuses_a_stale_token`,
> `test_content_token_is_the_bytes_and_not_the_clock`,
> `test_a_share_that_cannot_lock_still_saves`. The PAGE'S half, which pytest
> cannot reach, is `run_store_e2e` **[89] R20a–R20e**: that the token is really
> used (an operation count, never a clock), that a collision is retried and the
> colleague's record survives it, that `busy` is said rather than swallowed, and
> that an older launcher with neither method still saves. Handover §20.
>
> **What this does NOT cover: T-S10-31**, the whole-file `PERSIST_KEYS` writes
> (`recoSessions.json` and friends). They go through `Store.save`, which has no
> intents to replay, so they need a merge RULE before they can use the same
> primitive — which now exists.


**Where** `apps/Reco.html` `Store._enqueue` / `Store._mergeJob`. `Store._queues` lives in one JS
context, so the read → merge → write of `reco/entryHistory.json` cannot overlap a write of the
same file *from this page*. Nothing serialises it between pages: `Store._writeJsonFile` calls the
bridge's `write_file`, which is an unconditional overwrite — no mtime, no size, no hash, no lock
file under `reco/`.

**What** A reads the file, B reads the file, A writes (its entry in), B writes (A's entry gone).
Both writes SUCCEED, so neither operator is told, and A's rows stay stamped POSTED on the share
with nothing behind them. Measured on one share with `reco/entryHistory.json` seeded to 1,000
entries (2,263 KiB, about two years for a small team), two pages pressing Generate staggered by
*N* ms (`scratchpad/money/skB/probe/p13_window.mjs`, re-run by the fixer):

| stagger | 9a597da | the review build | after the fix round |
|---|---|---|---|
| 0 ms | — | one entry + 2 document numbers LOST | nothing lost |
| 100 ms | — | one entry + 2 document numbers LOST | nothing lost |
| 250 ms | — | lost in one run, survived in another | nothing lost |
| 500 ms | — | nothing lost | nothing lost |
| 1,000 ms | one entry LOST | nothing lost | nothing lost |
| 3,000 ms | one entry LOST | nothing lost | nothing lost |

So T-S10-1 narrowed the window from the WHOLE SESSION to one read-write cycle, and the fix round
narrowed it again: after every Generate the entry (and the document numbers it registered) are
read back off the share once the dust has settled, and a clobber inside that settle window is
healed by replaying the append intent, which is idempotent and re-finds by `accountingId`, so it
converges even when both pages do it at once (`Reco._confirmEntryOnShare`, `Reco._reSettleEntry`,
`Reco._SETTLE_MS`; `run_store_e2e` [57] drives the two pages with `Promise.all`).

**Why it is only a ticket** What is left cannot be fixed in `apps/Reco.html` at all. A clobber
that lands AFTER the settle look is invisible to the window that lost it, and closing that needs
an atomic primitive the bridge does not have — this round was scoped to `apps/Reco.html`,
`tests/e2e/run_store_e2e.mjs` and this file, and the bridge is Python. A lock file written
through the existing `write_file` is the other shape and is NOT a fix: `write_file` cannot fail
on "already exists", so a lock is only ever advisory, and a stale one left by a crashed page
would block the ledger for everybody — a worse failure than the one it replaces.

**Fix** Give the bridge a conditional write: `write_file_if_unchanged(rel, text, token)` where
`token` is the mtime+size (or a hash) read at the start of `Store._mergeJob`, returning a refusal
rather than writing when the file has moved. `_mergeJob` then re-reads and replays the buffered
intents — the intents are already idempotent and already re-find by `accountingId`, so the retry
loop is nearly free. An `O_EXCL` lock file with an owner, a timestamp and a staleness timeout is
the alternative; it needs the timeout decided and a way to break a stale lock on purpose.

**Test** `run_store_e2e` [57] already drives two overlapped pages and asserts both entries and
all four document numbers on the share. Add the case the settle cannot reach: hold one page's
write until AFTER the other page's settle has run (fault `write_file` for a fixed delay), and
assert both entries survive — which fails today and is the point of the ticket.

---

## T-S10-11  ~~Two windows can mint the SAME accountingId, and one of the two entries then cannot be told from the other~~  **FIXED**

> **FIXED.** Both halves: option (a) below (two base-36 characters drawn once per window, in
> `U.accountingId()`, used by both mint sites) **and** a content test in the append, so the
> 1-in-1,296 residue is re-minted rather than discarded. **The accounting reference is now two
> characters longer** — `AEMVAUQHDL` → `AEMVAUQHDL7K` — which is the user-visible half and the
> thing to tell the team. Written up in **handover §17**. Gates: `run_store_e2e` `[57]`
> S109c–S109g and `[57b]` S111a–S111h, mutation-checked both ways (removing the suffix fails
> S109b/c/f/g; restoring the reference-only append fails S111b/c/f). The two assertions the
> **Test** paragraph below asked for are S109c and S109d.
> What is still open is **T-S10-10** (the cross-page clobber, which needs the Python bridge) and
> **T-S10-12** (a mixed fleet).

**Where** `apps/Reco.html` `Reco.commitEntryFromPreview` — `'AE' + Date.now().toString(36).toUpperCase()`.
`reverseEntry` (the mirror id) has guarded against a collision since it was built, by testing the
id against the in-memory history and appending a counter; the Generate door had no test at all.

**What** Two people pressing Generate in the same millisecond mint the same accountingId. Seen in
the fixer's own run of `probe/p13_window.mjs` at a 0 ms stagger: `posted
["AEMVAYN4CT","AEMVAYN4CT"]` with `entriesOnShare` going up by ONE, i.e. one of the two entries
was gone and the other was indistinguishable from it. Everything downstream keys on the
accountingId: the reversal finds the first match, `docNumberMaster` maps a number to one of them,
and `_postedAuditIndex` resolves a row to whichever it met first.

**Why it is only a ticket** The fix round added the in-memory uniqueness test that `reverseEntry`
already had, which is the part that needs no decision — it covers a second entry in the same
window and costs nothing. It CANNOT cover two separate windows, because neither can see the
other's entry. Doing that means changing the shape of the accounting reference (per-session
entropy, or a per-template counter allocated through a merge write), and the accounting reference
is what people quote to each other and write on documents, so its shape is a decision for the
team and not for a fix round.

**Fix** Either (a) append a short per-session suffix at mint time — `'AE' + base36(now) + two
base-36 characters seeded once per window` — which keeps the reference readable and makes a
same-millisecond collision about 1 in 1,300 instead of 1 in 1; or (b) allocate the number through
`Store.mergeWrite` against a per-template counter, which is exact but makes Generate wait on the
shared folder. (a) is the cheap one; it lengthens every future reference by two characters, which
is the thing to ask about.

**Test** Two pages, `Promise.all`, both posting in the same millisecond (the fixture in
`run_store_e2e` [57] reaches this at a 0 ms stagger): assert the two accountingIds DIFFER, and
that `reco/entryHistory.json` holds two entries. A second window posting a second entry inside
one millisecond already differs by the in-memory guard, so that control belongs with it.

---

## T-S10-12  ~~The handover still claims the clobber is gone, that "nothing is gone" after a T-30-3 conflict, and says nothing about a mixed fleet~~  **PROSE FIXED — the build stamp is not**

**Where** `docs/RECO_ARCHITECTURE_HANDOVER.md` §16.4 (the T-S10-1 write-up), §16.5 (T-30-3),
§15's release-note table, §16.6's "Known limitations of this round", and the README's line about
the round.

**What** Three statements the fix round measured as wrong or incomplete, in the document the next
person reads first:
1. §16.4 says the clobber half is gone. The boot-time half is; the cross-page half is T-S10-10,
   with its window measured there. It should name the residual and point at the ticket.
2. §16.5 says "nothing is gone whichever way the operator answers" about a T-30-3 conflict. The
   characters are still in the file; they are under row ids that no longer exist, so the cells
   read BLANK the next time the file is opened, and before this feature one of the two values
   survived. See T-26-11.
3. Nothing anywhere says the fleet has to be upgraded together. An un-upgraded copy of the app on
   the same folder still writes `reco/entryHistory.json` and `reco/docNumberMaster.json` as whole
   files, so it keeps destroying its colleagues' entries while the fix appears to work for
   everybody else — and because the new build refreshes memory on every write, it reads as
   intermittent rather than attributable to one machine. Measured on one share root with
   `apps/Reco.html` swapped between builds: this build posts `AEMVAXBM2Y`, the old build posts
   next and `AEMVAXBM2Y` is gone (`scratchpad/money/skB/probe/p5_migration.mjs` P5d; the
   migration itself is clean in both directions, P5a-P5c).

**Why it was only a ticket** The fix round's editable files were `apps/Reco.html`,
`tests/e2e/run_store_e2e.mjs` and `docs/TICKETS.md`. The handover and the README were not in
scope, and a documentation correction written into the wrong file is worse than one left undone.

> **THE THREE PROSE CORRECTIONS ARE MADE.** §16.4 now carries a *"what this does NOT close"* block
> naming both residual halves (the cross-page clobber with its measured window, and the mixed
> fleet with the *every copy has to be on this build* line); §16.5 carries a block saying that
> *"exactly where they are"* is not the same as reachable, with the measured `INV-7=` and a
> pointer to T-26-11. **What is left is the code half**, below, which is the only part that makes
> the fleet rule enforceable rather than a request.

**Fix** A **build stamp** written into `reco/` at boot, with a boot warning when an OLDER stamp is
seen — the part that makes *"every copy of the app on the folder has to be on this build"*
enforceable instead of a request. That is code, and it belongs with T-S10-10.

**Test** Documentation. The build-stamp half: boot on a share whose stamp names a newer build and
assert the warning names it; assert a same-or-newer stamp warns about nothing.

---

## T-S10-13  "Document numbers saved", and then — one toast later — "it was NOT saved"

**Where** `apps/Reco.html` `Reco.saveAllocation` (the success toast and `App.closeModal`) and
`Reco._dnRefused` (the correction).

**What** `saveAllocation` tests the number against this window's copy of the shared master and
refuses properly when it is taken — that part returns before anything is written. But the
**authoritative** test lives inside the merge intent, because it is the only one that runs on the
file the merge has just read, and it therefore resolves **after** the function has already closed
the dialog and said *"Document numbers saved"*. When the share disagrees, `Reco._dnRefused` takes
the claim back off both files and tells the operator in an **error toast** — which is the exact
shape MR-6 was raised about: *"the one toast that did fire scrolled away in four seconds"*. So the
operator's last unambiguous signal is a success, and the number they think they allocated is not
theirs.

**Why it is only a ticket** The obvious fix — await the shared read before deciding — was tried
and reverted, and the comment in `saveAllocation` records why: two existing callers do not await
it, so its tail moved to a later tick and closed a dialog the caller had opened in the meantime
(`run_reverse_e2e` went 254 → 236, with `Reco.reverseEntry()` finding `_reverseState` already null
and silently minting no mirror). *A UI entry point that other code drives must not become async
quietly.* The right fix is therefore about the **notice**, not the timing, and picking its shape
is a UI decision.

**Fix** `_dnRefused` should open a **modal**, not a toast — the same precedence
`_confirmEntryOnShare` already uses for a journal entry that may not have landed, and for the same
reason: a document number the operator believes is theirs is a resolver for every future
re-upload. Repoint the allocate modal at the entry with the refused number cleared, so the next
thing they see is the box to type a different one into. The cheaper half, worth doing first, is to
delay the success toast until the merge job has run when nothing is waiting on the tail.

**Test** Two pages, B allocates `GL-7000` to its entry and A allocates the same number a moment
later: assert A sees a **modal** naming the number and the entry that holds it, that
`reco/docNumberMaster.json` names B's entry, and that A's `entry.docNumbers` does not carry it.
`run_store_e2e` `[58]` has the fixture and currently asserts the files only.

**CLOSED — BOTH HALVES, AND `saveAllocation` IS STILL SYNCHRONOUS.** That last part is the
constraint the ticket is built around, and it holds: the **tail** (`App.closeModal`,
`App.navigate`) still runs on the same tick, so no caller that drives this entry point without
awaiting it can have a dialog closed out from under it. Only the **sentence** moved.

- **`_dnRefused` opens a modal**, with the same precedence `_confirmEntryOnShare` uses for a
  journal entry that may not have landed. Its title names the number and says it was not saved;
  its body names the number, the entry that holds it, the entry it was taken off, and
  `reco/docNumberMaster.json` so somebody can go and look. **The toast stays as well** — it is
  what reaches somebody looking at the grid rather than the dialog, and the modal is what will not
  scroll away in four seconds.
- **The footer carries the way back**: a button that reopens the allocate dialog for *this* entry,
  with the refused number already cleared off it (the correction removed it from
  `entry.docNumbers`, which `openAllocateModal` reads). So the next thing on screen is the box to
  type a different one into.
- **The success waits for the merge** — the ticket's "cheaper half". `U.toast('Document numbers
  saved')` now fires from a promise nothing awaits, after `AppState.flush()`, and only if
  `Reco._dnSaid[accountingId]` is unset. `_dnRefused` sets that flag **before** either of its
  sentences, so the success cannot slip out between the modal and the toast even if its flush
  resolves first. A folder that cannot be reached claims nothing: the `.catch` is deliberately
  silent, because the claim is owed and retried on every save and the share-write machinery has
  its own sentence for that.

**Measured before the fix** (`scratchpad/dn/probes/d1_repro.mjs`, with the ordering that forces the
intent path — B writes `GL-7000` to the share, then A allocates it while A's in-memory master still
does not know, so A's immediate test passes): `success: Document numbers saved`, dialog closed,
then `error: ... was NOT saved`, and `#appModal.show` absent throughout. Reaching the in-memory
refusal instead would have measured MR-7, not this.

**Gated by `[94] R25a–R25q` in `run_store_e2e`** (17 checks). **R25n–R25p** are the control that
keeps the deferral honest: a number nobody holds still lands on the share and on the entry **and**
is still confirmed — a deferred sentence that never arrives would be a worse bug than the one this
round fixes. **`[58]` still covers the other side**, the in-memory refusal (MR-7), and `R25b` is
what keeps these two apart: it asserts A's own copy of the master does *not* know the number, so
only the intent can catch it.

**Mutation grid 7 × 16** in `scratchpad/dn/mut/run.py` against the round's own probe
(`scratchpad/dn/probes/d2_fix.mjs`), each turning exactly the checks it should — and it earned its
keep by catching a flaky check of **mine**: `R25m` went red under four mutations that touch nothing
but the toasts, because the probe was holding the entry object from *before* the flush.
`_dnRefused`'s own comment says why that is wrong (`_takeDisk` replaces the array, which is why the
function re-finds the entry by `accountingId`). It now re-finds it the same way, and is a control
no mutation in this grid can break — which is the correct status for a control.

---

## T-S10-14  A re-minted reversal MIRROR gets no notice, so the toast and the log name a reference it does not have

**Where** `apps/Reco.html` `Reco.reverseEntry` — the mirror's `U.accountingId()` mint, the
`AppState.ledgerFlush('entryHistory', …)` that appends it through `Reco._appendEntryIntent`, the
reversal toast, and the `reco/reversals.log.csv` line.

**What** T-S10-11 gave the mirror the same protections the generated entry has: a per-window
suffix, an `idNonce`, the shared append rule, and `e.reversal.reversalId` set from where the mirror
actually landed, **inside the mutate**. So the mirror is never lost and the original→contra link is
always right. What it did **not** get is `Reco._noticeReMint`: the reversal's own toast and the
`reversals.log.csv` line are written from `newId` **as announced**, so in the case where the mirror
was re-minted they name a reference the mirror does not have — and that reference belongs to
somebody else's entry.

**Why it is only a ticket** Reaching it needs two people reversing **different** entries in the
same millisecond **and** drawing the same two base-36 characters — about 1 in 1,296 of an already
rare event, against 1 in 1 for the Generate door before T-S10-11, which is why that one was fixed
and this one is written down. The record on the share is correct either way; only the toast and
one log line are wrong, and nothing reads the log programmatically.

**Fix** `reverseEntry` already has everything it needs: capture the announced `newId`, and after
`await AppState.flush()` compare it with `mirror.accountingId`. When they differ, call
`Reco._noticeReMint(tpl, announcedNewId, mirror, [])` — it is already a no-op when they do not —
and append a correcting line to `reco/reversals.log.csv` rather than rewriting the one already
there, because the log is append-only by design.

**Test** `run_reverse_e2e`, the two-page fixture, with `U.accountingId` pinned in both windows the
way `run_store_e2e` `[57b]` pins it: assert the mirror is on the share under a reference the
original's `reversal.reversalId` names, that the modal names both references, and that the log
carries a correcting line.

**CLOSED — AND TWO PARAGRAPHS ABOVE ARE WRONG, which is the more useful half of the round.**
The harm is real and was reproduced exactly; the ticket's account of *how rare it is* and of *what
the log needs* both turned out not to survive measurement.

**The first correction — "Why it is only a ticket" understates it.** "Two people reversing
different entries in the same millisecond **and** drawing the same two base-36 characters — about
1 in 1,296" is the condition for the **clash**, not for the stale announcement. `reverseEntry`
does not mint blind: it reads the share itself and `AppState.adoptLedger`s the result **before**
the mint — twice, in fact (`sh` before the plan re-check, `sh2` before the writes) — so its own
local de-dup loop normally sees the colleague's mirror and corrects `newId` before a word is said.
The announcement can only go stale if the colleague's write lands **after every read this window
made and before this window's merge job**: one read-write cycle, *on top of* the 1 in 1,296. Three
versions of this round's probe measured B's own loop doing the right thing and reported it as the
bug; the fourth stubbed `Reco._reverseReadShareHistory` to hide the colleague's mirror from
**every** read B makes, which is the honest shape of that window and nothing more — the share
file itself is untouched.

**The second correction — there was never a line to correct.** The Fix asks for "a correcting
line to `reco/reversals.log.csv` rather than rewriting the one already there, because the log is
append-only by design". But `Reco._reverseAppendLog` is called **after** `await
AppState.flush()`, so at the moment the adoption happens the log holds nothing about this
reversal yet. **One line carrying both references** is the same audit trail with nothing to
reconcile, and the append-only design is respected by construction. `R26l` is the check that pins
it and `R26m` is the control that keeps the new column empty on every ordinary reversal, so a log
only ever read by a human does not grow a column of noise.

**What was built, in `Reco.reverseEntry`:**

- **The announced reference is captured and the real one adopted**, immediately after
  `await AppState.flush()` and before anything is said or logged: `announcedNewId = newId`, then
  `newId = String(mirror.accountingId)` when the two differ. Everything downstream — toast, log,
  `AppState._activeEntryId`, the allocate dialog — was already reading `newId`, so one adoption
  fixes all of them.
- **The toast names the reference the mirror actually has** (`R26f`). It used to name the one the
  mint proposed, which in this window belongs to somebody else's mirror — and is the number the
  operator would quote and write on a document.
- **`Reco._noticeReMint(tpl, announcedNewId, mirror, [])`** raises the same "This entry is X, not
  Y" modal the Generate door has had since T-S10-11 (`R26g`). It already existed and was already a
  no-op when nothing moved; the reversal door simply never called it. The empty array is the honest
  argument: a reversal **frees** document numbers (step 6), it registers none, so there is nothing
  to re-point.
- **The allocate dialog is not opened on that path** (`R26h`). `reverseEntry` opens it on a 300 ms
  `setTimeout`, which would have replaced the one sentence that matters. Being told the reference
  is wrong comes before being asked to type document numbers against it, and the notice's own
  re-render leaves the operator on the entries tab where allocation is a click away. `R26c` is the
  other half of that: the ordinary path **still** gets the dialog, so the early return is taken
  only when the reference moved.
- **The log line carries both references.** `announcedReversalId` is `''` on every ordinary
  reversal and the announced reference on the one path where it moved.

**A bug this round's own probe found.** `Reco._reverseAppendLog` builds a **fixed** `flat` literal
and calls `append_csv_rows(…, Object.keys(flat), [flat])`, so a caller passing a new key gets it
dropped in silence and the column never appears. `R26i` — the premise check that the log has both
columns — is what caught it, with three checks red on a build whose code was otherwise right.

**Measured before the fix** (`scratchpad/rev/probes/r1_repro.mjs`): the toast said
`AEPINREVZZZZ` while `e.reversal.reversalId` — set inside the mutate, and right — said
`AEPINREVZZZZ1`; `reco/reversals.log.csv` carried **two** lines naming `AEPINREVZZZZ` as the
reversing entry, one of them a colleague's; and no notice modal was raised. Both mirrors were on
the share under different references throughout, which is what T-S10-11 bought and is why this was
a notice bug and not a data one.

**Every id comparison in the probe and the suite section is exact, and every CSV field is read by
column index.** `Reco._reMintAgainst` returns `U.accountingId() + (++n)`, so the re-minted
reference has the announced one as a **prefix**: `/reversed by AEPINREVZZZZ/` matches a *correct*
toast naming `AEPINREVZZZZ1`. Two versions of this probe reported first the harm and then the fix
off exactly that ambiguity.

**Gated by `[95] R26a—R26p` in `run_store_e2e`** (16 checks), not `run_reverse_e2e` as the Test
paragraph proposed: only `run_store_e2e` carries the two-window share fixture (`S101_SETUP` /
`S101_POST`) and the `[57b]` pinning technique this needs.

**Mutation grid 7 x 15** in `scratchpad/rev/mut/run.py` against the round's own probe
(`scratchpad/rev/probes/r2_fix.mjs`), each turning exactly the checks it should — and **two of
them measured nothing on the first pass**, which was a fault in the probe rather than in the grid.
The notice raised *without* the early return, and the early return taken on *every* reversal, are
both invisible to a probe that reads the modal straight after the flush: the stomp happens on a
`setTimeout`. The probe now waits 450 ms past it, which also bought `R26c`.

---

## T-26-11  ~~After a T-30-3 conflict the two values are in the file but unreachable, so the column reads blank next month~~  **FIXED** — the conflict is recorded where a reopen cannot orphan it, and the Column Values panel lists both strings

> **FIXED, and the measurement that mattered is the YES path rather than the
> decline.** Tick the box, answer YES, then reopen the day file through Version
> History (`scratchpad/cf/probes/q1_orphan.mjs`): the keys the promotion COULD
> move come back off the shared store — `INV-8=Carol`, `INV-9=Dave` on screen —
> and the conflicting key reads **blank**, with its two values in
> `reco/recoSessions.json` under ids no reader can reach. That isolates the
> conflict as the cause, which the declined path cannot: on a decline the save
> is abandoned above the template swap, so nothing is promoted at all.
>
> **THE SHAPE: A NOTE, NOT A VALUE.** `Reco._cfRecord` writes the conflict —
> the key, the column, **both strings**, when and by whom — onto the session
> when the promotion refuses to pick, and `Reco.carryConflicts` reads it back.
> Nothing in the values store was taught a new record kind, which is the review
> this ticket's own "honest shape" (a `k:'conflict'` record in
> `extraValueMaster`) would have needed from the grid, the ladder, the reports,
> the CSV, the workbook, the AEG extras loop and both ledger refusals. **[90]
> R21d** asserts the cell is still blank and the promoted keys still come back,
> so that claim is gated rather than asserted.
>
> **WHY THE SESSION.** It survives the reopen that causes the harm
> (`Reco.loadVersionedFile` replaces `sess.data` and nothing else) and it is
> persisted whole in `reco/recoSessions.json` (**[90] R21c2** reads it off the
> share, because a note that lived only in memory would die on the next
> restart — the same harm one day away). The property is created **lazily and
> deleted when the last note goes**, so a session with nothing to say is
> byte-identical to one that never had a conflict: `run_panes_e2e` diffs that
> file byte for byte against base `5f61d76`. It also means the note is exactly
> as durable as the two values it describes, which are in the same file — and
> no more: a window that writes `recoSessions.json` whole can still clobber
> another window's note, which is **T-S10-31** and is not this ticket's to fix.
>
> **THE RECOVERY IS THE OPERATOR'S, which is not the same as the app picking.**
> T-30-3 forbade the PROMOTION choosing a winner silently, because a typed
> record broadcasts to every row with the key and the loser was deleted in the
> same pass. The panel shows both strings and offers **"Keep this one"**, after
> a confirm that says the value will read on every row sharing the key and
> names what the other value is. It goes through `Reco.setTag` — the door a
> typed value in the grid already uses — so the key-rule refusals, the journal
> and the merge write apply unchanged. **Dismiss** removes the note and nothing
> else, for somebody who has corrected the duplicate rows and retyped by hand.
>
> **Gates: [90] R21a–R21j.** Including the two refusals that matter: with the
> key-rule latch up the write is refused and **the note is NOT forgotten**
> (R21g — a note cleared on a refused write would have deleted the only record
> of the two values), and with no row of that key on screen it refuses with a
> sentence naming the key (R21h). The panel itself is read off the **rendered
> modal** (R21e), because a record nothing shows is this ticket's own bug one
> level down. **The decline is recorded too and needs it more** (R21f): nothing
> is promoted, so the next reopen orphans every legacy value in that column and
> T-30-3's promised *"fix the duplicate rows and save again"* has nothing left
> to promote. Handover §21.


**Where** `apps/Reco.html` `Reco._promoteCarryForward` (the `clash` skip), `Reco._cfScan`, and
`Reco._tagKey(row, name) = row._id + '||' + name`.

**What** The promotion deliberately refuses to pick between two legacy values on a duplicated key
and leaves both where they are — which is right, and is what T-30-3 asked for. But "where they
are" is `sess.manualTags`, whose key contains `row._id`, and `row._id` is re-minted by `U.uid()`
on every load. So the characters survive in `reco/recoSessions.json` under ids no reader can
reach, and the operator sees a cell that has gone blank. Measured: the same fixture reads
`INV-7=Bob` on 9a597da (which picked a winner, the thing the ticket complained about) and
`INV-7=` after the fix (`scratchpad/money/skB/probe/p6g_decline_loss.mjs`). The fix round made
the confirm and the toast say so; it did not make the values reachable.

**Why it is only a ticket** Every remedy is a data-shape or a UI decision. A conflict-marked
record in `extraValueMaster` (two values under one key, with no winner) is a new record kind, and
EVERY reader of the store — the grid, the ladder, the reports, the CSV, the workbook, the AEG
extras loop and both ledger-write refusals — would have to be taught what it means, which is
precisely the review `k:'typed'` vs `k:'override'` already had. Writing one of the two values and
marking it "contested" is picking, which the ticket forbids.

**Fix** The honest shape is a record the grid can render as "two values — correct the duplicate
rows", carrying both strings and no value: `{ k:'conflict', vs:['Alice','Bob'], at, by }`, with
every reader treating it as "no value, and say why" rather than as an amount or a note. The
cheaper half, worth doing first, is a panel: list the conflicting (key, column) pairs and the
values still in the session file, so somebody can retype one of them against the corrected rows.

**Test** The `run_store_e2e` [60] fixture, reopened through `Versioning.latestDataFile` +
`Reco.loadVersionedFile`: assert the grid shows both candidate values (or the panel lists them)
rather than an empty cell, and that nothing reads as an amount — in particular that a posting
over that row is still refused or still reads the computed value, never one of the two.

---

## T-24R2-7  The exclusive-role matrix is not re-run when the AEG LINK changes, which is S11's third direction

**Where** `apps/Reco.html` — `RecoTemplate._exclusiveRoleConflict` is consulted when a column's
`allowOverride` / `carryForward` box is ticked and when an AEG input column is renamed (that arm
is T-24R2-6), but `aegIntegration.enabled` and `aegTemplateId` are raw assignments with no gate.
`XlSchema.aegTemplateFor` returns null unless `aegIntegration.enabled`, so with the integration
off — the default for a new template — the matrix has nothing to consult.

**What** Tick "Allow manual override per row" on a column while the integration is off, then
switch the integration on and link the template that reads that column: the matrix never runs
again, so a column S11 would have refused is now an AEG control column with an override on it.
Measured in the fixer's reproduction of the Z1 override door
(`scratchpad/money/skA/probes/p1_override_bypass.mjs`): `_exclusiveRoleConflict(tpl,'AED','allowOverride')`
returns null before the link and a refusal after it. Two ordinary clicks, in the order a person
works.

**Why it is only a ticket, and why it is no longer a blocker** MR-1 closed the harm at the
journal door: a non-numeric override on a column the entry reads is refused there, whatever the
editor allowed, and so is a broken formula in one. What is left is that the editor lets a
template into a state S11 exists to prevent, so the operator finds out at posting time instead of
at ticking time. And the gate itself needs a decision: a template that is ALREADY in that state —
saved by any build before this one — would be unable to turn its integration on at all, which is
a worse first experience than a late refusal.

**Fix** Re-run `_exclusiveRoleConflict` over every added column when `aegIntegration.enabled` or
`aegTemplateId` changes, and refuse the CHANGE naming the column. Decide what an already-conflicted
template does: the kind answer is to allow the save and warn, listing the columns, since the
journal door refuses anyway. Note a second route needs no S11 gap at all — the matrix matches
input columns by `name` only while the AEG loop falls back to `r[ic.label]` — and MR-1's read set
already covers that one by adding the label.

**Test** Tick the override box with the integration off, then link the AEG template that reads
that column: assert the change is refused (or warned) and names the column. Control: the same
link on a template with no flagged column is silent. Then the end-to-end one, which already
passes: `run_store_e2e` [54] MR1b, where the posting is refused even though the editor allowed
the state.

---

# From the review of the data-loss round

<!-- the fixer, after the two reviews of T-S10-7 / T-24R2-1 / T-S10-5 / T-F2-8 / T-S10-9 / T-26-4.
     Fourteen findings, all reproduced and all confirmed; thirteen fixed in sections [69]-[77].
     These three are what is left. Handover section 18.8. -->

## T-S10-15  `run_panes_e2e` [4]'s byte-identity gate fails about one run in three, and its premise is already hollow

**Where** `apps/Reco.html:22504` `Reco._measureVirtRow(sess);` inside
`setTimeout(Panes.wrapFixups(() => { … }), 0)`, and `_measureVirtRow(sess, wrap)` itself
(`if (sess._virtRowHeight) return; … if (sample && sample.offsetHeight) sess._virtRowHeight =
sample.offsetHeight;`). Nothing synchronises that timer with the `await AppState.flush()` at the end
of the fixture's SITTING (`tests/e2e/run_panes_e2e.mjs:336`).

**What** The gate compares `reco/recoSessions.json` byte for byte against base `5f61d76`. It fails
about one run in three on an **unchanged tree** — one failure in eight measured by the reviewer, the
diff reported at line 249/250 as the presence of `"_virtRowHeight": 38` **and nothing else**, with
five consecutive clean runs either side of it. `git diff c94264d d1e9509 -- apps/Reco.html | grep
_virtRowHeight` is **empty** on both the reviewer's measurement and mine, so this is not a behaviour
change any round made. The mechanism, measured eight times out of eight: `TPL_A=38
TPL_B=undefined TPL_C=undefined TPL_D=38`. The session at the failing line is **TPL_D**, the Restore
Session one — `RecoTemplate.open('TPL_D')` renders an EMPTY session so the first deferred measure
finds no sample row; the data is then assigned by hand with **no re-render**; only
`restoreSession`'s own re-render queues a second `setTimeout(0)`, and whether that fires before the
final flush is the race.

**AND THE PREMISE IS ALREADY HOLLOW**, which is the half worth knowing: `TPL_B` and `TPL_C` are
never measured at all (8/8), so the gate compares two sessions that are **absent on both sides** and
reads green by symmetry. A premise assertion added naively ("the field is present in both files")
would fail today.

**Why it is only a ticket** The fix belongs in the FIXTURE and the review round was not allowed to
edit `tests/e2e/run_panes_e2e.mjs`. The alternative — making the measurement eager in the app —
would change a field the byte-identity gate compares against its own base and break the gate for
real. **Do not "fix" it by dropping or normalising the field** (that is how a genuine migration
break gets waved through, and this repo has already shipped one bad baseline that read green for two
commits).

**Fix** In the fixture, before the final `await AppState.flush()`, poll until
`AppState.recoSessionsOwned[id]._virtRowHeight` is set for **every session the gate compares**, on
BOTH builds. Then either have the SITTING render each of the four sessions' grids with rows once, or
scope the new premise assertion to the sessions it actually renders — and assert the field is
PRESENT, so the gate stops reading green by symmetry.

**Test** `N=8 node tests/e2e/run_panes_e2e.mjs` with no changes: 8 green, and the premise assertion
green in all 8. The reviewer's `p1_virt.mjs` / `p1b_line249.mjs` are the mechanism probes.

---

## T-S10-16  ~~A4's latch guards three typing doors; `applyCorrection` and `manualOffset` write under the same dead key and are not latched~~  **FIXED** — the latch is asked per ACTION, and round 5 fixed the LIFT

> **REOPENED BY THE VERIFIER AND CLOSED AGAIN IN ROUND 5.** The per-action latch below is right and
> every door it names is green. **The latch itself lifted too early**, which made all of it
> reachable again by the route the refusal's own sentence prescribed, and **above
> `Reco.BUSY_ROWS` it never lifted at all**. Three more doors were open (the Excel load-back's
> Apply, and T-S10-18's). The gate claims in this ticket are therefore true of what they measure
> and were **not enough**: see handover **§18.10** and `run_store_e2e` **[79]–[81]**. The counts
> below are the round-4 ones; the suite is now **672**.
>
> **AND IT WAS NOT ENOUGH A SECOND TIME. See T-S10-20.** The decision below — *"the latch at EVERY
> entry point of that action"* — is right about the shape and wrong about the method: applied by
> hand it missed **eight** more controls, four of which a verifier had to find with real mouse
> clicks and four of which only a static enumeration of the writers ever found. The question is now
> asked at the **WRITE** (`Reco.writeKey` / `Reco.writeVerKey`) with the gesture-level latch kept on
> top of it, and `run_store_e2e` **[82]** enumerates the writers from the source so a ninth cannot
> arrive quietly. Handover **§18.11**.

**Where** `apps/Reco.html` — `Reco._keyStaleBlock` is consulted by `Reco.setTag`,
`Reco.setOverride` and `Reco.revertOverride`. It is **not** consulted by `Reco.applyCorrection`
(`AppState.correctionMaster[id][pk][colName] = { oldVal, newVal }`), `Reco.manualOffset`
(`AppState.manualOffsetMaster[id][pk] = { recoId, byUser: true }`), `Reco.unmarkOffset` or
`Reco.editCell`. `pk` in all of them is `Reco.rowKey(tpl, row)`, which returns the row's **frozen**
`_pk` first — i.e. exactly the key the refusal has just invalidated.

**What** Measured, `scratchpad/dataloss/fix/probes/q7_latchdoors.mjs` (port 21316), straight after
the T-24R2-1 key refusal with `Reco._keyStale.TPL_X === true`:

| door | what it said | what reached the share |
|---|---|---|
| `setTag` | the latch's sentence, `error` | nothing |
| `applyCorrection` | **`success: Correction applied`** | `reco/correctionMaster.json` → **`["D3"]`** |
| `manualOffset` | refused for tolerance, so unmeasured here | — |

The folder's rule now computes `D3-X`, so that correction is filed where **no colleague will ever
read it** and where this operator's own next load will not find it either — A4's harm exactly, in a
door the fix did not name. `manualOffset` is structurally identical and was only not measured
because that fixture's single row is outside the offset tolerance.

**Why it is only a ticket** It is the same mistake as B4/B6 one layer up — a rule applied to a list
of functions — and the review round closed the two doors its own finding named and measured. It is
narrower than A4 was: a correction and an offset are *reconciliation* facts rather than typed
values, and both have a second copy in `sess.corrections` / `sess.offsets` for this window, so the
operator's screen is not wrong; what is lost is the colleague's half. It needs the same decision A4
needed — refuse, or re-key — and it is better taken once for all five doors than bolted on here.

**Fix** Put `_keyStaleBlock` at the top of `applyCorrection`, `manualOffset`, `unmarkOffset` and
`editCell`, with each one's own verb ("corrected", "offset", "changed", "saved"), the way
`setOverride` and `revertOverride` carry it — and consider whether the rule belongs in
`Reco.rowKey` instead, which is the one function all five go through for the key. If it goes in
`rowKey`, the machine paths matter: the Excel load-back and `ingestData` must not be told to press
Load, which is why `applyEdits` was not the chokepoint for B4/B6 either.

**Test** The `run_store_e2e` [71] fixture, extended: after the refusal, assert
`applyCorrection` and `manualOffset` are each REFUSED with a sentence naming the row key, and that
`reco/correctionMaster.json` and `reco/manualOffsetMaster.json` hold **nothing** under the dead key.
Control: after a reload both work normally and write under the folder's own key.

**CLOSED — AS A PER-ACTION LATCH AT THE DOORS, NOT AS A RULE INSIDE `Reco.rowKey`.** Handover
§18.9 carries the argument; the short version is that `rowKey` is a key **reader** — the renderer
and every badge, the status filters, `runAutoOffset`'s restore, the drift check, `Groups.resolvePk`
— and that **the machine path goes through it**: `ingestData` has no operator at the keyboard, so
the Load sentence is addressed to nobody, which is why `applyEdits` was not the chokepoint for
B4/B6 either. (**This sentence said "the Excel load-back AND `ingestData`" and round 5 corrected
it.** `ExcelLink.apply()` is the Apply button of the review dialog, with an operator pressing it,
and it was filing under the dead key behind a green *"Applied 1 change to 1 row(s)"*. It is latched
at `ExcelLink.apply`, not at `applyEdits`. The argument against `rowKey` stands on `ingestData`
alone.) It also cannot carry four verbs, and it runs once per row
per render. So `Reco._keyStaleBlock` stays the one place the rule lives and each **action** asks it
at **every** entry point, with its own verb: *corrected* (`applyCorrection`), *offset*
(`manualOffset`, `bulkMarkOffset`, `offsetSelected`, `_xlOffsetSelectedRows`), *unmarked*
(`smartUnmark`, which is where both unmark gestures write), *changed* (`editCell`), beside A4's
*saved* / *overridden* / *reverted*. `removeManualOffset` and `removeCorrection` are deliberately
**not** latched: their key comes from the stored master the panel lists, not from a row on screen.
The latch's own sentence now covers a DELETE as well as a write, because the unmark and the revert
are changes to a record the folder holds rather than typing.

**ALL FIVE DOORS WERE MEASURED FIRST, AND THE FIXTURE HOLE THIS TICKET NAMES IS CLOSED**
(`scratchpad/dataloss/close/repro_before.txt`, port 21340). `manualOffset` said **nothing at all**
and filed `D3`; `unmarkOffset` said a green *"Unmarked 1 row(s)"* and **deleted** `D5`'s record
under the dead key, leaving the copy a colleague's load reads — a delete that did not happen;
`editCell` said nothing and put a version row in the day file under `D4`. `R1_SETUP` now carries
`toleranceValue` and an editable column so the offset and file-cell doors are reachable at all, and
**R3g asserts that** rather than trusting it.

**THE GATE** is `run_store_e2e` **[71]** R3g–R3v: 598 passed / 0 failed with the fix, and the ten
new value-and-file assertions **all red** on the tree before it (`close/store_fail_first.txt`) and
again through `APP_FILE=<f9329e7 Reco.html>` (`close/store_mutation.txt`). Every other suite is at
its baseline.

**WHAT IT LEFT, AND WHAT ROUND 5 DID WITH IT.** `R3s–R3v` — the control that says the latch lifts —
reads `sess.data[length-2]` and `[length-1]`, i.e. **only the rows the reload minted**, so it could
not see that the latch had come off while the rest of the session was still dead-keyed. Measured:
after the refusal the operator presses the only file input the UI has, which **appends**, and
`Reco.setTag` on a row that was already on screen says **nothing** while `extraValueMaster` gains
the dead key. Above `Reco.BUSY_ROWS` the chunked pass passes `from`=0 for the first chunk, so the
clear site never ran and the latch **never came off** on a 100,001-row load. And a load the operator
**declined** lifted it too, because the clear was above `Reco._keyIngestCheck`. All three are one
site now (`Reco._keyStaleLift`, called after the concat), the refusal names **Clear Loaded Data and
then the load** instead of "press Load", and **[79]** R11d fires every door at an **OLD** row —
the gate this ticket's own control could not be. Also closed with it: the **Excel load-back's
Apply** (this ticket's Fix paragraph argued it away as a machine path — it is the Apply button in
the review dialog) and **T-S10-18**'s group, comment and attachment doors. Handover **§18.10**.

---

## T-S10-17  `AppState.flush()` can now wait on a template settle, so any future settle path that needs a flush deadlocks

**Where** `apps/Reco.html` — `AppState.flush()` and `AppState.saveKeys()` both begin with
`if (AppState._keyHeld('recoTemplates')) await Promise.resolve(RecoTemplate._flagGuard);`, and
`RecoTemplate.saveTemplate`'s share read waits for `RecoTemplate._flagGuard` and then for
`RecoTemplate._tplWritten`. `AppState._writeKeyNow(key)` exists so that `_tplWritten` is a promise
for a WRITE rather than for a flush, and it deliberately **bypasses `_keyHeld`**.

**What** This is a trap rather than a defect: the current code is correct and the suite pins it
(`run_store_e2e` [70], and [28] C6h is what caught the deadlock), but the invariant that makes it
safe is **not local**. The first shape of A3's fix had `RecoTemplate._tplWritten = AppState.save()`
— a 250 ms debounce that only a flush resolves — so the second of two back-to-back saves waited for
a flush that was waiting for the second save's guard. `run_store_e2e` stopped dead at section [28]
and never returned; a checkpoint was committed in that state. Reproduced in 12 seconds by
`scratchpad/dataloss/fix/probes/q6_deadlock.mjs`: `flushed:false`, `settleOwed:1`.

Three things have to stay true, and nothing in the code enforces them:

1. anything the settle waits for must **not** be a flush or an `AppState.save()`;
2. the `_tplWriteOwed()` flush in the share read must stay **synchronous on its own line**, ahead of
   every `.then` — the hold is taken at the swap, i.e. after that read is issued, so that one flush
   never sees a hold. Deferring it by one microtask moves the serialisation past the swap and the
   flush publishes the editor's own clone, with the whole fix reading green while doing nothing;
3. `_writeKeyNow` must stay the settle's private door. A second caller using it to get around a
   hold would publish the un-merged clone, which is the loss A3 is about.

**Why it is only a ticket** Closing it properly means either a real dependency-ordered writer (one
place that knows "this key is owed, and it is owed behind that promise") or making `saveTemplate`
async, which §18.7 explains cannot happen while every caller saves a template and reads
`AppState.recoTemplates` on the next line. Both are bigger than the round that found it, and the
three rules above are written into the code at each site.

**Fix** Give the hold a release promise of its own (resolved by `release()`, never by a write) and
have `flush()` wait on **that** rather than on `_flagGuard`, so the wait can never reach a write at
all; then `_writeKeyNow` can go back to being an ordinary targeted write. Alternatively, add a dev
assertion: a flush that has been waiting on a hold for more than one `SAVE_DELAY` logs the hold's
age and the owed keys, so the next version of this deadlock is a console line rather than a hang.

**Test** `probes/q6_deadlock.mjs` as a suite section: two saves with no await between them and a
slowed share read, then `await AppState.flush()` inside a `Promise.race` against a budget — assert
it resolves and that `RecoTemplate._settleOwed` is back to 0. Mutation: put
`_tplWritten = AppState.save()` back and assert it times out.


---

## T-S10-18  ~~The group and comment doors still file under a dead row key after the key refusal~~  **FIXED** in round 5, with the attachment door measured

> **CLOSED.** All three gestures are latched (*grouped* / *removed from the group*), so is
> `Comments._confirmAdd` (*commented*), and so is the door this ticket recorded as **unmeasured**:
> the **attachment** one (*attached*), at both of its entry points — the Attach File dialog's
> Upload and the multi-file drop onto a row. It was measured OPEN first, exactly as this ticket
> asked: a green *"Uploaded: note.txt"* with `linkedPks ["E5"]` in `reco/attachmentMaster.json`
> while the folder's rule computed `E5-X`. The remove arm was measured too, and it was the unmark's
> shape: a green *"Removed 1 member(s) from group"* that **deleted** the membership filed while the
> keys were still right and left the colleague-visible one behind. The gate is `run_store_e2e`
> **[80]** R12c–R12n, files and values, with the reload control. Handover **§18.10**.

**Where** `apps/Reco.html` — `Reco.createGroupFromSelection`, `Reco.addSelectionToGroup`,
`Reco.removeSelectionFromGroup` (all three take their keys from `Reco._selectedPks`, i.e.
`Reco.rowKey` over the selected rows) and `Comments.openAddDialog(tplId, pk)` →
`Comments._confirmAdd` → `Comments.create(..., { linkedPks })`, whose `pk` is captured from the row
the menu was opened on. `groupMaster`, `commentMaster` and `attachmentMaster` are all in
`AppState.PERSIST_KEYS`, so each write is a whole-file blind write of a file every colleague parses
at boot.

**What** Measured, `scratchpad/dataloss/close/other_doors.txt` (port 21341), straight after the
T-24R2-1 key refusal with `Reco._keyStale.TPL_X === true` and the folder's rule computing `D<n>-X`:

| door | what it said | what reached the share |
|---|---|---|
| create group from selection | **`success: Group "G1" created with 1 member(s)`** | `reco/groupMaster.json` → members `["D1"]` |
| post a comment on a row | **`success: Comment posted`** | `reco/commentMaster.json` → `linkedPks ["D2"]` |

§18.2's argument for refusing a key change names *groups* and *comments* in the list of what a key
change detaches from the rows, so this is the same harm T-S10-16 closed for corrections and
offsets: the operator's own screen is right, the colleague's half is lost, and the toast is green.
The **attachment** door (`Attachments.*`, keyed the same way) was **not measured** — do not assume
either answer for it.

**Why it is only a ticket** T-S10-16's decision was scoped to the two masters it measured, and
these two doors are not a one-line repeat of it: a group is an accounting control with refusals of
its own (`smartUnmark` refuses a partial unmark of an offset group, `sess.requireGroup` filters on
membership), the comment door's key is captured when the MENU opens rather than when Post is
pressed, and three of the four gestures are *removals* from a group, where the verb has to say that
nothing was removed. Bolting the latch on without a measured test for each is how a rule becomes a
list of function names again — the mistake B4/B6 were about.

**Fix** The rule is already written at `Reco._keyStale`: a gesture whose key comes from a row on
screen and which writes a pk-keyed shared store asks `Reco._keyStaleBlock(tpl, verb)` first. Apply
it at the three group gestures (*grouped* / *removed from the group*) and at `Comments._confirmAdd`
rather than at `openAddDialog`, so the operator is told when they press Post and not before they
have typed. Measure the attachment door and do the same there or say why not.

**Test** Extend `run_store_e2e` [71] the way R3g–R3v extends it: after the refusal, assert each
door is refused with its own sentence and that `reco/groupMaster.json` / `reco/commentMaster.json`
hold **nothing** under the dead key — files and values, not toasts — with the reload control that
both work normally afterwards under the folder's own key. `close/q8_otherdoors.mjs` is the
reproduction, already written.

**DONE, in section [80]** (`PORT_R12` 21382), with `reco/attachmentMaster.json` read as well and a
control that all four doors — and the Excel load-back's Apply — file under the folder's own key
afterwards. The reproduction this round used is `scratchpad/dataloss/lift/probes/w1_doors.mjs`
(`logs/w1_before.txt` is the before, 1 as-expected / 7 not). Only the **row** branch of the comment
and attachment dialogs is latched: a group-linked record is filed against the group's id and not
against a row key.

---

## T-S10-31  `reco/recoSessions.json` is written WHOLE by every window, so one window's boot copy of a template it never opened overwrites another window's work on it

**Where** `apps/Reco.html` `Store.save(key, data, text)` — the tail,
`api.write_file('reco/' + key + '.json', text)` — for every member of
`AppState.PERSIST_KEYS`, and `AppState._persistValue('recoSessions')`, which
returns **the whole of** `AppState.recoSessionsOwned`.

**What** *(Read off the code. NOT measured: a two-page probe was started and
left hanging in `scratchpad/bridge/probes/p3_sessions.mjs`, and it is not worth
holding the bridge round for. The Test paragraph below is the measurement this
ticket wants first.)* `Store.loadAll` reads every session on the folder into
`recoSessionsOwned`, including templates this window never opens, and
`AppState.flush` writes all of them back. So window A, which has had T2's
session in memory since boot and has not touched it, overwrites whatever window
B has been doing in T2 all morning — with its own stale copy, unconditionally,
and nobody is told. It is **T-S10-10's shape on a different file**, and a
bigger one: §14.6 measures `recoSessions.json` at 24.6 MiB for one
200,000-row template.

**Why it is only a ticket** This round closed the shape on the path that has a
merge — `Store._mergeJob`, i.e. the values store and the ledgers — because
that path already has per-id intents that replay. `Store.save` has none: it
writes a serialised snapshot of the whole key and there is nothing to replay
onto a fresher read. The primitive it needs now EXISTS
(`write_file_if_unchanged`, T-S10-10), so this is no longer blocked on the
bridge; what it needs is a decision about what MERGING two windows' sessions
means. Last-write-wins **per template id** is the obvious rule and is probably
right — a session is one window's view of one reconciliation — but it is a rule
about the operator's work and not a detail, so it is not a drive-by fix.

**Fix** Give `Store.save` the same compare-and-swap loop `_mergeJob` has, with a
per-key merge rule. For `recoSessions`: take the share as the authority per
template id and keep only the ids this window has actually OPENED (there is
already a notion of that — `AppState.activeRecoId` and the pane table), so an
untouched template's session is never written back at all. The other
PERSIST_KEYS want naming one at a time: `groupMaster`, `commentMaster`,
`attachmentMaster` and `correctionMaster` are pk-keyed and merge the way
`extraValueMaster` does; `recoTemplates` already has its own refusal
(T-24R2-1).

**Test** Two pages on one share, each with two templates loaded, each editing a
DIFFERENT template, flushed in turn — then assert both edits are on
`reco/recoSessions.json`. It fails today. `run_panes_e2e`'s byte-identity gate
(base `5f61d76`) pins that file, so the change has to leave a single window's
bytes alone, which is also the proof that the merge only fires where there is
something to merge.

---

## T-S10-19  ~~A day file written before a key change hands its OLD keys back to any window, with no latch anywhere~~  **FIXED in round 8, reviewed, and then cleaned up** — the key rule's SIGNATURE is recorded on the row at mint time and carried through the day file; the remainder is T-S10-25

> ## CLOSED IN ROUND 8. WHAT WAS BUILT, WHAT THE THREE OPEN QUESTIONS WERE DECIDED TO BE, AND
> ## WHAT IS LEFT. Everything below this block is the design as it stood when the round started and
> ## is kept because it is the argument; this block is what happened.
>
> ### AND THEN A CLEANUP ROUND, BECAUSE THE REVIEW'S VERIFIER SIGNED THE BEHAVIOUR OFF AND REFUSED
> ### TO SIGN THE ROUND OFF: *"what stops me is not the behaviour."* Nine items: **five sentences,
> one safety control with no behavioural test anywhere, and three about the code — two of which
> became code changes.** None is a false refusal and none loses a value; the worst loses the
> PROTECTION on a value. **Handover §19.9 has all nine; the three that change what this ticket SAYS
> are here.**
>
> 1. **COMPACTION WIDENS AN EXISTING DAY FILE AND THE NEXT APPEND INTO IT LOST ITS SIGNATURE.**
>    Finding 2 below put the no-widening guard in `Versioning._appendRows`; `Versioning.compactFile`
>    does not go through it. The widening itself is safe and is the one route that upgrades such a
>    file, but `Versioning._hdrCache` was never invalidated by `Versioning.writeFile`, so after a
>    compaction the next `Add Data` read the stale narrow header and **deleted the signature off the
>    record**: a row the mint had signed landed unsigned in a file whose header carries the column,
>    and after a real key-rule change it is the one row that is **not** refused. One line in
>    `writeFile`. Handover §14.5, §19.9. **[88] R19z**.
> 2. **`carryForward` WAS STILL IN THE SIGNATURE — the FIFTH instance of finding 1's shape.** A
>    dropdown or custom column cannot be in a key's closure at all (`_pkEligible1` and
>    `_pkFormulaOk` refuse it, measured through the real save), and past the save the flag still
>    cannot reach a minted key, because `_extraTyped` returns at its record test while `row._pk` is
>    the empty string the ingest reserves. **[88] R19s now asserts the opposite of what it
>    asserted**, and the review pass's own mutation grid had graded the right answer as a defect.
>    Handover §19.2, §19.9.
> 3. **THE ⊘ older rule BADGE HAD NO BEHAVIOURAL GATE.** R19x is a regex over the source, and a
>    mutant that deleted the render while leaving every character that regex matches behind in a
>    comment read 724 / 0 — the one safety control in the round whose removal nothing noticed.
>    **[88] R19x2** reads the rendered `<tbody>` of the mixed screen: the badge on each refused row,
>    on none of the live copies, and `Reco.keyOldRuleCount` beside it.
>
> **The five sentences, and they matter because this cluster has already shipped documentation that
> said the opposite of the code twice:** the summary block below asserted as fact the *"same set by
> construction"* argument the review called the central defect; the answer to question (c) quoted a
> refusal sentence the code is gated never to say and cited **R19f** — the gate that asserts it
> absent — as the proof; the same answer said *"no new readerless counter was added"* when
> `Reco.keyOldRuleCount` is one; handover §15.6(a) quoted the same dead sentence in the present
> tense and reinstated the Clear-and-load loop the same bullet says is not advice; and
> `Reco.keyRuleSig`'s own header in `apps/Reco.html` named `_keyDefOf` sixty lines above the code
> that hashes `_keyRuleDefOf`. **All five are corrected in place below and marked as the mistake**,
> because a reader who trusts a summary block rebuilds the defect.
>
> ### ROUND 8's REVIEW PASS CHANGED FOUR THINGS IN THIS BLOCK AND ONE OF THEM WAS A BLOCKER.
> Read this before the block below it, because the block below is the build's own write-up and parts
> of it are now wrong. Two skeptics, thirteen findings, measured from the files and the probes in
> `scratchpad/pksig/skA.json`, `skB.json` and `scratchpad/pksig/fix/REPORT.json`.
>
> 1. **THE HASH WAS OVER THE WRONG THING (BLOCKER, both skeptics, independently).** It hashed
>    `RecoTemplate._keyDefOf`, which keeps the **whole stored column object**, so **four edits an
>    operator can make through the editor's own handlers refused every row minted before while the
>    keys were exactly what the folder's rule computes**: ticking *Allow manual override per row* on
>    a key helper, ticking *Carry this value forward* on one, a MIS-CLICK on a key extra's type
>    dropdown clicked straight back (which leaves `_setExtraType`'s dropdown defaults behind for
>    ever, invisible, with no control that removes them), and reformatting a key formula. Round 6's
>    harm with a different cause. It now hashes **`RecoTemplate._keyRuleDefOf`**, a per-type
>    PROJECTION of the same walk down to the fields `Reco._extraOwnValue`'s ladder reads, plus the
>    closure's declaration order, plus a formula canonicalisation that keeps string literals byte
>    for byte. `_keyDefOf` stays coarse for the latch and T-24R2-1's confirm, deliberately:
>    **over-approximating is cheap in a WARNING and ruinous in a REFUSAL**, and the argument the
>    build offered for sharing it — *"the same set by construction"* — is the defect, not the
>    defence. Handover §19.2. Gates **[88] R19q / R19r / R19s / R19t** — and R19s was itself turned
>    round by the cleanup round above, because the projection still kept one field it should not.
> 2. **THE SCHEMA CHANGE GUARANTEED A DATA LOSS.** The sixth control column made the first write
>    into any pre-`_pksig` day file take `append_csv_rows`' whole-file rewrite, and that rewrite was
>    measured **losing a colleague's concurrent append in three of four timings, with both writers
>    reporting success** — 120,001 rows where 120,002 were written — and recurring once per template
>    **per day** while the fleet is mixed, not once per file. `Versioning._appendRows` now refuses
>    to widen a file it did not create. Handover §19.5. **[88] R19k2** (turned round), **R19w** — and
>    the one path that is NOT `_appendRows`, compaction, is item 1 of the cleanup round above.
> 3. **ONE ORDINARY EDIT FROM AN UN-UPGRADED WINDOW STRIPPED A ROW'S SIGNATURE FOR GOOD** and
>    reopened the dead-key door for exactly that row, in silence, with the value landing on the
>    share. `Versioning.collapseToActive` now inherits a signature from the newest version of the
>    same `_pk` that has one — exact, because `_pk` is what files a row. Handover §19.5. **[88] R19v**.
> 4. **THE REFUSAL SENTENCE WAS FALSE IN THE COMMONEST CASE** — it blamed a saved day file and said
>    *"Nobody has changed anything"* to an operator whose own save had moved the signature under
>    rows minted in that window — and the recovery it named does not exist for an older day file.
>    There are **three** branches now, chosen from the row's own data set id. Handover §19.4.
>    **[88] R19u / R19u2 / R19f**. §15.6 now tells the operator the real blast radius: **a key-rule
>    change makes every earlier day file of that reconciliation read-only.**
>
> **ALSO FIXED:** the cache keys missed an in-place `tpl.columns` push, so the answer was stale and
> flipped to *"refuse every row"* at the next unrelated save (**[88] R19y** refuses the clash at
> source); the hash's second lane was fed only the high byte, which is zero for ASCII, so the
> discriminating width was 32 bits and a collision turned up in 154,453 tries; and a refused row is
> now **marked on the row** (`⊘ older rule`) with a count, because the same business key was
> measured on screen twice, one copy refused and one writable, with nothing to tell them apart.
> **FILED, NOT FIXED:** T-S10-26 (the backup-restore confirm), T-S10-27 (the toolbar count and
> filter), T-S10-28 (`main.py`'s widening branch, which this round may not edit), T-S10-29 (30 bytes
> a row on `recoSessions.json`), T-S10-30 (`Groups.resolvePk`).
>
> **THE SIGNATURE EXISTS.** `Reco.keyRuleSig(tpl)` is `'1:' + fnv1a64(canonical(RecoTemplate._keyRuleDefOf(tpl)))`
> — the `primaryKeys` list plus the DEFINITION of every column in the key's dependency closure
> (`Reco._keyDepNames`), object keys sorted so the hash survives the JSON round trip through
> `reco/recoTemplates.json` and a mixed fleet (T-S10-12). `Reco._mintKeysSync` writes it on every row
> that got a business key as `_pksig`; `Versioning._fields` carries it as a FIXED control column;
> `Versioning.appendUpload` and `appendChangesBatch` put it in the day file's records;
> `Reco.loadVersionedFile`'s row literal brings it back; `Reco._keyWriteUnsafe` and `_keyRowsUnsafe`
> ask the template latch FIRST and then `Reco._keySigMoved(tpl, row)`.
>
> **IT IS `_keyRuleDefOf` AND NOT `_keyDefOf`, AND THE ARGUMENT FOR `_keyDefOf` IS THE ONE THING IN
> THIS ROUND WORTH READING TWICE, BECAUSE IT IS THE MISTAKE AND IT READS LIKE A VIRTUE.** That
> argument was: there is deliberately no second definition of "the key rule" in the file, `_keyDefOf`
> is what T-24R2-1's refusal and the definition-change confirm already compare, so *"a change that
> raises the latch"* and *"a change that moves the signature"* are the same set **by construction**.
> Both skeptics found independently that this is the defect. `_keyDefOf` keeps the **whole stored
> column object**, so display and ownership flags the key engine never reads were in the hash, and
> **four edits an operator can make through the editor's own handlers moved the signature while the
> rule went on computing BYTE-IDENTICAL keys** — round 6's harm with a different cause.
> **THE ASYMMETRY IT MISSES:** over-approximating is **cheap in a warning and ruinous in a refusal**.
> The latch and T-24R2-1's confirm are warnings, so they **keep** the coarse `_keyDefOf`; the
> signature refuses, so it needs the narrow projection. One definition of "the key rule" was the
> right instinct and `_keyRuleDefOf` keeps it — same `primaryKeys`, same `Reco._keyDepNames` closure,
> same walk; one definition of "which BYTES of it matter" was the error. **[88] R19q** is the
> twelve-change gate and **R19r** is the mirror, and they have to be read together. Handover §19.2.
>
> **IT IS NOT A RECOMPUTE, and that is checkable rather than asserted.** `_keySigMoved` reads two
> strings. It touches no cell, calls no formula engine and never splits `_pk`, so **[82] G82f did not
> have to be turned round** — its forbidding half (`_keyRowDrifted`, `_extraComputedValue`,
> `_keyFrozenPart`, `_keyRowCols` must not appear) passes unchanged, and a third, POSITIVE clause was
> added so that *removing* the signature arm reddens it too. All six of **[86]**'s false-refusal
> gates stay green.
>
> **THE THREE OPEN QUESTIONS, DECIDED:**
>
> **(a) Does a template whose key names no added column need a signature?** *Decided: no — and the
> ticket's own reason for that ("it cannot drift") is WRONG, so the right reason is written down
> instead.* Such a rule CAN move: editing `primaryKeys` from `['Doc']` to `['Doc','Line']` re-keys
> every row, and `RecoTemplate._keyDefMoved` already reports it first ("which columns the row key is
> built from"). It is declined on **cost and blast radius**, measured: `Versioning._fields` reads
> `keyRuleSig`, so a signature there widens the day-file header of **every template that existed
> before #24** — which is every template on the folder — and that header is pinned byte-for-byte by
> `run_pk_extras` **G1** (the acceptance bar for "#24's migration is a no-op") and asserted verbatim
> by `run_e2e`, `run_autoload`, `run_colorder` [13] and `run_reverse`. The change it would protect
> against is also the LOUD one: it fires the definition-change confirm, it marks every exported
> workbook stale, and it is what #24's own confirm warns about — where T-S10-19's whole premise is
> the SILENT case, a key extra's `formula` or `masterCfg` moving with `primaryKeys` byte-identical.
> The cost of the signature itself is **not** what decided it: measured at **[88] R19j2** and
> **[85] R16d**, 2,000 guarded writes cost **ZERO** canonical-JSON-plus-hash passes (one per mint
> pass, and nothing after it), because `keyRuleSig` is cached against the template object and the
> identity of `primaryKeys`/`additionalColumns`, so the write-side arm is a WeakMap get and two
> identity compares. **The shape this leaves open is measured, not claimed
> shut: T-S10-25**, gated at [88] R19j.
>
> **(b) What does the signature do about a `master_lookup` key extra, whose configuration can change
> without any formula text changing?** *Decided: the CONFIG is in the signature; the MASTER'S ROWS
> are not, and must never be.* `masterCfg` (`source`, `matchColumn`, `matchKey`, `returnKey`, and the
> legacy `masterRefColumn`/`masterValueColumn` pair) sits inside `_keyDefOf`, so re-pointing a lookup
> moves the signature and a day file written before the re-pointing is refused — which is the gap
> this ticket's last paragraph named as needing exactly this round. The accounts master's DATA is
> excluded on §14.3's own grounds: a colleague adding a nominal code changes what the key WOULD
> compute without changing the rule that minted it, the day file holds the minted key, and every
> surface in Reco is deliberately on it. Hashing those rows would make this a value comparison in
> disguise — round 6 by another route — and would refuse every gesture on every lookup-keyed template
> the first time anybody edited the master. **Both arms are measured in one fixture, [88] R19i**, and
> **[84] R15i** is kept unchanged as the cheapest tripwire on the second.
>
> **(c) Should the signature be shown anywhere?** *Decided: not as a value and not as a badge. Its
> one reader is its own refusal sentence.* A 16-hex hash is a string no operator can judge, which is
> T-S10-24's complaint about row keys in a confirm. A badge on the key cell would collide with
> `Reco.keyDrift`'s existing **⚠ recalculated**, which answers a different question (the cell is
> printing a recalculation) and would read as "the key is wrong" — and the key is exactly right for
> the file it came from. What the operator needs is the sentence at the moment of the refusal, so the
> signature arm has **its own**, and there are **three** branches of it chosen from the row's own
> data set id. The file branch reads: *"This row came back from a saved day file and its key was
> minted under a DIFFERENT row-key rule from the one in force now … Opening that day file again will
> keep bringing the old keys back — nothing re-keys a saved file. To record this against the row, use
> Clear Loaded Data and then load that day's EXTRACT again … Every day file this reconciliation
> wrote under the previous rule is read-only in the same way."*
>
> **THAT IS NOT THE SENTENCE THIS ANSWER ORIGINALLY QUOTED, AND THE TWO CLAIMS IT LOST ARE THE
> REVIEW'S FINDING.** The round-8 build's version said the file *"was **written before**"* the rule
> changed and added *"**Nobody has changed anything** while you had these rows open."* Neither is
> sayable: the direction is not knowable (a backup restore puts an OLDER rule back under a NEWER day
> file), and "nobody has changed anything" is reachable by the operator's **own** template save, over
> rows the upload minted in that window that no file ever handed back — which is exactly the claim
> round 7 deleted a sentence for. Both halves are asserted **ABSENT** from all three branches
> (**[88] R19u2**, and **R19f** on the live screen), so quoting them here as what the app says
> described a build that was corrected before it shipped. Each branch now says only what it can
> know, which is why each is true every time it is said.
>
> `Reco.keyDriftCount` is **left alone and still has no reader in the app**: it counts VALUE drift,
> not rule drift, so it is not this arm's counter and pretending it is would be the round-6
> conflation in a tidier form. **R15j** keeps it alive. **A SECOND READERLESS COUNTER WAS ADDED, AND
> SAYING OTHERWISE WAS WRONG:** `Reco.keyOldRuleCount(tpl, sess)` — how many rows on screen cannot
> be written — has no reader in the app either. It is the number a Clear-and-load decision wants and
> the toolbar does not show it yet; **T-S10-27** carries that, and **[88] R19x2** reads it beside the
> badge on a rendered screen so it cannot rot unmeasured.
>
> **THE MIGRATION, UNCHANGED AND NOT WIDENED:** a row with **no** signature is **not refused**
> ([88] R19k, and the causal half of R19e deletes a live row's signature on screen and watches the
> same door go through). An empty string counts as none, because Papa gives `''` for a
> present-but-empty column. A signature whose VERSION this build does not recognise also counts as
> none (**[88] R19n**), so a future change to what is hashed degrades to *"those rows are
> unprotected"* and never to *"the app is read-only"* — bumping `Reco.KEYSIG_VER` is itself a
> migration and has to be written down as one.
>
> **THE FORMAT CHANGE, SAID PLAINLY:** for a template whose key names an added column, every day
> file gains a `_pksig` column. The first write of the day by an updated build into a file that
> predates it takes **one** whole-file rewrite inside `append_csv_rows` (`header + missing`), which
> is the rewrite `Versioning._fields`'s own comment says can lose a colleague's concurrent append. It
> happens once per file. Both back-compat directions are measured at **[88] R19k** (this build on a
> pre-change CSV) and **[88] R19l** (the build on `55171d8`, run for real, on a CSV this build
> wrote: it loads every row, drops `_pksig` on the way in, appends with the column intact and blank,
> and this build reads that blank back as "no signature").
>
> **THE DISCLOSED COST:** a reopened day file now puts writable and unwritable rows on one screen, so
> an all-or-none control that writes EVERY row in the view — sheet mode's "↓ Fill Column", Find &
> Replace's "↻ Replace All" — is refused as a whole from a healthy cell. **[84] R15g is rewritten to
> assert that** and §15.6(b) is corrected with it. It is not round 6's cost: round 6 refused the view
> because one row's own DATA had moved, which **[86] R17b** still measures and which is still green.
>
> ---
>
> ## THE DESIGN AS IT STOOD WHEN THE ROUND STARTED — KEPT, BECAUSE IT IS THE ARGUMENT
>
> ## RE-OPENED. ROUND 6'S FIX IS REMOVED AND THIS IS WHY, AND WHAT TO BUILD INSTEAD.
>
> **Handover §18.12. The hole is measured, not hidden: `run_store_e2e` [84] R15d asserts that all
> ten doors GO THROUGH at a dead-keyed row, and R15e asserts POSITIVELY that records land under
> both identities on the share — so a future fix makes R15e fail and gets re-read.**
>
> **WHY THE ROUND-6 FIX WENT.** It asked, per row at the write, *"is `row._pk` still what this
> template's rule computes for this row NOW?"* and read a disagreement as *"the rule moved"*. That
> inference is **invalid**: a frozen `_pk` is **supposed** to disagree with a recompute whenever the
> **row's own data** changed, which is what freezing a key means (§14.3). So ordinary work read as
> drift. Five false refusals were measured on ONE window with the latch DOWN and nobody else
> involved, each now a named gate in `run_store_e2e` **[86]**:
>
> 1. **a correction of a key-feeding column** — §14's own worked shape, `CONCAT({Doc})` over a file
>    column, corrected through the Correction tab, which is what that tab is FOR — said **both**
>    *"Nothing was corrected…"* and a green *"Correction applied"*, wrote nothing to the share, left
>    the row changed on screen with `_corrected_Doc` set, and then **refused every later gesture on
>    that row** with a sentence blaming a colleague for a change nobody made. The recovery that
>    sentence names is where the correction actually died. **R17a / R17a2**;
> 2. the **second edit** of a row whose key-feeding *editable* column was edited — the row bricked
>    itself on first use. **R17e**;
> 3. a **partial recompute**: the skip only covered a recompute that was *wholly* `''` or `'#ERR'`,
>    so §14.4's own `CONCAT({Base},"-",{Line})` with one component missing from this month's file
>    recomputes to `'E1-'`, a POSITIVE disagreement, and refused everything. **R17c**;
> 4. a **key formula that reads the clock** (`AGEING`), which the template editor refuses on SAVE
>    and nothing re-checks when stored: not drifted today, drifted tomorrow, **for every row of that
>    template**. **R17d**;
> 5. **one bricked row refused "↻ Replace All" for an entire file**. **R17b**.
>
> **AND WHY A SIXTH SHAPE WAS ALWAYS GOING TO EXIST** — the point, not a footnote. The arm fires
> whenever a row's own data has moved since its key was minted, and **every feature of this app that
> edits a row does that**. Enumerating those features is the list this cluster has already failed at
> four times one level up. Three rounds in a row narrowed the arm and declared the cluster closed.
>
> ## THE REMEDY: THE KEY RULE'S SIGNATURE, RECORDED PER ROW AT MINT TIME
>
> **Why per-row drift is NOT a substitute for it, in one paragraph, because this is the third time
> this trap has been walked into.** A *value* comparison answers *"does this key still come out of
> today's data?"*, which is a question about the **DATA**. What this ticket needs answered is *"was
> this key minted by the rule that is in force now?"*, which is a question about the **RULE**. The
> two coincide only when nothing about the row has changed, and the whole application exists to
> change rows. A **signature** separates them: it cannot be moved by a correction, a cell edit, a
> fill, a replace, a carried value, a column this month's file does not carry, or the clock, so it
> has none of the five shapes above and no sixth one either.
>
> **The design, as far as it is decided:**
> - at mint time (`Reco._mintKeysSync`) compute a stable hash of the **key extras' definitions** —
>   for each name in `tpl.primaryKeys` that is an added column, its `type`, `formula`/`masterCfg`
>   and the transitive closure of the extras it references, in declaration order — and write it on
>   the row beside `_pk` as a control field (`_pksig`);
> - carry it through the day file's **control columns**, the same way `_pk` and `_ver` round-trip,
>   so a reopened row brings the signature the file was written with;
> - `Reco._keyWriteUnsafe` then asks: latch, **or** `row._pksig` present and **different** from the
>   template's signature now → refuse with the existing sentence;
> - **a row with NO signature is NOT refused.** Every row already on every share has none, and
>   refusing them would make the app read-only on the day it shipped. That is the migration, and it
>   means the fix only protects rows minted after it — which is honest and is the reason this is a
>   round of its own rather than a patch.
>
> **Open questions that belong to that round:** whether a template whose key names no added column
> needs a signature at all (it cannot drift, so probably not — and skipping it keeps the cost at one
> property read); what a signature should do about a `master_lookup` key extra, where the
> *configuration* can change without the formula text changing; and whether the signature should be
> shown anywhere, given that `Reco.keyDriftCount` — which names exactly these rows — has **no reader
> in the app at all** (only `run_store_e2e`, `run_pk_extras` G8 and the documents). `run_store_e2e`
> **R15j** keeps it alive so it is not tidied away before this round happens.
>
> **The size of what is open, measured against `999b936` by
> `scratchpad/dataloss/choke/probes/p3_r15.mjs`:** not
> one door and one file but **TEN doors, SIX of them in total silence**, reaching **all five**
> pk-keyed shared masters plus the day file. Measured against `999b936` by
> `scratchpad/dataloss/choke/probes/p3_r15.mjs` (`logs/p3_before.txt`): `extraValueMaster` gained
> `K1,K2,K3`, `correctionMaster` `K2`, `manualOffsetMaster` `K3`, `groupMaster` a membership
> `[K1]`, `commentMaster` a `linkedPks` `[K2]`, and the day file five `Cn` rows under `K1/K2/K3`
> — from `setTag`, `applyCorrection`, `manualOffset`, `editCell`, `createGroupFromSelection`,
> `Comments._confirmAdd`, sheet mode's **✓ Apply**, sheet mode's **↓ Fill Column**, sheet mode's
> **×** and the **fill-handle drag**. The two the earlier walk had not counted are sheet mode's
> and the drag's, which is the same gap T-S10-20 is about.
>
> **The remedy taken is the third of the three below** — *mark the rows and refuse the write* —
> because it is the only one that does not change a reopened row's identity behind the operator's
> back or lock a day's work out of the app, and because `Reco.keyDriftCount` already named exactly
> the affected rows. It is asked **per row at the write** (`Reco.writeKey` / `Reco.writeVerKey`,
> through `Reco._keyRowDrifted`) and **not** per session, so the healthy copy of the same business
> row, on the same screen, in the same template, still writes normally — which is R15g, and is the
> measurement that makes the per-row arm affordable. The template latch stays as the first arm,
> because it is one property read and because its sentence is the better one.
>
> **WHAT IS STILL OPEN, and it is narrower than what was closed.** The per-row arm only fires on
> a key component the ROW'S OWN LOADED COLUMNS decide — a `formula` whose transitive closure
> reads no shared master. Where a key extra is a `master_lookup`, a disagreement between the
> stored key and the recomputed one is §14.3's **frozen value working as designed**: the rule did
> not move, the day file holds the key and every surface in Reco is deliberately on it, so a guard
> there would refuse every gesture on every such template for the life of the file (measured,
> `choke/logs/p2_rule.txt` C4, and gated as **R15i** so the narrowing cannot be quietly widened).
> The consequence: on a lookup-keyed template, a day file written before the LOOKUP'S OWN CONFIG
> changed is still writable under its old keys. That needs the key-rule signature to be recorded
> per row at mint time, which is a schema change and a round of its own. Two further measured
> non-firings, both deliberate and both for the same reason — the disagreement cannot be
> attributed to the rule: a component containing the `'||'` separator (C5) and a key formula whose
> referenced column is not loaded (C6).

**Where** `apps/Reco.html` — `Reco.loadVersionedFile` hydrates each row with `_pk: r._pk` straight
out of `reco_data/<folder>/<MMM-YY>/<DD>.csv`. The day file is written by the upload that minted
those keys, so a file written before a colleague changed the key definition carries the OLD keys for
ever. `Reco._keyStale` cannot help: it is per window and it is about **this** window's refused save,
and this state is reachable with no refusal in the story at all — including by the colleague who
made the change.

**What** Measured, `scratchpad/dataloss/lift/probes/w4_dayfile.mjs` (port 21386,
`logs/w4_before.txt`), AFTER a correct recovery, i.e. with the latch down and every row on screen
keyed by the folder's rule:

| | measured |
|---|---|
| B uploads `K1/K2/K3`, A changes the key rule, B is refused | latch ON |
| B does what the refusal says — Clear Loaded Data, then load | rows `K1-X/K2-X/K3-X`, latch **OFF**, correctly |
| B presses **Open Existing** and reopens today's day file | rows `["K1","K2","K3","K1-X","K2-X","K3-X"]` — **three rows on screen carrying the old keys**, latch still off |
| B types into the `K1` row (`Reco.setTag`) | **nothing said**, and `reco/extraValueMaster.json` gains **`K1`** |
| what the screen shows for those rows' key cell | `K1`, `K2`, `K3` — the **frozen** value, so it looks ordinary |
| `Reco.keyDriftCount(tplId)` | **3** — the drift check already knows about exactly those three rows |

So the answer to "can a row that was on screen before the refusal be written under its dead key by
any gesture" was given as **no through any latched gesture while the latch is up** (sections [71],
[79], [80] measure twelve of them plus the Excel Apply and T-S10-18's four), and **yes by this
route**, which is not a latch hole: it is what a key change does to the files already on the share.

> **THAT SENTENCE WAS DOING LOAD-BEARING WORK NO READER WOULD NOTICE, AND IT WAS FALSE AS A COUNT.**
> *"any latched gesture"* is true of the eighteen gestures that were latched and says nothing about
> the ones that were not — and there were **eight** of those, four found with real mouse clicks and
> four found by enumerating the writers from the source. The question is now asked at the WRITE, so
> it can be answered without counting gestures at all: **no, through anything, because the key a
> write needs comes from `Reco.writeKey` / `Reco.writeVerKey` and they ask.** T-S10-20.

**Why it is only a ticket** It is the state **#24's own confirm warns about** when the key is
changed — *"Rows saved before this change will no longer match their version history, manual
offsets, corrections, groups, comments, and the values typed into added columns"* — so it is a
documented consequence rather than a new silence, and the three remedies are all bigger than this
round and pull against each other:

* **re-mint on load** changes every reopened row's identity behind the operator's back, which is the
  argument §18.8 gives for a latch rather than a re-mint in the first place, and it would detach the
  day file's rows from the records a colleague has filed under the old keys since;
* **refuse to open the file** locks a day's work out of the app over a key change somebody else
  made;
* **mark the rows and refuse the write** is the per-row latch §18.10 rejects — and it is the only
  one of the three that could be right here, because `Reco.keyDriftCount` shows the mechanism to
  carry the mark already exists (3 of 6 rows, with no extra pass).

Any of them needs its own measurement of what happens to the records already filed under both
schemes, which is the part no round has done.

**Fix** The one that fits the house rule ("a gesture asks the question when its key comes from a row
on screen and it writes a pk-keyed store the folder shares"): give the DRIFT check a write-side arm.
`Reco._keyFrozenPart` already compares the frozen component against the recomputed one per row, and
`Reco._noteKeyDrift` already counts the rows where they differ; a row whose key has drifted is
exactly a row whose `_pk` the folder's rule no longer computes, so the row-level writers can ask
**per row** rather than per session, with the same sentence and the existing verbs. That also closes
the case this ticket is about for a colleague who never saw a refusal.

**Test** `run_store_e2e` **[84]** (ports 21431) carries the outcome — the ten doors are now
asserted REFUSED (R15d), nothing reaches any of the five pk-keyed shared masters or the day file
under a dead key (R15e), the live copies beside them still work and file under the folder's own keys
(R15f/R15h), the all-or-none refusal is disclosed (R15g), a `master_lookup`-keyed template whose
master DATA moved is still writable (R15i) and `Reco.keyDriftCount` is the premise and not the
assertion (R15c/R15j). `run_store_e2e` **[88]** (ports 21482/21483) carries the ROUND TRIP and the
mechanism: the signature at every hop (R19a–R19d, read out of the CSV), the causal check that
deleting the row's `_pksig` makes the same door at the same row go through again (R19e), the
sentence (R19f), the control (R19g), the cost of all-or-none (R19h), question (b) in both
directions (R19i), question (a) plus the measurement of what it leaves open (R19j) and the cost as
an operation count (R19j2), both back-compat directions (R19k, R19l — the second against
`55171d8` for real), that a save outside the key rule does not move the signature (R19m) and that
an unknown signature version is treated as absent (R19n).

**The original plan for this test was `w4_dayfile.mjs` as a section of its own, and it is worth
saying why it is not that.** The reproduction it describes is already [84]'s fixture
(`R15_SETUP` → `R15_A_KEY` → `R15_RELOAD` → `R15_REOPEN` → `R15_WALK`), and round 7 pointed it at
the open hole. Writing a second fixture for the same screen would have given two screens that could
drift apart, so [84] was rewritten in place and [88] reuses its template id, rows and key change
deliberately.


---

## T-S10-20  ~~Four live controls still write under a dead row key, because the fix was a list of controls and not a rule~~  **FIXED** in round 6 — the question is asked at the WRITE, and a gate enumerates the writers

> **ROUND 7 (T-S10-21, handover §18.12): THE CHOKEPOINT STANDS AND IS KEPT. What was built on top
> of it did not.** An adversarial attack found a **twenty-second door** this ticket's own
> enumeration could not see — `Reco.openSpecialJv`'s completion callback writing row keys into
> `reco/pendingSpecialJV.json`, a `PERSIST_KEYS` whole-file write — because `pendingSpecialJV` was
> **not one of the six masters [82] enumerated**, and because the six-master list's *exclusions had
> never been written down*. [82] now carries a `STORES` table covering every `PERSIST_KEYS` member
> and every `reco/*.json` the app writes, including the ones that hold no row keys and why, and
> **G82j/G82k read that list out of the source** so a new shared store fails the section until
> somebody answers for it. The attack also **blinded [82] eleven ways** with all eight assertions
> green and **crashed** it with a write at column 0, taking [83]/[84]/[85] down with no tally; all
> of that is fixed or admitted in §18.12, the enumeration reads **71 sites in 49 functions**, and
> the section has 16 checks. The per-row arm this ticket's part 2 describes is **REMOVED** — see
> **T-S10-21** and the re-opened **T-S10-19**.
>
> **CLOSED. Handover §18.11. Gates `run_store_e2e` [82] (the static enumeration, G82a–G82h), [83]
> (R14a–R14i, sheet mode and the Excel view by real clicks) and [84] (R15a–R15j, T-S10-19).**
> `run_store_e2e` 638 → **672** (two clean readings). Six mutations, each reversing ONE change
> through `APP_FILE` with `apps/Reco.html` never written: the sheet-mode buttons redden G82a/G82c/
> R14a/R14b and T-S10-19's walk; the per-row arm reddens only the T-S10-19 assertions and the
> question counter, and **nothing in [83]**, which is the measurement that separates the two arms;
> the §14.3 narrowing reddens **R15i only**; the `×` door reddens R14c; the `applyEdits` chokepoint
> reddens R14e; and **a new button that writes `manualOffsetMaster` without asking reddens G82a and
> nothing else** — 672 behavioural checks cannot see it and the enumeration can.

**Where** `apps/Reco.html`. **THE DEFECT IS NOT THE FOUR CONTROLS. IT IS THAT THE LIST KEPT
GROWING** — round 1 latched 3 doors, round 2 added 7 and claimed closed, round 3 added 5 and
claimed closed, round 4's verifier walked gestures with real mouse clicks and found 4 more still
open, and this round's own static enumeration found 4 that no human walk had named:

| control | what it said | what reached the share |
|---|---|---|
| sheet mode **✓ Apply** (`Reco._ssCommit(false)`) | **nothing at all** | a version row in the shared day CSV: `E2,C1,…,BTN-APPLY,20` |
| sheet mode **↓ Fill Column** (`Reco._ssCommit(true)`) | green *"Applied to 3 row(s)"* | three version rows under `E1/E2/E3` |
| the sheet-mode **fill-handle drag** (`Reco._ssCommitFill`) | green *"Filled 2 cells"* | `reco/extraValueMaster.json` gained `E2` and `E3` |
| the **in-app Excel view's cell edit** (`Reco._xlOnChange` → `_xlApply`) | **nothing at all** | `E3.Vendor = "REAL-KEYS-EXCEL-VIEW"` while the folder's rule computes `E3-X`; the colleague reads blank |
| sheet mode **×** / Delete (`Reco._ssClearActive`) | **nothing at all** | `E3,C2,…` — **found by the enumeration, not by a walk** |
| **Find & Replace**, single and bulk (`FindReplace._replaceOne` / `_replaceAll`) | green *"Replaced N cell(s)"* | one version row per touched key — **enumeration** |
| the **journal post's stamp** (`Reco.commitEntryFromPreview`) | the entry posts green | a version row per stamped row **and `entry.postedPks`** into `reco/entryHistory.json`, so no colleague can resolve the entry to its rows — **enumeration** |
| **"Unmark Entire Groups"** (`Reco._unmarkBlockedGroups`) | green *"Unmarked N row(s) from blocked groups"* | deletes `manualOffsetMaster` records under dead keys — **enumeration** |
| the group panel's **single-row remove** (`Reco.removeMemberFromGroup`) | green *"Removed from group"* | `smartUnmark`'s shape: deletes the membership filed while the key was right — **enumeration** |

Reproduced on `999b936` before anything was touched:
`scratchpad/dataloss/choke/probes/p1_doors.mjs`, port 21420, `logs/p1_before.txt` — five of five
doors through, three driven by real clicks on the buttons and real keystrokes.

**Why the list could never close** The rule was written down (at `Reco._keyStale`: *a gesture asks
when its key comes from a ROW ON SCREEN and it writes a pk-keyed store the folder shares*) and then
**applied by hand, control by control**. The comment even claimed *"so the next writer is covered
without being listed"*, which is the sentence that stops the next engineer looking. Meanwhile the
suite had 638 green checks and could not see any of it, because **every assertion named a function
somebody remembered**.

**Fix, in three parts**

1. **THE CHOKEPOINT.** Enumerated from the code: 58 write sites in 44 functions, funnelling through
   `Reco.applyEdits` (the store and the override), `Versioning.appendChangesBatch` (the day file)
   and plain assignment into the five remaining masters. There is no single function — but every
   one of the 58 does one thing: **a ROW becomes a KEY in order to write.** That step is now a
   function: `Reco.writeKey(tpl, sess, row, verb)` for a master and
   `Reco.writeVerKey(tpl, sess, row, verb)` for a day-file version row, both asking
   `Reco._keyWriteUnsafe`, both saying the refusal with the caller's verb, both returning `null` —
   which every call site already handled, because the write was already guarded by `if (pk)`.
   `Reco.applyEdits` asks once per edit and puts the refusal in `res.rejected`.
   **NOT inside `Reco.rowKey`**: it is a key READER on every render path, it cannot carry a verb
   and it runs once per row per paint. Gated by **G82g** so it cannot be moved there later.
   The gesture-level `Reco._keyStaleBlock` is kept on top, because that is where the verb and the
   whole selection are and so the refusal is one sentence and all-or-none.
2. **THE RULE IS ABOUT THE ROW** (`Reco._keyRowDrifted`), which is what closes **T-S10-19** as well,
   with the three measured false positives left out — see that ticket and §18.11's table.
3. **THE GATE THAT CANNOT GO STALE** — `run_store_e2e` **[82]**: it reads `apps/Reco.html`,
   enumerates the writers itself and fails on a write that is neither guarded nor allow-listed with
   a reason, naming the file, the line, the master and what to do. The allow-list is the pressure
   valve, a **stale** allow-list entry fails too (G82h), and the gate self-tests that it still finds
   the writes and that the twenty-one known doors are still both found and guarded (G82b/G82c/G82d).

**Failing first** With the gates in and no app change (`APP_FILE=999b936`): **13 of the new
assertions red, every pre-existing assertion green** (`choke/logs/store_failfirst.txt`). The green
ones are the premises and the Clear-and-Load controls. **After: 669 passed, 0 failed.**

**One defect the fix introduced, and the suite caught it within the hour.** The refusal is said once
per gesture rather than once per row; the first build cleared that flag one **task** later, and two
gestures of the same action in succession are separated by an `await` and not by a task — so the
second was refused **in total silence** ([80] R12e and R12k, red). It is cleared on a **microtask**
now. A silent refusal arriving by the back door of its own fix is exactly this cluster's shape.

---

## T-S10-21  ~~The dead-key guard refuses ORDINARY WORK and destroys it; a refusal leaves the row already mutated; and the Special JV send writes row keys into a shared file with no guard at all~~  **FIXED** in round 7 — the per-row drift arm is removed, the ask moves above the mutation, and door 22 is closed

> **CLOSED. Handover §18.12. Gates `run_store_e2e` [82] (16 checks, the static enumeration and the
> ask-first order), [84] (the re-opened T-S10-19 measured rather than claimed shut), [85] (the cost,
> now zero recomputes), [86] (R17a/R17a2/R17b/R17c/R17d/R17e — the five shapes), [87]
> (R18/R18a/R18a2/R18b/R18c — the unchanged row, and door 22).**
> `run_store_e2e` 672 → **694**. Failing first through `APP_FILE=5c1fb25`: **678 passed, 16
> failed** (`scratchpad/dataloss/unbrick/logs/FAILFIRST_store.txt`). 44 mutant files graded through
> the real [82]: **44 red, the tree the only green**
> (`scratchpad/dataloss/unbrick/logs/G82_MUTATION.txt`).

**Where** `apps/Reco.html`, `tests/e2e/run_store_e2e.mjs`. **Found by** an adversarial attack on
round 6 (`scratchpad/dataloss/recovered/ATTACK.json`), which measured all three of its claims true.

### PART 1 — THE PER-ROW DRIFT ARM WAS INVALID, NOT MERELY TOO WIDE

`Reco._keyRowDrifted` asked *"is `row._pk` still what this template's rule computes for this row
NOW?"* and treated a disagreement as *"the template's rule moved"*. A frozen `_pk` is **supposed**
to disagree with a recompute whenever the **row's own data** changed — §14.3 — so ordinary work read
as drift. Five measured false refusals, one window, latch DOWN, nobody else involved: a correction
of a key-feeding column **bricked the row** (and said both *"Nothing was corrected…"* and a green
*"Correction applied"*, with nothing on the share); the second edit of a row whose key-feeding
editable column was edited; a **partial** recompute, which the documented C6 non-firing never
covered; a stored key formula that reads the clock, drifted tomorrow for every row; and one bricked
row refusing "↻ Replace All" for an entire file. All five are gates in **[86]**, and a sixth shape
was always going to exist because every feature that edits a row produces the disagreement.

**`Reco._keyWriteUnsafe` now asks the TEMPLATE LATCH only.** The latch's question — *did the key
DEFINITION change while these rows were loaded?* — is a property of the template and cannot be
confused with a row's data changing. **[82] G82f is the inverse of what it was** and fails if a
per-row recompute comes back. **T-S10-19 was RE-OPENED here and is CLOSED in round 8** by the
key-rule-signature design this round wrote onto it — and G82f did **not** have to be turned round to
let it in, because a signature comparison reads no cell and calls no formula engine. G82f now
*also* asserts the signature arm positively, so removing it is a red check rather than a silent
loss.

### PART 2 — MUTATE-THEN-ASK

`Reco.applyCorrection` wrote `row[colName] = newVal` and **then** asked, so a refusal left the row
mutated, `_corrected_<col>` set, the changed value published in `reco/recoSessions.json` by
`AppState.save()`, **no record anywhere**, and two toasts — one green, one red. Find & Replace had
the same order. **Fixed at all eleven sites** through the new `Reco._keyAsk(tpl, sess, row, verb)`,
which exists because `Reco.writeKey` answers `null` both for *refused* and for *this template has no
business key*. `_replaceAll` is now **plan → ask → mutate**, all-or-none. **[82] G82m** pins the
ORDER in the source — each site's own ask, nearest-above, within fourteen lines (mutation-tested:
`m21_mutate_first`, `m23_sscommit_order`) — and **[87] R18a/R18a2/R18b** assert the row is UNCHANGED
after a refusal, on screen and in the file on the share.

**`_replaceAll`'s all-or-none: decided.** With the per-row arm gone, *unsafe* is a property of the
template, so a per-row skip could only skip all rows or none. All-or-none is kept and **§15.6 is
corrected**, because what it disclosed was the per-row cost — which no longer exists — and it never
mentioned Find & Replace.

### PART 3 — DOOR 22

`Reco.openSpecialJv`'s completion callback wrote `primaryKeys` / `sentPks` — row keys off the rows on
screen — into `AppState.pendingSpecialJV`, a `PERSIST_KEYS` **whole-file** write of
`reco/pendingSpecialJV.json` that every colleague parses at boot. Latch UP, in a window that had just
been refused a template save: it said only `success: Special JV "TCHX" completed` and the share gained
`["E1","E2"]` while the folder's rule computed `E1-X`/`E2-X`. **That is the double post this cluster
exists to stop**: no colleague's row matches the pending entry, so rows whose JV has been raised look
un-sent to everybody and can be sent and posted again. Closed at the gesture (before `SpecialJV.open`,
because being told after the operator has keyed a JV elsewhere is too late) **and** at the write,
through `Reco.writeVerKey`, all-or-none. Gate **[87] R18c**.

**AND THE SIX-MASTER LIST WAS NOT THE SET OF SHARED PK-KEYED STORES.** [82] now carries a `STORES`
table answering for every `PERSIST_KEYS` member and every `reco/*.json`, **with a reason per entry
including the exclusions**; **G82j/G82k** read both lists out of the source, **G82l** fails on an
entry with no reasoning. Nineteen entries, eleven of which hold row keys. `reco/reversals.log.*` and
the Excel-link manifest are the two new ones that hold keys and are allow-listed with reasons;
`docNumberMaster` was checked against the code rather than assumed.

### PART 4 — THE STATIC GATE WAS BLIND ELEVEN WAYS AND COULD CRASH THE SUITE

Fixed: the master taken without a subscript (which ran the full suite at 672/0 with the gate still
printing "58 write site(s)"); `name: function (…) {` and `name: (…) => {`; a `/* comment */` at the
start of a write line; the **crash** on a write at column 0 (which killed the run with no tally and
stopped [83]/[84]/[85] executing — now a named G82a failure, plus a **G82z** catch so a defect in the
detector can never take the suite down again); a `function` declaration credited to a method 10,708
lines above it (declarations recognised, bodies end at their **braces**, and **G82n** fails on an
implausible body); a computed master name; an object-literal alias; a `Versioning` alias; a write
built as a string (**every** `new Function`/`eval` is now a site); the allow-list matched on a NAME
and per FUNCTION (**G82i** pins each entry's write-site census); and the self-tests that did not stop
a class going dark (**G82b** floor raised, **G82d** a floor **per store**, **G82c** all 22 guarded
writers, **G82q** fails if the list falls behind the code). **Partly fixed and admitted:** the dead
`if (false)` guard — those blocks are stripped, any other unreachable guard call still counts.
**T-S10-22** carries what only a parse can do.

### What this round did NOT change

The chokepoint (`Reco.writeKey` / `Reco.writeVerKey` / `Reco.applyEdits`'s per-edit question), the
template latch and its two-direction lift, the refusal sentence for the latch, and the allow-list's
reasons. The **drifted** sentence is removed rather than left as a dead branch: a refusal sentence
nothing can produce is a promise of a safety control that does not exist.

---

## T-S10-22  The static write-site gate is a text gate, so it cannot see reachability or a master passed as a parameter

**Where** `tests/e2e/run_store_e2e.mjs` section [82]. **Filed by** round 7 (T-S10-21, handover
§18.12) in place of papering over two limits that a text gate cannot honestly close.

**The two holes, both measured:**

1. **REACHABILITY.** `GUARD` is a text test over the function body, so a guard call that cannot run
   still satisfies it. The measured shape — `if (false) { Reco.writeKey(...) }` beside an unguarded
   write — is now stripped out of the body before the test, together with `if (0)` and `if (!1)`.
   That is the shape, not the class: a guard call behind any other false condition, on a **different
   row**, inside a branch the write never takes, or after an early `return`, still counts. A dead
   call, a commented-out-then-restored call and a call on another row all pass.
2. **A MASTER PASSED AS A PARAMETER.** `Reco._unmarkRows(tpl, sess, mm, rows)` receives the offset
   master as an argument and writes through it; the alias (`const mm = AppState.manualOffsetMaster…`)
   is declared in the **caller**, so the enumeration attributes the write to the caller and cannot
   see the helper's own write at all. There is exactly one such helper in the tree today and it is
   pinned **by name** in **G82m** — which is a list of names, in a section whose whole purpose is not
   to be one, and that is said out loud at the top of [82].

**Why a regex cannot close either** Both need the shape of the program, not the shape of the text:
(1) is a control-flow question and (2) is a data-flow question. Every other blind shape the attack
found was a *lexical* gap and all of them are fixed; these two are not lexical.

**The fix, when somebody takes it** Parse `apps/Reco.html`'s script islands with a real JS parser
(acorn or the platform's own, in a dev-only dependency the suite can load the way it loads
playwright), walk the AST for assignments into the shared stores and for calls into the enumerated
helpers, resolve the enclosing **function node** rather than the nearest preceding definition line,
and answer the guard question from the function's control-flow graph: *is there a path from the
function's entry to this write that does not pass a guard call about this row?* Positional
data-flow then closes (2) for free, because a parameter's binding is in the AST.

**What this does NOT block** The gate is a **detector, not a safety mechanism** — the safety
mechanism is the chokepoint, which a gesture cannot get a key without going through — so these two
holes let a *detector* miss a write, not a write reach the share unguarded. That is why this is a
ticket and not a blocker. **What it does mean:** nobody should read [82] green as proof that a
guard call is reachable.

**Gate when it is done** The existing 44-mutant grading harness
(`scratchpad/dataloss/unbrick/gates/`) plus two new mutants: a guard call behind a condition that is
false for other reasons, and a master written through a parameter in a new helper.

---

## T-S10-23  A backup restores typed values WITHOUT the template whose rule minted their keys

**Where** `apps/Reco.html` `App.importBackup` — the acceptance test at line 11664
(`!(d.recoTemplates || d.aegTemplates || d.recoSessions || d.templates)`) and the eighteen
INDEPENDENTLY CONDITIONAL assignments below it (`if (d.recoTemplates) …`,
`if (d.extraValueMaster) {…}`, and sixteen more).

**What** The acceptance test needs only **one** of four keys, and every restore is its own `if`.
So a backup carrying `recoSessions` + `extraValueMaster` but **no** `recoTemplates` is accepted,
restores the typed values, and leaves the LIVE template in place — and the live template's key rule
is not the one that minted those keys. Every record then sits under a key the current rule does not
compute: filed where no colleague reads it, and where this operator's own next load will not find
it. It is T-S10-19's harm reached through the restore door instead of through a day file, and
nothing refuses it because `importBackup` is one of the two paths deliberately **allow-listed** out
of the dead-key chokepoint (§18.11) — on the reasoning that *"refusing would make a backup
unrestorable on the day it is needed"*, which is right for a WHOLE backup and does not hold for a
partial one.

> **Round 8 note.** A partial restore now has a cheaper honest answer than it had, and it is
> narrower than it looks. The restored rows carry whatever `_pksig` the backup holds, so a restore
> bringing `recoSessions` without `recoTemplates` leaves rows whose signature is not the live
> template's — and the write guard already refuses those, per row, with the file-older-than-the-rule
> sentence. **Three things are still wrong with that**, which is why this stays open: the refusal
> arrives one gesture too late, at the first write rather than at the restore, where the operator
> has already been told it worked; it says *"a saved day file"*, which is not what happened; and it
> does nothing at all for a backup written before round 8, whose rows carry no signature. The fix
> is still a decision about what a PARTIAL backup means, taken at `importBackup`.

**Found by** the round 7 adversarial attack (handover §18.12, `stillWrong`), which measured the
allow-list reason and found this hole in it. **Filed late**, in the pending-work sweep after it:
the attack reported it and no round wrote it down, which is the failure this file exists to
prevent.

**Why it is only a ticket** The fix is a decision about what a PARTIAL backup means, not a patch.
Three shapes are defensible and they are not equivalent: refuse a backup that carries pk-keyed
records without the templates that key them; accept it and **say** which templates' records are now
keyed by a rule that is not on this folder; or restore the records and raise the key latch for the
templates involved, so the next gesture is refused with the sentence that already exists. The third
is closest to the rest of the design and the most intrusive. `importBackup` is also wholesale BY
DESIGN (T-C27-6) and its confirm says so, so the sentence has to be written carefully or it reads
as a contradiction.

**Fix** Before the assignments, compare the pk-keyed payload against the templates in the file:
for every `tplId` present in `extraValueMaster` / `correctionMaster` / `manualOffsetMaster` /
`groupMaster` / `commentMaster` / `attachmentMaster`, is `d.recoTemplates` carrying that template,
and does its key definition (`RecoTemplate._keyDefOf`, which already exists for T-24R2-1) match the
one on the folder? Name the templates that fail in the confirm — the confirm already counts the
typed values, so this is a clause, not a new dialog.

**Test** A backup containing `recoSessions` and `extraValueMaster` for `TPL_X` but no
`recoTemplates`, restored over a folder whose `TPL_X` key definition has since changed: assert the
confirm NAMES `TPL_X`, and assert on the FILES afterwards — either nothing was restored, or the
records are there and the next gesture on an affected row is refused with the key sentence. Control:
a WHOLE backup (templates included) restores silently and every gesture works, because that is the
case the allow-list exists for.

---

## T-S10-24  The replay confirm lists row keys it cannot vouch for

**Where** `apps/Reco.html` `App._replayJournal` (~line 11333) and the confirm it builds, whose
lines read `<template> · <pk> / <col> = "<value>"`.

**What** The owed-write journal (T-S10-9) holds values typed while the shared folder was down, on
this PC, and offers them back at the next boot. The confirm names the **key** in every line, which
is right. What it does not say is that the key may no longer be the key this reconciliation
computes — because somebody can have changed the key definition between the typing and the boot. So
the operator presses Yes on a list of key strings they have **no way to judge**, and an accepted
replay writes them to the share under the old rule's keys.

`App._replayJournal` is the other path deliberately **allow-listed** out of the dead-key chokepoint
(§18.11), and that reason is sound as far as it goes: refusing would discard work the operator was
told was saved, and the replay runs inside the flush where T-S10-17 forbids waiting and a toast is
addressed to nobody. The gap is not the writing — it is that the one dialog which CAN ask a person
does not give them the fact they would need.

**Found by** the round 7 attack (handover §18.12, `stillWrong`), which also corrected an earlier
round's claim that the confirm does not name the key at all — it does. **Filed late**, in the
pending-work sweep.

**Why it is only a ticket** It needed the same thing T-S10-19 needed and for the same reason: to
say "this key was minted by a rule that is no longer in force" you must know which rule minted it,
and a value comparison cannot tell you (§14.3 — a frozen key is *supposed* to disagree with a
recompute once the row's data has changed, which is why round 6's per-row arm was removed in round
7). **Round 8 built that signature** (`Reco.keyRuleSig`, handover §19), so this is now one clause in
an existing dialog rather than a schema round — and it stays a ticket only because the journal's own
shape has to carry it. Without it the honest version is a general warning on every replay, which
trains people to click through.

**Fix** With T-S10-19's signature, which now exists: stamp `Reco.keyRuleSig(tpl)` onto each journal
entry when it is buffered — the same string the mint already writes onto the row — compare it with
`Reco._keySigMoved`'s own test at replay, and name the affected lines in the confirm. A journal
entry buffered before this change has none, and an absent signature means "not flagged", exactly as
it means "not refused" at the write. That is a change to the journal's own shape, which is local to this PC and
needs no schema round — it is the one place a signature can be added without touching the day file.

**Test** Type a value with the folder down; change the template's key definition; boot: assert the
confirm NAMES that line as keyed by a rule that has changed, and assert the FILES afterwards match
whichever answer the operator gave. Control: with no key change between the typing and the boot,
the confirm says nothing extra and the replay lands exactly as it does today
(`run_store_e2e` [73]/[74] already hold that path).


---

## T-S10-25  A key that names NO ADDED COLUMN gets no signature, so a day file written before its `primaryKeys` LIST was edited is still writable under the old keys

**Where** `apps/Reco.html` — `Reco.keyRuleSig` returns `null` when `Reco._keyExtraSet(tpl)` is null,
i.e. when no component of `primaryKeys` is an added column. Nothing is then stamped on the row by
`Reco._mintKeysSync`, `Versioning._fields` adds no `_pksig` column, and `Reco._keySigMoved` answers
false for every row of that template for ever.

**What** Measured, `run_store_e2e` **[88] R19j** (and `scratchpad/pksig/build/logs/store.txt`): a
template keyed `primaryKeys: ['Doc']` on three rows `P1/P2/P3`; the day file's header is
`_pk,_ver,_ts,_src,_by,Doc,Line,Amount` with no signature column and `row._pksig` is `undefined`;
`primaryKeys` is then edited to `['Doc','Line']`, which re-keys every row to `P1||L1` and fires the
definition-change confirm; after Clear Loaded Data and **Open Existing** on that day file the rows
come back as `P1/P2/P3` and `Reco.setTag` on `P1` **goes through**, filing
`reco/extraValueMaster.json` → `P1` → `Vendor` under a key the folder's rule no longer computes.
This is T-S10-19's harm exactly, on the one template shape round 8 declined to cover.

**Why it is only a ticket** Round 8's reason for declining it is cost and blast radius, and it is
written out on T-S10-19 under question (a). In short: `Versioning._fields` reads the same answer, so
a signature here widens the day-file header of **every template that existed before #24** — every
template on the folder today — and that file is pinned byte-for-byte by `run_pk_extras` **G1**, the
acceptance bar for "#24's migration is a no-op", and asserted verbatim by `run_e2e`,
`run_autoload`, `run_colorder` [13] and `run_reverse`. The harm is also the LOUD one rather than
T-S10-19's silent one: editing `primaryKeys` fires the definition-change confirm, raises the latch
for every window that has rows loaded, and marks every exported workbook stale, where a key extra's
`formula`/`masterCfg` moving left `primaryKeys` byte-identical and said nothing. So it is a smaller
hole than the one that was closed, reached only by a change the operator has already been warned
about, and closing it costs a format change to 100% of the folder's files instead of to the
templates that can drift silently.

**Fix** Two shapes, and the choice is the point of the ticket.
1. **Widen unconditionally** — drop the `_keyExtraSet` test from `Reco.keyRuleSig`, so `_keyDefOf`'s
   `pk` array alone produces a signature. Four assertions in three suites nobody may weaken then
   have to be re-read as declared differences, exactly as `run_pk_extras` G1 already handles #26's
   one declared insertion. That is the honest version and it is a round of its own, because "the
   migration is a no-op" stops being true for every template in the folder.
2. **Carry it beside the file rather than in it** — a per-day sidecar
   (`reco_data/<folder>/<MMM-YY>/<DD>.sig`) holding one signature per `_pk`, written by the same
   two record builds and read by `loadVersionedFile`. No header changes, so nothing is re-read; the
   cost is a second file per day that can go missing, and a missing sidecar has to mean "no
   signature" — which is the migration rule again and is therefore consistent.

**Test** `[88] R19j`'s own fixture, with its last assertion inverted: after the `primaryKeys` list
edit and the reopen, `Reco.setTag` on `P1` is REFUSED with the file-older-than-the-rule sentence and
`reco/extraValueMaster.json` gains nothing under `P1`. Controls that must stay green with it: the
day-file header assertions in `run_e2e`, `run_autoload`, `run_colorder` [13] and `run_reverse`, and
`run_pk_extras` G1's byte-identical day file — whichever of those a chosen fix changes must be
re-read and declared, never moved.

---

## T-S10-26  `App.importBackup` replaces every template with no key-definition comparison and no confirm, and the refusal then points at the wrong artefact

**Where** `apps/Reco.html` `App.importBackup` — `if (d.recoTemplates) AppState.recoTemplates = d.recoTemplates;`
— against `RecoTemplate.saveTemplate`'s key-definition confirm, which this path does not have.

**What** The restore confirm lists templates, sessions, masters and entry history and says **nothing
about row keys**. `reco_data`'s day files are not in the backup and are not replaced. So restoring a
backup taken BEFORE a legitimate key-rule edit puts the OLD rule back under day files written AFTER
it, and every row in them is then refused. Round 8's review pass fixed the half of this that is a
lie — the sentence no longer claims the file was *"written before"* the rule changed, because it
cannot know the direction — but the restore still moves the rule silently.

**Why it is only a ticket** Measured as a **code-reading claim only**: skA could not drive the file
input's `FileReader` from the probe harness, so the direction was reasoned from the source and not
run. It also needs a decision this round did not have the room for: `importBackup` replaces ALL
templates, so the comparison is a loop and the confirm has to summarise *"N reconciliations' row-key
rules differ from the folder's"* without becoming a wall of text.

**Fix** Run `RecoTemplate._keyDefMoved(folder's template, backup's template)` for each id present in
both and name the result in the restore confirm. The coarse `_keyDefOf` is the **right** definition
here, for §19.2's reason: this is a warning.

**Test** A restore whose backup holds a template whose key definition differs: the confirm names it,
and declining leaves `AppState.recoTemplates` untouched.

---

## T-S10-27  A screen that is partly read-only says so per row but not as a number, and cannot be filtered

**Where** `apps/Reco.html` — the `⊘ older rule` badge in the row's status cell and
`Reco.keyOldRuleCount(tpl, sess)`, which exists and has **no reader in the app**.

**What** After a key-rule change a reopened day file plus **Add Data** puts refused and writable rows
on one screen. Round 8's review pass made each refused row visible before the gesture, which was the
blocker half. What is missing is the toolbar count and a *"show only rows from an older rule"*
filter, so a Clear-and-load decision can be made on a number rather than by scrolling.

**Why it is only a ticket** The function is there and measured (**[88] R19x**); a toolbar surface and
a filter are UI work with their own byte-diff exposure (`run_colorder` T1 diffs the `<tbody>`), and
the finding that mattered — *"nothing on screen tells them apart"* — is closed.

**Fix** Read `Reco.keyOldRuleCount` into the reconciliation toolbar in the shape `keyDriftCount`
would have used, and add the filter beside the existing ones.

**Test** Three refused and three writable rows on one screen: the toolbar reads 3, the filter shows
exactly those three, and `keyDriftCount` still reads 0 (it answers a different question).

---

## T-S10-28  ~~`append_csv_rows`' widening branch is not cross-process safe~~  **FIXED** — both branches hold the OS's lock on the file

> **FIXED.** `LauncherAPI.append_csv_rows` now holds a cross-process advisory
> lock (`main._cross_process_lock`, `flock` on POSIX / `LockFile` on Windows,
> on one file per path under `ROOT/.locks/`) across **both** branches — the
> `header + missing` whole-file rewrite AND the plain append, because two
> processes appending with `open(..., "a")` can interleave and because the
> header read has to see the same file the append lands in.
>
> **MEASURED, the test this ticket asked for.** `scratchpad/bridge/probes/`
> `p1_csvrace.py` (this ticket's own `b3_race.py`, unchanged in substance): a
> 30,000-row pre-change day file, this build appending a signed row, a
> colleague appending 0.00 / 0.15 / 0.40 / 0.80 s into the rewrite. **Before:**
> `B_LOST: true` at 0.00 and 0.15, 30,001 rows where 30,002 were written, both
> writers reporting success. **After: `B_LOST: false` at every timing**, which
> is what this ticket's Test paragraph demanded. In pytest, cross-process, as
> `test_a_colleagues_append_survives_the_widening_rewrite` — which **fails three
> times out of three on the build before this round**, naming both writers'
> success and the missing row. (It needed a barrier and a 60,000-row file: at
> 4,000 rows the rewrite finished inside the two processes' own startup jitter
> and the test passed on the broken code, which is worse than no test.)
>
> **WHAT IS STILL TRUE, AND IS WHY ROUND 8's B1 GUARD STAYS.** The lock only
> helps where BOTH writers have it. An un-upgraded build's `append_csv_rows`
> takes no lock, so its append can still land inside an upgraded build's
> widening rewrite and be lost — and a mixed fleet is the normal state
> (T-S10-12). So `Versioning._appendRows` goes on refusing to widen a day file
> it did not create, and **[88] R19k2 / R19w** go on gating that. The guard
> comes off when the fleet is uniform, which is a fact about a deployment that
> no code can assert. Handover §14.5, §20.
>
> **AND ONE CLAIM THIS TICKET MADE WAS WRONG, corrected by the cleanup round
> before this one:** history compaction is **not** an instance of this hazard.
> It does not use `append_csv_rows` at all — `Versioning.compactFile` calls
> `Versioning.writeFile`, one atomic whole-file write — so the measured loss
> window here (a rewrite with a concurrent APPEND landing in the middle of it)
> is not its shape. It is now also locked, like every other `write_file`.


**Where** `main.py:683` — the `missing` branch of `LauncherAPI.append_csv_rows`, which rewrites the
whole file; and `main.py:243` `_writing`, which is a per-path lock **inside one process**.

**What** MEASURED, two separate python processes against one 7.7 MB day file: writer A takes the
widening rewrite, writer B appends 0.00 / 0.15 / 0.40 s into it, **both report success, and B's row
is not in the file**. At 0.80 s, past the end of the 672 ms rewrite, both survive. Two windows are
two processes, so the lock does not see it. `Versioning._fields`' own comment has warned about this
rewrite for rounds; nothing had ever made it happen until T-S10-19 added a sixth control column, and
round 8's review pass stopped asking for the widening rather than fixing the rewrite. **The hazard
is still there for anything else that widens a day file through `append_csv_rows`** — the Excel-link
write that comment names.

**AND THE CLEANUP ROUND CORRECTED ONE CLAIM THIS TICKET MADE: HISTORY COMPACTION IS NOT AN INSTANCE
OF IT.** The line this paragraph used to cite (`Reco.html:5268`) was a stale number that pointed at
`Versioning.collapseToActive`, and the function it meant, `Versioning.compactFile`, does **not** go
through `append_csv_rows` at all — it calls `Versioning.writeFile`, which is one atomic whole-file
`write_file`. So this ticket's measured loss window (a rewrite with a concurrent APPEND landing in
the middle of it) is not the compaction's shape. Compaction does rewrite a whole day file and will
drop a colleague's append that lands during it, which is inherent to compacting and is why it is a
deliberate operator action on one named file with an archive option — a different ticket if anybody
wants it, not this one. What the cleanup round DID find on that path is fixed: compaction widens a
pre-`_pksig` day file (safely), and `Versioning._hdrCache` was not following it, so the next append
stripped the signature off a row. Handover §14.5, §19.9, **[88] R19z**.

**Why it is only a ticket** `main.py` is outside the set of files that round was allowed to edit, and
routing around it inside `apps/Reco.html` was both available and cheap.

**Fix** A lock file beside the CSV, or write-then-verify-then-retry, in the widening branch. Then
`Versioning._appendRows` could widen again and the mixed-fleet rows would stay signed.

**Test** `scratchpad/pksig/skB/probes/b3_race.py` as it stands — it already measures the loss and
already has the 0.80 s control that shows the window is the rewrite. It must read `B_LOST: false` at
every timing.

---

## T-S10-29  The signature costs 30 bytes a row on `recoSessions.json`, which is the slowest shared write in the product

**Where** `apps/Reco.html` `Store.serialize('recoSessions')` and the mint's `row._pksig` stamp.

**What** MEASURED through the real serialiser: **21,467,287 bytes with `_pksig` and 15,467,287
without at 200,000 rows** — `+6.0 MB`, exactly 30 bytes a row — and **54,167,287 vs 39,167,287 at
500,000**, `+15.0 MB`. `reco/recoSessions.json` is rewritten wholesale on a 250 ms timer and shipped
to the shared folder, and §14.6 already calls an 85 MiB serialise at 200,000 rows a problem.

**Why it is only a ticket** It is a **price, not a bug**, and it is now written down and agreed
(handover §16.4a's round-8 block) rather than discovered. The saving is bytes, not correctness.

**Fix** The signature is one string per data set, so `sess` could hold it once — beside
`sess.dataSetIds`, which is already per-row by index through `_dsi` — and the row literal could read
it from there. The **day file** still needs the per-row column, because a reopened file genuinely
mixes rules.

**Test** `Store.serialize('recoSessions', …)` at 200,000 rows is within 1 MB of the no-signature
figure, with **[88] R19a–R19d**'s round trip still green and `run_panes_e2e`'s byte diff of the row
literal re-read and declared.

---

## T-S10-30  `Groups.resolvePk` reads a row out of a day file FOR A WRITE and does not carry the signature

**Where** `apps/Reco.html` `Groups.resolvePk`'s historic row literal — `{_id:'hist_'+uid, _pk, _ver,
_historic}` plus `tpl.columns` only — against `Reco.loadVersionedFile`'s literal, which now carries
`_pksig`; and `Reco.removeMemberFromGroup`, which re-finds the row in `sess.data` only and passes
`null` when it is not there.

**What** Both literals are built from the same `collapseToActive(readFile(...))` rows, and those rows
hold the signature. `Reco.openGroupDetails` shows a historic member with a **–** button, and
`removeMemberFromGroup` then degrades the question to the template latch — which is DOWN after one's
own key edit. So a group membership filed under a key the rule no longer mints can still be deleted
from the Group details modal with the signature sitting unread in the file two lines away.

**Why it is only a ticket** T-S10-20's comment makes that deliberate — *"a key with no row left on
screen can only be the template latch's business"* — and an operator pressing **–** on a historic
row probably means it. What changed is the **premise** of that comment: the file can answer now. It
is also a code-reading finding with no measurement attached (skB B6, out of its own dimension), and
the fix needs a decision about what the refusal should SAY there: *"Clear Loaded Data and load the
extract again"* is not advice about a group modal.

**Fix** Either carry `_pksig` in `Groups.resolvePk`'s literal and pass the resolved row to
`Reco._keyStaleBlock`, with a sentence written for that modal — or write one line in the T-S10-20
note saying why a historic member is deliberately exempt now that the file can answer. Not both.

**Test** A group with one historic member whose signature is not the live template's: pressing **–**
is refused with a sentence that names the modal, and `reco/groupMaster.json` is unchanged.
