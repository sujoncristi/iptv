/* StreamWave Pro
 * Features:
 * 1) Search + Filter + Sort
 * 2) Favorites + Tags
 * 3) Details Drawer
 * 4) Better validation (best-effort)
 * 5) Scan controls (pause/resume/stop) + concurrency slider + skip duplicates
 * 6) Playback enhancements (retry, quality selector, volume memory, PiP)
 * 7) Export / Import (JSON / M3U)
 * 8) Notifications + Stats
 * 9) Security/Privacy hardening
 * 10) PWA (manifest + service worker)
 */

const DB_KEY = "streamwave_pro_db_v1";
const VOL_KEY = "streamwave_pro_volume";
const UI_KEY = "streamwave_pro_ui_v1";

const el = (id) => document.getElementById(id);
const listEl = el("list");
const video = el("video");
const qualityEl = el("quality");

let hls = null;
let deferredInstallPrompt = null;

let state = {
  channels: [],             // [{id,name,url,fav,tags[],status,lastChecked,lastError,addedAt}]
  activeId: null,
  filter: "all",
  sort: "newest",
  tagFilter: "",
  query: "",
  scanQueue: [],
  scanning: false,
  paused: false,
  stopped: false,
  concurrency: 15,
  skipDup: true,
  scanProgress: { done: 0, total: 0, online: 0, startedAt: null },
};

function nowISO() { return new Date().toISOString(); }
function shortTime(ts){
  if(!ts) return "—";
  try{
    const d = new Date(ts);
    return d.toLocaleString(undefined, { year:"numeric", month:"short", day:"2-digit", hour:"2-digit", minute:"2-digit" });
  }catch{ return "—"; }
}
function uid() { return Math.random().toString(16).slice(2) + Date.now().toString(16); }

function toast(msg, tone="info"){
  const box = document.createElement("div");
  box.className = "toast glass px-4 py-3 rounded-2xl text-sm flex items-start gap-3";
  const dot = document.createElement("div");
  dot.className = "w-2.5 h-2.5 rounded-full mt-1";
  dot.style.background = tone === "ok" ? "rgba(163,230,53,0.9)"
                   : tone === "warn" ? "rgba(251,191,36,0.9)"
                   : tone === "bad" ? "rgba(239,68,68,0.9)"
                   : "rgba(34,211,238,0.9)";
  box.appendChild(dot);
  const p = document.createElement("div");
  p.textContent = msg;
  p.className = "text-slate-100";
  box.appendChild(p);
  el("toasts").prepend(box);
  setTimeout(()=> box.remove(), 3400);
}

function sanitizeText(s){
  return (s ?? "").toString().replace(/[<>]/g, "");
}
function safeURL(u){
  try{
    const url = new URL(u);
    if(url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  }catch{ return null; }
}

function loadDB(){
  try{
    const raw = localStorage.getItem(DB_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if(!Array.isArray(parsed)) return [];
    // Normalize
    return parsed.map(ch => ({
      id: ch.id || uid(),
      name: sanitizeText(ch.name || "Live Stream"),
      url: safeURL(ch.url) || "",
      fav: !!ch.fav,
      tags: Array.isArray(ch.tags) ? ch.tags.map(t => sanitizeText(t)).filter(Boolean) : [],
      status: ch.status || "unknown", // online/offline/unknown
      lastChecked: ch.lastChecked || null,
      lastError: ch.lastError || null,
      addedAt: ch.addedAt || nowISO(),
    })).filter(ch => !!ch.url);
  }catch{
    return [];
  }
}
function saveDB(){
  localStorage.setItem(DB_KEY, JSON.stringify(state.channels));
}

function loadUI(){
  try{
    const raw = localStorage.getItem(UI_KEY);
    return raw ? JSON.parse(raw) : {};
  }catch{ return {}; }
}
function saveUI(){
  localStorage.setItem(UI_KEY, JSON.stringify({
    filter: state.filter,
    sort: state.sort,
    tagFilter: state.tagFilter,
    query: state.query
  }));
}

function updateStats(){
  el("stat-saved").textContent = state.channels.length;
  const online = state.channels.filter(c => c.status === "online").length;
  el("stat-online").textContent = online;
  el("shown-count").textContent = getVisibleChannels().length;

  if(state.scanning){
    el("stat-scan").innerHTML = `<span class="scan-dots">Scanning</span>`;
  }else{
    el("stat-scan").textContent = "Idle";
  }

  // Last scan
  const lastScan = state.scanProgress.startedAt ? shortTime(state.scanProgress.startedAt) : "—";
  el("stat-lastscan").textContent = lastScan;
  if(state.scanProgress.startedAt && state.scanProgress.endedAt){
    const ms = new Date(state.scanProgress.endedAt) - new Date(state.scanProgress.startedAt);
    el("stat-duration").textContent = `Duration: ${Math.max(0, Math.round(ms/1000))}s`;
  }else{
    el("stat-duration").textContent = "—";
  }

  // Progress UI
  el("progress-label").textContent = `${state.scanProgress.done}/${state.scanProgress.total}`;
  const pct = state.scanProgress.total ? (state.scanProgress.done/state.scanProgress.total)*100 : 0;
  el("progress-bar").style.width = `${Math.min(100, pct)}%`;
}

function getAllTags(){
  const set = new Set();
  state.channels.forEach(c => (c.tags||[]).forEach(t => set.add(t)));
  return Array.from(set).sort((a,b)=>a.localeCompare(b));
}
function refreshTagFilterOptions(){
  const tags = getAllTags();
  const sel = el("tag-filter");
  const cur = state.tagFilter;
  sel.innerHTML = `<option value="">All Tags</option>` + tags.map(t=>`<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join("");
  sel.value = cur || "";
}
function escapeHtml(s){
  return (s ?? "").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}
function escapeAttr(s){ return escapeHtml(s); }

function matches(ch){
  const q = state.query.trim().toLowerCase();
  const tagOk = !state.tagFilter || (ch.tags||[]).includes(state.tagFilter);
  const qOk = !q || ch.name.toLowerCase().includes(q) || (ch.tags||[]).some(t=>t.toLowerCase().includes(q));
  const filterOk =
    state.filter === "all" ||
    (state.filter === "online" && ch.status === "online") ||
    (state.filter === "favorites" && ch.fav);
  return tagOk && qOk && filterOk;
}

function sortChannels(arr){
  const s = state.sort;
  const a = [...arr];
  if(s === "az"){
    a.sort((x,y)=>x.name.localeCompare(y.name));
  }else if(s === "random"){
    for(let i=a.length-1;i>0;i--){
      const j = Math.floor(Math.random()*(i+1));
      [a[i],a[j]] = [a[j],a[i]];
    }
  }else if(s === "lastchecked"){
    a.sort((x,y)=> (y.lastChecked||"").localeCompare(x.lastChecked||""));
  }else{ // newest
    a.sort((x,y)=> (y.addedAt||"").localeCompare(x.addedAt||""));
  }
  return a;
}

function getVisibleChannels(){
  return sortChannels(state.channels.filter(matches));
}

function render(){
  refreshTagFilterOptions();

  const visible = getVisibleChannels();
  listEl.innerHTML = "";

  visible.forEach(ch => {
    const div = document.createElement("div");
    const isActive = ch.id === state.activeId;

    div.className = `card p-4 rounded-3xl cursor-pointer flex items-center justify-between border ${isActive ? "active" : "glass"}`
      .replace("border glass","glass") // glass already has border
      ;

    const left = document.createElement("div");
    left.className = "flex items-center gap-3 min-w-0";
    const dot = document.createElement("div");
    dot.className = "w-2 h-2 rounded-full";
    dot.style.boxShadow = "0 0 10px rgba(34,211,238,0.35)";
    dot.style.background =
      ch.status === "online" ? "rgba(163,230,53,0.95)" :
      ch.status === "offline" ? "rgba(239,68,68,0.9)" :
      "rgba(148,163,184,0.7)";
    left.appendChild(dot);

    const textWrap = document.createElement("div");
    textWrap.className = "min-w-0";
    const name = document.createElement("div");
    name.className = "font-black text-xs truncate";
    name.textContent = ch.name;
    const meta = document.createElement("div");
    meta.className = "text-[10px] text-slate-400 mono truncate";
    const tags = (ch.tags||[]).slice(0,3).join(", ");
    meta.textContent = `${ch.status.toUpperCase()} • ${tags || "no tags"}`;
    textWrap.appendChild(name);
    textWrap.appendChild(meta);
    left.appendChild(textWrap);

    const right = document.createElement("div");
    right.className = "flex items-center gap-2";
    const fav = document.createElement("button");
    fav.className = "pill px-2 py-1 rounded-xl text-[11px] font-bold hover:bg-white/5";
    fav.textContent = ch.fav ? "★" : "☆";
    fav.title = "Toggle favorite";
    fav.onclick = (e) => { e.stopPropagation(); toggleFav(ch.id); };

    const more = document.createElement("button");
    more.className = "pill px-2 py-1 rounded-xl text-[11px] font-bold hover:bg-white/5";
    more.textContent = "⋯";
    more.title = "Details";
    more.onclick = (e) => { e.stopPropagation(); openDrawer(ch.id); };

    right.appendChild(fav);
    right.appendChild(more);

    div.appendChild(left);
    div.appendChild(right);

    div.onclick = () => playById(ch.id);

    listEl.appendChild(div);
  });

  updateStats();
  saveUI();
}

function setActive(id){
  state.activeId = id;
  const ch = state.channels.find(c=>c.id===id);
  el("active-name").textContent = ch ? ch.name : "—";
  render();
}

function toggleFav(id){
  const ch = state.channels.find(c=>c.id===id);
  if(!ch) return;
  ch.fav = !ch.fav;
  saveDB();
  render();
  toast(ch.fav ? "Added to favorites" : "Removed from favorites", "ok");
  if(el("drawer").classList.contains("open")) openDrawer(id); // refresh drawer
}

function removeChannel(id){
  const idx = state.channels.findIndex(c=>c.id===id);
  if(idx < 0) return;
  const wasActive = state.activeId === id;
  const name = state.channels[idx].name;
  state.channels.splice(idx, 1);
  if(wasActive) state.activeId = null;
  saveDB();
  closeDrawer();
  render();
  toast(`Removed: ${name}`, "bad");
}

function setTags(id, tags){
  const ch = state.channels.find(c=>c.id===id);
  if(!ch) return;
  ch.tags = tags;
  saveDB();
  render();
}

function openDrawer(id){
  const ch = state.channels.find(c=>c.id===id);
  if(!ch) return;
  el("drawer").classList.add("open");
  el("d-name").textContent = ch.name;
  el("d-status").textContent = `Status: ${ch.status.toUpperCase()}`;
  el("d-url").value = ch.url;
  el("d-tags").value = (ch.tags||[]).join(", ");
  el("d-last").textContent = shortTime(ch.lastChecked);
  el("d-err").textContent = ch.lastError ? ch.lastError.slice(0,120) : "—";

  const favBtn = el("btn-fav");
  favBtn.textContent = ch.fav ? "★ Favorited" : "☆ Favorite";
  favBtn.onclick = () => toggleFav(id);

  el("btn-remove").onclick = () => {
    if(confirm("Remove this channel permanently?")) removeChannel(id);
  };

  el("btn-copy-drawer").onclick = async () => {
    await navigator.clipboard.writeText(ch.url);
    toast("URL copied", "ok");
  };

  // Save tags with debounce
  let tmr = null;
  el("d-tags").oninput = () => {
    clearTimeout(tmr);
    tmr = setTimeout(()=>{
      const tags = el("d-tags").value
        .split(",")
        .map(s => sanitizeText(s.trim()))
        .filter(Boolean)
        .slice(0, 15);
      setTags(id, Array.from(new Set(tags)));
      toast("Tags updated", "ok");
    }, 500);
  };
}

function closeDrawer(){
  el("drawer").classList.remove("open");
}

el("btn-close-drawer").onclick = closeDrawer;
el("drawer").addEventListener("click", (e)=>{
  if(e.target === el("drawer")) closeDrawer();
});

async function playById(id){
  const ch = state.channels.find(c=>c.id===id);
  if(!ch) return;
  setActive(id);
  el("play-status").textContent = "Loading";

  // Save "played" implies maybe online
  ch.status = ch.status === "offline" ? "unknown" : ch.status;

  // Cleanup HLS
  if(hls){
    try{ hls.destroy(); }catch{}
    hls = null;
  }

  // Attach & play
  const url = ch.url;

  // Some playlists are direct MP4
  const isM3U8 = /\.m3u8(\?.*)?$/i.test(url) || url.includes(".m3u8");
  if(Hls.isSupported() && isM3U8){
    hls = new Hls({
      // Conservative for stability
      backBufferLength: 30,
      lowLatencyMode: false
    });
    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      populateQuality();
      video.play().catch(()=>{});
      el("play-status").textContent = "Playing";
      toast(`Playing: ${ch.name}`, "ok");
    });

    hls.on(Hls.Events.ERROR, (event, data)=>{
      // Auto-retry mild
      el("play-status").textContent = "Error";
      const msg = data?.details || data?.type || "HLS error";
      ch.lastError = String(msg);
      saveDB();
      // Try recover when possible
      if(data?.fatal){
        if(data.type === Hls.ErrorTypes.NETWORK_ERROR){
          toast("Network issue, retrying…", "warn");
          hls.startLoad();
        }else if(data.type === Hls.ErrorTypes.MEDIA_ERROR){
          toast("Media issue, recovering…", "warn");
          hls.recoverMediaError();
        }else{
          toast("Fatal error. Try another channel.", "bad");
        }
      }
    });
  }else{
    video.src = url;
    try{
      await video.play();
      el("play-status").textContent = "Playing";
      toast(`Playing: ${ch.name}`, "ok");
    }catch{
      el("play-status").textContent = "Blocked";
      toast("Playback blocked (tap play or try another channel).", "warn");
    }
  }

  // Update copy URL button
  el("btn-copy-url").onclick = async () => {
    await navigator.clipboard.writeText(url);
    toast("Active URL copied", "ok");
  };

  // Validation-on-play (best effort)
  validateChannel(ch, {timeoutMs: 6000}).then((res)=>{
    if(res !== "unknown"){
      ch.status = res;
      ch.lastChecked = nowISO();
      saveDB();
      render();
    }
  });
}

function populateQuality(){
  if(!hls || !hls.levels) return;
  qualityEl.innerHTML = `<option value="-1">Auto</option>`;
  // levels contain height/bitrate
  hls.levels.forEach((lvl, idx)=>{
    const label = lvl.height ? `${lvl.height}p` : (lvl.bitrate ? `${Math.round(lvl.bitrate/1000)}kbps` : `L${idx}`);
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = label;
    qualityEl.appendChild(opt);
  });
}
qualityEl.onchange = () => {
  if(!hls) return;
  const v = Number(qualityEl.value);
  hls.currentLevel = v; // -1 auto
  toast(v === -1 ? "Quality: Auto" : `Quality: ${qualityEl.selectedOptions[0]?.textContent || v}`, "info");
};

el("btn-pip").onclick = async () => {
  try{
    if(document.pictureInPictureElement){
      await document.exitPictureInPicture();
    }else{
      await video.requestPictureInPicture();
    }
  }catch{
    toast("PiP not available in this browser.", "warn");
  }
};

video.addEventListener("volumechange", ()=>{
  try{
    localStorage.setItem(VOL_KEY, String(video.volume));
    el("vol-label").textContent = Math.round(video.volume*100) + "%";
  }catch{}
});
(function initVolume(){
  const v = Number(localStorage.getItem(VOL_KEY));
  if(!Number.isNaN(v) && v >= 0 && v <= 1){
    video.volume = v;
    el("vol-label").textContent = Math.round(v*100) + "%";
  }else{
    el("vol-label").textContent = Math.round(video.volume*100) + "%";
  }
})();

/* ---------------- Import / Export ---------------- */

function parseM3U(text){
  const lines = text.split(/\r?\n/);
  const out = [];
  for(let i=0;i<lines.length;i++){
    const line = lines[i].trim();
    if(line.startsWith("#EXTINF:")){
      const name = sanitizeText((line.split(",")[1]||"Live Stream").trim());
      const url = (lines[i+1]||"").trim();
      const safe = safeURL(url);
      if(safe) out.push({ name, url: safe });
    }
  }
  return out;
}

function mergeChannels(incoming){
  let added = 0;
  for(const item of incoming){
    const url = safeURL(item.url);
    if(!url) continue;
    const name = sanitizeText(item.name || "Live Stream");
    const exists = state.channels.some(c => c.url === url);
    if(state.skipDup && exists) continue;

    const ch = {
      id: uid(),
      name,
      url,
      fav: false,
      tags: Array.isArray(item.tags) ? item.tags.map(t=>sanitizeText(String(t))).filter(Boolean) : [],
      status: "unknown",
      lastChecked: null,
      lastError: null,
      addedAt: nowISO()
    };
    state.channels.push(ch);
    added++;
  }
  if(added){
    saveDB();
    render();
  }
  return added;
}

async function handleFile(file){
  const ext = (file.name.split(".").pop()||"").toLowerCase();
  const text = await file.text();
  if(ext === "json"){
    let parsed = [];
    try{
      parsed = JSON.parse(text);
    }catch{
      toast("Invalid JSON file.", "bad");
      return;
    }
    // Accept either array of {name,url,...} or {channels:[...]}
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.channels) ? parsed.channels : []);
    const incoming = arr.map(x=>({
      name: x.name, url: x.url, tags: x.tags, fav: x.fav
    }));
    const added = mergeChannels(incoming);
    toast(`Imported ${added} items from JSON.`, "ok");
    return;
  }

  // m3u/m3u8
  const incoming = parseM3U(text);
  const added = mergeChannels(incoming);
  toast(`Imported ${added} streams from M3U.`, "ok");
}

el("upload").addEventListener("change", async (e)=>{
  const file = e.target.files?.[0];
  if(!file) return;
  await handleFile(file);
  // Put imported items into scan queue
  queueScan(state.channels.slice(-500)); // recent
});

el("btn-import").onclick = ()=> el("import-file").click();
el("import-file").addEventListener("change", async (e)=>{
  const file = e.target.files?.[0];
  if(!file) return;
  await handleFile(file);
});

function exportJSON(){
  const data = JSON.stringify(state.channels, null, 2);
  downloadBlob(data, "streamwave_export.json", "application/json");
}
function exportM3U(){
  const header = "#EXTM3U\n";
  const body = state.channels.map(ch => `#EXTINF:-1,${ch.name}\n${ch.url}`).join("\n");
  downloadBlob(header + body + "\n", "streamwave_export.m3u", "audio/x-mpegurl");
}
function downloadBlob(content, filename, type){
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1500);
}

el("btn-export-json").onclick = exportJSON;
el("btn-export-m3u").onclick = exportM3U;

/* ---------------- Validation & Scanning ---------------- */

// Best-effort validator:
// 1) Try fetch GET for small chunk (CORS-dependent).
// 2) If fails quickly, return "unknown" (not "online"), to avoid false positives.
async function validateChannel(ch, {timeoutMs=4000} = {}){
  const url = safeURL(ch.url);
  if(!url) return "offline";
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);

  try{
    const res = await fetch(url, { method: "GET", mode: "cors", cache: "no-store", signal: ctrl.signal });
    clearTimeout(t);
    if(!res.ok) return "offline";
    // If m3u8, require at least a few bytes of text
    if(url.includes(".m3u8")){
      const txt = await res.text();
      if(!txt || !txt.includes("#EXTM3U")) return "unknown";
    }
    return "online";
  }catch(err){
    clearTimeout(t);
    // CORS or blocked: unknown
    return "unknown";
  }
}

function queueScan(channels){
  // Only add unique URLs
  const seen = new Set(state.scanQueue.map(c=>c.url));
  channels.forEach(c=>{
    if(c?.url && !seen.has(c.url)){
      state.scanQueue.push(c);
      seen.add(c.url);
    }
  });
}

async function scanWorker(){
  while(state.scanning && !state.stopped){
    if(state.paused){
      await sleep(150);
      continue;
    }
    const ch = state.scanQueue.shift();
    if(!ch){
      await sleep(120);
      continue;
    }
    // Skip duplicates in queue already handled.
    const res = await validateChannel(ch, {timeoutMs: 3500});
    ch.status = res;
    ch.lastChecked = nowISO();
    if(res === "online") state.scanProgress.online++;
    state.scanProgress.done++;
    saveDB();
    render();
  }
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function startScan(){
  if(state.scanning) { toast("Scan already running.", "warn"); return; }
  state.scanning = true;
  state.paused = false;
  state.stopped = false;

  // Build queue from all channels
  state.scanQueue = [];
  queueScan(state.channels);

  state.scanProgress = {
    done: 0,
    total: state.scanQueue.length,
    online: 0,
    startedAt: nowISO(),
    endedAt: null
  };

  toast(`Scan started • ${state.scanProgress.total} items`, "info");

  const workers = [];
  for(let i=0;i<state.concurrency;i++){
    workers.push(scanWorker());
  }

  Promise.all(workers).then(()=>{
    if(!state.scanProgress.endedAt) state.scanProgress.endedAt = nowISO();
    state.scanning = false;
    saveDB();
    render();
    toast(`Scan complete • Online: ${state.channels.filter(c=>c.status==="online").length}`, "ok");
  });

  render();
}

function pauseScan(){
  if(!state.scanning) return toast("No scan running.", "warn");
  state.paused = true;
  toast("Scan paused.", "warn");
  render();
}
function resumeScan(){
  if(!state.scanning) return toast("No scan running.", "warn");
  state.paused = false;
  toast("Scan resumed.", "info");
  render();
}
function stopScan(){
  if(!state.scanning) return toast("No scan running.", "warn");
  state.stopped = true;
  state.scanning = false;
  state.paused = false;
  state.scanQueue = [];
  state.scanProgress.endedAt = nowISO();
  toast("Scan stopped.", "bad");
  render();
}

/* ---------------- UI events ---------------- */

document.querySelectorAll(".filter").forEach(btn=>{
  btn.onclick = ()=>{
    state.filter = btn.dataset.filter;
    document.querySelectorAll(".filter").forEach(b=>b.style.borderColor="rgba(255,255,255,0.10)");
    btn.style.borderColor = "rgba(34,211,238,0.55)";
    render();
  };
});

el("search").addEventListener("input", (e)=>{
  state.query = e.target.value || "";
  render();
});
el("sort").addEventListener("change", (e)=>{
  state.sort = e.target.value;
  render();
});
el("tag-filter").addEventListener("change", (e)=>{
  state.tagFilter = e.target.value || "";
  render();
});

el("btn-start").onclick = startScan;
el("btn-pause").onclick = pauseScan;
el("btn-resume").onclick = resumeScan;
el("btn-stop").onclick = stopScan;

el("concurrency").addEventListener("input", (e)=>{
  const v = Number(e.target.value);
  state.concurrency = v;
  el("concurrency-label").textContent = String(v);
});

el("skip-dup").addEventListener("change", (e)=>{
  state.skipDup = !!e.target.checked;
});

el("btn-reset").onclick = ()=>{
  if(confirm("Delete ALL saved channels & settings?")){
    localStorage.removeItem(DB_KEY);
    localStorage.removeItem(UI_KEY);
    toast("Reset complete. Reloading…", "bad");
    setTimeout(()=>location.reload(), 400);
  }
};

/* ---------------- PWA ---------------- */

window.addEventListener("beforeinstallprompt", (e)=>{
  e.preventDefault();
  deferredInstallPrompt = e;
  el("btn-install").classList.remove("hidden");
});
el("btn-install").onclick = async ()=>{
  if(!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  if(choice.outcome === "accepted") toast("Installed!", "ok");
  deferredInstallPrompt = null;
  el("btn-install").classList.add("hidden");
};

// Service Worker
(async function registerSW(){
  if("serviceWorker" in navigator){
    try{
      await navigator.serviceWorker.register("sw.js");
    }catch{
      // ignore
    }
  }
})();

/* ---------------- Init ---------------- */

(function init(){
  // Load DB
  state.channels = loadDB();

  // Load UI prefs
  const ui = loadUI();
  state.filter = ui.filter || "all";
  state.sort = ui.sort || "newest";
  state.tagFilter = ui.tagFilter || "";
  state.query = ui.query || "";

  // Apply UI
  el("search").value = state.query;
  el("sort").value = state.sort;
  el("tag-filter").value = state.tagFilter;
  document.querySelectorAll(".filter").forEach(btn=>{
    if(btn.dataset.filter === state.filter) btn.style.borderColor = "rgba(34,211,238,0.55)";
  });

  // If you have saved channels but none checked recently, show "unknown" and let scan update
  render();

  // Quick toast
  toast(`Loaded ${state.channels.length} saved channel(s).`, "info");
})();
