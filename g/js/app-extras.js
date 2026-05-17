// ══════════════════════════════════════════════════
// EXTRAS: KM Markers, Chart, Export
// ══════════════════════════════════════════════════
function updateKmMarkers(){
  if(!map.getSource('vn-km')) return;
  const {coords} = fullRoute;
  if(!kmMarkersOn||coords.length<2){ map.getSource('vn-km').setData(emptyFC()); return; }
  const feats=[];
  let dist=0, nextKm=1;
  for(let i=0;i<coords.length-1;i++){
    const d=haversineM(coords[i],coords[i+1]);
    dist+=d;
    while(dist/1000>=nextKm){
      const t=(nextKm*1000-(dist-d))/d;
      const lng=coords[i][0]+(coords[i+1][0]-coords[i][0])*t;
      const lat=coords[i][1]+(coords[i+1][1]-coords[i][1])*t;
      feats.push({type:'Feature',properties:{label:`${nextKm}km`},geometry:{type:'Point',coordinates:[lng,lat]}});
      nextKm++;
    }
  }
  map.getSource('vn-km').setData({type:'FeatureCollection',features:feats});
}

function toggleKmMarkers(){
  kmMarkersOn=!kmMarkersOn;
  const v=kmMarkersOn?'visible':'none';
  if(map.getLayer('vn-km-dot')) map.setLayoutProperty('vn-km-dot','visibility',v);
  if(map.getLayer('vn-km-lbl')) map.setLayoutProperty('vn-km-lbl','visibility',v);
  document.getElementById('t-km')?.classList.toggle('active',kmMarkersOn);
  document.getElementById('mob-t-km')?.classList.toggle('active',kmMarkersOn);
  updateKmMarkers();
}

function mapFitRoute(){
  if(!fullRoute.coords.length) return;
  const bounds = fullRoute.coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(fullRoute.coords[0], fullRoute.coords[0]));
  map.fitBounds(bounds, {padding: 60, duration: 1200});
}

const wpChartPlugin={
  id:'wpLines',
  beforeDraw(chart){
    if(!window.wpDistKm?.length) return;
    const {ctx,scales:{x,y}} = chart;
    ctx.save();
    ctx.lineWidth=1; ctx.setLineDash([4,4]);
    window.wpDistKm.forEach((d,i)=>{
      if(d===0&&i>0) return;
      const px=x.getPixelForValue(d);
      if(px<x.left||px>x.right) return;
      const col=i===0?'#00e676':i===window.wpDistKm.length-1?'#ff3d6b':'#ffd600';
      ctx.strokeStyle=col;
      ctx.beginPath(); ctx.moveTo(px,y.top); ctx.lineTo(px,y.bottom); ctx.stroke();
      ctx.fillStyle=col; ctx.beginPath(); ctx.arc(px,y.bottom,3,0,Math.PI*2); ctx.fill();
    });
    ctx.restore();
  }
};
// wpChartPlugin passed directly to elevChart, not registered globally

function renderElevChart(){
  const {coords,elevs} = fullRoute;
  const emptyEl = document.getElementById('mob-elev-empty');

  if(elevs.length===0){
    if(elevChart){elevChart.data.datasets[0].data=[];elevChart.update('none');}
    if(emptyEl) emptyEl.style.display='flex';
    return;
  }
  const dists=[0];
  for(let i=0;i<coords.length-1;i++) dists.push(dists[dists.length-1]+haversineM(coords[i],coords[i+1]));
  const N=Math.min(elevs.length,350);
  const step=Math.max(1,Math.floor(elevs.length/N));
  const data=[];
  for(let i=0;i<elevs.length;i+=step){
    const distKm=(dists[Math.min(i,dists.length-1)]||0)/1000;
    data.push({x:distKm,y:Math.round(elevs[i])});
  }

  // Desktop chart
  if(elevChart){ elevChart.data.datasets[0].data=data; elevChart.update('none'); }
  else if(typeof Chart !== 'undefined'){
    const ctx=document.getElementById('elev-canvas').getContext('2d');
    const grad=ctx.createLinearGradient(0,0,0,110);
    grad.addColorStop(0,'rgba(0,212,255,.35)'); grad.addColorStop(1,'rgba(0,212,255,0)');
    elevChart=new Chart(ctx,{
      type:'line',
      plugins:[wpChartPlugin],
      data:{datasets:[{data,fill:true,backgroundColor:grad,borderColor:'#00d4ff',borderWidth:2,pointRadius:0,tension:.4}]},
      options:{
        responsive:true,maintainAspectRatio:false,animation:{duration:350},
        layout:{padding:{left:0,right:0,top:2,bottom:0}},
        plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false,backgroundColor:'rgba(8,12,20,.92)',borderColor:'rgba(255,255,255,.08)',borderWidth:1,titleColor:'#8b9bb4',bodyColor:'#00d4ff',titleFont:{family:'JetBrains Mono',size:10},bodyFont:{family:'JetBrains Mono',size:12,weight:'bold'},callbacks:{title:it=>`${Number(it[0].raw.x).toFixed(2)} km`,label:it=>`${it.raw.y} m ü.NN`}}},
        scales:{
          x:{type:'linear',ticks:{callback:v=>v.toFixed(1)+'km',color:'#4a5568',maxTicksLimit:7,font:{size:9,family:'JetBrains Mono'}},grid:{color:'rgba(255,255,255,.04)'}},
          y:{ticks:{color:'#4a5568',maxTicksLimit:4,font:{size:9,family:'JetBrains Mono'},maxRotation:0},grid:{color:'rgba(255,255,255,.04)'},afterFit(scale){scale.width=38;}}
        },
        onHover:(_,els)=>{ if(els.length){ const v=elevChart.data.datasets[0].data[els[0].index]; setEl('elev-pos',`${v.y}m @ ${v.x.toFixed(2)}km`); } else setEl('elev-pos',''); }
      }
    });
  }

  // Mobile chart
  if(emptyEl) emptyEl.style.display='none';
  const mobCanvas = document.getElementById('mob-elev-chart');
  if(mobCanvas && typeof Chart !== 'undefined'){
    if(mobCanvas._chart){ mobCanvas._chart.data.datasets[0].data=data; mobCanvas._chart.update('none'); }
    else {
      const mctx = mobCanvas.getContext('2d');
      const mgrad = mctx.createLinearGradient(0,0,0,100);
      mgrad.addColorStop(0,'rgba(0,212,255,.3)'); mgrad.addColorStop(1,'rgba(0,212,255,0)');
      mobCanvas._chart = new Chart(mctx,{
        type:'line',
        data:{datasets:[{data,fill:true,backgroundColor:mgrad,borderColor:'#00d4ff',borderWidth:1.5,pointRadius:0,tension:.4}]},
        options:{
          responsive:true,maintainAspectRatio:false,animation:{duration:200},
          layout:{padding:{left:0,right:0,top:4,bottom:0}},
          plugins:{legend:{display:false},tooltip:{enabled:false}},
          scales:{
            x:{type:'linear',ticks:{callback:v=>v.toFixed(0)+'km',color:'#4a5568',maxTicksLimit:5,font:{size:8}},grid:{color:'rgba(255,255,255,.04)'}},
            y:{ticks:{color:'#4a5568',maxTicksLimit:3,font:{size:8},maxRotation:0},grid:{color:'rgba(255,255,255,.04)'},afterFit(sc){sc.width=30;}}
          }
        }
      });
    }
  }
}

function exportGPX(){
  const {coords,elevs} = fullRoute;
  if(coords.length<2){ showToast('Keine Route zum Exportieren'); return; }
  const pts = coords.map((c,i)=>`    <trkpt lat="${c[1].toFixed(7)}" lon="${c[0].toFixed(7)}"><ele>${Math.round(elevs[i]||0)}</ele></trkpt>`).join('\n');
  const gpx=`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GravelGuide 3D" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata><name>GravelGuide Route</name><desc>${fmtDist(fullRoute.dist)} · ↑${Math.round(fullRoute.up)}m</desc></metadata>
  <trk><name>GravelGuide Route</name><trkseg>\n${pts}\n  </trkseg></trk>\n</gpx>`;
  const blob=new Blob([gpx],{type:'application/gpx+xml'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`gravelguide-${new Date().toISOString().slice(0,10)}.gpx`; a.click(); URL.revokeObjectURL(a.href);
  showToast('✓ GPX exportiert');
}

function importGPX(input){
  const file=input.files[0];
  if(!file) return;
  const reader=new FileReader();
  reader.onload=async e=>{
    try {
      const parser=new DOMParser();
      const doc=parser.parseFromString(e.target.result,'application/xml');
      if(doc.querySelector('parsererror')) throw new Error('Parse error');
      let pts=[...doc.querySelectorAll('rtept')];
      if(pts.length<2){
        const all=[...doc.querySelectorAll('trkpt')];
        const step=Math.max(1,Math.floor(all.length/25));
        pts=all.filter((_,i)=>i%step===0||i===all.length-1);
      }
      if(pts.length<2){ showToast('GPX: Zu wenige Punkte'); return; }
      clearAll();
      pts.forEach(p=>{
        const lat=parseFloat(p.getAttribute('lat')),lng=parseFloat(p.getAttribute('lon'));
        if(!isNaN(lat)&&!isNaN(lng)) waypoints.push({lat,lng,label:`P${waypoints.length+1}`, hidden: false, manualLine: false, customCoords: null});
      });
      renderWpMarkers(); renderWpList();
      if(waypoints.length>=2){ map.flyTo({center:[waypoints[0].lng,waypoints[0].lat],zoom:11}); await rerouteAll(); mapFitRoute(); }
      showToast(`✓ ${waypoints.length} Punkte importiert`);
    } catch(err){ showToast('GPX Import fehlgeschlagen'); }
    input.value='';
  };
  reader.readAsText(file);
}

function exportGMaps(){
  if(waypoints.length < 2){ showToast('Mindestens 2 Wegpunkte nötig'); return; }
  // Google Maps supports max 10 stops (origin + 8 waypoints + destination)
  const pts = waypoints.filter((_, i) => i === 0 || i === waypoints.length-1 || waypoints.length <= 10);
  let stops;
  if(waypoints.length <= 10){
    stops = waypoints;
  } else {
    // Sample: start, ~7 intermediate, end
    const step = Math.floor((waypoints.length-2) / 7);
    stops = [waypoints[0]];
    for(let i=step; i<waypoints.length-1; i+=step) stops.push(waypoints[i]);
    stops.push(waypoints[waypoints.length-1]);
    stops = stops.slice(0,10);
  }
  const coords = stops.map(w => `${w.lat.toFixed(6)},${w.lng.toFixed(6)}`);
  const url = `https://www.google.com/maps/dir/${coords.join('/')}`;
  window.open(url, '_blank');
  showToast('✓ Google Maps geöffnet');
}

function saveRoute(){
  if(waypoints.length<2){ showToast('Mindestens 2 Wegpunkte nötig'); return; }
  const deskInp = document.getElementById('save-name-inp');
  const mobInp  = document.getElementById('mob-save-inp');
  const name = (deskInp?.value.trim() || '') || (mobInp?.value.trim() || '') || `Route ${new Date().toLocaleDateString('de-DE')}`;
  const saves = getSaves();
  const id = Date.now();
  
  saves.push({ 
      id, name, date: new Date().toLocaleDateString('de-DE'), 
      wps: waypoints.map(w=>({lat:w.lat, lng:w.lng, label:w.label, hidden:w.hidden, manualLine:w.manualLine, customCoords:w.customCoords})), 
      stats: { dist:fullRoute.dist, up:fullRoute.up } 
  });
  
  if(saves.length>10) saves.splice(0,saves.length-10);
  localStorage.setItem('vn_saves', JSON.stringify(saves));
  if(deskInp) deskInp.value = '';
  if(mobInp)  mobInp.value  = '';
  renderSavesList();
  showToast(`✓ "${name}" gespeichert`);

  // ☁️ Cloud-Speicherung falls eingeloggt
  if(typeof window._awSaveRoute === 'function' && typeof window._awCurrentUser === 'function' && window._awCurrentUser()){
    const w = parseFloat(document.getElementById('weight-inp')?.value || 75);
    const cal = typeof calcCalories === 'function' ? calcCalories(fullRoute.dist, fullRoute.up, w, currentSpeedKmh||15) : 0;
    window._awSaveRoute({
      name,
      distance: Math.round(fullRoute.dist || 0),
      coordinates: fullRoute.coords.slice(0, 200),
      elevation: Math.round(fullRoute.up || 0),
      calories: cal,
      date: new Date().toISOString().slice(0,10),
      weight: w,
      coins: 0
    });
  }
}
function getSaves(){ try { return JSON.parse(localStorage.getItem('vn_saves')||'[]'); } catch(e){ return []; } }

function renderSavesList(){
  const saves=getSaves();
  const html = !saves.length
    ? '<div class="wp-empty" style="padding:14px 0;">Noch keine Routen gespeichert.</div>'
    : saves.slice().reverse().map(s=>`
    <div class="srt-item">
      <button class="srt-load" onclick="loadSavedRoute(${s.id})">
        <div class="srt-name">${s.isRecording ? '<span style="color:var(--red);font-size:9px;margin-right:4px;">⏺ REC</span>' : ''}${s.name}</div>
        <div class="srt-meta">${s.date} · ${fmtDist(s.stats?.dist||0)} · ↑${Math.round(s.stats?.up||0)}m</div>
      </button>
      <button class="srt-del" onclick="deleteSave(${s.id})">🗑</button>
    </div>`).join('');
  const list=document.getElementById('saves-list');
  const mobList=document.getElementById('mob-saves-list');
  if(list) list.innerHTML=html;
  if(mobList) mobList.innerHTML=html;
}
async function loadSavedRoute(id){
  const saves=getSaves();
  const s=saves.find(x=>x.id===id);
  if(!s) return;
  clearAll();

  if(s.rawCoords && s.rawCoords.length >= 2){
    // Aufgezeichnete Route: GPS-Track direkt anzeigen, kein Re-Routing
    // Wegpunkte: gespeicherte km-Marker verwenden, fallback Start+Ziel
    const wpsToLoad = (s.wps && s.wps.length >= 2) ? s.wps : null;
    if(wpsToLoad){
      wpsToLoad.forEach(w => waypoints.push({lat:w.lat,lng:w.lng,label:w.label||'WP',hidden:false,manualLine:false,customCoords:null}));
    } else {
      const first = s.rawCoords[0];
      const last  = s.rawCoords[s.rawCoords.length-1];
      waypoints.push({lat:first[1],lng:first[0],label:'Start',hidden:false,manualLine:false,customCoords:null});
      waypoints.push({lat:last[1], lng:last[0], label:'Ziel', hidden:false,manualLine:false,customCoords:null});
    }
    renderWpMarkers(); renderWpList();
    // Track auf Karte zeichnen
    if(map.getSource('vn-rec-live')){
      map.getSource('vn-rec-live').setData({type:'Feature',geometry:{type:'LineString',coordinates:s.rawCoords}});
    }
    const bounds = s.rawCoords.reduce((b,c)=>b.extend(c), new maplibregl.LngLatBounds(s.rawCoords[0],s.rawCoords[0]));
    map.fitBounds(bounds,{padding:60,duration:1000});
    showToast(`✓ "${s.name}" geladen (${waypoints.length} Wegpunkte)`);
  } else {
    // Normale Route: Wegpunkte laden + neu routen
    s.wps.forEach((w,i)=>{
      waypoints.push({lat:w.lat,lng:w.lng,label:w.label||`P${i+1}`,hidden:!!w.hidden,manualLine:!!w.manualLine,customCoords:w.customCoords||null});
    });
    renderWpMarkers(); renderWpList();
    if(waypoints.length>=2){ map.flyTo({center:[waypoints[0].lng,waypoints[0].lat],zoom:11}); await rerouteAll(); mapFitRoute(); }
    showToast(`✓ "${s.name}" geladen`);
  }
  switchTab('t-route', document.querySelector('.tab-btn:nth-child(1)'));
}
function deleteSave(id){ const saves=getSaves().filter(s=>s.id!==id); localStorage.setItem('vn_saves',JSON.stringify(saves)); renderSavesList(); showToast('Route gelöscht'); }

// ── URL Compress/Decompress (deflate-raw + URL-safe Base64) ───────────────
// Compresses a string ~70% smaller than plain Base64 JSON.
// Uses browser-native CompressionStream (Chrome 80+, Firefox 113+, Safari 16.4+).
async function _compressToB64(str){
  const bytes  = new TextEncoder().encode(str);
  const cs     = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buf    = await new Response(cs.readable).arrayBuffer();
  // URL-safe Base64, no padding
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

async function _decompressFromB64(b64){
  // Restore standard Base64 with padding
  const std = b64.replace(/-/g,'+').replace(/_/g,'/')
    + '==='.slice(0,(4 - b64.length % 4) % 4);
  const bytes = Uint8Array.from(atob(std), c => c.charCodeAt(0));
  try {
    // Try deflate-raw (new compressed format)
    const ds     = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const buf  = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(buf);
  } catch(e){
    // Fallback: plain Base64 (old format without compression)
    return decodeURIComponent(escape(atob(std)));
  }
}

async function shareRoute(){
  if(waypoints.length < 2){ showToast('Mindestens 2 Wegpunkte nötig'); return; }

  // Vollständige Wegpunkt-Daten kodieren (inkl. Labels, Freihand-Segmente)
  const data = waypoints.map(w => {
    const entry = {
      a: parseFloat(w.lat.toFixed(6)),
      o: parseFloat(w.lng.toFixed(6)),
      l: w.label || '',
      h: w.hidden ? 1 : 0,
      m: w.manualLine ? 1 : 0
    };
    // Freihand-Koordinaten mitkodieren (auf max 200 Punkte reduzieren)
    if(w.customCoords && w.customCoords.length >= 2){
      const cc = w.customCoords;
      const step = Math.max(1, Math.floor(cc.length / 200));
      const slim = [];
      for(let i = 0; i < cc.length; i += step) slim.push([parseFloat(cc[i][0].toFixed(5)), parseFloat(cc[i][1].toFixed(5))]);
      if(slim[slim.length-1] !== cc[cc.length-1]){
        const last = cc[cc.length-1];
        slim.push([parseFloat(last[0].toFixed(5)), parseFloat(last[1].toFixed(5))]);
      }
      entry.c = slim;
    }
    return entry;
  });

  let param;
  try {
    const json  = JSON.stringify(data);
    const b64   = await _compressToB64(json);
    param = '?r=' + b64;
  } catch(e) {
    // Fallback: uncompressed base64
    try {
      const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(data))))
        .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
      param = '?r=' + b64;
    } catch(e2){
      param = '?wp=' + waypoints.map(w => `${w.lng.toFixed(5)},${w.lat.toFixed(5)}`).join('|');
    }
  }

  const url = window.location.origin + window.location.pathname + param;
  if(navigator.clipboard){
    navigator.clipboard.writeText(url).then(()=>showToast('🔗 Link kopiert!')).catch(()=>fallbackCopy(url));
  } else {
    fallbackCopy(url);
  }
}

function fallbackCopy(text){ const ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy'); showToast('🔗 Link kopiert!');}catch(e){} document.body.removeChild(ta); }

async function checkURLHash(){
  // ── Neues Format: ?r=<base64> (WhatsApp-kompatibel) ─────────────────────
  // ── Altes Format: #r=<base64> oder #wp=... (rückwärtskompatibel) ────────
  const params = new URLSearchParams(window.location.search);
  const hash   = window.location.hash;

  let b64str = null;
  let legacyWp = null;
  let isNew = false;

  if(params.get('r')){
    b64str = params.get('r');
    isNew  = true;
  } else if(params.get('wp')){
    legacyWp = params.get('wp');
    isNew = true;
  } else if(hash.startsWith('#r=')){
    b64str = hash.slice(3);
  } else if(hash.startsWith('#wp=')){
    legacyWp = hash.slice(4);
  } else {
    return; // no route in URL
  }

  let wps = null;

  if(b64str){
    try {
      const json = await _decompressFromB64(b64str);
      const data = JSON.parse(json);
      wps = data.map(d => ({
        lat:          d.a,
        lng:          d.o,
        label:        d.l || 'WP',
        hidden:       d.h === 1,
        manualLine:   d.m === 1,
        customCoords: d.c || null
      })).filter(w => !isNaN(w.lat) && !isNaN(w.lng));
    } catch(e){
      showToast('⚠️ Link konnte nicht geladen werden');
      return;
    }
  } else if(legacyWp){
    const parts = legacyWp.split('|');
    wps = parts.map((p, i) => {
      const [lng, lat] = p.split(',').map(Number);
      return {lng, lat, label: i === 0 ? 'Start' : i === parts.length-1 ? 'Ziel' : `WP ${i}`, hidden:false, manualLine:false, customCoords:null};
    }).filter(w => !isNaN(w.lat) && !isNaN(w.lng));
  }

  if(!wps || wps.length < 2) return;

  // Clean URL (remove ?r= so reloading doesn't re-trigger)
  if(isNew) history.replaceState(null, '', window.location.pathname);

  waypoints = wps;
  renderWpMarkers();
  renderWpList();
  await sleep(500);
  map.flyTo({center:[waypoints[0].lng, waypoints[0].lat], zoom:11});
  await rerouteAll();
  mapFitRoute();
  showToast(`✓ Route geladen (${waypoints.length} Wegpunkte)`);
}

function toggle3D(){ if(!apiKey){ showToast('Key benötigt'); return; } terrainOn=!terrainOn; map.setTerrain(terrainOn?{source:'dem',exaggeration:+document.getElementById('exag-sl').value}:null); document.getElementById('btn-3d').classList.toggle('active',terrainOn); const m=document.getElementById('mob-btn-3d'); if(m) m.classList.toggle('active',terrainOn); const m2=document.getElementById('mob-btn-3d2'); if(m2) m2.classList.toggle('active',terrainOn); }

function toggleSat(){
  if(!apiKey){ showToast('Key benötigt'); return; }
  satelliteOn = !satelliteOn;
  document.getElementById('btn-sat').classList.toggle('active', satelliteOn);
  const ms=document.getElementById('mob-btn-sat'); if(ms) ms.classList.toggle('active',satelliteOn);

  if(satelliteOn){
    if(!map.getSource('vn-satellite')){
      map.addSource('vn-satellite',{
        type:'raster',
        tiles:[`https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${apiKey}`],
        tileSize:256, maxzoom:20
      });
    }
    // Find the first vn- or route- layer to insert satellite below it
    const firstVnId = (map.getStyle().layers||[]).find(l => l.id.startsWith('vn-') || l.id.startsWith('route-'))?.id;
    if(!map.getLayer('vn-sat-layer')){
      map.addLayer({id:'vn-sat-layer',type:'raster',source:'vn-satellite',paint:{
        'raster-opacity':1,
        'raster-contrast':0.15,
        'raster-saturation':0.2,
        'raster-brightness-min':0.02,
        'raster-brightness-max':1.0,
        'raster-fade-duration':150
      }}, firstVnId||undefined);
    } else {
      map.setLayoutProperty('vn-sat-layer','visibility','visible');
    }
    // Hide base vector/raster layers (keep vn- and route- layers visible)
    (map.getStyle().layers||[]).forEach(l => {
      if(l.id.startsWith('vn-') || l.id.startsWith('route-') || l.id === 'vn-sat-layer') return;
      try { map.setLayoutProperty(l.id,'visibility','none'); } catch(e){}
    });
  } else {
    if(map.getLayer('vn-sat-layer')) map.setLayoutProperty('vn-sat-layer','visibility','none');
    // Restore all base map layers
    (map.getStyle().layers||[]).forEach(l => {
      if(l.id.startsWith('vn-') || l.id.startsWith('route-') || l.id === 'vn-sat-layer') return;
      try { map.setLayoutProperty(l.id,'visibility', mapHidden ? 'none' : 'visible'); } catch(e){}
    });
    // Re-apply layer visibility (roads/paths) without overriding general layers
    const cats = getLayerCats();
    for(const type in cats){
      cats[type].forEach(l => {
        if(map.getLayer(l.id)) map.setLayoutProperty(l.id,'visibility', layerVis[type] ? 'visible' : 'visible'); // default to visible
      });
    }
  }
}

/* --- Mesh Funktion & Matrix Impulses --- */
let meshDots = [];
let meshReq = null;

function initMeshDots() {
    meshDots = [];
    for(let i=0; i<35; i++) {
        meshDots.push({
            isHoriz: Math.random() > 0.5,
            index: Math.floor(Math.random() * 20),
            prog: Math.random(),
            spd: (Math.random() * 0.003 + 0.001) * (Math.random()>0.5?1:-1)
        });
    }
}

function tickMeshDots() {
    if(!meshOn || !map || !map.getSource('vn-mesh-dots')) {
        cancelAnimationFrame(meshReq);
        return;
    }
    const b = map.getBounds();
    const w=b.getWest(), e=b.getEast(), s=b.getSouth(), n=b.getNorth();
    const feats = meshDots.map(d => {
        d.prog += d.spd;
        if(d.prog > 1) d.prog = 0;
        if(d.prog < 0) d.prog = 1;
        let lng = d.isHoriz ? w + (e-w)*d.prog : w + (e-w)*(d.index/20);
        let lat = d.isHoriz ? s + (n-s)*(d.index/20) : s + (n-s)*d.prog;
        return {type:'Feature', geometry:{type:'Point', coordinates:[lng, lat]}};
    });
    map.getSource('vn-mesh-dots').setData({type:'FeatureCollection', features:feats});
    meshReq = requestAnimationFrame(tickMeshDots);
}

window.toggleMesh = function(){ 
  meshOn=!meshOn; 
  const v=meshOn?'visible':'none'; 
  if(map.getLayer('vn-mesh')) map.setLayoutProperty('vn-mesh','visibility',v); 
  if(map.getLayer('vn-mesh-dots')) map.setLayoutProperty('vn-mesh-dots','visibility',v);
  document.getElementById('btn-mesh').classList.toggle('active',meshOn);
  const mm=document.getElementById('mob-btn-mesh'); if(mm) mm.classList.toggle('active',meshOn);
  
  if(meshOn) { 
      updateMesh(); 
      initMeshDots();
      cancelAnimationFrame(meshReq);
      meshReq = requestAnimationFrame(tickMeshDots);
  } else {
      cancelAnimationFrame(meshReq);
  }
};

window.updateMesh = function() {
    if(!meshOn || !map) return;
    const b = map.getBounds();
    const feats = [];
    for(let i=0; i<=20; i++) {
        const lng = b.getWest() + (b.getEast()-b.getWest())*(i/20);
        feats.push({type:'Feature', geometry:{type:'LineString', coordinates:[[lng, b.getSouth()], [lng, b.getNorth()]]}});
        const lat = b.getSouth() + (b.getNorth()-b.getSouth())*(i/20);
        feats.push({type:'Feature', geometry:{type:'LineString', coordinates:[[b.getWest(), lat], [b.getEast(), lat]]}});
    }
    if(map.getSource('vn-mesh')) map.getSource('vn-mesh').setData({type:'FeatureCollection', features:feats});
};

/* --- Map aus/ein togglen --- */
window.toggleHide = function() {
    mapHidden = !mapHidden;
    const style = map.getStyle();
    if(style && style.layers) {
       style.layers.forEach(l => {
           if(!l.id.startsWith('vn-') && !l.id.startsWith('route-') && l.type !== 'background') {
               map.setLayoutProperty(l.id, 'visibility', mapHidden ? 'none' : 'visible');
           }
       });
    }
    document.getElementById('t-hide').classList.toggle('active', mapHidden);
    document.getElementById('mob-t-hide')?.classList.toggle('active', mapHidden);
    applyMapLayers();
};

/* --- Meteo Pause Toggle --- */
window.toggleMeteo = function() {
    meteoPaused = !meteoPaused;
    document.getElementById('t-meteo').classList.toggle('active', meteoPaused);
    document.getElementById('mob-t-meteo')?.classList.toggle('active', meteoPaused);
    showToast(meteoPaused ? "Meteo pausiert (keine Höhenanfragen)" : "Meteo wieder aktiv");
};

function switchTab(id,btn){
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('on'));
  document.getElementById(id)?.classList.add('on');
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  if(id==='t-tools') renderBrouterProfileBtns();
  if(id==='t-profil' && typeof initD2Stats === 'function') setTimeout(initD2Stats, 50);
}
function switchSheetTab(id,btn){
  document.querySelectorAll('.sh-pane').forEach(p=>p.classList.remove('on'));
  document.getElementById(id).classList.add('on');
  document.querySelectorAll('.sh-tab').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  if(id==='st-tools') renderBrouterProfileBtns();
  if(id==='st-profil' && typeof initD2Stats === 'function') setTimeout(initD2Stats, 50);
}

// ── LAYER CYCLE (Satellit → Hybrid → Karte → Satellit → …) ──────────
// Cycle order: 0=Satellit, 1=Hybrid, 2=Karte  — start at Satellit (0)
let layerMode = 0; // 0=Satellit on load
const LAYER_LABELS = ['🛰 Satellit','🌐 Hybrid','🗺 Karte'];
const MOB_LAYER_SVG = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;"><line x1="2" y1="16" x2="16" y2="2" stroke="#00d4ff" stroke-opacity="1"   stroke-width="2.5" stroke-linecap="round"/><line x1="7" y1="17" x2="17" y2="7" stroke="#00d4ff" stroke-opacity="0.55" stroke-width="2.5" stroke-linecap="round"/><line x1="1"  y1="11" x2="11" y2="1" stroke="#00d4ff" stroke-opacity="0.25" stroke-width="2.5" stroke-linecap="round"/></svg>';
function cycleLayerMode(){
  layerMode = (layerMode + 1) % 3;
  const label = LAYER_LABELS[layerMode];
  const btnD = document.getElementById('hdr-layer-btn');
  const btnM = document.getElementById('mob-layer-btn');
  if(btnD) btnD.textContent = label;
  if(btnM) btnM.innerHTML = MOB_LAYER_SVG; // always SVG, never text

  if(layerMode === 2){
    // Karte: Satellit + Hybrid-Overlay ausblenden, Vektorlayer einblenden
    if(map.getLayer('vn-sat-layer')) map.setLayoutProperty('vn-sat-layer','visibility','none');
    hideHybridLabels();
    (map.getStyle().layers||[]).forEach(l=>{
      if(l.id.startsWith('vn-')||l.id.startsWith('route-')) return;
      try{ map.setLayoutProperty(l.id,'visibility', mapHidden?'none':'visible'); }catch(e){}
    });
    satelliteOn = false;
    ortsNamenOn = false;
    document.getElementById('btn-sat')?.classList.remove('active');
    document.getElementById('mob-btn-sat')?.classList.remove('active');
  } else {
    // Satellit (0) oder Hybrid (1): Sat-Layer einschalten
    if(!satelliteOn){ satelliteOn=true; ensureSatLayer(); }
    else{ if(map.getLayer('vn-sat-layer')) map.setLayoutProperty('vn-sat-layer','visibility','visible'); }
    document.getElementById('btn-sat')?.classList.add('active');
    document.getElementById('mob-btn-sat')?.classList.add('active');
    if(layerMode === 1){
      // Hybrid: Label-Overlay drüberlegen
      ortsNamenOn = true;
      ensureHybridLabels();
      document.getElementById('t-ortsnamen')?.classList.add('active');
      document.getElementById('mob-t-ortsnamen')?.classList.add('active');
    } else {
      // Reiner Satellit (0): Labels ausblenden
      ortsNamenOn = false;
      hideHybridLabels();
      document.getElementById('t-ortsnamen')?.classList.remove('active');
      document.getElementById('mob-t-ortsnamen')?.classList.remove('active');
    }
  }
  showToast(label);
}

function ensureSatLayer(){
  if(!apiKey){ showToast('Key benötigt'); layerMode=2; return; }
  if(!map.getSource('vn-satellite')){
    map.addSource('vn-satellite',{
      type:'raster',
      tiles:[`https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${apiKey}`],
      tileSize:256, maxzoom:20
    });
  }
  const firstVn = (map.getStyle().layers||[]).find(l=>l.id.startsWith('vn-')||l.id.startsWith('route-'))?.id;
  if(!map.getLayer('vn-sat-layer')){
    map.addLayer({id:'vn-sat-layer',type:'raster',source:'vn-satellite',paint:{
      'raster-opacity':1,
      'raster-contrast':0.15,
      'raster-saturation':0.2,
      'raster-fade-duration':150   // sanftes Einblenden statt hartem Flackern
    }},firstVn||undefined);
  } else {
    map.setLayoutProperty('vn-sat-layer','visibility','visible');
  }
  (map.getStyle().layers||[]).forEach(l=>{
    if(l.id.startsWith('vn-')||l.id.startsWith('route-')||l.id==='vn-sat-layer') return;
    try{ map.setLayoutProperty(l.id,'visibility','none'); }catch(e){}
  });
}

// ── Hybrid: Vektor-Symbol-Layer über Sat einblenden ──────────────────────────
// Statt eines halbdurchsichtigen Raster-Overlays werden direkt die Symbol-Layer
// (Ortsnamen, Straßennamen) aus dem geladenen Vektorstil reaktiviert.
// → gestochen scharfe, gut lesbare Beschriftungen über dem Satellitenbild.

function ensureHybridLabels(){
  // Alten Raster-Overlay ausblenden
  if(map.getLayer('vn-hybrid-labels')) map.setLayoutProperty('vn-hybrid-labels','visibility','none');

  if(!apiKey){ showToast('API-Key für Hybrid-Labels benötigt'); return; }

  // ── Eigene Vektorkacheln-Quelle für Ortsnamen ──────────────────────────────
  // Wir fügen eine eigenständige pbf-Quelle hinzu und definieren Symbol-Layer
  // explizit on top – unabhängig vom Basis-Stil und dessen Render-Reihenfolge.
  if(!map.getSource('vn-place-src')){
    map.addSource('vn-place-src',{
      type:'vector',
      url:`https://api.maptiler.com/tiles/v3/tiles.json?key=${apiKey}`
    });
  }

  // Konfiguration: [layerId, class-Filter, minzoom, textSize, fontWeight]
  const cfgs = [
    ['vn-lbl-country', ['in','class','country'],          2,  13, 'Bold'],
    ['vn-lbl-state',   ['in','class','state','region'],   5,  12, 'Bold'],
    ['vn-lbl-city',    ['in','class','city'],              6,  13, 'Bold'],
    ['vn-lbl-town',    ['in','class','town'],              9,  12, 'Regular'],
    ['vn-lbl-village', ['in','class','village','hamlet'], 11,  11, 'Regular'],
    ['vn-lbl-suburb',  ['in','class','suburb','quarter'], 13,  10, 'Regular'],
  ];

  cfgs.forEach(([id, filter, minzoom, size, weight])=>{
    if(!map.getLayer(id)){
      map.addLayer({
        id, type:'symbol',
        source:'vn-place-src', 'source-layer':'place',
        minzoom,
        filter,
        layout:{
          'text-field':['coalesce',['get','name:de'],['get','name:en'],['get','name']],
          'text-font':[`Noto Sans ${weight}`,`Open Sans ${weight}`,'Arial Unicode MS Regular'],
          'text-size': size,
          'text-anchor':'center',
          'text-max-width': 8,
          'text-allow-overlap': false,
          'visibility':'visible'
        },
        paint:{
          'text-color':'#ffffff',
          'text-halo-color':'rgba(0,0,0,0.85)',
          'text-halo-width': 1.8,
          'text-halo-blur': 0.5
        }
      });
    } else {
      map.setLayoutProperty(id,'visibility','visible');
    }
  });
}

function hideHybridLabels(){
  if(map.getLayer('vn-hybrid-labels')) map.setLayoutProperty('vn-hybrid-labels','visibility','none');
  ['vn-lbl-country','vn-lbl-state','vn-lbl-city','vn-lbl-town','vn-lbl-village','vn-lbl-suburb'].forEach(id=>{
    if(map.getLayer(id)) map.setLayoutProperty(id,'visibility','none');
  });
  // Ggf. noch vorhandene alte Symbol-Layer wieder verstecken
  (map.getStyle().layers||[]).forEach(l=>{
    if(l.id.startsWith('vn-')||l.id.startsWith('route-')||l.id==='vn-sat-layer') return;
    if(l.type==='symbol'){
      try{ map.setLayoutProperty(l.id,'visibility','none'); }catch(e){}
    }
  });
}

// ── ORTSNAMEN AUF SAT TOGGLE ──────────────────────────
let ortsNamenOn = false;
window.toggleOrtsnamen = function(){
  if(!satelliteOn && layerMode===2){ showToast('Erst Satellit aktivieren'); return; }
  ortsNamenOn = !ortsNamenOn;
  document.getElementById('t-ortsnamen')?.classList.toggle('active', ortsNamenOn);
  document.getElementById('mob-t-ortsnamen')?.classList.toggle('active', ortsNamenOn);
  if(ortsNamenOn){
    layerMode = 1;
    const btnD = document.getElementById('hdr-layer-btn');
    const btnM = document.getElementById('mob-layer-btn');
    if(btnD) btnD.textContent = '🌐 Hybrid';
    if(btnM) btnM.innerHTML = MOB_LAYER_SVG;
    ensureHybridLabels();
    showToast('🌐 Hybrid-Karte (Sat + Labels)');
  } else {
    layerMode = 0;
    const btnD = document.getElementById('hdr-layer-btn');
    const btnM = document.getElementById('mob-layer-btn');
    if(btnD) btnD.textContent = '🛰 Satellit';
    if(btnM) btnM.innerHTML = MOB_LAYER_SVG;
    if(map.getLayer('vn-hybrid-labels')) map.setLayoutProperty('vn-hybrid-labels','visibility','none');
    hideHybridLabels();
    showToast('Ortsnamen ausgeblendet');
  }
};

// ── PROFIL ANALYSE SWITCH ─────────────────────────────
const PA_DATA = {
  w:{ km:'142.3', hm:'1.840', cal:'9.820', tours:'6' },
  m:{ km:'487.2', hm:'5.320', cal:'32.140', tours:'19' },
  y:{ km:'1.247', hm:'14.820', cal:'87.340', tours:'68' }
};
window.switchAnalysis = function(period, btn){
  const d = PA_DATA[period];
  ['km','hm','cal','tours'].forEach(k=>{
    const dEl = document.getElementById('pa-'+k);
    const mEl = document.getElementById('mob-pa-'+k);
    if(dEl) dEl.textContent = d[k];
    if(mEl) mEl.textContent = d[k];
  });
  document.querySelectorAll('#pa-w,#pa-m,#pa-y,#mob-pa-w,#mob-pa-m,#mob-pa-y').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll(`#pa-${period},#mob-pa-${period}`).forEach(b=>b.classList.add('active'));
};

function setSheetState(s){
  sheetState    = Math.max(0, Math.min(1, s));
  sheetExpanded = sheetState >= 1;
  const bs = document.getElementById('bsheet');
  bs.classList.toggle('exp', sheetState === 1);
  bs.classList.remove('max');
}

function toggleSheet(){
  // Handle-click: collapsed ↔ expanded (62vh)
  setSheetState(sheetState === 0 ? 1 : 0);
}

function updateMobBtns(){
  const isMob = window.innerWidth<=860;
  const mbtn = document.getElementById('mob-menu-btn');
  if(mbtn) mbtn.style.display = isMob ? 'block' : 'none';
}
window.addEventListener('resize',updateMobBtns);

function setExag(v){ document.getElementById('exag-v').textContent=Number(v).toFixed(1)+'×'; if(terrainOn&&apiKey) map.setTerrain({source:'dem',exaggeration:+v}); }

function locateMe(){
  if(!navigator.geolocation){ showToast('Geolocation nicht unterstützt'); return; }
  showToast('Sucht Standort…');
  navigator.geolocation.getCurrentPosition(p=>{
    map.flyTo({center:[p.coords.longitude,p.coords.latitude],zoom:14});
  },()=>showToast('Standort fehlgeschlagen'),{enableHighAccuracy:true});
}

function setSpeed(v,btn,prof='casual'){
  if(v){ currentSpeedKmh=v; localStorage.setItem('vn_speed', String(v)); }
  activeProfile=prof;
  document.querySelectorAll('.spd-btn').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  recalcStats();
}

function applyCustomSpeed(){
  const v=+document.getElementById('custom-spd-inp').value;
  if(v>=5&&v<=60){ setSpeed(v,document.getElementById('spd-custom'),'casual'); document.getElementById('spd-custom').textContent=`⚙ ${v}`; }
}

// ══════════════════════════════════════════════════
// NAVIGATION MODE
// ══════════════════════════════════════════════════
let naviActive      = false;
let naviWatchId     = null;
let naviUiInterval  = null;
let naviViewMode    = 0;
let naviStartTime   = null;
let naviRiddenM     = 0;
let naviLastPos     = null;
let naviLastPosPrev = null;
let naviRouteIdx    = 0;
let _naviRiddenCoords   = [];   // grows incrementally — never rebuilt from scratch
let _naviRiddenLastIdx  = -1;   // last fullRoute index already appended
let naviWakeLock    = null;
let naviHideTimer   = null;
let naviAutoReturnTimer = null;
let naviPeekTimer   = null;
let naviBearing     = 0;
let naviUserLastTouch = 0;   // timestamp of last manual map touch during navi
const NAVI_RETURN_MS = 20000; // 20s inactivity → return to follow mode

// ── NAVI ERWEITERUNGEN ────────────────────────────────
let naviPassedWps   = new Set(); // welche WP-Indices bereits passiert wurden
let naviSpeedSamples= [];        // [kmh] letzte Werte für Ø-Berechnung
let naviPreRouteAdded = false;   // wurde Pre-Route-Layer angelegt?

// ── POWER SAVE STATE ─────────────────────────────────
const ps = (() => {
  try { return Object.assign({master:true,gps:true,display:true,cache:true,darkhud:true,noanim:true},
    JSON.parse(localStorage.getItem('vn_ps')||'{}')); } catch(e) {
    return {master:true,gps:true,display:true,cache:true,darkhud:true,noanim:true};
  }
})();
let naviClimbM = 0;
let naviLastElev = null;

// ── ROUTING ENGINE ───────────────────────────────────
let usebrouter      = true;   // BRouter is default
let brouterProfile  = 'trekking';
let touchedWpIdx    = null;   // waypoint index from last touchstart
let touchedWpCoord  = null;   // coordinates of that waypoint
let suppressClick   = false;  // prevents click from firing after touch-popup
let _activePinDrag  = false;  // true while an HTML-marker pin is being dragged (desktop)

const BROUTER_PROFILES = [
  {id:'trekking',     icon:'🚵', label:'Trekking'},
  {id:'fastbike',     icon:'🏎', label:'Rennrad'},
  {id:'shortest',     icon:'📏', label:'Kürzeste'},
  {id:'mtb',          icon:'⛰', label:'MTB'},
  {id:'electric',     icon:'⚡', label:'E-Bike'},
  {id:'hiking-mountain',icon:'🥾',label:'Bergwandern'},
];

async function fetchBRouterSegment(a, b){
  const url = `https://brouter.de/brouter?lonlats=${a.lng},${a.lat}|${b.lng},${b.lat}&profile=${brouterProfile}&alternativeidx=0&format=geojson`;
  const res = await fetch(url);
  const data = await res.json();
  if(!data.features?.length) return null;
  const feat = data.features[0];
  const coords = feat.geometry.coordinates.map(c => [c[0], c[1]]);
  // BRouter returns elevation as 3rd coord (metres*1 or *0.1 depending on version)
  const elevs  = feat.geometry.coordinates.map(c => c[2] != null ? (c[2] > 5000 ? c[2]/10 : c[2]) : null);
  return { coords, elevs };
}

const NAVI_VIEW_LABELS = ['🧭 Nah', '↑ Nord', '▷ Abschn.', '⊞ Gesamt'];

