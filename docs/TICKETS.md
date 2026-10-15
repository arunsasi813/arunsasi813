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
