# Open tickets

Things found while building, deliberately not built, and picked up cold from here. Each one
says WHERE, WHAT, WHY IT IS ONLY A TICKET, the FIX and the TEST, because a ticket without those
is a rumour.

Three are worth promoting above the rest:

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


## T-24R2-1  `saveTemplate`'s read-modify-write race now splits ROW IDENTITY, not just a column's values

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

## T-26-4  A row that is already posted can be posted a SECOND time

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

## T-S10-5  A column that is renamed AND moved is read as a removal, not a rename

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

## T-S10-7  Every template field except the two flags is still last-writer-wins

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

## T-S10-9  The last typing of the day is still lost if the folder is down and the operator leaves anyway

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

## T-S10-10  The ledger merge is atomic inside ONE page and not BETWEEN pages — two colleagues pressing Generate together can still lose an entry

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

---

## T-26-11  After a T-30-3 conflict the two values are in the file but unreachable, so the column reads blank next month

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
