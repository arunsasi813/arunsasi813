/* Injected by the Android app after the deck loads. It adds two things the
 * deck doesn't have on its own: per-user score capture and mark-for-review.
 * Everything is stored in the WebView's localStorage AND mirrored to the
 * native bridge (window.CMA) so it survives reinstalls and can sync. In a
 * plain browser (no window.CMA) it degrades to localStorage only. */
(function () {
  if (window.__cmaBridge) return;
  window.__cmaBridge = true;
  var AND = window.CMA; // native interface, may be undefined outside the app

  function hash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
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

  function makeStar(key, kind, labelFn, cls) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "cma-star " + (cls || "");
    b.textContent = isMarked(key) ? "★" : "☆";
    if (isMarked(key)) b.classList.add("on");
    b.title = "Mark for review";
    b.onclick = function (ev) {
      ev.stopPropagation(); ev.preventDefault();
      var now = !isMarked(key);
      setReview(key, kind, labelFn(), now);
      b.textContent = now ? "★" : "☆";
      b.classList.toggle("on", now);
    };
    return b;
  }

  /* ---------- MCQ: star + score mirror ---------- */
  function decorateMCQ(root) {
    (root || document).querySelectorAll(".q").forEach(function (q) {
      if (q.__cma) return; q.__cma = true;
      var txt = (q.querySelector(".q-text") || q).textContent.trim().slice(0, 160);
      var key = "mcq:" + sectionOf(q) + ":" + hash(txt);
      q.style.position = q.style.position || "relative";
      q.appendChild(makeStar(key, "mcq", function () { return txt; }, "cma-star-q"));
    });
  }
  document.addEventListener("click", function (e) {
    var o = e.target.closest && e.target.closest(".q-opt");
    if (!o) return;
    setTimeout(function () {
      var q = o.closest(".q");
      if (!q || q.dataset.done !== "1" || q.__scored) return;
      q.__scored = true;
      try { if (AND && AND.recordAnswer) AND.recordAnswer(sectionOf(q), q.dataset.ok === "1"); } catch (e) {}
    }, 30);
  }, true);

  /* ---------- Flashcards: star on the current card ---------- */
  function setupCardStar() {
    var host = document.querySelector("#v-cards .fc-host");
    if (!host || host.__cma) return; host.__cma = true;
    var meta = host.querySelector(".fc-meta") || host;
    var star = makeStar("", "flashcard", function () { return frontText(); }, "cma-star-card");
    meta.appendChild(star);
    function frontText() {
      var f = host.querySelector(".fc-front .txt");
      return f ? f.textContent.trim().slice(0, 160) : "";
    }
    function keyFor(t) { return "flash:" + hash(t); }
    function refresh() {
      var t = frontText();
      if (!t) { star.style.display = "none"; return; }
      star.style.display = "";
      var k = keyFor(t), m = isMarked(k);
      star.textContent = m ? "★" : "☆";
      star.classList.toggle("on", m);
      star.onclick = function (ev) {
        ev.stopPropagation(); ev.preventDefault();
        var now = !isMarked(k);
        setReview(k, "flashcard", t, now);
        refresh();
      };
    }
    new MutationObserver(refresh).observe(host, { subtree: true, childList: true, characterData: true });
    refresh();
  }

  /* ---------- floating "Review (n)" panel ---------- */
  var fab, panel;
  function count() { return Object.keys(readReview()).length; }
  function updateReviewButton() {
    if (fab) fab.textContent = "★ Review (" + count() + ")";
  }
  function buildFab() {
    fab = document.createElement("button");
    fab.className = "cma-fab";
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
    var html = '<div class="cma-panel-h"><b>Marked for review</b><button class="cma-x">✕</button></div>';
    if (!keys.length) html += '<p class="cma-empty">Nothing marked yet. Tap ☆ on a question or flashcard.</p>';
    else html += keys.map(function (k) {
      var r = m[k];
      return '<div class="cma-item" data-k="' + k + '"><span class="cma-kind">' + r.kind + '</span>'
        + '<span class="cma-lbl">' + (r.label || k).replace(/[<>&]/g, "") + '</span>'
        + '<button class="cma-un" data-k="' + k + '">remove</button></div>';
    }).join("");
    panel.innerHTML = html;
    panel.classList.add("open");
    panel.querySelector(".cma-x").onclick = function () { panel.classList.remove("open"); };
    panel.querySelectorAll(".cma-un").forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute("data-k");
        setReview(k, (m[k] || {}).kind || "", (m[k] || {}).label || "", false);
        openPanel();
        document.querySelectorAll('.cma-star[data-reset]').forEach(function(){});
      };
    });
  }

  /* ---------- styles ---------- */
  function injectCss() {
    var css = ''
      + '.cma-star{background:transparent;border:0;font-size:20px;line-height:1;color:#b9832a;cursor:pointer;padding:2px 6px}'
      + '.cma-star.on{color:#b9832a}'
      + '.cma-star-q{position:absolute;top:8px;right:8px}'
      + '.cma-star-card{font-size:22px}'
      + '.cma-fab{position:fixed;right:16px;bottom:16px;z-index:60;background:#0f7a5a;color:#fff;border:0;border-radius:22px;padding:11px 16px;font:700 13px/1 "Segoe UI",system-ui,sans-serif;box-shadow:0 6px 18px rgba(13,31,45,.3);cursor:pointer}'
      + '.cma-panel{position:fixed;right:16px;bottom:64px;z-index:60;width:min(360px,92vw);max-height:60vh;overflow:auto;background:#fff;border:1px solid #d3dcdf;border-radius:14px;box-shadow:0 18px 48px rgba(13,31,45,.3);padding:12px;display:none}'
      + '.cma-panel.open{display:block}'
      + 'body.dark .cma-panel{background:#12293a;border-color:#1b3852;color:#cfe0ea}'
      + '.cma-panel-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:14px}'
      + '.cma-x{background:transparent;border:0;font-size:16px;cursor:pointer;color:inherit}'
      + '.cma-empty{font-size:13px;color:#7d94a1;padding:8px 2px}'
      + '.cma-item{display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid rgba(125,148,161,.2);font-size:13px}'
      + '.cma-kind{font-size:10px;font-weight:800;text-transform:uppercase;color:#0f7a5a;flex:0 0 auto}'
      + '.cma-lbl{flex:1;color:inherit}'
      + '.cma-un{background:transparent;border:1px solid #d3dcdf;border-radius:6px;font-size:11px;padding:3px 7px;cursor:pointer;color:inherit}';
    var s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ---------- boot + keep decorating as views render ---------- */
  function sweep() { decorateMCQ(document); setupCardStar(); }
  function boot() {
    injectCss();
    buildFab();
    sweep();
    new MutationObserver(function () { sweep(); }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("hashchange", function () { setTimeout(sweep, 120); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
