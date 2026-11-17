/* ColSift PDF module.

   Documents are read through ColSift's API (a few MB a call) and kept as bytes. pdf.js
   draws the pages and reads their text; pdf-lib (the @cantoo fork: it encrypts and
   decrypts) writes the result. The board is one list of pages from any number of
   documents: reorder, rotate, delete, duplicate, add blank pages — Save copies them, in
   that order, into a new PDF, with what was added on top (text, white-out, highlight,
   images, signatures) and the stamps (page numbers, watermark, header / footer),
   document properties and a password. Nothing leaves the machine. */

const L = window.PDFLib;
const J = window.pdfjsLib;
const HOST = window.parent && window.parent !== window ? window.parent : window;
const api = () => (HOST.pdfHost ? HOST.pdfHost.api() : HOST.pywebview.api);
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const human = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/* ---------------- pdf.js worker: a real one when the page may start it ---------------- */
(function setupWorker(){
  const code = $("#pdfjsWorkerSrc").textContent;
  try {
    const url = URL.createObjectURL(new Blob([code], {type: "text/javascript"}));
    J.GlobalWorkerOptions.workerPort = new Worker(url, {type: "module"});
  } catch (e) {
    // no workers here: run pdf.js's worker in this page (slower, same result)
    const s = document.createElement("script"); s.type = "module"; s.textContent = code;
    document.head.appendChild(s);
  }
})();

/* ---------------- state ---------------- */
const S = {docs: [], pages: [], sel: new Set(), last: null, hist: [], edit: null, tool: null, ovSel: null, extraFolders: [],
           folderFiles: [], folderTick: new Set(), hits: [], stop: false, busy: false};

function say(msg, kind = ""){
  const el = $("#status"); el.textContent = msg; el.className = kind;
  if (HOST.pdfHost?.say && kind) HOST.pdfHost.say(msg, kind);
}
function prog(f){ $("#prog").style.width = f == null ? "0" : `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`; }
async function busy(on, msg){ S.busy = on; $$("footer .btn, #tbPages .btn").forEach(b => b.disabled = on); if (msg) say(msg); if (!on) prog(null);
  await new Promise(r => setTimeout(r)); }

/* ---------------- files in and out (through ColSift, a few MB a call) ---------------- */
async function b64bytes(b64){ return new Uint8Array(await (await fetch(`data:application/octet-stream;base64,${b64}`)).arrayBuffer()); }
function bytesB64(u8){
  return new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",", 2)[1] || ""); r.readAsDataURL(new Blob([u8])); });
}
async function readFile(path){
  const parts = []; let off = 0, size = 0, name = path.split(/[\\/]/).pop();
  for (;;){
    const r = await api().file_read({path, offset: off});
    if (!r?.ok) throw new Error(r?.error || `Could not read ${name}`);
    size = r.size; name = r.name || name;
    parts.push(await b64bytes(r.b64)); off = r.next;
    if (size) prog(off / size);
    if (r.done) break;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0;
  for (const p of parts){ out.set(p, at); at += p.length; }
  return {bytes: out, name, size};
}
async function saveFile(bytes, opt){
  const b = await api().file_save_begin(opt);
  if (!b?.ok){ if (!b?.cancelled) throw new Error(b?.error || "Could not save"); return null; }
  const CH = 3 << 20;
  try {
    for (let at = 0; at < bytes.length; at += CH){
      const r = await api().file_save_chunk({token: b.token, b64: await bytesB64(bytes.subarray(at, at + CH))});
      if (!r?.ok) throw new Error(r?.error || "Could not save");
      prog((at + CH) / bytes.length);
    }
  } catch (e){ await api().file_save_end({token: b.token, abort: true}); throw e; }
  const e = await api().file_save_end({token: b.token});
  if (!e?.ok) throw new Error(e?.error || "Could not save");
  return e.path;
}
const hostFolders = () => (HOST.pdfHost?.folders?.() || []);
const outFolder = () => HOST.pdfHost?.outFolder?.() || "";

/* ---------------- documents ---------------- */
async function openPaths(paths){
  if (!paths.length) return;
  await busy(true, `Opening ${paths.length} file${paths.length === 1 ? "" : "s"}…`);
  let added = 0;
  try {
    for (const p of paths){
      try { added += await openBytes((await readFile(p)), p); }
      catch (e){ say(`${p.split(/[\\/]/).pop()}: ${e.message || e}`, "err"); }
    }
  } finally { await busy(false); }
  if (added){ drawDocs(); drawGrid(); fillMeta(); drawForm(); say(`${added} page${added === 1 ? "" : "s"} added — ${S.pages.length} on the board.`, "ok"); }
}
async function openBytes(f, path = ""){
  let password = null, js;
  for (let tries = 0; ; tries++){
    try {
      js = await J.getDocument({data: f.bytes.slice(), password: password ?? undefined, isEvalSupported: false}).promise;
      break;
    } catch (e){
      if (e?.name !== "PasswordException" || tries > 4) throw e;
      password = prompt(`${f.name} is protected. Its password:`, "");
      if (password == null) throw new Error("needs its password");
    }
  }
  const doc = {id: uid(), name: f.name, path, bytes: f.bytes, js, n: js.numPages, password, lib: null};
  S.docs.push(doc);
  snapshot();
  for (let i = 0; i < doc.n; i++) S.pages.push({id: uid(), doc: doc.id, index: i, rot: 0, ov: []});
  return doc.n;
}
const docOf = id => S.docs.find(d => d.id === id);
async function libDoc(d){
  if (!d.lib) d.lib = await L.PDFDocument.load(d.bytes, d.password != null ? {password: d.password} : {ignoreEncryption: true});
  return d.lib;
}
function drawDocs(){
  $("#docs").innerHTML = S.docs.length ? S.docs.map(d => `<div class="li" data-d="${d.id}" title="${esc(d.path || d.name)}">
      <span class="nm">${esc(d.name)}</span><span class="sz">${d.n}p · ${human(d.bytes.length)}</span>
      <button class="btn ghost sm" data-close="${d.id}" title="Take this document's pages off the board">✕</button></div>`).join("")
    : `<div class="hint">None yet.</div>`;
}
$("#docs").addEventListener("click", e => {
  const c = e.target.closest("[data-close]"); if (!c) return;
  snapshot();
  const id = c.dataset.close;
  S.pages = S.pages.filter(p => p.doc !== id);
  const d = docOf(id); d?.js?.destroy?.();
  S.docs = S.docs.filter(x => x.id !== id);
  S.sel.clear(); drawDocs(); drawGrid();
});
$("#openBtn").onclick = async () => {
  const r = await api().open_dialog({multiple: true, types: ["PDF files (*.pdf)"], folder: hostFolders()[0]?.path || ""});
  await openPaths((r?.paths || []).filter(p => /\.pdf$/i.test(p)));
};
$("#clearBtn").onclick = () => {
  if (S.pages.length && !confirm("Close every document? Pages and additions on the board are dropped.")) return;
  S.docs.forEach(d => d.js?.destroy?.()); S.docs = []; S.pages = []; S.sel.clear(); S.hist = [];
  drawDocs(); drawGrid(); show("pages");
};

/* ---------------- PDFs in the open folders ---------------- */
async function scanFolders(){
  const seen = new Set(), folders = [...hostFolders(), ...S.extraFolders].filter(f => !seen.has(f.path) && seen.add(f.path));
  if (!folders.length){ $("#folderList").innerHTML = `<div class="hint">The folders open in ColSift are listed here — or add one with ＋ Folder.</div>`; return; }
  const r = await api().pdf_list({folders});
  S.folderFiles = r?.files || [];
  drawFolder();
}
function drawFolder(){
  const q = $("#fq").value.trim().toLowerCase();
  const fs = S.folderFiles.filter(f => !q || f.name.toLowerCase().includes(q));
  let html = "", folder = "";
  for (const f of fs.slice(0, 1500)){
    if (f.folder !== folder){ folder = f.folder; html += `<div class="fold" title="${esc(folder)}">${esc(folder)}</div>`; }
    html += `<div class="li" data-open="${esc(f.path)}" title="Click to open · tick for Search PDFs"><input type="checkbox" data-tick="${esc(f.path)}" ${S.folderTick.has(f.path) ? "checked" : ""}>
      <span class="nm">${esc(f.name)}</span><span class="sz">${human(f.size)}</span></div>`;
  }
  $("#folderList").innerHTML = html || `<div class="hint">${S.folderFiles.length ? "No PDF matches." : "No PDFs in the open folders."}</div>`;
}
$("#fq").oninput = drawFolder;
$("#rescan").onclick = scanFolders;
async function addFolder(path){
  if (!path){ const r = await api().pick_folder(hostFolders()[0]?.path || ""); path = r?.folder; }
  if (!path) return;
  S.extraFolders.push({path, recursive: $("#fsub").checked}); await scanFolders();
}
$("#addFolder").onclick = () => addFolder();
$("#folderList").addEventListener("click", e => {
  const t = e.target.closest("[data-tick]");
  if (t){ t.checked ? S.folderTick.add(t.dataset.tick) : S.folderTick.delete(t.dataset.tick); e.stopPropagation(); return; }
  const o = e.target.closest("[data-open]"); if (o) openPaths([o.dataset.open]);
});

/* ---------------- thumbnails ---------------- */
const thumbCache = new Map();          // page id + rotation -> data URL
let thumbObs = null;
async function renderThumb(pg, canvas){
  const W = 140;
  if (pg.blank){
    const r = (pg.blank.w > pg.blank.h) !== (pg.rot % 180 !== 0) ? [W, W * 0.7] : [W, W * 1.41];
    canvas.width = r[0]; canvas.height = r[1]; const c = canvas.getContext("2d"); c.fillStyle = "#fff"; c.fillRect(0, 0, r[0], r[1]); return;
  }
  const d = docOf(pg.doc); if (!d) return;
  const page = await d.js.getPage(pg.index + 1);
  const rotation = (page.rotate + pg.rot) % 360;
  const vp0 = page.getViewport({scale: 1, rotation});
  const vp = page.getViewport({scale: W / vp0.width, rotation});
  canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
  await page.render({canvas, canvasContext: canvas.getContext("2d"), viewport: vp}).promise;
}
function drawGrid(){
  const g = $("#grid");
  if (!S.pages.length){
    g.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>No pages yet</h3>Open PDFs (button on the left, or click one in your folders) — their pages land here.
      Then drag to reorder, select and rotate or delete, double-click a page to add text, a signature or a white-out, and <b>Save PDF</b>.</div>`;
    selInfo(); return;
  }
  g.innerHTML = S.pages.map((p, i) => {
    const d = docOf(p.doc);
    return `<div class="th ${S.sel.has(p.id) ? "sel" : ""}" draggable="true" data-id="${p.id}">
      ${p.ov.length ? `<span class="badge" title="Things added on this page">✎ ${p.ov.length}</span>` : ""}
      <canvas></canvas>
      <div class="cap"><span title="${esc(d ? d.name : "blank page")}">${esc(p.blank ? "blank page" : `${d?.name || "?"} · p${p.index + 1}`)}</span><span>${i + 1}${p.rot ? ` · ${p.rot}°` : ""}</span></div></div>`;
  }).join("");
  thumbObs?.disconnect();
  thumbObs = new IntersectionObserver(ents => ents.forEach(en => {
    if (!en.isIntersecting) return;
    thumbObs.unobserve(en.target);
    const pg = S.pages.find(p => p.id === en.target.dataset.id);
    if (pg) renderThumb(pg, en.target.querySelector("canvas")).catch(() => {});
  }), {root: $("#v-pages"), rootMargin: "300px"});
  $$("#grid .th").forEach(el => thumbObs.observe(el));
  selInfo();
}
function selInfo(){
  $("#selInfo").textContent = S.pages.length ? `${S.pages.length} page${S.pages.length === 1 ? "" : "s"}${S.sel.size ? ` · ${S.sel.size} selected` : ""}` : "";
}
$("#grid").addEventListener("click", e => {
  const th = e.target.closest(".th"); if (!th) return;
  const id = th.dataset.id, ids = S.pages.map(p => p.id);
  if (e.shiftKey && S.last){
    const a = ids.indexOf(S.last), b = ids.indexOf(id);
    ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => S.sel.add(x));
  } else if (e.ctrlKey || e.metaKey){ S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); }
  else { S.sel.clear(); S.sel.add(id); }
  S.last = id;
  $$("#grid .th").forEach(x => x.classList.toggle("sel", S.sel.has(x.dataset.id)));
  selInfo();
});
$("#grid").addEventListener("dblclick", e => { const th = e.target.closest(".th"); if (th) openEditor(th.dataset.id); });
/* drag to reorder: the selected pages move together */
let drag = null;
$("#grid").addEventListener("dragstart", e => {
  const th = e.target.closest(".th"); if (!th) return;
  if (!S.sel.has(th.dataset.id)){ S.sel.clear(); S.sel.add(th.dataset.id); }
  drag = [...S.sel]; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "pages");
});
$("#grid").addEventListener("dragover", e => {
  if (!drag) return; const th = e.target.closest(".th"); if (!th) return;
  e.preventDefault();
  const r = th.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
  $$("#grid .th").forEach(x => x.classList.remove("drop-before", "drop-after"));
  th.classList.add(after ? "drop-after" : "drop-before");
});
$("#grid").addEventListener("drop", e => {
  if (!drag) return; const th = e.target.closest(".th"); if (!th) return;
  e.preventDefault();
  const after = th.classList.contains("drop-after");
  snapshot();
  const moving = S.pages.filter(p => drag.includes(p.id));
  let rest = S.pages.filter(p => !drag.includes(p.id));
  let at = rest.findIndex(p => p.id === th.dataset.id);
  if (at < 0) at = rest.length; else if (after) at += 1;
  rest.splice(at, 0, ...moving); S.pages = rest; drag = null; drawGrid();
});
$("#grid").addEventListener("dragend", () => { drag = null; $$("#grid .th").forEach(x => x.classList.remove("drop-before", "drop-after")); });

/* ---------------- page actions ---------------- */
function snapshot(){
  S.hist.push(JSON.stringify(S.pages));
  if (S.hist.length > 60) S.hist.shift();
}
const selected = () => S.pages.filter(p => S.sel.has(p.id));
function act(a){
  const sel = selected();
  if (["rotl", "rotr", "dup", "del", "first", "last", "extract"].includes(a) && !sel.length){ say("Select some pages first (click, Ctrl-click, Shift-click).", "err"); return; }
  if (a === "all"){ S.pages.forEach(p => S.sel.add(p.id)); drawGrid(); return; }
  if (a === "none"){ S.sel.clear(); drawGrid(); return; }
  if (a === "undo"){ const h = S.hist.pop(); if (!h){ say("Nothing to undo."); return; } S.pages = JSON.parse(h); S.sel.clear(); drawGrid(); if (S.edit) drawEditor(); return; }
  if (a === "extract"){ saveDoc(sel, "extract"); return; }
  if (a === "split"){ if (!S.pages.length){ say("Open a PDF first.", "err"); return; } $("#splitDlg").classList.add("on"); return; }
  snapshot();
  if (a === "rotl" || a === "rotr") sel.forEach(p => p.rot = (p.rot + (a === "rotl" ? 270 : 90)) % 360);
  else if (a === "dup"){
    const out = [];
    S.pages.forEach(p => { out.push(p); if (S.sel.has(p.id)) out.push({...JSON.parse(JSON.stringify(p)), id: uid()}); });
    S.pages = out;
  } else if (a === "del"){ S.pages = S.pages.filter(p => !S.sel.has(p.id)); S.sel.clear(); }
  else if (a === "blank"){
    const ref = sel[sel.length - 1] || S.pages[S.pages.length - 1];
    const size = ref ? pageSize(ref) : [595.28, 841.89];
    const nu = {id: uid(), doc: null, index: -1, rot: 0, ov: [], blank: {w: size[0], h: size[1]}};
    const at = ref ? S.pages.indexOf(ref) + 1 : S.pages.length;
    S.pages.splice(at, 0, nu);
  } else if (a === "first" || a === "last"){
    const rest = S.pages.filter(p => !S.sel.has(p.id));
    S.pages = a === "first" ? [...sel, ...rest] : [...rest, ...sel];
  } else if (a === "reverse"){
    if (sel.length > 1){ const idx = S.pages.map((p, i) => S.sel.has(p.id) ? i : -1).filter(i => i >= 0); const rv = [...sel].reverse(); idx.forEach((i, k) => S.pages[i] = rv[k]); }
    else S.pages.reverse();
  }
  drawGrid();
}
const sizeCache = new Map();
function pageSize(p){ if (p.blank) return [p.blank.w, p.blank.h]; return sizeCache.get(`${p.doc}:${p.index}`) || [595.28, 841.89]; }
$("#tbPages").addEventListener("click", e => { const b = e.target.closest("[data-a]"); if (b) act(b.dataset.a); });
document.addEventListener("keydown", e => {
  if (e.target.closest("input, textarea, [contenteditable=true]")) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z"){ e.preventDefault(); act("undo"); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && cur() === "pages"){ e.preventDefault(); act("all"); }
  else if (e.key === "Delete" && cur() === "pages") act("del");
  else if (e.key === "Delete" && cur() === "edit" && S.ovSel){ delOverlay(S.ovSel); }
});

/* ---------------- views ---------------- */
const cur = () => $(".tab.on")?.dataset.v;
function show(v){
  $$(".tab").forEach(t => t.classList.toggle("on", t.dataset.v === v));
  $$(".view").forEach(x => x.classList.toggle("on", x.id === `v-${v}`));
  $("#tbPages").style.display = v === "pages" ? "" : "none";
  if (v === "edit"){ if (!S.edit && S.pages.length) openEditor((selected()[0] || S.pages[0]).id); else drawEditor(); }
  if (v === "tools") drawForm();
}
$("#tabs").addEventListener("click", e => { const t = e.target.closest(".tab"); if (t) show(t.dataset.v); });
$$(".modal [data-close]").forEach(b => b.onclick = () => b.closest(".modal").classList.remove("on"));

/* ---------------- the page editor ---------------- */
const ED = {scale: 1.4, vp: null, rot: 0, page: null};
async function openEditor(id){ S.edit = id; S.ovSel = null; show("edit"); }
async function drawEditor(){
  const pg = S.pages.find(p => p.id === S.edit);
  const stage = $("#stage");
  if (!pg){ stage.innerHTML = `<div class="empty"><h3>Pick a page</h3>Double-click a page on the Pages tab.</div>`; return; }
  const i = S.pages.indexOf(pg);
  $("#edInfo").textContent = `page ${i + 1} of ${S.pages.length}`;
  const avail = Math.max(300, stage.clientWidth - 40);
  let vp, canvas = document.createElement("canvas");
  if (pg.blank){
    const rot = pg.rot % 360, w = rot % 180 ? pg.blank.h : pg.blank.w;
    vp = blankViewport(pg.blank.w, pg.blank.h, rot, Math.min(1.6, avail / w));
    canvas.width = vp.width; canvas.height = vp.height; const c = canvas.getContext("2d"); c.fillStyle = "#fff"; c.fillRect(0, 0, vp.width, vp.height);
    ED.rot = rot;
  } else {
    const d = docOf(pg.doc), page = await d.js.getPage(pg.index + 1);
    const rotation = (page.rotate + pg.rot) % 360;
    const v1 = page.getViewport({scale: 1, rotation});
    const scale = Math.min(1.6, avail / v1.width);
    vp = page.getViewport({scale, rotation});
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    await page.render({canvas, canvasContext: canvas.getContext("2d"), viewport: vp}).promise;
    ED.rot = rotation;
    const v0 = page.getViewport({scale: 1, rotation: 0}); sizeCache.set(`${pg.doc}:${pg.index}`, [v0.width, v0.height]);
  }
  ED.vp = vp; ED.scale = vp.scale;
  stage.innerHTML = "";
  const box = document.createElement("div"); box.className = "pagebox"; box.style.width = `${vp.width}px`; box.style.height = `${vp.height}px`;
  const layer = document.createElement("div"); layer.className = "layer"; layer.id = "layer";
  box.append(canvas, layer); stage.append(box);
  drawOverlays();
}
/* a viewport for a blank page, with pdf.js's conversions */
function blankViewport(w, h, rot, scale){
  const m = {0: [1, 0, 0, -1, 0, h], 90: [0, 1, 1, 0, 0, 0], 180: [-1, 0, 0, 1, w, 0], 270: [0, -1, -1, 0, h, w]}[rot];
  const t = [m[0] * scale, m[1] * scale, m[2] * scale, m[3] * scale, m[4] * scale, m[5] * scale];
  const W = (rot % 180 ? h : w) * scale, H = (rot % 180 ? w : h) * scale;
  return {width: W, height: H, scale, transform: t,
    convertToViewportPoint: (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]],
    convertToPdfPoint: (x, y) => { const d = t[0] * t[3] - t[1] * t[2]; return [((x - t[4]) * t[3] - (y - t[5]) * t[2]) / d, ((y - t[5]) * t[0] - (x - t[4]) * t[1]) / d]; }};
}
const hex2rgb = h => { const n = parseInt(String(h || "#000000").slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
/* overlays live in PDF space: an anchor (their bottom-left corner as seen), a size in
   points and the angle the page showed at — so a page rotated later carries them along */
function ovScreen(o){
  const [sx, sy] = ED.vp.convertToViewportPoint(o.ax, o.ay);
  return {left: sx, top: sy - o.h * ED.scale, w: o.w * ED.scale, h: o.h * ED.scale, turn: (ED.rot - o.theta + 360) % 360};
}
function drawOverlays(){
  const pg = S.pages.find(p => p.id === S.edit), layer = $("#layer"); if (!pg || !layer) return;
  layer.innerHTML = pg.ov.map(o => {
    const s = ovScreen(o);
    const st = `left:${s.left}px;top:${s.top}px;width:${s.w}px;height:${s.h}px;transform:rotate(${s.turn}deg);`;
    const sel = S.ovSel === o.id ? " sel" : "";
    if (o.type === "text") return `<div class="ov text${sel}" data-o="${o.id}" style="${st}font-size:${o.size * ED.scale}px;color:${o.color};font-weight:${o.bold ? 700 : 400}">${esc(o.text)}<span class="hd"></span></div>`;
    if (o.type === "image") return `<div class="ov${sel}" data-o="${o.id}" style="${st}"><img src="${o.src}"><span class="hd"></span></div>`;
    const fill = o.type === "cover" ? `background:${o.color || "#ffffff"};` : o.type === "highlight" ? `background:${o.color || "#ffe14d"};opacity:${o.opacity ?? 0.4};` : "";
    const border = o.type === "box" ? `border:${Math.max(1, (o.width || 1.5) * ED.scale)}px solid ${o.color || "#9c2f2f"};` : "";
    return `<div class="ov${sel}" data-o="${o.id}" style="${st}${fill}${border}"><span class="hd"></span></div>`;
  }).join("");
  drawProps(); drawOvList();
}
function drawOvList(){
  const pg = S.pages.find(p => p.id === S.edit);
  $("#ovList").innerHTML = pg && pg.ov.length ? pg.ov.map(o => `<div class="li" data-pick="${o.id}"><span class="nm">${esc({text: "Text", highlight: "Highlight", cover: "White-out",
      box: "Box", image: o.sig ? "Signature" : "Image"}[o.type])}${o.type === "text" ? `: ${esc(o.text.slice(0, 30))}` : ""}</span>
      <button class="btn ghost sm" data-delov="${o.id}" title="Remove">✕</button></div>`).join("") : `<span class="hint">Nothing added.</span>`;
}
$("#ovList").addEventListener("click", e => {
  const d = e.target.closest("[data-delov]"); if (d){ delOverlay(d.dataset.delov); return; }
  const p = e.target.closest("[data-pick]"); if (p){ S.ovSel = p.dataset.pick; drawOverlays(); }
});
function delOverlay(id){ const pg = S.pages.find(p => p.id === S.edit); if (!pg) return; snapshot(); pg.ov = pg.ov.filter(o => o.id !== id); S.ovSel = null; drawOverlays(); }
function drawProps(){
  const pg = S.pages.find(p => p.id === S.edit), o = pg?.ov.find(x => x.id === S.ovSel), box = $("#ovProps");
  if (!o){ box.innerHTML = `<p class="hint">${S.tool ? `<b>${esc($(`#edTools [data-t=${S.tool}]`)?.textContent || "")}</b> — ${S.tool === "text" || S.tool === "date" || S.tool === "check" ? "click where it goes." : S.tool === "image" || S.tool === "sig" ? "" : "drag over the page."}`
      : "Pick a tool, then click or drag on the page. Click something you added to change, move (drag) or resize it (corner). It is written into the PDF when you save."}</p>`; return; }
  const col = o.type === "cover" ? "#ffffff" : o.color;
  box.innerHTML = `${o.type === "text" ? `<div class="row"><textarea id="pText" rows="3" style="width:100%">${esc(o.text)}</textarea></div>
      <div class="row"><label class="lbl">Size</label><input type="number" id="pSize" value="${o.size}" min="4" max="200" style="width:60px">
        <label class="f" style="font-size:11.5px"><input type="checkbox" id="pBold" ${o.bold ? "checked" : ""}> Bold</label></div>` : ""}
    ${o.type !== "image" ? `<div class="row"><label class="lbl">Colour</label><input type="color" id="pColor" value="${col || "#000000"}"></div>` : ""}
    ${o.type === "highlight" ? `<div class="row"><label class="lbl">Opacity</label><input type="number" id="pOp" value="${o.opacity ?? 0.4}" min="0.05" max="1" step="0.05" style="width:64px"></div>` : ""}
    <div class="row"><button class="btn sm danger" id="pDel">✕ Remove</button><button class="btn sm" id="pDone">Done</button></div>
    ${o.type === "text" ? `<p class="hint">Standard PDF fonts: letters outside Western European ones are written as “?”.</p>` : ""}`;
  const upd = () => { drawOverlays(); };
  $("#pText")?.addEventListener("input", e => { o.text = e.target.value; o.h = textH(o); o.w = textW(o); refreshOv(o); });
  $("#pSize")?.addEventListener("change", e => { o.size = Math.max(4, +e.target.value || 12); o.h = textH(o); o.w = textW(o); upd(); });
  $("#pBold")?.addEventListener("change", e => { o.bold = e.target.checked; o.w = textW(o); upd(); });
  $("#pColor")?.addEventListener("input", e => { o.color = e.target.value; refreshOv(o); });
  $("#pOp")?.addEventListener("change", e => { o.opacity = +e.target.value; upd(); });
  $("#pDel").onclick = () => delOverlay(o.id);
  $("#pDone").onclick = () => { S.ovSel = null; drawOverlays(); };
}
function refreshOv(o){
  const el = $(`#layer [data-o="${o.id}"]`); if (!el) return;
  const s = ovScreen(o);
  Object.assign(el.style, {left: `${s.left}px`, top: `${s.top}px`, width: `${s.w}px`, height: `${s.h}px`});
  if (o.type === "text"){ el.firstChild.nodeValue = o.text; el.style.color = o.color; }
  else if (o.type === "cover") el.style.background = o.color;
  else if (o.type === "highlight") el.style.background = o.color;
  else if (o.type === "box") el.style.borderColor = o.color;
  drawOvList();
}
/* text metrics: Helvetica, as pdf-lib will write it */
let MEASURE = null;
function textW(o){
  if (!MEASURE) MEASURE = document.createElement("canvas").getContext("2d");
  MEASURE.font = `${o.bold ? "bold " : ""}${o.size}px Helvetica, Arial, sans-serif`;
  return Math.max(...String(o.text || " ").split("\n").map(l => MEASURE.measureText(l || " ").width)) + 2;
}
const textH = o => String(o.text || " ").split("\n").length * o.size * 1.2;
$("#edTools").addEventListener("click", async e => {
  const b = e.target.closest("[data-t]"); if (!b) return;
  const t = b.dataset.t;
  if (!S.edit){ say("Open a page first (double-click one on the Pages tab).", "err"); return; }
  if (t === "image"){
    const r = await api().open_dialog({types: ["Images (*.png;*.jpg;*.jpeg)"]});
    const p = (r?.paths || [])[0]; if (!p) return;
    const f = await readFile(p);
    const mime = /\.png$/i.test(p) ? "image/png" : "image/jpeg";
    placeImage(`data:${mime};base64,${await bytesB64(f.bytes)}`, false); return;
  }
  if (t === "sig"){ sigOpen(); return; }
  S.tool = S.tool === t ? null : t;
  $$("#edTools .btn").forEach(x => x.classList.toggle("on", x.dataset.t === S.tool));
  S.ovSel = null; drawProps();
});
function placeImage(src, sig){
  const pg = S.pages.find(p => p.id === S.edit); if (!pg) return;
  const img = new Image();
  img.onload = () => {
    const maxW = ED.vp.width / ED.scale * 0.4, w = Math.min(maxW, img.width * 0.75), h = w * img.height / img.width;
    const [ax, ay] = ED.vp.convertToPdfPoint(ED.vp.width / 2 - w * ED.scale / 2, ED.vp.height / 2 + h * ED.scale / 2);
    snapshot();
    const o = {id: uid(), type: "image", src, sig, ax, ay, w, h, theta: ED.rot};
    pg.ov.push(o); S.ovSel = o.id; drawOverlays();
    say(sig ? "Signature placed — drag it into place, resize from its corner." : "Image placed — drag it into place, resize from its corner.", "ok");
  };
  img.src = src;
}
/* clicks and drags on the page: new things, moving, resizing */
let gest = null;
$("#stage").addEventListener("mousedown", e => {
  const layer = $("#layer"); if (!layer || !layer.contains(e.target) && e.target !== layer) return;
  const pg = S.pages.find(p => p.id === S.edit), r = layer.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const ovEl = e.target.closest(".ov");
  if (ovEl && !S.tool){
    if (ovEl.isContentEditable) return;
    const o = pg.ov.find(v => v.id === ovEl.dataset.o); S.ovSel = o.id;
    snapshot();
    gest = {kind: e.target.classList.contains("hd") ? "size" : "move", o, x, y, ax: o.ax, ay: o.ay, w: o.w, h: o.h};
    $$("#layer .ov").forEach(v => v.classList.toggle("sel", v.dataset.o === o.id)); drawProps(); drawOvList();
    e.preventDefault(); return;
  }
  if (!S.tool){ S.ovSel = null; drawOverlays(); return; }
  e.preventDefault();
  if (["text", "date", "check"].includes(S.tool)){
    const text = S.tool === "date" ? new Date().toLocaleDateString() : S.tool === "check" ? "✓" : "Text";
    const o = {id: uid(), type: "text", text, size: S.tool === "check" ? 16 : 12, color: "#000000", bold: false, theta: ED.rot, tick: S.tool === "check"};
    o.w = textW(o); o.h = textH(o);
    [o.ax, o.ay] = ED.vp.convertToPdfPoint(x, y + o.h * ED.scale / 2);
    snapshot(); pg.ov.push(o); S.ovSel = o.id; S.tool = null;
    $$("#edTools .btn").forEach(b => b.classList.remove("on")); drawOverlays();
    if (o.text === "Text") setTimeout(() => editText(o), 30);
    return;
  }
  gest = {kind: "new", x, y, type: S.tool};
});
document.addEventListener("mousemove", e => {
  if (!gest) return; const layer = $("#layer"); if (!layer) return;
  const r = layer.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (gest.kind === "new"){
    let g = $("#ghost"); if (!g){ g = document.createElement("div"); g.id = "ghost"; g.className = "ov sel"; layer.append(g); }
    Object.assign(g.style, {left: `${Math.min(x, gest.x)}px`, top: `${Math.min(y, gest.y)}px`, width: `${Math.abs(x - gest.x)}px`, height: `${Math.abs(y - gest.y)}px`,
      background: gest.type === "cover" ? "#fff" : gest.type === "highlight" ? "rgba(255,225,77,.45)" : "transparent", border: gest.type === "box" ? "2px solid #9c2f2f" : ""});
    return;
  }
  const dx = x - gest.x, dy = y - gest.y, o = gest.o;
  if (gest.kind === "move"){
    const [sx, sy] = ED.vp.convertToViewportPoint(gest.ax, gest.ay);
    [o.ax, o.ay] = ED.vp.convertToPdfPoint(sx + dx, sy + dy);
  } else {
    // the handle is the bottom-right corner as seen; the box turns by `turn` about its
    // bottom-left corner (the anchor). Width grows along the box's own x, height along
    // its own "down" — which moves the anchor down with it; the top edge stays put.
    const turn = (ED.rot - o.theta + 360) % 360, rad = turn * Math.PI / 180;
    const lx = dx * Math.cos(rad) + dy * Math.sin(rad), ldown = -dx * Math.sin(rad) + dy * Math.cos(rad);
    o.w = Math.max(6, gest.w + lx / ED.scale);
    o.h = Math.max(6, gest.h + ldown / ED.scale);
    if (o.type === "text"){ o.size = Math.max(4, o.h / (String(o.text).split("\n").length * 1.2)); o.w = textW(o); o.h = textH(o); }
    if (o.type === "image" && !e.shiftKey){ const img = $(`#layer [data-o="${o.id}"] img`); if (img?.naturalWidth) o.h = o.w * img.naturalHeight / img.naturalWidth; }
    const [sx, sy] = ED.vp.convertToViewportPoint(gest.ax, gest.ay), grow = (o.h - gest.h) * ED.scale;
    [o.ax, o.ay] = ED.vp.convertToPdfPoint(sx - grow * Math.sin(rad), sy + grow * Math.cos(rad));
  }
  refreshOv(o);
});
document.addEventListener("mouseup", e => {
  if (!gest) return; const g = gest; gest = null;
  if (g.kind !== "new"){ drawOverlays(); return; }
  $("#ghost")?.remove();
  const layer = $("#layer"), r = layer.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const x0 = Math.min(x, g.x), y0 = Math.min(y, g.y), w = Math.abs(x - g.x), h = Math.abs(y - g.y);
  if (w < 4 || h < 4){ say("Drag over the page to draw it.", "err"); return; }
  const pg = S.pages.find(p => p.id === S.edit);
  const [ax, ay] = ED.vp.convertToPdfPoint(x0, y0 + h);
  const o = {id: uid(), type: g.type, ax, ay, w: w / ED.scale, h: h / ED.scale, theta: ED.rot,
             color: g.type === "cover" ? "#ffffff" : g.type === "highlight" ? "#ffe14d" : "#9c2f2f", opacity: 0.4, width: 1.5};
  snapshot(); pg.ov.push(o); S.ovSel = o.id; drawOverlays();
});
$("#stage").addEventListener("dblclick", e => {
  const el = e.target.closest(".ov.text"); if (!el) return;
  const pg = S.pages.find(p => p.id === S.edit), o = pg.ov.find(v => v.id === el.dataset.o); if (o) editText(o);
});
function editText(o){
  const el = $(`#layer [data-o="${o.id}"]`); if (!el) return;
  el.contentEditable = "true"; el.focus();
  const sel = getSelection(); sel.selectAllChildren(el);
  let ended = false;
  // blur can fire while the layer is being redrawn: finish on the next turn, once
  const done = () => { if (ended) return; ended = true; o.text = (el.innerText || "").replace(/\n$/, "") || " "; o.w = textW(o); o.h = textH(o);
                       setTimeout(() => { el.contentEditable = "false"; drawOverlays(); }); };
  el.addEventListener("blur", done, {once: true});
  el.addEventListener("keydown", ev => { if (ev.key === "Escape"){ ev.preventDefault(); el.blur(); } });
}
$("#edPrev").onclick = () => { const i = S.pages.findIndex(p => p.id === S.edit); if (i > 0){ S.edit = S.pages[i - 1].id; S.ovSel = null; drawEditor(); } };
$("#edNext").onclick = () => { const i = S.pages.findIndex(p => p.id === S.edit); if (i >= 0 && i < S.pages.length - 1){ S.edit = S.pages[i + 1].id; S.ovSel = null; drawEditor(); } };

/* signature pad */
function sigOpen(){
  const c = $("#sigPad"), x = c.getContext("2d"); x.clearRect(0, 0, c.width, c.height);
  $("#sigDlg").classList.add("on");
}
(() => {
  const c = $("#sigPad"), x = c.getContext("2d"); let down = false, last = null;
  const pt = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
  c.addEventListener("pointerdown", e => { down = true; last = pt(e); c.setPointerCapture(e.pointerId); });
  c.addEventListener("pointermove", e => {
    if (!down) return; const p = pt(e);
    x.strokeStyle = $("#sigInk").value; x.lineWidth = 2.6; x.lineCap = "round"; x.lineJoin = "round";
    x.beginPath(); x.moveTo(...last); x.lineTo(...p); x.stroke(); last = p;
  });
  c.addEventListener("pointerup", () => { down = false; });
  $("#sigClear").onclick = () => x.clearRect(0, 0, c.width, c.height);
  $("#sigUse").onclick = () => {
    // crop to the ink
    const d = x.getImageData(0, 0, c.width, c.height).data; let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let yy = 0; yy < c.height; yy++) for (let xx = 0; xx < c.width; xx++) if (d[(yy * c.width + xx) * 4 + 3] > 10){ x0 = Math.min(x0, xx); x1 = Math.max(x1, xx); y0 = Math.min(y0, yy); y1 = Math.max(y1, yy); }
    if (x1 <= x0){ say("Draw a signature first.", "err"); return; }
    const out = document.createElement("canvas"); out.width = x1 - x0 + 8; out.height = y1 - y0 + 8;
    out.getContext("2d").drawImage(c, x0 - 4, y0 - 4, out.width, out.height, 0, 0, out.width, out.height);
    $("#sigDlg").classList.remove("on");
    placeImage(out.toDataURL("image/png"), true);
  };
})();

/* ---------------- writing the PDF ---------------- */
const WINANSI = /[^\x20-\x7e\xa0-\xff\n€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g;
const safeText = t => String(t ?? "").replace(/\r/g, "").replace(/✓/g, "X").replace(WINANSI, "?");
function parseRanges(txt, n){
  const out = new Set(); const s = String(txt || "").trim();
  if (!s) { for (let i = 1; i <= n; i++) out.add(i); return out; }
  for (const part of s.split(/[,;]+/)){
    const m = part.trim().match(/^(\d+)?\s*(?:-\s*(\d+)?)?$/); if (!m || (!m[1] && !m[2])) continue;
    const a = +(m[1] || 1), b = part.includes("-") ? +(m[2] || n) : a;
    for (let i = Math.max(1, a); i <= Math.min(n, b); i++) out.add(i);
  }
  return out;
}
function stampOpts(){
  return {
    pn: $("#pnOn").checked ? {fmt: $("#pnFmt").value || "{n}", pos: $("#pnPos").value, size: +$("#pnSize").value || 10, start: +$("#pnStart").value || 1, skip: $("#pnSkip").checked} : null,
    wm: $("#wmOn").checked && $("#wmText").value.trim() ? {text: $("#wmText").value, size: +$("#wmSize").value || 60, angle: +$("#wmAngle").value || 0, op: +$("#wmOp").value || 0.15, color: $("#wmColor").value} : null,
    hf: $("#hfOn").checked ? {head: $("#hdText").value, foot: $("#ftText").value, align: $("#hfAlign").value, size: +$("#hfSize").value || 9} : null,
    range: $("#stRange").value,
    meta: {title: $("#mdTitle").value, author: $("#mdAuthor").value, subject: $("#mdSubject").value, keywords: $("#mdKeys").value},
    pw: $("#pwOn").checked && $("#pwUser").value ? {user: $("#pwUser").value, owner: $("#pwOwner").value || $("#pwUser").value,
         print: $("#pwPrint").checked, copy: $("#pwCopy").checked, edit: $("#pwEdit").checked} : null,
    small: $("#optSmall").checked, flatten: $("#optFlatten").checked,
  };
}
async function drawOv(out, page, o, fonts){
  const th = o.theta * Math.PI / 180;
  const rot = L.degrees(o.theta);
  if (o.type === "text"){
    const font = o.tick ? fonts.zapf : o.bold ? fonts.bold : fonts.reg, lines = o.tick ? ["4"] : safeText(o.text).split("\n");
    // the first baseline sits one ascent below the box's top edge (local axes turn with theta)
    const up = o.h - o.size * 0.93;
    const x = o.ax - Math.sin(th) * up, y = o.ay + Math.cos(th) * up;
    page.drawText(lines.join("\n"), {x, y, size: o.size, font, color: L.rgb(...hex2rgb(o.color)), rotate: rot, lineHeight: o.size * 1.2});
  } else if (o.type === "image"){
    const bytes = await b64bytes(o.src.split(",", 2)[1]);
    const img = o.src.startsWith("data:image/png") ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    page.drawImage(img, {x: o.ax, y: o.ay, width: o.w, height: o.h, rotate: rot});
  } else if (o.type === "cover" || o.type === "highlight"){
    page.drawRectangle({x: o.ax, y: o.ay, width: o.w, height: o.h, rotate: rot, color: L.rgb(...hex2rgb(o.color)),
                        opacity: o.type === "highlight" ? (o.opacity ?? 0.4) : 1, borderWidth: 0});
  } else if (o.type === "box"){
    page.drawRectangle({x: o.ax, y: o.ay, width: o.w, height: o.h, rotate: rot, borderColor: L.rgb(...hex2rgb(o.color)), borderWidth: o.width || 1.5});
  }
}
/* text placed upright on a page shown at `angle`, at a spot given as fractions of what is seen */
function seenPoint(page, fx, fy){
  const {width: w, height: h} = page.getSize(), r = page.getRotation().angle % 360;
  const W = r % 180 ? h : w, H = r % 180 ? w : h, sx = fx * W, sy = fy * H;    // seen: from bottom-left, y up
  return r === 0 ? [sx, sy] : r === 90 ? [w - sy, sx] : r === 180 ? [w - sx, h - sy] : [sy, h - sx];
}
function seenSize(page){ const {width: w, height: h} = page.getSize(), r = page.getRotation().angle % 360; return r % 180 ? [h, w] : [w, h]; }
function drawSeen(page, text, fx, fy, align, size, font, color, opacity = 1){
  const t = safeText(text), tw = font.widthOfTextAtSize(t, size), [W] = seenSize(page);
  const dx = align === "c" ? -tw / 2 : align === "r" ? -tw : 0;
  const r = page.getRotation().angle % 360;
  const [x, y] = seenPoint(page, fx + dx / W, fy);
  page.drawText(t, {x, y, size, font, color, opacity, rotate: L.degrees(r)});
}
async function build(pages, opts){
  const out = await L.PDFDocument.create();
  const fonts = {reg: await out.embedFont(L.StandardFonts.Helvetica), bold: await out.embedFont(L.StandardFonts.HelveticaBold),
                 zapf: await out.embedFont(L.StandardFonts.ZapfDingbats)};
  // copy each document's pages in one go (shared fonts and images are copied once)
  const want = new Map();
  pages.forEach(p => { if (!p.blank){ if (!want.has(p.doc)) want.set(p.doc, []); want.get(p.doc).push(p.index); } });
  const copied = new Map();
  let k = 0;
  for (const [id, idx] of want){
    const src = await libDoc(docOf(id));
    copied.set(id, await out.copyPages(src, idx));
    prog(++k / (want.size + 1) * 0.6);
  }
  const used = new Map();
  for (const p of pages){
    let page;
    if (p.blank) page = out.addPage([p.blank.w, p.blank.h]);
    else { const n = used.get(p.doc) || 0; used.set(p.doc, n + 1); page = out.addPage(copied.get(p.doc)[n]); }
    if (p.rot) page.setRotation(L.degrees((page.getRotation().angle + p.rot) % 360));
    for (const o of p.ov) await drawOv(out, page, o, fonts);
  }
  const all = out.getPages(), n = all.length, pick = parseRanges(opts.range, n);
  const today = new Date().toLocaleDateString(), file = (docOf(pages.find(p => !p.blank)?.doc)?.name || "").replace(/\.pdf$/i, "");
  const fill = (t, i) => String(t || "").replace(/\{n\}/g, (opts.pn ? opts.pn.start : 1) + i).replace(/\{total\}/g, n)
    .replace(/\{date\}/g, today).replace(/\{file\}/g, file);
  all.forEach((page, i) => {
    if (!pick.has(i + 1)) return;
    const [W, H] = seenSize(page);
    if (opts.wm){
      const font = fonts.bold, t = safeText(opts.wm.text), size = opts.wm.size, tw = font.widthOfTextAtSize(t, size);
      const a = opts.wm.angle * Math.PI / 180, r = page.getRotation().angle % 360;
      const cx = W / 2 - Math.cos(a) * tw / 2 + Math.sin(a) * size / 3, cy = H / 2 - Math.sin(a) * tw / 2 - Math.cos(a) * size / 3;
      const [x, y] = seenPoint(page, cx / W, cy / H);
      page.drawText(t, {x, y, size, font, color: L.rgb(...hex2rgb(opts.wm.color)), opacity: opts.wm.op, rotate: L.degrees(r + opts.wm.angle)});
    }
    if (opts.pn && !(opts.pn.skip && i === 0)){
      const pos = opts.pn.pos, m = 22, fy = pos[0] === "b" ? m / H : 1 - (m + opts.pn.size) / H;
      const fx = pos[1] === "c" ? 0.5 : pos[1] === "r" ? 1 - m / W : m / W;
      drawSeen(page, fill(opts.pn.fmt, i), fx, fy, pos[1], opts.pn.size, fonts.reg, L.rgb(0.2, 0.2, 0.2));
    }
    if (opts.hf){
      const fx = opts.hf.align === "c" ? 0.5 : opts.hf.align === "r" ? 1 - 30 / W : 30 / W;
      if (opts.hf.head) drawSeen(page, fill(opts.hf.head, i), fx, 1 - (18 + opts.hf.size) / H, opts.hf.align, opts.hf.size, fonts.reg, L.rgb(0.3, 0.3, 0.3));
      if (opts.hf.foot) drawSeen(page, fill(opts.hf.foot, i), fx, 10 / H, opts.hf.align, opts.hf.size, fonts.reg, L.rgb(0.3, 0.3, 0.3));
    }
  });
  if (opts.flatten){ try { out.getForm().flatten(); } catch (e){ /* no form */ } }
  const md = opts.meta || {};
  if (md.title) out.setTitle(md.title);
  if (md.author) out.setAuthor(md.author);
  if (md.subject) out.setSubject(md.subject);
  if (md.keywords) out.setKeywords(md.keywords.split(/[,;]/).map(s => s.trim()).filter(Boolean));
  out.setProducer("ColSift"); out.setCreator("ColSift PDF");
  if (opts.pw){
    out.encrypt({userPassword: opts.pw.user, ownerPassword: opts.pw.owner,
                 permissions: {printing: opts.pw.print ? "highResolution" : false, copying: opts.pw.copy, modifying: opts.pw.edit,
                               annotating: opts.pw.edit, fillingForms: true, contentAccessibility: true, documentAssembly: opts.pw.edit}});
  }
  prog(0.8);
  return out.save({useObjectStreams: opts.small !== false});
}
async function saveDoc(pages, why, name){
  if (!pages.length){ say(why === "extract" ? "Select some pages first." : "Open a PDF first.", "err"); return null; }
  await busy(true, `Writing ${pages.length} page${pages.length === 1 ? "" : "s"}…`);
  try {
    // form values typed on the Stamp & protect tab go into their document first
    await applyForm();
    const bytes = await build(pages, stampOpts());
    const first = docOf(pages.find(p => !p.blank)?.doc);
    const base = name || (first ? first.name.replace(/\.pdf$/i, "") + (why === "extract" ? "_pages" : "_edited") : "document");
    const path = await saveFile(bytes, {filename: `${base}.pdf`, folder: outFolder(), types: ["PDF (*.pdf)"], ask: true});
    if (path) say(`Saved ${pages.length} page${pages.length === 1 ? "" : "s"} — ${human(bytes.length)} — ${path}`, "ok");
    return path;
  } catch (e){ say(`Not saved: ${e.message || e}`, "err"); return null; }
  finally { await busy(false); }
}
$("#saveAll").onclick = () => saveDoc(S.pages, "save");
$("#saveSel").onclick = () => saveDoc(selected(), "extract");

/* split */
$("#spGo").onclick = async () => {
  const how = document.querySelector("input[name=sp]:checked").value, n = S.pages.length;
  let groups = [];
  if (how === "each") groups = S.pages.map(p => [p]);
  else if (how === "every"){ const k = Math.max(1, +$("#spN").value || 1); for (let i = 0; i < n; i += k) groups.push(S.pages.slice(i, i + k)); }
  else if (how === "ranges"){
    for (const part of $("#spRanges").value.split(/[,;]+/)){ const set = [...parseRanges(part, n)]; if (set.length) groups.push(set.map(i => S.pages[i - 1])); }
  } else {
    let curG = [];
    S.pages.forEach(p => { if (S.sel.has(p.id) && curG.length){ groups.push(curG); curG = []; } curG.push(p); });
    if (curG.length) groups.push(curG);
  }
  if (!groups.length){ say("Nothing to split — check the ranges.", "err"); return; }
  const f = await api().pick_folder(outFolder());
  const folder = f?.folder || outFolder();
  if (!folder){ say("Pick a folder for the parts.", "err"); return; }
  $("#splitDlg").classList.remove("on");
  await busy(true, `Writing ${groups.length} files…`);
  const base = ($("#spName").value || "part").trim(), digits = String(groups.length).length < 2 ? 2 : String(groups.length).length;
  let done = 0;
  try {
    await applyForm();
    for (const g of groups){
      const bytes = await build(g, stampOpts());
      await saveFile(bytes, {folder, filename: `${base}_${String(done + 1).padStart(digits, "0")}.pdf`});
      done++; prog(done / groups.length);
    }
    say(`Split into ${done} PDFs in ${folder}.`, "ok");
  } catch (e){ say(`Stopped after ${done} files: ${e.message || e}`, "err"); }
  finally { await busy(false); }
};

/* ---------------- forms and properties ---------------- */
async function fillMeta(){
  const d = S.docs[0]; if (!d || $("#mdTitle").dataset.from === d.id) return;
  try {
    const m = (await d.js.getMetadata()).info || {};
    $("#mdTitle").value = m.Title || ""; $("#mdAuthor").value = m.Author || ""; $("#mdSubject").value = m.Subject || ""; $("#mdKeys").value = m.Keywords || "";
    $("#mdTitle").dataset.from = d.id;
  } catch (e){ /* none */ }
}
async function drawForm(){
  const box = $("#formBox"); const rows = [];
  for (const d of S.docs){
    try {
      const lib = await libDoc(d), fields = lib.getForm().getFields();
      fields.slice(0, 200).forEach(f => {
        const kind = f.constructor.name, nm = f.getName();
        if (kind === "PDFTextField") rows.push(`<div class="row"><label class="lbl" style="min-width:120px;text-transform:none;letter-spacing:0" title="${esc(d.name)}">${esc(nm)}</label>
          <input type="text" data-fd="${d.id}" data-fn="${esc(nm)}" value="${esc(f.getText() || "")}" style="flex:1"></div>`);
        else if (kind === "PDFCheckBox") rows.push(`<label class="f" style="font-size:12px;margin:4px 0"><input type="checkbox" data-fd="${d.id}" data-fn="${esc(nm)}" ${f.isChecked() ? "checked" : ""}> ${esc(nm)}</label>`);
      });
    } catch (e){ /* not a form */ }
  }
  box.innerHTML = rows.length ? `<div class="lbl" style="margin:6px 0">Form fields</div>${rows.join("")}` : "";
}
async function applyForm(){
  for (const el of $$("#formBox [data-fd]")){
    const d = docOf(el.dataset.fd); if (!d) continue;
    try {
      const form = (await libDoc(d)).getForm();
      if (el.type === "checkbox"){ const f = form.getCheckBox(el.dataset.fn); el.checked ? f.check() : f.uncheck(); }
      else form.getTextField(el.dataset.fn).setText(el.value);
    } catch (e){ /* field gone */ }
  }
}

/* ---------------- convert ---------------- */
$("#imPick").onclick = async () => {
  const r = await api().open_dialog({multiple: true, types: ["Images (*.png;*.jpg;*.jpeg)"]});
  await imagesToPdf((r?.paths || []).filter(p => /\.(png|jpe?g)$/i.test(p)));
};
$("#imgBtn").onclick = () => $("#imPick").click();
async function imagesToPdf(paths){
  if (!paths.length) return;
  await busy(true, `Making a PDF of ${paths.length} image${paths.length === 1 ? "" : "s"}…`);
  try {
    const out = await L.PDFDocument.create(), how = $("#imPage").value, m = +$("#imMargin").value || 0;
    let i = 0;
    for (const p of paths){
      const f = await readFile(p);
      const img = /\.png$/i.test(p) ? await out.embedPng(f.bytes) : await out.embedJpg(f.bytes);
      const size = how === "a4p" ? [595.28, 841.89] : how === "a4l" ? [841.89, 595.28] : how === "letter" ? [612, 792] : [img.width + 2 * m, img.height + 2 * m];
      const page = out.addPage(size);
      const s = Math.min((size[0] - 2 * m) / img.width, (size[1] - 2 * m) / img.height, how === "fit" ? 1 : Infinity);
      const w = img.width * s, h = img.height * s;
      page.drawImage(img, {x: (size[0] - w) / 2, y: (size[1] - h) / 2, width: w, height: h});
      prog(++i / paths.length);
    }
    const bytes = await out.save();
    const n = await openBytes({bytes, name: `images_${new Date().toISOString().slice(0, 10)}.pdf`}, "");
    drawDocs(); drawGrid(); show("pages");
    say(`${n} image page${n === 1 ? "" : "s"} on the board — Save PDF writes them.`, "ok");
  } catch (e){ say(`Could not make the PDF: ${e.message || e}`, "err"); }
  finally { await busy(false); }
}
$("#rxGo").onclick = async () => {
  const pages = selected().length ? selected() : S.pages;
  if (!pages.length){ say("Open a PDF first.", "err"); return; }
  const f = await api().pick_folder(outFolder()); const folder = f?.folder || outFolder();
  if (!folder){ say("Pick a folder for the images.", "err"); return; }
  const fmt = $("#rxFmt").value, dpi = +$("#rxDpi").value;
  await busy(true, `Drawing ${pages.length} page${pages.length === 1 ? "" : "s"}…`);
  let done = 0;
  try {
    for (const p of pages){
      if (p.blank) continue;
      const d = docOf(p.doc), page = await d.js.getPage(p.index + 1);
      const vp = page.getViewport({scale: dpi / 72, rotation: (page.rotate + p.rot) % 360});
      const c = document.createElement("canvas"); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
      await page.render({canvas: c, canvasContext: x, viewport: vp}).promise;
      const blob = await new Promise(r => c.toBlob(r, `image/${fmt}`, 0.92));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await saveFile(bytes, {folder, filename: `${d.name.replace(/\.pdf$/i, "")}_p${String(p.index + 1).padStart(3, "0")}.${fmt === "jpeg" ? "jpg" : "png"}`, overwrite: false});
      done++; prog(done / pages.length);
    }
    say(`${done} image${done === 1 ? "" : "s"} saved in ${folder}.`, "ok");
  } catch (e){ say(`Stopped after ${done}: ${e.message || e}`, "err"); }
  finally { await busy(false); }
};
/* a page's text as lines: items on one baseline joined left to right, cells where the gap is wide */
async function pageLines(js, n, gap = 12){
  const page = await js.getPage(n), tc = await page.getTextContent();
  const items = tc.items.filter(it => it.str && it.str.trim()).map(it => ({s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || 10}));
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of items){
    const ln = lines.find(l => Math.abs(l.y - it.y) <= Math.max(2, it.h * 0.35));
    ln ? ln.items.push(it) : lines.push({y: it.y, items: [it]});
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map(l => {
    l.items.sort((a, b) => a.x - b.x);
    const cells = []; let cell = null, end = -1e9;
    for (const it of l.items){
      if (cell && it.x - end > gap){ cells.push(cell); cell = null; }
      cell = cell ? cell + (it.x - end > 1.5 ? " " : "") + it.s : it.s;
      end = it.x + it.w;
    }
    if (cell != null) cells.push(cell);
    return cells.map(c => c.replace(/\s+/g, " ").trim());
  });
}
$("#txGo").onclick = async () => {
  if (!S.pages.length){ say("Open a PDF first.", "err"); return; }
  await busy(true, "Reading the text…");
  try {
    const parts = []; let i = 0;
    for (const p of S.pages){
      i++; if (p.blank) continue;
      const lines = await pageLines(docOf(p.doc).js, p.index + 1, 6);
      parts.push(`--- page ${i} ---\n` + lines.map(c => c.join("   ")).join("\n"));
      prog(i / S.pages.length);
    }
    const text = parts.join("\n\n");
    if (!text.replace(/--- page \d+ ---/g, "").trim()){ say("No text in these pages — scanned pages are pictures and need OCR.", "err"); return; }
    const first = S.docs[0]?.name.replace(/\.pdf$/i, "") || "document";
    const path = await saveFile(new TextEncoder().encode(text), {filename: `${first}.txt`, folder: outFolder(), types: ["Text (*.txt)"], ask: true});
    if (path) say(`Text saved — ${path}`, "ok");
  } catch (e){ say(`Could not read the text: ${e.message || e}`, "err"); }
  finally { await busy(false); }
};
$("#tbGo").onclick = async () => {
  if (!S.pages.length){ say("Open a PDF first.", "err"); return; }
  await busy(true, "Reading the tables…");
  try {
    const gap = +$("#tbGap").value || 12, rows = []; let width = 0, i = 0;
    for (const p of S.pages){
      i++; if (p.blank) continue;
      const d = docOf(p.doc);
      for (const cells of await pageLines(d.js, p.index + 1, gap)){
        const r = [...($("#tbFile").checked ? [d.name] : []), ...($("#tbPage").checked ? [String(i)] : []), ...cells];
        rows.push(r); width = Math.max(width, r.length);
      }
      prog(i / S.pages.length);
    }
    if (!rows.length){ say("No text in these pages — scanned pages are pictures and need OCR.", "err"); return; }
    const fixed = ($("#tbFile").checked ? 1 : 0) + ($("#tbPage").checked ? 1 : 0);
    const cols = [...($("#tbFile").checked ? ["FILE"] : []), ...($("#tbPage").checked ? ["PAGE"] : [])];
    for (let k = 1; cols.length < width; k++) cols.push(`COL_${k}`);
    $("#tbPrev").innerHTML = `<table class="hits"><tr>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr>${rows.slice(0, 12).map(r =>
      `<tr>${cols.map((_, j) => `<td>${esc(r[j] || "")}</td>`).join("")}</tr>`).join("")}</table>`;
    const first = S.docs[0]?.name.replace(/\.pdf$/i, "") || "tables";
    const r = await api().write_rows({columns: cols, rows, filename: `${first}_table.xlsx`, folder: outFolder(), sheet: "Table"});
    if (r?.ok) say(`${rows.length.toLocaleString()} rows in ${cols.length - fixed} columns — ${r.path}`, "ok");
    else if (!r?.cancelled) say(r?.error || "Not saved.", "err");
  } catch (e){ say(`Could not read the tables: ${e.message || e}`, "err"); }
  finally { await busy(false); }
};

/* ---------------- search inside PDFs ---------------- */
function matcher(){
  const vals = $("#sqVals").value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const cs = $("#sqCase").checked, mode = $("#sqMode").value, sp = $("#sqSpace").checked;
  const norm = s => { let t = cs ? s : s.toLowerCase(); if (sp) t = t.replace(/\s+/g, ""); return t; };
  const tests = vals.map(v => {
    if (mode === "regex"){ try { const re = new RegExp(v, cs ? "g" : "gi"); return {v, test: line => { re.lastIndex = 0; return re.test(line); }}; } catch (e){ return {v, bad: e.message}; } }
    const nv = norm(v);
    if (mode === "word"){ const re = new RegExp(`(^|[^\\p{L}\\p{N}])${nv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u"); return {v, test: line => re.test(norm(line))}; }
    return {v, test: line => norm(line).includes(nv)};
  });
  return tests;
}
$("#sqGo").onclick = async () => {
  const tests = matcher();
  if (!tests.length){ say("Type the values to look for, one per line.", "err"); return; }
  const bad = tests.find(t => t.bad); if (bad){ say(`Pattern “${bad.v}”: ${bad.bad}`, "err"); return; }
  let targets;
  if ($("#sqScope").value === "open") targets = S.docs.map(d => ({name: d.name, path: d.path, doc: d}));
  else targets = S.folderFiles.filter(f => S.folderTick.has(f.path)).map(f => ({name: f.name, path: f.path}));
  if (!targets.length){ say($("#sqScope").value === "open" ? "Open some PDFs first." : "Tick PDFs in the folder list on the left.", "err"); return; }
  S.hits = []; S.stop = false; const found = new Set(); let pagesRead = 0, files = 0;
  $("#sqStop").style.display = ""; $("#sqGo").disabled = true; $("#sqExport").disabled = true;
  $("#sqOut").innerHTML = ""; $("#sqMiss").innerHTML = "";
  try {
    for (const t of targets){
      if (S.stop) break;
      let js = t.doc?.js, own = false;
      try {
        if (!js){ const f = await readFile(t.path); js = await J.getDocument({data: f.bytes, isEvalSupported: false}).promise; own = true; }
        for (let n = 1; n <= js.numPages && !S.stop; n++){
          const lines = await pageLines(js, n, 6);
          for (const cells of lines){
            const line = cells.join("  ");
            for (const tt of tests) if (tt.test(line)){ S.hits.push({file: t.name, path: t.path, doc: t.doc?.id, page: n, value: tt.v, line}); found.add(tt.v); }
          }
          pagesRead++;
          $("#sqInfo").textContent = `${files + 1} of ${targets.length} files · ${pagesRead.toLocaleString()} pages · ${S.hits.length.toLocaleString()} hits`;
        }
        files++;
      } catch (e){ S.hits.push({file: t.name, path: t.path, page: "", value: "", line: `Could not read: ${e.message || e}`, err: true}); }
      finally { if (own) js?.destroy?.(); }
      prog(files / targets.length);
    }
  } finally { $("#sqStop").style.display = "none"; $("#sqGo").disabled = false; prog(null); }
  const miss = tests.map(t => t.v).filter(v => !found.has(v));
  $("#sqMiss").innerHTML = miss.length ? `<div class="card" style="border-color:#ecd6ac;background:var(--amber-soft)"><b>${miss.length} of ${tests.length} not found:</b>
      <span class="mono" style="font-size:11.5px">${miss.slice(0, 200).map(esc).join(", ")}${miss.length > 200 ? " …" : ""}</span></div>` : "";
  drawHits(); $("#sqExport").disabled = !S.hits.length;
  say(`${S.hits.length.toLocaleString()} hits in ${files} file${files === 1 ? "" : "s"}, ${pagesRead.toLocaleString()} pages${S.stop ? " (stopped)" : ""}.`, "ok");
};
$("#sqStop").onclick = () => { S.stop = true; };
function drawHits(){
  const tests = matcher(), mark = (line, v) => {
    if ($("#sqMode").value === "regex") return esc(line);
    const i = line.toLowerCase().indexOf(v.toLowerCase());
    return i < 0 ? esc(line) : esc(line.slice(0, i)) + `<mark>${esc(line.slice(i, i + v.length))}</mark>` + esc(line.slice(i + v.length));
  };
  const rows = S.hits.slice(0, 3000);
  $("#sqOut").innerHTML = rows.length ? `<table class="hits"><tr><th>File</th><th>Page</th><th>Value</th><th>Line</th></tr>${rows.map((h, i) =>
    `<tr class="${h.err ? "" : "go"}" data-h="${i}"><td>${esc(h.file)}</td><td>${h.page}</td><td class="mono">${esc(h.value)}</td><td>${h.err ? `<span style="color:var(--red)">${esc(h.line)}</span>` : mark(h.line, h.value)}</td></tr>`).join("")}</table>
    ${S.hits.length > rows.length ? `<p class="hint">${rows.length.toLocaleString()} of ${S.hits.length.toLocaleString()} shown — Export has them all.</p>` : ""}` : `<div class="empty">No hits.</div>`;
  void tests;
}
$("#sqOut").addEventListener("click", async e => {
  const tr = e.target.closest("tr.go"); if (!tr) return;
  const h = S.hits[+tr.dataset.h]; if (!h) return;
  let d = h.doc ? docOf(h.doc) : S.docs.find(x => x.path && x.path === h.path);
  if (!d){ await openPaths([h.path]); d = S.docs.find(x => x.path === h.path); }
  const pg = d && S.pages.find(p => p.doc === d.id && p.index === h.page - 1);
  if (pg){ S.sel.clear(); S.sel.add(pg.id); openEditor(pg.id); }
});
$("#sqExport").onclick = async () => {
  const r = await api().write_rows({columns: ["FILE", "PAGE", "VALUE", "LINE", "PATH"], rows: S.hits.map(h => [h.file, String(h.page), h.value, h.line, h.path || ""]),
                                    filename: "pdf_search.xlsx", folder: outFolder(), sheet: "Hits"});
  if (r?.ok) say(`${S.hits.length.toLocaleString()} hits saved — ${r.path}`, "ok"); else if (!r?.cancelled) say(r?.error || "Not saved.", "err");
};

/* ---------------- start ---------------- */
window.pdfApp = {scanFolders, openPaths, addFolder, state: S, build, show, act, stampOpts, saveDoc, pageLines, imagesToPdf};
drawGrid(); scanFolders();
