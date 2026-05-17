// ══════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════
const DEFAULT_KEYS = [
  '0h9bkxDZifPxKncVxFXv',
  'S0822qXR5bPQF7vH1Ycn',
  'zLcWav205anXVDOQZswt'
];
let map, elevChart;
let apiKey = localStorage.getItem('custom_maptiler_key') || DEFAULT_KEYS[0];
let _poolKeyIndex = DEFAULT_KEYS.indexOf(apiKey); // -1 if custom key is active
let limitReachedShown = false;
let waypoints = []; window.waypoints = waypoints;
// Expose live route data for cross-script access (e.g. Appwrite module)
window.getRouteData = () => ({ waypoints, fullRoute, currentSpeedKmh });
let segments = [];
let fullRoute = { coords:[], elevs:[], dist:0, up:0, dn:0, maxGrade:0 };
let warnings = [];
let terrainOn = true, meshOn = false, satelliteOn = true, mapHidden = false, kmMarkersOn = false, meteoPaused = false;
let mapLayerIds = [];
let currentSpeedKmh = parseInt(localStorage.getItem('vn_speed')||'16') || 16;
let activeProfile = 'casual';

// Expose for profile speed slider
window.setSpeedFromProfile = function(sp){
  currentSpeedKmh = sp;
  recalcStats();
};
let prefForest = false;
// 0 = collapsed (peek), 1 = expanded (mid), 2 = maximized (full)
let sheetState    = 0;
let sheetExpanded = false; // true when state >= 1 (backwards compat)
let sheetStartY = 0;
let sheetDragging = false;
window.wpDistKm = [];

// Waypoint View Toggle
let globalWpVisible = true;
let wpMarkers       = [];   // HTML pin markers for waypoints
let osmPinMarkers   = [];   // HTML pin markers for OSM route start points

// Drag & Drop / Freehand state
let dragWpId = null;
let isDraggingWp = false;
let longPressTimer = null;
let isLongPress = false;
let drawModeIdx = -1;
let drawCoords = [];
let searchPin = null;

const PROFILES = {
  casual:{ osrm:'cycling', speed:15 },
  mtb:   { osrm:'foot',    speed:16 },
  road:  { osrm:'cycling', speed:28 }
};

// ══════════════════════════════════════════════════
// ELEVATION CACHE
// ══════════════════════════════════════════════════
const ELC = (() => {
  try { return JSON.parse(localStorage.getItem('vn_el_c') || '{}'); } catch(e) { return {}; }
})();
let elcDirty = false;

function elKey(lat, lng){ return `${lat.toFixed(3)},${lng.toFixed(3)}`; }

function persistElCache(){
  if(!elcDirty) return;
  try {
    const keys = Object.keys(ELC);
    if(keys.length > 3000) keys.slice(0, keys.length-3000).forEach(k => delete ELC[k]);
    localStorage.setItem('vn_el_c', JSON.stringify(ELC));
    elcDirty = false;
  } catch(e){}
}
setInterval(persistElCache, 8000);
window.addEventListener('beforeunload', persistElCache);

async function fetchElevations(coords){
  if(meteoPaused) {
      // Return 0s or cached values to avoid API block
      return smoothElev(coords.map(c => ELC[elKey(c[1],c[0])] || 0), 5);
  }

  const maxSamples = 90;
  const step = Math.max(1, Math.floor(coords.length / maxSamples));
  const sidx = [];
  for(let i=0;i<coords.length;i+=step) sidx.push(i);
  if(sidx[sidx.length-1]!==coords.length-1) sidx.push(coords.length-1);
  const sampled = sidx.map(i=>coords[i]);

  const edata = new Array(sampled.length).fill(null);
  const toFetch = [];

  sampled.forEach((c,si)=>{
    const k = elKey(c[1],c[0]);
    if(ELC[k]!==undefined){ edata[si]=ELC[k]; }
    else toFetch.push({si,c,k});
  });

  for(let ci=0;ci<toFetch.length;ci+=100){
    if(ci>0) await sleep(280);
    const chunk = toFetch.slice(ci,ci+100);
    try {
      const lats = chunk.map(u=>u.c[1].toFixed(6)).join(',');
      const lngs = chunk.map(u=>u.c[0].toFixed(6)).join(',');
      const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`);
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      if(!d.elevation) throw new Error('no data');
      chunk.forEach((u,k)=>{
        const e = d.elevation[k] ?? 0;
        ELC[u.k] = e; edata[u.si] = e; elcDirty = true;
      });
    } catch(err){
      chunk.forEach(u=>{ if(edata[u.si]===null) edata[u.si]=0; });
    }
  }

  const filled = edata.map(v=>v??0);
  const out = [];
  for(let i=0;i<coords.length;i++){
    let lo=0, hi=sidx.length-1;
    for(let j=0;j<sidx.length-1;j++){
      if(sidx[j]<=i && sidx[j+1]>=i){ lo=j; hi=j+1; break; }
    }
    const span = sidx[hi]-sidx[lo];
    const t = span===0 ? 0 : (i-sidx[lo])/span;
    out.push(filled[lo]*(1-t)+filled[hi]*t);
  }
  return smoothElev(out, 5);
}

// ══════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════
const sleep = ms => new Promise(r=>setTimeout(r,ms));

function haversineM(a,b){
  const R=6371000, dLat=(b[1]-a[1])*Math.PI/180, dLng=(b[0]-a[0])*Math.PI/180;
  const x=Math.sin(dLat/2)**2+Math.cos(a[1]*Math.PI/180)*Math.cos(b[1]*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}

function smoothElev(arr, w=5){
  return arr.map((_,i)=>{
    const a=arr.slice(Math.max(0,i-w),i+w+1);
    return a.reduce((s,v)=>s+v,0)/a.length;
  });
}

function lerpColor(c1,c2,t){
  return `rgb(${Math.round(c1[0]+(c2[0]-c1[0])*t)},${Math.round(c1[1]+(c2[1]-c1[1])*t)},${Math.round(c1[2]+(c2[2]-c1[2])*t)})`;
}

function gradeColor(g){
  g=Math.max(-20,Math.min(20,g));
  const stops=[[-15,[123,31,162]],[-5,[25,118,210]],[0,[0,212,255]],[5,[192,202,51]],[10,[245,124,0]],[15,[229,57,53]],[20,[183,28,28]]];
  for(let i=0;i<stops.length-1;i++){
    if(g<=stops[i+1][0]){
      const t=(g-stops[i][0])/(stops[i+1][0]-stops[i][0]);
      return lerpColor(stops[i][1],stops[i+1][1],t);
    }
  }
  return `rgb(183,28,28)`;
}

function fmtDist(m){ return m>=1000?`${(m/1000).toFixed(1)} km`:`${Math.round(m)} m`; }
function fmtTime(sec){
  if(!sec||sec<0) return '—';
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60);
  return h>0?`${h}h ${m<10?'0':''}${m}m`:`${m} min`;
}

function calcCalories(distM, upM, weightKg, speedKmh){
  if(distM<50) return 0;
  const bikeKg = parseFloat(localStorage.getItem('vn_bike_weight')||'12');
  const totalKg = weightKg + bikeKg;
  const met = speedKmh<16?5.8:speedKmh<22?8.5:speedKmh<28?11:14;
  const h = (distM/1000)/speedKmh;
  const base = met*weightKg*h;
  const climb = upM*totalKg*9.81/4186/0.25;
  return Math.round(base+climb);
}

function emptyFC(){ return {type:'FeatureCollection',features:[]}; }
function showToast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2500); }
function showLoad(msg){ document.getElementById('load-txt').textContent=msg||'Lädt…'; document.getElementById('loading').style.display='flex'; }
function hideLoad(){ document.getElementById('loading').style.display='none'; }

// ══════════════════════════════════════════════════
// SEARCH
// ══════════════════════════════════════════════════
let srchTimer = null;
document.getElementById('srch-inp').addEventListener('input', e => {
  const v = e.target.value.trim();
  document.getElementById('srch-clear').style.display = v?'block':'none';
  clearTimeout(srchTimer);
  if(v.length < 2){ hideDrop(); return; }
  srchTimer = setTimeout(() => doSearch(v), 420);
});
document.getElementById('srch-inp').addEventListener('keydown', e => { if(e.key==='Escape') clearSearch(); });

async function doSearch(q){
  try {
    const mapCenter = map ? `&viewbox=${map.getCenter().lng-1},${map.getCenter().lat+1},${map.getCenter().lng+1},${map.getCenter().lat-1}&bounded=0` : '';
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&accept-language=de&addressdetails=1${mapCenter}`);
    const data = await res.json();
    showDrop(data);
  } catch(e){ hideDrop(); }
}

function showDrop(results){
  const drop = document.getElementById('srch-drop');
  if(!results.length){ drop.innerHTML='<div class="sr-item" style="color:var(--muted)"><span class="sr-pin">🔍</span><div><div class="sr-name">Keine Ergebnisse</div></div></div>'; drop.style.display='block'; return; }
  drop.innerHTML = results.map(r => {
    const name = r.display_name.split(',')[0];
    const sub  = r.display_name.split(',').slice(1,3).join(',').trim();
    const icon = r.type==='street'||r.type==='road'?'🛣️':r.class==='place'?'📍':r.class==='natural'?'🌳':'📌';
    return `<div class="sr-item" onclick="selectResult(${r.lat},${r.lon}, '${name.replace(/'/g,"\\'")}')">
      <span class="sr-pin">${icon}</span>
      <div style="min-width:0"><div class="sr-name">${name}</div><div class="sr-sub">${sub}</div></div>
    </div>`;
  }).join('');
  drop.style.display='block';
}

function hideDrop(){ document.getElementById('srch-drop').style.display='none'; }

function clearSearch(){
  document.getElementById('srch-inp').value='';
  document.getElementById('srch-clear').style.display='none';
  hideDrop();
}

window.addWpFromSearch = function(lng, lat) {
    addWaypoint(lng, lat);
    clearSearchPin();
};

window.clearSearchPin = function() {
    if(searchPin) { searchPin.remove(); searchPin = null; }
};

function selectResult(lat, lng, name){
  clearSearch();
  lat=parseFloat(lat); lng=parseFloat(lng);
  map.flyTo({center:[lng,lat],zoom:14,speed:1.8});
  
  if(searchPin) searchPin.remove();
  searchPin = new maplibregl.Marker({color: '#ff3d6b'}).setLngLat([lng, lat]).addTo(map);
  
  const popup = new maplibregl.Popup({closeButton:false, offset:30, anchor:'bottom'})
    .setHTML(`
      <div style="font-family:var(--font);text-align:center;padding:5px;">
        <div style="margin-bottom:8px;font-size:14px;font-weight:600">${name}</div>
        <button class="btn ok" style="width:100%;margin-bottom:5px;justify-content:center" onclick="addWpFromSearch(${lng},${lat})">📍 Als Wegpunkt setzen</button>
        <button class="btn danger" style="width:100%;justify-content:center" onclick="clearSearchPin()">✕ Verwerfen</button>
      </div>
    `);
  searchPin.setPopup(popup).togglePopup();
}

