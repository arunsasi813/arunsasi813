/* Injected by the Android app after the deck loads. Adds per-user score
 * capture and mark-for-review on top of the deck, without touching its code.
 * State lives in localStorage AND is mirrored to the native bridge
 * (window.CMA); with no bridge it degrades to localStorage only.
 *
 * Performance: the deck mutates the DOM constantly while scrolling (reading
 * bar, animated counters, reveal classes). This script therefore reacts only
 * to added ELEMENT nodes (new questions / a redrawn flashcard), debounced to
 * idle, with the observer disconnected while it inserts so it can't trigger
 * itself. It never reacts to attribute or text mutations. */
(function () {
  if (window.__cmaBridge) return;
  window.__cmaBridge = true;
  var AND = window.CMA; // native interface, may be undefined outside the app

  function hash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function sectionOf(el) {
    var v = el.closest && el.closest(".view");
    return v && v.id && v.id.indexOf("v-") === 0 ? v.id.slice(2) : "?";
  }

  /* ---------- review store ---------- */
  function readReview() {
    try { return JSON.parse(localStorage.getItem("cma_review") || "{}") || {}; }
    catch (e) { return {}; }
  }
  function writeReview(m) {
    try { localStorage.setItem("cma_review", JSON.stringify(m)); } catch (e) {}
  }
  function isMarked(k) { return !!readReview()[k]; }
  function setReview(key, kind, label, marked) {
    var m = readReview();
    if (marked) m[key] = { kind: kind, label: label, at: Date.now() };
    else delete m[key];
    writeReview(m);
    try { if (AND && AND.toggleReview) AND.toggleReview(key, kind, label || "", !!marked); } catch (e) {}
    updateReviewButton();
  }

  /* ---------- MCQ: star + score mirror ---------- */
  function decorateMCQ(root) {
    (root || document).querySelectorAll(".q").forEach(function (q) {
      if (q.__cma) return; q.__cma = true;
      var stem = q.querySelector(".q-stem") || q.querySelector(".q-text");
      var txt = (stem || q).textContent.trim().slice(0, 160);
      var key = "mcq:" + sectionOf(q) + ":" + hash(txt);   // key stays stable
      var label = txt.replace(/^\s*\d+[.)]?\s*/, "");       // drop leading number for display
      var b = document.createElement("button");
      b.type = "button"; b.className = "cma-star cma-star-q";
      b.textContent = isMarked(key) ? "★" : "☆";
      if (isMarked(key)) b.classList.add("on");
      b.title = "Mark for review";
      b.onclick = function (ev) {
        ev.stopPropagation(); ev.preventDefault();
        var now = !isMarked(key);
        setReview(key, "mcq", label, now);
        b.textContent = now ? "★" : "☆";
        b.classList.toggle("on", now);
      };
      q.style.position = q.style.position || "relative";
      q.appendChild(b);
    });
  }
  // Score mirror: one delegated capture listener. Reads the deck's own answered
  // state AFTER its click handler has run. Section quizzes set data-ok; the mock
  // test does NOT set it at click time (graded later), so we skip those to avoid
  // recording every mock-test answer as wrong under a bogus "test" section.
  document.addEventListener("click", function (e) {
    var o = e.target.closest && e.target.closest(".q-opt");
    if (!o) return;
    setTimeout(function () {
      var q = o.closest(".q");
      if (!q || q.dataset.done !== "1" || q.dataset.ok == null || q.__scored) return;
      q.__scored = true;
      var sec = q.dataset.sec || sectionOf(q);   // real section even in the mock test
      try { if (AND && AND.recordAnswer) AND.recordAnswer(sec, q.dataset.ok === "1"); } catch (e) {}
    }, 30);
  }, true);

  /* ---------- Flashcards: star on the current card ----------
   * The deck rebuilds #v-cards .fc-host via innerHTML on every flip/advance,
   * which wipes our star and the node we observe. So setupCardStar is
   * idempotent and re-runs on every decorate() pass (decorate fires on the
   * redraw's childList mutation): it re-adds the star if missing and re-points
   * a single observer at the current card node. */
  var cardObs = null;
  function cardFrontText(host) {
    var f = host.querySelector(".fc-front .txt");
    return f ? f.textContent.trim().slice(0, 160) : "";
  }
  function refreshCardStar(host, star) {
    var t = cardFrontText(host);
    if (!t) { star.style.display = "none"; return; }
    star.style.display = "";
    var k = "flash:" + hash(t), m = isMarked(k);
    star.textContent = m ? "★" : "☆";
    star.classList.toggle("on", m);
    star.onclick = function (ev) {
      ev.stopPropagation(); ev.preventDefault();
      var now = !isMarked(k);
      setReview(k, "flashcard", t, now);
      star.textContent = now ? "★" : "☆";
      star.classList.toggle("on", now);
    };
  }
  function setupCardStar() {
    var host = document.querySelector("#v-cards .fc-host");
    if (!host) return;
    var meta = host.querySelector(".fc-meta");
    if (!meta) return;                       // cards view not built yet
    var star = meta.querySelector(".cma-star-card");
    if (!star) {
      star = document.createElement("button");
      star.type = "button"; star.className = "cma-star cma-star-card";
      star.textContent = "☆"; star.title = "Mark this card for review";
      meta.appendChild(star);
    }
    var card = host.querySelector(".fcard3") || host.querySelector(".fc-inner");
    if (card && !card.__cmaObs) {
      card.__cmaObs = true;
      if (cardObs) cardObs.disconnect();
      cardObs = new MutationObserver(function () { refreshCardStar(host, star); });
      cardObs.observe(card, { subtree: true, childList: true, characterData: true });
    }
    refreshCardStar(host, star);
  }

  /* ---------- floating "Review (n)" panel ---------- */
  var fab, panel;
  function count() { return Object.keys(readReview()).length; }
  function updateReviewButton() { if (fab) fab.textContent = "★ Review (" + count() + ")"; }
  function buildFab() {
    fab = document.createElement("button");
    fab.className = "cma-fab"; fab.type = "button";
    fab.onclick = openPanel;
    document.body.appendChild(fab);
    panel = document.createElement("div");
    panel.className = "cma-panel";
    document.body.appendChild(panel);
    updateReviewButton();
  }
  function openPanel() {
    var m = readReview();
    var keys = Object.keys(m).sort(function (a, b) { return m[b].at - m[a].at; });
    var html = '<div class="cma-panel-h"><b>Marked for review</b><button class="cma-x" type="button">✕</button></div>';
    if (!keys.length) html += '<p class="cma-empty">Nothing marked yet. Tap ☆ on a question or flashcard.</p>';
    else html += keys.map(function (k) {
      var r = m[k];
      return '<div class="cma-item"><span class="cma-kind">' + esc(r.kind) + '</span>'
        + '<span class="cma-lbl">' + esc(r.label || k) + '</span>'
        + '<button class="cma-un" type="button" data-k="' + esc(k) + '">remove</button></div>';
    }).join("");
    panel.innerHTML = html;
    panel.classList.add("open");
    panel.querySelector(".cma-x").onclick = function () { panel.classList.remove("open"); };
    panel.querySelectorAll(".cma-un").forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute("data-k");
        var meta = readReview()[k] || {};
        setReview(k, meta.kind || "", meta.label || "", false);
        // reflect on any visible star for this key
        document.querySelectorAll(".cma-star.on").forEach(function (s) {
          if (s.__key === k) { s.textContent = "☆"; s.classList.remove("on"); }
        });
        openPanel();
      };
    });
  }

  /* ---------- styles ---------- */
  function injectCss() {
    var css = ''
      + '.q .q-stem{padding-right:38px}'
      + '.cma-star{background:transparent;border:0;font-size:20px;line-height:1;color:#b9832a;cursor:pointer;padding:6px 9px;-webkit-tap-highlight-color:transparent;min-width:40px;min-height:40px}'
      + '.cma-star-q{position:absolute;top:2px;right:2px;z-index:2}'
      + '.cma-star-card{font-size:22px}'
      + '.cma-fab{position:fixed;right:14px;bottom:14px;z-index:60;background:#0f7a5a;color:#fff;border:0;border-radius:22px;padding:11px 16px;font:700 13px/1 "Segoe UI",system-ui,sans-serif;box-shadow:0 6px 18px rgba(13,31,45,.3);cursor:pointer}'
      + '.cma-panel{position:fixed;right:14px;bottom:62px;z-index:60;width:min(360px,92vw);max-height:62vh;overflow:auto;background:#fff;border:1px solid #d3dcdf;border-radius:14px;box-shadow:0 18px 48px rgba(13,31,45,.3);padding:12px;display:none}'
      + '.cma-panel.open{display:block}'
      + 'body.dark .cma-panel{background:#12293a;border-color:#1b3852;color:#cfe0ea}'
      + '.cma-panel-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:14px}'
      + '.cma-x{background:transparent;border:0;font-size:16px;cursor:pointer;color:inherit}'
      + '.cma-empty{font-size:13px;color:#7d94a1;padding:8px 2px}'
      + '.cma-item{display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid rgba(125,148,161,.2);font-size:13px}'
      + '.cma-kind{font-size:10px;font-weight:800;text-transform:uppercase;color:#0f7a5a;flex:0 0 auto}'
      + '.cma-lbl{flex:1;color:inherit;word-break:break-word}'
      + '.cma-un{background:transparent;border:1px solid #d3dcdf;border-radius:6px;font-size:11px;padding:3px 7px;cursor:pointer;color:inherit;flex:0 0 auto}'
      + '.topbar{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;background:#f5f7f8 !important}'
      + 'body.dark .topbar{background:#0d1f2d !important}';
    var s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ---------- scheduling ---------- */
  var obs = null, scheduled = false;
  function decorate() {
    if (obs) obs.disconnect();           // our inserts must not re-trigger us
    try { decorateMCQ(document); setupCardStar(); }
    finally { if (obs) obs.observe(document.body, { childList: true, subtree: true }); }
  }
  function schedule() {
    if (scheduled) return; scheduled = true;
    var run = function () { scheduled = false; decorate(); };
    if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 600 });
    else setTimeout(run, 150);
  }

  function boot() {
    injectCss();
    buildFab();
    // React ONLY to added element nodes; ignore the text-node churn from the
    // deck's animated counters and the attribute churn from scrolling.
    obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var a = muts[i].addedNodes;
        for (var j = 0; j < a.length; j++) {
          if (a[j].nodeType === 1) { schedule(); return; }
        }
      }
    });
    decorate();                          // first pass sets up obs via finally
    window.addEventListener("hashchange", function () { setTimeout(schedule, 120); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
