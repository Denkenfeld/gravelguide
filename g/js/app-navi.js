// ══════════════════════════════════════════════════
// POWER SAVE
// ══════════════════════════════════════════════════
function togglePsMaster(on){
  ps.master = on;
  ['dsk','mob'].forEach(sfx => {
    const opts = document.getElementById(`ps-opts-${sfx}`);
    if(opts) opts.classList.toggle('disabled', !on);
    const cb = document.getElementById(`ps-master-${sfx}`);
    if(cb) cb.checked = on;
  });
  localStorage.setItem('vn_ps', JSON.stringify(ps));
}

function togglePs(key){
  ps[key] = !ps[key];
  const label = ps[key] ? 'AN' : 'AUS';
  ['dsk','mob'].forEach(sfx => {
    const b = document.getElementById(`ps-${key}-${sfx}`);
    if(b){ b.textContent = label; b.className = 'ps-badge' + (ps[key] ? ' on' : ''); }
  });
  localStorage.setItem('vn_ps', JSON.stringify(ps));
}

function psApply(){
  if(!ps.master) return;
  if(ps.darkhud){
    // Remove expensive backdrop-blur from HUD during navi
    const ov = document.getElementById('navi-overlay');
    if(ov) ov.style.cssText += ';--blur:blur(2px)';
    const hud = document.getElementById('navi-hud-bar');
    if(hud) hud.style.backdropFilter = 'none';
    
    
  }
}

function psRestore(){
  const hud = document.getElementById('navi-hud-bar');
  if(hud) hud.style.backdropFilter = '';
  
  
}

async function psCacheTiles(){
  if(naviActive) return;  // never cache tiles during active navigation
  if(!ps.master || !ps.cache || !fullRoute.coords.length) return;
  if(!('caches' in window)) return;
  try {
    const cache = await caches.open('vn-tiles-v1');
    const step = Math.max(1, Math.floor(fullRoute.coords.length / 24));
    const urls = [];
    for(let i = 0; i < fullRoute.coords.length; i += step){
      const [lng, lat] = fullRoute.coords[i];
      for(const z of [13, 14]){
        const x = Math.floor((lng + 180) / 360 * (1 << z));
        const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * (1 << z));
        urls.push(`https://basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`);
        if(apiKey) urls.push(`https://api.maptiler.com/maps/outdoor-v2/${z}/${x}/${y}.png?key=${apiKey}`);
      }
    }
    const unique = [...new Set(urls)].slice(0, 40);
    // Serialise in micro-batches of 4 with a 300 ms gap — avoids memory spike on iOS
    const BATCH = 4, DELAY = 300;
    let cached = 0;
    for(let i = 0; i < unique.length; i += BATCH){
      if(naviActive) break; // abort if user re-started navigation
      const slice = unique.slice(i, i + BATCH);
      await Promise.allSettled(slice.map(url =>
        fetch(url, {mode:'no-cors'}).then(r => { cache.put(url, r); cached++; }).catch(()=>{})
      ));
      if(i + BATCH < unique.length) await new Promise(res => setTimeout(res, DELAY));
    }
    if(cached > 0) showToast(`📦 ${cached} Kacheln gecacht`);
  } catch(e){ console.warn('psCacheTiles:', e); }
}

// Init UI from saved ps state on load
(function psInitUI(){
  document.addEventListener('DOMContentLoaded', () => {
    ['dsk','mob'].forEach(sfx => {
      const cb = document.getElementById(`ps-master-${sfx}`);
      if(cb) cb.checked = ps.master;
      const opts = document.getElementById(`ps-opts-${sfx}`);
      if(opts) opts.classList.toggle('disabled', !ps.master);
      ['gps','display','cache','darkhud','noanim'].forEach(key => {
        const b = document.getElementById(`ps-${key}-${sfx}`);
        if(b){ b.textContent = ps[key] ? 'AN' : 'AUS'; b.className = 'ps-badge' + (ps[key] ? ' on' : ''); }
      });
    });
  });
})();

/* ---------- START / STOP ---------- */
function startNavi(){
  if(fullRoute.coords.length < 2){ showToast('Bitte erst eine Route planen!'); return; }
  if(!navigator.geolocation){ showToast('Kein GPS verfügbar'); return; }

  naviActive     = true;
  naviStartTime  = Date.now();
  naviRiddenM    = 0;
  naviLastPos    = null;
  naviLastPosPrev= null;
  naviRouteIdx   = 0;
  _naviRiddenCoords  = [];
  _naviRiddenLastIdx = -1;
  naviViewMode   = 0;
  naviBearing    = 0;
  naviClimbM     = 0;
  naviLastElev   = null;
  naviPassedWps  = new Set();
  naviSpeedSamples = [];
  naviFabViewState = 0;
  const viewFab = document.getElementById('navi-view-fab');
  if(viewFab) viewFab.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 5.5L8 3.5L14 5.5L20 3.5V17.5L14 19.5L8 17.5L2 19.5V5.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/><path d="M8 3.5V17.5M14 5.5V19.5" stroke="currentColor" stroke-width="1.5"/></svg>';

  // Reset ridden layer
  if(map.getSource('vn-ridden')) map.getSource('vn-ridden').setData(emptyFC());
  if(map.getSource('vn-gps'))    map.getSource('vn-gps').setData(emptyFC());

  document.body.classList.add('navi-mode');
  document.getElementById('navi-overlay').classList.add('active');
  document.getElementById('navi-start-fab').style.display = 'none';
  // Kreis → Richtungs-Teardrop
  if(map.getLayer('vn-gps-dot'))     map.setLayoutProperty('vn-gps-dot',     'visibility','none');
  if(map.getLayer('vn-gps-dot-nav')) map.setLayoutProperty('vn-gps-dot-nav', 'visibility','visible');

  // Mobile: collapse & hide bsheet, show stop button
  if(window.innerWidth <= 860){
    setSheetState(0);
    const mobStop = document.getElementById('mob-navi-stop');
    if(mobStop) mobStop.style.display = 'block';
  }

  // Blur all inputs to prevent iOS Safari "Shake to Undo" dialog
  document.querySelectorAll('input, textarea').forEach(el => { try{ el.blur(); }catch(e){} });

  // Prevent screen sleep
  if('wakeLock' in navigator){
    navigator.wakeLock.request('screen')
      .then(lock => { naviWakeLock = lock; })
      .catch(()=>{});
  }

  // GPS watch — power-save uses 2s/5m (smooth enough, saves battery vs 1s/0m)
  const gpsOpts = (ps.master && ps.gps)
    ? { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
    : { enableHighAccuracy: true, maximumAge: 500,  timeout: 10000 };

  // Fly to current position immediately on start — don't wait for first watchPosition tick
  navigator.geolocation.getCurrentPosition(pos => {
    const {longitude:lng, latitude:lat} = pos.coords;
    naviUserLastTouch = 0; // ensure follow mode is active
    map.flyTo({center:[lng,lat], zoom:16.5, pitch:62, bearing:0, duration:1200, essential:true});
    if(map.getSource('vn-gps')) map.getSource('vn-gps').setData({type:'Feature',geometry:{type:'Point',coordinates:[lng,lat]},properties:{bearing:0}});
    // ── Auto-Route zum ersten Wegpunkt ──────────────────────
    if(waypoints.length >= 1){
      const d = haversineM([lng,lat],[waypoints[0].lng,waypoints[0].lat]);
      if(d > 40 && d < 15000) naviShowPreRoute(lng, lat, waypoints[0].lng, waypoints[0].lat, d);
    }
  }, ()=>{}, {enableHighAccuracy:true, maximumAge:10000, timeout:8000});

  // Suspend background GPS watch during navigation (only one watch needed)
  if(window._bgGpsWatchId != null){
    navigator.geolocation.clearWatch(window._bgGpsWatchId);
    window._bgGpsWatchId = null;
  }

  naviWatchId = navigator.geolocation.watchPosition(
    pos  => naviOnPosition(pos),
    err  => console.warn('GPS error:', err.message),
    gpsOpts
  );

  naviUiInterval = setInterval(naviTickUI, 1000);
  // Make all navi UI elements visible at start, then start the auto-hide timer
  ['navi-top','navi-zoom','navi-speed-bubble','navi-bottom'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ el.style.opacity='1'; el.style.pointerEvents='auto'; }
  });
  naviStartAutoHide();
  updateNaviViewBtn();
  psApply();
  // Tile caching runs AFTER navigation stops (triggered from stopNavi).
  // Do NOT cache during active navigation — it causes a memory spike on iOS.
  showToast('🚴 Navigation gestartet!');
}

function stopNavi(silent){
  naviActive = false;
  if(naviWatchId !== null){ navigator.geolocation.clearWatch(naviWatchId); naviWatchId = null; }
  if(naviUiInterval){  clearInterval(naviUiInterval);  naviUiInterval = null; }
  if(naviWakeLock){    naviWakeLock.release().catch(()=>{}); naviWakeLock = null; }
  clearTimeout(naviHideTimer);
  clearTimeout(naviAutoReturnTimer);
  clearTimeout(naviPeekTimer);

  // Hide watermark logo
  const wm = document.getElementById('navi-watermark-logo');
  if(wm){ wm.classList.remove('show'); }
  // Hide turn-by-turn panel
  const tbtPanel = document.getElementById('navi-turn-panel');
  if(tbtPanel){ tbtPanel.style.opacity='0'; tbtPanel.style.pointerEvents='none'; }
  // Restore UI elements opacity
  ['navi-top','navi-zoom','navi-speed-bubble','navi-bottom'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ el.style.opacity='1'; el.style.pointerEvents='auto'; }
  });
  // Clear auto-reroute ghost layer
  _clearOrigRouteLayer();
  autoRerouteOrigCoords = null;

  document.body.classList.remove('navi-mode');
  document.getElementById('navi-overlay').classList.remove('active');
  // Teardrop → Kreis zurück
  if(map.getLayer('vn-gps-dot-nav')) map.setLayoutProperty('vn-gps-dot-nav','visibility','none');
  if(map.getLayer('vn-gps-dot'))     map.setLayoutProperty('vn-gps-dot',    'visibility','visible');
  // Pre-Route ausblenden
  if(map.getSource('vn-pre-rt')) map.getSource('vn-pre-rt').setData(emptyFC());

  // Mobile: restore bsheet state, hide stop button
  const bs = document.getElementById('bsheet');
  
  const mobStop = document.getElementById('mob-navi-stop');
  if(mobStop) mobStop.style.display = 'none';

  // Show FAB again if route still exists
  const fab = document.getElementById('navi-start-fab');
  if(fab && fullRoute.coords.length >= 2) fab.style.display = 'flex';
  // Restore rec fab if no route
  const recFab = document.getElementById('rec-start-fab');
  if(recFab) recFab.style.display = fullRoute.coords.length >= 2 ? 'none' : 'flex';

  psRestore();

  // Restore background GPS dot watch (if not in REC mode)
  if(!recActive && navigator.geolocation && window._bgGpsWatchId == null){
    window._bgGpsWatchId = navigator.geolocation.watchPosition(pos => {
      if(naviActive) return;
      if(recActive)  return;
      const {longitude:lng, latitude:lat} = pos.coords;
      if(map.getSource('vn-gps'))
        map.getSource('vn-gps').setData({type:'Feature',geometry:{type:'Point',coordinates:[lng,lat]}});
    }, ()=>{}, {enableHighAccuracy:false, maximumAge:15000, timeout:25000});
  }

  if(!silent){
    showToast('Navigation beendet · ' + (naviRiddenM/1000).toFixed(1) + ' km gefahren');
    // ── Route beenden & speichern ──────────────────────────────────────
    // Wenn die Route manuell per ✕ abgebrochen wird, wird sie als
    // "beendet und gespeichert" in den lokalen Saves und ggf. der Cloud
    // abgelegt (sofern mindestens 200m gefahren wurden).
    if(naviRiddenM > 200){
      _naviSaveStoppedRoute();
    }
  }

  // Cache tiles for the ridden area after a brief settle delay (non-silent = user stopped)
  if(!silent) setTimeout(psCacheTiles, 1500);
}

/* ── NAVI PAUSE / RESUME ─────────────────────────────────────── */
let _naviPaused = false;
let _naviPausedData = null; // store runtime data to resume

function pauseNavi(){
  if(!naviActive || _naviPaused) return;
  _naviPaused = true;

  // Store current runtime values
  _naviPausedData = {
    startTime:   naviStartTime,
    riddenM:     naviRiddenM,
    climbM:      naviClimbM,
    routeIdx:    naviRouteIdx,
    riddenCoords: [..._naviRiddenCoords],
    riddenLastIdx: _naviRiddenLastIdx,
    bearing:     naviBearing,
    lastPos:     naviLastPos,
    lastElev:    naviLastElev,
    passedWps:   new Set(naviPassedWps),
    speedSamples:[...naviSpeedSamples]
  };

  // Stop GPS + UI ticker — but keep naviActive = true so state is preserved
  if(naviWatchId !== null){ navigator.geolocation.clearWatch(naviWatchId); naviWatchId = null; }
  if(naviUiInterval){ clearInterval(naviUiInterval); naviUiInterval = null; }

  // Hide navi overlay → back to normal map view
  document.body.classList.remove('navi-mode');
  document.getElementById('navi-overlay').classList.remove('active');

  // Show orange resume FAB where the navi start FAB would be
  document.getElementById('navi-start-fab').style.display = 'none';
  document.getElementById('navi-resume-fab').style.display = 'flex';

  // Restore normal GPS dot
  if(map.getLayer('vn-gps-dot-nav')) map.setLayoutProperty('vn-gps-dot-nav','visibility','none');
  if(map.getLayer('vn-gps-dot'))     map.setLayoutProperty('vn-gps-dot',    'visibility','visible');

  // Wake lock release
  if(naviWakeLock){ try{ naviWakeLock.release(); }catch(e){} naviWakeLock = null; }

  showToast('⏸ Navigation pausiert');
}

function resumeNavi(){
  if(!_naviPaused || !_naviPausedData) return;
  _naviPaused = false;

  // Restore runtime values
  naviStartTime         = _naviPausedData.startTime;
  naviRiddenM           = _naviPausedData.riddenM;
  naviClimbM            = _naviPausedData.climbM;
  naviRouteIdx          = _naviPausedData.routeIdx;
  _naviRiddenCoords     = _naviPausedData.riddenCoords;
  _naviRiddenLastIdx    = _naviPausedData.riddenLastIdx;
  naviBearing           = _naviPausedData.bearing;
  naviLastPos           = _naviPausedData.lastPos;
  naviLastElev          = _naviPausedData.lastElev;
  naviPassedWps         = _naviPausedData.passedWps;
  naviSpeedSamples      = _naviPausedData.speedSamples;
  _naviPausedData       = null;

  // Re-activate overlay
  document.body.classList.add('navi-mode');
  document.getElementById('navi-overlay').classList.add('active');
  document.getElementById('navi-resume-fab').style.display = 'none';
  document.getElementById('navi-start-fab').style.display  = 'none';

  // Re-switch to nav dot
  if(map.getLayer('vn-gps-dot'))     map.setLayoutProperty('vn-gps-dot',    'visibility','none');
  if(map.getLayer('vn-gps-dot-nav')) map.setLayoutProperty('vn-gps-dot-nav','visibility','visible');

  // Wake lock
  if('wakeLock' in navigator){
    navigator.wakeLock.request('screen').then(lock => { naviWakeLock = lock; }).catch(()=>{});
  }

  // Restart GPS + UI ticker
  const gpsOpts = (ps.master && ps.gps)
    ? { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
    : { enableHighAccuracy: true, maximumAge: 500,  timeout: 10000 };
  naviWatchId    = navigator.geolocation.watchPosition(pos => naviOnPosition(pos), err => console.warn('GPS:', err.message), gpsOpts);
  naviUiInterval = setInterval(naviTickUI, 1000);

  ['navi-top','navi-zoom','navi-speed-bubble','navi-bottom'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ el.style.opacity='1'; el.style.pointerEvents='auto'; }
  });
  naviStartAutoHide();
  psApply();
  showToast('▶ Navigation fortgesetzt!');
}

window.pauseNavi = pauseNavi;
window.resumeNavi = resumeNavi;
function _naviSaveStoppedRoute(){
  try {
    const elapsedSec = Math.floor((Date.now() - naviStartTime) / 1000);
    const distKm     = (naviRiddenM / 1000).toFixed(2);
    const avgKmh     = elapsedSec > 0 ? ((naviRiddenM/1000)/(elapsedSec/3600)).toFixed(1) : '0';
    const w          = parseFloat(document.getElementById('weight-inp')?.value||75);
    const cal        = typeof calcCalories === 'function' ? calcCalories(naviRiddenM, naviClimbM, w, parseFloat(avgKmh)||15) : 0;
    const now        = new Date();
    const routeName  = `Tour ${now.toLocaleDateString('de-DE')} ${now.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}`;

    // Lokale Statistik
    const saved = JSON.parse(localStorage.getItem('vn_rides')||'[]');
    saved.unshift({date:now.toISOString().slice(0,10),km:parseFloat(distKm),hm:Math.round(naviClimbM),time:elapsedSec,cal,avgKmh});
    localStorage.setItem('vn_rides', JSON.stringify(saved.slice(0,50)));

    // Cloud-Speicherung falls eingeloggt
    if(typeof window._awSaveRoute === 'function' && typeof window._awCurrentUser === 'function' && window._awCurrentUser()){
      window._awSaveRoute({
        name: routeName,
        distance: Math.round(naviRiddenM),
        coordinates: (_naviRiddenCoords||[]).slice(0,200),
        waypoints: waypoints.map(wp=>({lat:wp.lat,lng:wp.lng,label:wp.label||''})),
        elevation: Math.round(naviClimbM),
        calories: cal,
        date: now.toISOString().slice(0,10),
        weight: w,
        ridetime: Math.round(elapsedSec/60),
        speed: parseFloat(avgKmh)||0
      });
      showToast('✅ Route gespeichert');
    }
  } catch(e){ console.warn('_naviSaveStoppedRoute:', e); }
}

/* ---------- GPS POSITION HANDLER ---------- */
function naviOnPosition(pos){
  const { latitude:lat, longitude:lng, speed, accuracy } = pos.coords;
  const now = [lng, lat];
  const nowTime = Date.now();

  // Throttle: ignore updates faster than 800ms to avoid hammering MapLibre on iOS
  if(naviOnPosition._lastTs && (nowTime - naviOnPosition._lastTs) < 800) return;
  naviOnPosition._lastTs = nowTime;

  // Heading — primär: GPS-Kompass (pos.coords.heading), sekundär: berechneter Kurs
  const gpsHeading = pos.coords.heading;
  const gpsSpeed   = pos.coords.speed; // m/s, kann null sein
  const isMoving   = (gpsSpeed != null && gpsSpeed > 0.3) || (naviLastPos && haversineM(naviLastPos, now) > 8);

  if(isMoving){
    if(gpsHeading != null && !isNaN(gpsHeading) && gpsHeading >= 0){
      // GPS-Chip liefert direkt den Kurs → genaueste Quelle
      naviBearing = gpsHeading;
    } else if(naviLastPos){
      // Fallback: Kurs aus Positions-Differenz berechnen
      naviBearing = calcBearing(naviLastPos, now);
    }
  }

  // Accumulate distance
  if(naviLastPos){
    const d = haversineM(naviLastPos, now);
    if(d < 80) naviRiddenM += d;
  }

  // Elevation gain
  const alt = pos.coords.altitude;
  if(alt !== null && alt !== undefined){
    if(naviLastElev !== null && alt > naviLastElev + 0.5) naviClimbM += (alt - naviLastElev);
    naviLastElev = alt;
  }

  naviLastPosPrev = naviLastPos;
  naviLastPos     = now;

  // Route progress
  naviRouteIdx = naviNearestIdx(now);

  // ── Auto-Reroute prüfen ────────────────────────────────────────────────
  autoRerouteCheck(now);

  // ── Turn-by-Turn Pfeil aktualisieren (immer berechnen, Sichtbarkeit via naviStartAutoHide) ──
  naviUpdateTurnArrow();

  // ── Wegpunkt-Passage prüfen ──────────────────────────
  naviCheckWpPassage(now);

  // GPS dot (bearing für Richtungs-Layer)
  if(map.getSource('vn-gps')){
    map.getSource('vn-gps').setData({type:'Feature',geometry:{type:'Point',coordinates:now},properties:{bearing:naviBearing}});
  }

  // Ridden track — incremental append, never rebuild full array
  if(map.getSource('vn-ridden') && naviRouteIdx >= 1){
    if(naviRouteIdx > _naviRiddenLastIdx){
      const from = Math.max(0, _naviRiddenLastIdx + 1);
      for(let i = from; i <= naviRouteIdx; i++){
        _naviRiddenCoords.push(fullRoute.coords[i]);
      }
      _naviRiddenLastIdx = naviRouteIdx;
      map.getSource('vn-ridden').setData({
        type:'Feature',
        geometry:{type:'LineString', coordinates: _naviRiddenCoords}
      });
    }
  }

  // Speed display (jetzt im oberen HUD)
  const kmh = (speed != null && speed >= 0) ? Math.round(speed * 3.6) : null;
  const speedEl = document.getElementById('navi-speed');
  if(speedEl) speedEl.textContent = kmh !== null ? `${kmh}` : '—';

  // ── CAMERA FOLLOW ─────────────────────────────────
  // Follow if: user hasn't touched the map, OR 20s have passed since last touch
  const sinceTouch = nowTime - naviUserLastTouch;
  const shouldFollow = naviUserLastTouch === 0 || sinceTouch >= NAVI_RETURN_MS;

  if(shouldFollow){
    // Snap back mode label if we were in explore mode
    if(naviViewMode !== 0){
      naviViewMode = 0;
      updateNaviViewBtn();
      if(naviUserLastTouch > 0) showToast('↩ Navi-Ansicht wiederhergestellt');
    }
    // Only animate camera when position or bearing changed meaningfully —
    // avoids stacking easeTo calls on iOS when GPS jitters in place
    const movedEnough   = !naviOnPosition._camPos || haversineM(naviOnPosition._camPos, now) > 3;
    const bearingShifted = Math.abs(naviBearing - (naviOnPosition._camBearing || 0)) > 2;
    if(movedEnough || bearingShifted){
      naviOnPosition._camPos     = now;
      naviOnPosition._camBearing = naviBearing;
      map.easeTo({center:now, zoom:16.5, pitch:62, bearing:naviBearing, duration:600, easing:t=>t, essential:true});
    }
  }
}

function naviNearestIdx(pos){
  const coords = fullRoute.coords;
  if(!coords.length) return 0;
  let minD = Infinity, minI = naviRouteIdx;
  const start = Math.max(0, naviRouteIdx - 30);
  const end   = Math.min(coords.length - 1, naviRouteIdx + 120);
  for(let i = start; i <= end; i++){
    const d = haversineM(pos, coords[i]);
    if(d < minD){ minD = d; minI = i; }
  }
  return minI;
}

/* ---------- UI TICK (every 1s) ---------- */
function naviTickUI(){
  if(!naviActive) return;

  // Elapsed time
  const elapsedSec = Math.floor((Date.now() - naviStartTime) / 1000);
  const h = Math.floor(elapsedSec / 3600);
  const m = Math.floor((elapsedSec % 3600) / 60);
  const s = elapsedSec % 60;
  const elStr = h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
  setEl('navi-elapsed', elStr);

  // Distances
  const remainM = Math.max(0, fullRoute.dist - naviRiddenM);
  setEl('navi-remain', (remainM / 1000).toFixed(1));
  setEl('navi-ridden', (naviRiddenM / 1000).toFixed(1));
  setEl('navi-climb',  Math.round(naviClimbM));

  // Calories: ~40 kcal/km (moderate cycling)
  const kcal = Math.round((naviRiddenM / 1000) * 40);
  setEl('navi-cal-hud', kcal);
}

let naviFabViewState = 0; // 0=follow, 1=full route

function cycleNaviViewFab(){
  naviFabViewState = naviFabViewState === 0 ? 1 : 0;
  const btn = document.getElementById('navi-view-fab');
  if(naviFabViewState === 1){
    // Show full route
    naviUserLastTouch = Date.now();
    mapFitRoute();
    map.easeTo({pitch:0, bearing:0, duration:800, essential:true});
    if(btn) btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11 2C7.686 2 5 4.686 5 8c0 4.5 6 12 6 12s6-7.5 6-12c0-3.314-2.686-6-6-6Z" stroke="currentColor" stroke-width="1.5" fill="rgba(0,212,255,0.18)"/><circle cx="11" cy="8" r="2.2" fill="currentColor"/></svg>';
    naviViewMode = 3;
    updateNaviViewBtn();
  } else {
    // Snap back to follow
    naviUserLastTouch = 0;
    naviViewMode = 0;
    updateNaviViewBtn();
    if(btn) btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 5.5L8 3.5L14 5.5L20 3.5V17.5L14 19.5L8 17.5L2 19.5V5.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/><path d="M8 3.5V17.5M14 5.5V19.5" stroke="currentColor" stroke-width="1.5"/></svg>';
    if(naviLastPos){
      map.easeTo({center:naviLastPos, zoom:16.5, pitch:62, bearing:naviBearing, duration:800, easing:t=>t, essential:true});
    }
  }
  naviShowUI();
}
function cycleNaviView(){
  naviViewMode = (naviViewMode + 1) % 4;
  updateNaviViewBtn();
  naviShowUI();

  if(naviViewMode === 0){
    // Manual return to follow — reset touch timer so follow starts immediately
    naviUserLastTouch = 0;
  } else if(naviViewMode === 2){
    naviUserLastTouch = Date.now();
    const segStart = Math.max(0, naviRouteIdx - 20);
    const segEnd   = Math.min(fullRoute.coords.length-1, naviRouteIdx + 100);
    const seg      = fullRoute.coords.slice(segStart, segEnd+1);
    if(seg.length >= 2){
      const bounds = seg.reduce((b,c)=>b.extend(c), new maplibregl.LngLatBounds(seg[0],seg[0]));
      map.fitBounds(bounds,{padding:70, pitch:20, bearing:0, duration:1000});
    }
  } else if(naviViewMode === 3){
    naviUserLastTouch = Date.now();
    mapFitRoute();
    map.easeTo({pitch:0, bearing:0, duration:1000, essential:true});
  } else {
    naviUserLastTouch = Date.now();
  }
}

function naviScheduleReturn(){ /* no-op: handled by timestamp in naviOnPosition */ }

function updateNaviViewBtn(){
  const btn = document.getElementById('navi-view-btn');
  if(btn) btn.textContent = NAVI_VIEW_LABELS[naviViewMode];
}

/* ---------- BEARING ---------- */
function calcBearing(from, to){
  const dLng = (to[0]-from[0]) * Math.PI/180;
  const lat1 = from[1] * Math.PI/180;
  const lat2 = to[1]   * Math.PI/180;
  const y = Math.sin(dLng)*Math.cos(lat2);
  const x = Math.cos(lat1)*Math.sin(lat2) - Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLng);
  return (Math.atan2(y,x)*180/Math.PI + 360) % 360;
}

/* ---------- ZOOM ---------- */
function naviZoom(dir){
  map.easeTo({zoom: map.getZoom()+dir, duration:300, essential:true});
  naviShowUI();
}

/* ---------- UI AUTO-HIDE ---------- */
function naviShowUI(){
  clearTimeout(naviHideTimer);
  ['navi-top','navi-zoom','navi-speed-bubble','navi-bottom'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ el.style.opacity='1'; el.style.pointerEvents='auto'; }
  });
  // Hide watermark logo when UI is visible
  const wm = document.getElementById('navi-watermark-logo');
  if(wm){ wm.classList.remove('show'); }
  // Hide turn panel when stats are visible
  const tp = document.getElementById('navi-turn-panel');
  if(tp){ tp.style.opacity='0'; tp.style.pointerEvents='none'; }
  naviStartAutoHide();
}

function naviStartAutoHide(){
  clearTimeout(naviHideTimer);
  naviHideTimer = setTimeout(()=>{
    ['navi-top','navi-zoom','navi-speed-bubble','navi-bottom'].forEach(id=>{
      const el=document.getElementById(id);
      if(el){ el.style.opacity='0'; el.style.pointerEvents='none'; }
    });
    // Show turn panel when stats are hidden (if feature enabled)
    if(turnByTurnEnabled){
      const tp = document.getElementById('navi-turn-panel');
      if(tp){ tp.style.opacity='1'; tp.style.pointerEvents='none'; }
    } else {
      // Only show watermark logo if turn-by-turn is off
      const wm = document.getElementById('navi-watermark-logo');
      if(wm){ wm.classList.add('show'); }
    }
  }, 20000);
}

// Tap on watermark logo: hide logo, show UI
function naviLogoTap(){
  const wm = document.getElementById('navi-watermark-logo');
  if(wm){ wm.classList.remove('show'); }
  naviShowUI();
}

// Re-show UI on any touch/click inside the overlay
document.addEventListener('DOMContentLoaded', ()=>{
  const overlay = document.getElementById('navi-overlay');
  if(overlay){
    overlay.addEventListener('touchstart', naviShowUI, {passive:true});
    overlay.addEventListener('click', naviShowUI, {passive:true});
  }

  // HUD tap just shows UI — no bottom sheet pop-up during navi

  // ── MOBILE: Bottom-Sheet Swipe Gesten (3 Zustände) ──────────────
  // collapsed(0) ↔ expanded(1) ↔ maximized(2)
  // REGEL: Hochschieben (vergrößern) NUR vom Handle oder Peek-Leiste aus.
  // Body-Swipe nach OBEN ist deaktiviert (passiert zu leicht beim Scrollen).
  // Body-Swipe nach UNTEN (minimieren) bleibt wie gehabt.
  const handle  = document.getElementById('sh-handle');
  const bsheet  = document.getElementById('bsheet');
  if(handle && bsheet){
    let swY = 0, swX = 0, swFrom = null;
    let swScrollTop = 0;

    const activeScrollTop = () => {
      const pane = bsheet.querySelector('.sh-pane.on');
      return pane ? pane.scrollTop : 0;
    };

    const swStart = (from) => (e) => {
      if(e.touches.length > 1) return;
      if(from === 'body' && sheetState === 0) return;
      swY    = e.touches[0].clientY;
      swX    = e.touches[0].clientX;
      swFrom = from;
      swScrollTop = activeScrollTop();
    };

    const swEnd = (e) => {
      if(!swFrom) return;
      const dy  = e.changedTouches[0].clientY - swY;
      const dx  = e.changedTouches[0].clientX - swX;
      const src = swFrom;
      swFrom = null;

      // Muss mehr vertikal als horizontal sein
      if(Math.abs(dy) <= Math.abs(dx)) return;

      if(src === 'handle' || src === 'peek'){
        // Handle / Peek: auf/zu toggle, 30px reichen
        if(dy < -30)      setSheetState(1); // rauf → öffnen
        else if(dy > 30)  setSheetState(0); // runter → schließen
      } else {
        // Body: NUR runter (minimieren) erlaubt — kein versehentliches Öffnen
        // beim Scrollen von Inhalten
        if(dy <= 0) return; // nach oben ignorieren
        const threshold = 90;
        if(dy < threshold) return;
        if(swScrollTop > 8) return; // User scrollt Inhalt → ignorieren
        setSheetState(0);
      }
    };

    handle.addEventListener('touchstart', swStart('handle'), {passive:true});
    handle.addEventListener('touchend',   swEnd,             {passive:true});

    const peek = document.getElementById('sh-peek');
    if(peek){
      peek.addEventListener('touchstart', swStart('peek'), {passive:true});
      peek.addEventListener('touchend',   swEnd,           {passive:true});
    }

    bsheet.addEventListener('touchstart', swStart('body'), {passive:true});
    bsheet.addEventListener('touchend',   swEnd,           {passive:true});
  }

  // ── iOS Safari Shake-to-Undo: vollständig deaktivieren ──
  // Capture-Phase: blockiert das Ereignis bevor irgendein Handler es bekommt
  document.addEventListener('beforeinput', e => {
    if(e.inputType === 'historyUndo' || e.inputType === 'historyRedo'){
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
  // Zusätzlich: alle Inputs readonly während Navi, damit kein Undo-Stack entsteht
  document.addEventListener('visibilitychange', () => {
    if(naviActive) document.querySelectorAll('input,textarea').forEach(el=>{try{el.blur();}catch(e){}});
  });
});

/* ---------- BACKGROUND / VISIBILITY ---------- */
document.addEventListener('visibilitychange', ()=>{
  if(!naviActive) return;
  if(!document.hidden){
    // Re-request wake lock after coming back to foreground
    if('wakeLock' in navigator && !naviWakeLock){
      navigator.wakeLock.request('screen').then(l=>{ naviWakeLock=l; }).catch(()=>{});
    }
    // ── Stats aus Routengeometrie nachberechnen ──────────
    // (GPS läuft im Hintergrund nicht → Distanz/Aufstieg aus
    //  Route + aktueller Position rekonstruieren)
    naviRecoverStatsFromRoute();
  }
});

// ══════════════════════════════════════════════════
// iOS SAFARI: SHAKE-TO-UNDO komplett deaktivieren
// ══════════════════════════════════════════════════
// 1) Blockt historyUndo/historyRedo bevor iOS den Dialog zeigen kann
document.addEventListener('beforeinput', e => {
  if(e.inputType === 'historyUndo' || e.inputType === 'historyRedo'){
    e.preventDefault(); e.stopImmediatePropagation();
  }
}, true);
// 2) Schüttelgeste per DeviceMotion abfangen → sofort alle Inputs blur()
//    (iOS zeigt den Widerrufen-Dialog nur wenn ein Textfeld fokussiert ist)
(function(){
  let _last=0, _prev={x:0,y:0,z:0}, _lastCheck=0;
  window.addEventListener('devicemotion', e=>{
    // Coarse throttle: evaluate at most 10×/s — the handler fires at 60 Hz on iOS
    const t = Date.now(); if(t - _lastCheck < 100) return; _lastCheck = t;
    const a=e.accelerationIncludingGravity; if(!a) return;
    const dx=Math.abs((a.x||0)-_prev.x), dy=Math.abs((a.y||0)-_prev.y), dz=Math.abs((a.z||0)-_prev.z);
    _prev={x:a.x||0,y:a.y||0,z:a.z||0};
    if(dx+dy+dz>20){
      if(t-_last<700) return; _last=t;
      document.querySelectorAll('input,textarea').forEach(el=>{try{el.blur();}catch(ex){}});
      try{document.activeElement?.blur();}catch(ex){}
    }
  },{passive:true});
})();

// ══════════════════════════════════════════════════
// DESKTOP SEARCH (sidebar)
// ══════════════════════════════════════════════════
let srchDeskTimer = null;
document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('srch-inp-desk');
  const clr = document.getElementById('srch-clear-desk');
  const drop = document.getElementById('srch-drop-desk');
  if(!inp) return;

  inp.addEventListener('input', e => {
    const v = e.target.value.trim();
    clr.style.display = v ? 'block' : 'none';
    clearTimeout(srchDeskTimer);
    if(v.length < 2){ drop.style.display='none'; return; }
    srchDeskTimer = setTimeout(() => doSearchDesk(v), 420);
  });
  inp.addEventListener('keydown', e => { if(e.key==='Escape') clearSearchDesk(); });
});

async function doSearchDesk(q){
  try {
    const bias = map ? `&viewbox=${map.getCenter().lng-1},${map.getCenter().lat+1},${map.getCenter().lng+1},${map.getCenter().lat-1}&bounded=0` : '';
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&accept-language=de&addressdetails=1${bias}`);
    const data = await res.json();
    const drop = document.getElementById('srch-drop-desk');
    if(!data.length){ drop.innerHTML='<div class="sr-item" style="color:var(--muted)"><span class="sr-pin">🔍</span><div><div class="sr-name">Keine Ergebnisse</div></div></div>'; drop.style.display='block'; return; }
    drop.innerHTML = data.map(r => {
      const name = r.display_name.split(',')[0];
      const sub  = r.display_name.split(',').slice(1,3).join(',').trim();
      const icon = r.type==='street'||r.type==='road'?'🛣️':r.class==='place'?'📍':r.class==='natural'?'🌳':'📌';
      return `<div class="sr-item" onclick="selectResultDesk(${r.lat},${r.lon},'${name.replace(/'/g,"\\'")}')">
        <span class="sr-pin">${icon}</span>
        <div style="min-width:0"><div class="sr-name">${name}</div><div class="sr-sub">${sub}</div></div>
      </div>`;
    }).join('');
    drop.style.display='block';
  } catch(e){}
}

function clearSearchDesk(){
  const inp = document.getElementById('srch-inp-desk');
  const clr = document.getElementById('srch-clear-desk');
  const drop = document.getElementById('srch-drop-desk');
  if(inp) inp.value='';
  if(clr) clr.style.display='none';
  if(drop) drop.style.display='none';
}

function selectResultDesk(lat, lng, name){
  clearSearchDesk();
  lat=parseFloat(lat); lng=parseFloat(lng);
  map.flyTo({center:[lng,lat],zoom:14,speed:1.8});
  if(searchPin) searchPin.remove();
  searchPin = new maplibregl.Marker({color:'#ff3d6b'}).setLngLat([lng,lat]).addTo(map);
  const popup = new maplibregl.Popup({closeButton:false,offset:30,anchor:'bottom'})
    .setHTML(`<div style="font-family:var(--font);text-align:center;padding:5px;">
      <div style="margin-bottom:8px;font-size:14px;font-weight:600">${name}</div>
      <button class="btn ok" style="width:100%;margin-bottom:5px;justify-content:center" onclick="addWpFromSearch(${lng},${lat})">📍 Als Wegpunkt</button>
      <button class="btn danger" style="width:100%;justify-content:center" onclick="clearSearchPin()">✕</button>
    </div>`);
  searchPin.setPopup(popup).togglePopup();
}

// ══════════════════════════════════════════════════
// OSM CYCLING ROUTES IMPORT (Overpass API)
// ══════════════════════════════════════════════════
let osmRoutesData = [];
let selectedOsmRoute = null;

async function loadOsmRoutes(){
  if(!map) return;
  const isMob = window.innerWidth <= 860;
  const panel = document.getElementById(isMob ? 'mob-osm-panel' : 'osm-routes-panel');
  const list  = document.getElementById(isMob ? 'mob-osm-list' : 'osm-routes-list');
  if(!panel||!list) return;
  panel.style.display = 'block';
  list.innerHTML = '<div class="wp-empty" style="padding:12px 0;"><div class="spin" style="margin:0 auto 8px;"></div>Lade Fahrradrouten…</div>';

  if(isMob) {
    // Sheet aufklappen, aber im Route-Tab bleiben
    if(!sheetExpanded){ setSheetState(1); }
  }

  const b = map.getBounds();
  const bbox = `${b.getSouth().toFixed(4)},${b.getWest().toFixed(4)},${b.getNorth().toFixed(4)},${b.getEast().toFixed(4)}`;
  const query = `[out:json][timeout:60];(relation["type"="route"]["route"~"bicycle|mtb"](${bbox}););out body geom;`;

  try {
    const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`);
    if(!res.ok) throw new Error('Overpass-Fehler');
    const data = await res.json();
    osmRoutesData = (data.elements||[]).filter(e => e.type==='relation' && e.members);

    if(!osmRoutesData.length){
      list.innerHTML = '<div class="wp-empty" style="padding:12px 0;">Keine Routen im aktuellen Bereich.</div>';
      return;
    }

    // Show routes on map + start-point pins
    renderOsmRoutes(osmRoutesData);

    // Render list with numbers
    const colors = ['#e040fb','#ff6d00','#00e5ff','#69f0ae','#ffea00','#ff1744','#40c4ff'];
    list.innerHTML = osmRoutesData.slice(0,20).map((r,i)=>{
      const tags = r.tags||{};
      const name = tags.name || tags.ref || `Route ${i+1}`;
      const type = tags.route === 'mtb' ? 'MTB' : 'Rad';
      const dist = tags.distance ? `${parseFloat(tags.distance).toFixed(0)} km` : '';
      const col = colors[i % colors.length];
      return `<div class="osm-route-item" id="osm-ri-${r.id}" onclick="selectOsmRoute(${r.id})">
        <div class="osm-num" style="background:${col}">${i+1}</div>
        <div class="osm-route-info">
          <div class="osm-route-name">${name}</div>
          <div class="osm-route-meta">${type}${dist?' · '+dist:''}</div>
        </div>
        <button class="osm-route-use" onclick="useOsmRoute(event,${r.id})">Route nutzen</button>
      </div>`;
    }).join('');
  } catch(err){
    list.innerHTML = `<div class="wp-empty" style="padding:12px 0;color:var(--red)">Fehler: ${err.message}</div>`;
  }
}

function renderOsmRoutes(routes){
  if(!map.getSource('vn-osm-routes')) map.addSource('vn-osm-routes',{type:'geojson',data:emptyFC()});
  if(!map.getLayer('vn-osm-routes')) map.addLayer({
    id:'vn-osm-routes',type:'line',source:'vn-osm-routes',
    paint:{'line-color':['get','color'],'line-width':3,'line-opacity':0.7},
    layout:{'line-join':'round','line-cap':'round'}
  },'route-segs');

  const colors = ['#e040fb','#ff6d00','#00e5ff','#69f0ae','#ffea00','#ff1744','#40c4ff'];
  const features = [];

  // Remove old OSM pins
  osmPinMarkers.forEach(m => m.remove());
  osmPinMarkers = [];

  routes.slice(0,20).forEach((r,i) => {
    const col = colors[i % colors.length];

    // Collect all way coordinates
    const ways = (r.members||[]).filter(m=>m.type==='way'&&m.geometry);
    ways.forEach(m=>{
      const coords = m.geometry.map(p=>[p.lon,p.lat]);
      if(coords.length>=2) features.push({type:'Feature',properties:{color:col,routeId:r.id},geometry:{type:'LineString',coordinates:coords}});
    });

    // Start-point pin
    const firstWay = ways[0];
    if(!firstWay || !firstWay.geometry.length) return;
    const startPt = [firstWay.geometry[0].lon, firstWay.geometry[0].lat];
    const tags = r.tags||{};

    const el = document.createElement('div');
    el.className = 'osm-pin-wrap';
    el.innerHTML = makePinSVG(col, i+1, 30);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelector('.maplibregl-popup')?.remove();
      showOsmRoutePopup(r, i, col, startPt);
    });
    const marker = new maplibregl.Marker({element:el, anchor:'bottom'})
      .setLngLat(startPt)
      .addTo(map);
    osmPinMarkers.push(marker);
  });

  map.getSource('vn-osm-routes').setData({type:'FeatureCollection',features});
}

function osmDifficulty(tags){
  const diff = (tags.mtb_scale||tags['mtb:scale']||tags.difficulty||tags.osmc_symbol||'').toLowerCase();
  if(/[3-9]|advanced|hard|expert|schwer/.test(diff)) return {label:'Schwer',color:'#ff3d6b'};
  if(/[12]|moderate|mittel/.test(diff))              return {label:'Mittel', color:'#ffd600'};
  return {label:'Leicht', color:'#00e676'};
}

function showOsmRoutePopup(r, idx, col, lngLat){
  const tags   = r.tags||{};
  const name   = tags.name || tags.ref || `Route ${idx+1}`;
  const type   = tags.route === 'mtb' ? '🚵 MTB' : '🚴 Radroute';
  const distKm = tags.distance ? `${parseFloat(tags.distance).toFixed(1)} km` : '—';
  const elevM  = tags['ascent']||tags['ele:gain']||tags.ascent || null;
  const elevStr= elevM ? `${Math.round(parseFloat(elevM))} m` : '—';
  // Estimated duration at 15 km/h
  const durStr = tags.distance ? fmtTime((parseFloat(tags.distance)/15)*3600) : '—';
  const diff   = osmDifficulty(tags);
  const net    = tags.network||tags.ref||'';

  new maplibregl.Popup({closeButton:false, anchor:'bottom', offset:10, maxWidth:'260px'})
    .setLngLat(lngLat)
    .setHTML(`
      <div style="position:relative;font-family:var(--font);min-width:220px;padding-top:6px;">
        <div class="popup-x" onclick="document.querySelector('.maplibregl-popup')?.remove()">✕</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
          <div style="width:26px;height:26px;border-radius:50%;background:${col};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#000;flex-shrink:0;">${idx+1}</div>
          <div>
            <div style="font-size:13px;font-weight:700;color:var(--text);line-height:1.25;">${name}</div>
            <div style="font-size:10px;color:var(--dim);margin-top:1px;">${type}${net?' · '+net:''}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:10px;">
          <div style="background:var(--glass-lite);border:1px solid var(--border);border-radius:var(--r-sm);padding:6px 8px;">
            <div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;">Strecke</div>
            <div style="font-size:14px;font-weight:700;color:var(--text);margin-top:2px;">${distKm}</div>
          </div>
          <div style="background:var(--glass-lite);border:1px solid var(--border);border-radius:var(--r-sm);padding:6px 8px;">
            <div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;">Höhenmeter</div>
            <div style="font-size:14px;font-weight:700;color:var(--text);margin-top:2px;">${elevStr}</div>
          </div>
          <div style="background:var(--glass-lite);border:1px solid var(--border);border-radius:var(--r-sm);padding:6px 8px;">
            <div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;">Dauer</div>
            <div style="font-size:14px;font-weight:700;color:var(--text);margin-top:2px;">${durStr}</div>
          </div>
          <div style="background:var(--glass-lite);border:1px solid var(--border);border-radius:var(--r-sm);padding:6px 8px;">
            <div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;">Schwierigkeit</div>
            <div style="font-size:13px;font-weight:700;color:${diff.color};margin-top:2px;">${diff.label}</div>
          </div>
        </div>
        <button class="btn ok" style="width:100%;justify-content:center;padding:8px;font-size:12px;" onclick="document.querySelector('.maplibregl-popup')?.remove();useOsmRouteById(${r.id})">📍 Diese Route wählen</button>
      </div>
    `).addTo(map);
}

function selectOsmRoute(id){
  selectedOsmRoute = id;
  document.querySelectorAll('.osm-route-item').forEach(el=>el.classList.remove('selected'));
  const el = document.getElementById(`osm-ri-${id}`);
  if(el) el.classList.add('selected');
}

async function useOsmRoute(event, id){
  if(typeof event?.stopPropagation === 'function') event.stopPropagation();
  document.querySelector('.maplibregl-popup')?.remove();
  const route = osmRoutesData.find(r=>r.id===id);
  if(!route) return;

  const coords = [];
  (route.members||[]).filter(m=>m.type==='way'&&m.geometry).forEach(m=>{
    m.geometry.forEach(p=>coords.push([p.lon,p.lat]));
  });
  if(coords.length < 2){ showToast('Route hat keine verwertbaren Koordinaten'); return; }

  // Sample ~12 waypoints evenly along the route
  const maxWp = 12;
  const step = Math.max(1, Math.floor(coords.length / maxWp));
  clearAll();
  const sampled = [];
  for(let i=0; i<coords.length; i+=step) sampled.push(coords[i]);
  if(sampled[sampled.length-1] !== coords[coords.length-1]) sampled.push(coords[coords.length-1]);

  sampled.forEach((c,i)=>waypoints.push({lng:c[0],lat:c[1],label:`P${i+1}`,hidden:false,manualLine:false,customCoords:null}));
  renderWpMarkers(); renderWpList();
  if(waypoints.length>=2){ 
    map.flyTo({center:waypoints[0].lng?[waypoints[0].lng,waypoints[0].lat]:[waypoints[0][0],waypoints[0][1]],zoom:11});
    await rerouteAll(); 
    mapFitRoute(); 
  }
  showToast(`✓ OSM-Route geladen: ${route.tags?.name||'Route'}`);
  clearOsmRoutes();
}

async function useOsmRouteById(id){
  await useOsmRoute({stopPropagation:()=>{}}, id);
}

function clearOsmRoutes(){
  document.getElementById('osm-routes-panel').style.display='none';
  const mobPanel = document.getElementById('mob-osm-panel');
  if(mobPanel) mobPanel.style.display='none';
  if(map.getLayer('vn-osm-routes')) map.setLayoutProperty('vn-osm-routes','visibility','none');
  osmPinMarkers.forEach(m => m.remove());
  osmPinMarkers = [];
  osmRoutesData=[];
}


let pulseReqId = null;

function startPulseAnimation(routeCoordinates){
  if(pulseReqId){ cancelAnimationFrame(pulseReqId); pulseReqId=null; }
  if(!routeCoordinates||routeCoordinates.length<2) return;

  if(!map.getSource('vn-pulse')){
    map.addSource('vn-pulse',{type:'geojson',data:{type:'Feature',geometry:{type:'Point',coordinates:routeCoordinates[0]}}});
    map.addLayer({id:'vn-pulse-layer',type:'circle',source:'vn-pulse',paint:{
      'circle-radius':6,'circle-color':'#00ffcc','circle-opacity':0.85,
      'circle-pitch-alignment':'map',
      'circle-stroke-width':2,'circle-stroke-color':'#ffffff'
    }});
  }

  let progress = 0;
  const speed  = 0.0015;

  function tick(){
    progress += speed;
    if(progress >= 1) progress = 0;
    const idx   = progress * (routeCoordinates.length-1);
    const lo    = Math.floor(idx), hi = Math.ceil(idx);
    const w     = idx - lo;
    if(routeCoordinates[lo] && routeCoordinates[hi]){
      map.getSource('vn-pulse').setData({type:'Feature',geometry:{type:'Point',coordinates:[
        routeCoordinates[lo][0]*(1-w)+routeCoordinates[hi][0]*w,
        routeCoordinates[lo][1]*(1-w)+routeCoordinates[hi][1]*w
      ]}});
    }
    pulseReqId = requestAnimationFrame(tick);
  }
  tick();
}

// ══════════════════════════════════════════════════
// NAVI ERWEITERUNGEN
// ══════════════════════════════════════════════════

/* ── PRE-ROUTE: vom aktuellen Ort zum 1. Wegpunkt ── */
async function naviShowPreRoute(lng, lat, tLng, tLat, distM){
  // Layer anlegen falls nicht vorhanden
  if(!map.getSource('vn-pre-rt')){
    map.addSource('vn-pre-rt',{type:'geojson',data:emptyFC()});
    map.addLayer({id:'vn-pre-rt-bg',type:'line',source:'vn-pre-rt',
      paint:{'line-color':'rgba(0,0,0,.35)','line-width':5,'line-blur':4},
      layout:{'line-join':'round','line-cap':'round'}});
    map.addLayer({id:'vn-pre-rt',type:'line',source:'vn-pre-rt',
      paint:{'line-color':'#ffd600','line-width':3,'line-dasharray':[2,3],'line-opacity':.85},
      layout:{'line-join':'round','line-cap':'round'}});
    naviPreRouteAdded = true;
  }
  showToast(`📍 ${distM>999?(distM/1000).toFixed(1)+' km':Math.round(distM)+' m'} bis zum Start`);
  try {
    const url = `https://brouter.de/brouter?lonlats=${lng},${lat}|${tLng},${tLat}&profile=${brouterProfile}&alternativeidx=0&format=geojson`;
    const res = await fetch(url);
    const data = await res.json();
    if(data.features?.length) map.getSource('vn-pre-rt').setData(data.features[0].geometry);
    else throw new Error('no features');
  } catch(e){
    // Fallback: Luftlinie
    map.getSource('vn-pre-rt').setData({type:'LineString',coordinates:[[lng,lat],[tLng,tLat]]});
  }
  // Pre-Route nach 90s oder wenn nahe genug automatisch ausblenden
  setTimeout(()=>{
    if(map.getSource('vn-pre-rt')) map.getSource('vn-pre-rt').setData(emptyFC());
  }, 90000);
}

/* ── WAYPOINT-PASSAGE ERKENNUNG ─────────────────── */
function naviCheckWpPassage(now){
  if(!waypoints.length) return;

  // Nur den NÄCHSTEN noch nicht passierten Wegpunkt prüfen (sequenziell).
  // Das verhindert, dass bei Rundtouren (Start ≈ Ziel) oder dicht
  // beieinander liegenden Pins mehrere WPs gleichzeitig anschlagen.
  let nextIdx = -1;
  for(let i = 0; i < waypoints.length; i++){
    if(!naviPassedWps.has(i)){ nextIdx = i; break; }
  }
  if(nextIdx === -1) return; // alle passiert

  const wp     = waypoints[nextIdx];
  const d      = haversineM([wp.lng, wp.lat], now);
  const thresh = 45 + (naviRiddenM > 100 ? 20 : 0);
  if(d > thresh) return;

  // Letzten WP (Ziel) erst auslösen wenn ≥ 85 % der Strecke gefahren.
  // Das schützt vor Frühauslösung bei Rundtouren (Start ≈ Ziel).
  if(nextIdx === waypoints.length - 1 && waypoints.length > 1){
    const minRidden = Math.max(100, fullRoute.dist * 0.85);
    if(naviRiddenM < minRidden) return;
  }

  naviPassedWps.add(nextIdx);
  if(nextIdx === waypoints.length - 1){
    setTimeout(() => showNaviFinish(), 1200);
  } else {
    naviOnWpPassed(nextIdx);
  }
}

function naviOnWpPassed(i){
  const wp = waypoints[i];
  // Konfetti an der Pin-Position
  const pt = map.project([wp.lng, wp.lat]);
  const rect = map.getCanvas().getBoundingClientRect();
  triggerConfetti(pt.x + rect.left, pt.y + rect.top, 38);
  // Marker orange + Pulsieren
  naviMarkWpPassed(i);
  // Popup mit Etappen-Stats
  showWpPassPopup(i);
}

function naviMarkWpPassed(i){
  const marker = wpMarkers.find(m => m._wpIdx === i);
  if(!marker) return;
  const el = marker.getElement();
  if(!el) return;
  // Pin-SVG komplett mit Orange neu rendern – Form & Zahl bleiben identisch
  const inner = el.querySelector('.wp-pin-inner');
  if(inner) inner.innerHTML = makePinSVG('#ff9100', i + 1);
  el.classList.add('wp-pin-passed');
}

function showWpPassPopup(i){
  document.querySelector('.navi-wp-pass-popup')?.remove();
  const wp = waypoints[i];

  // ── Startpunkt: persönliche Begrüßung ──
  if(i === 0){
    const name = currentUser?.name?.split(' ')[0] || currentUser?.name || null;
    const greet = name ? `Gute Fahrt und viel Spass, ${name}!` : 'Gute Fahrt und viel Spass!';
    new maplibregl.Popup({closeButton:false, anchor:'bottom', offset:[60,-32], maxWidth:'200px', className:'navi-wp-pass-popup'})
      .setLngLat([wp.lng, wp.lat])
      .setHTML(`<div class="navi-popup-body" style="font-family:var(--font);padding:2px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span style="font-size:13px;font-weight:800;color:#00e676;letter-spacing:.03em;">🚴 ${greet}</span>
          <button onclick="document.querySelector('.navi-wp-pass-popup')?.remove()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;padding:0 2px;flex-shrink:0;">✕</button>
        </div>
      </div>`)
      .addTo(map);
    setTimeout(() => document.querySelector('.navi-wp-pass-popup')?.remove(), 9000);
    return;
  }

  // ── Regulärer Wegpunkt ──
  const distKm = (naviRiddenM / 1000).toFixed(1);
  const upM    = Math.round(naviClimbM);
  const elapsedSec = Math.floor((Date.now() - naviStartTime) / 1000);
  const avgKmh = elapsedSec > 0 ? ((naviRiddenM/1000) / (elapsedSec/3600)).toFixed(1) : '—';
  const label  = `WP ${i + 1}`;
  new maplibregl.Popup({closeButton:false, anchor:'bottom', offset:[60,-32], maxWidth:'190px', className:'navi-wp-pass-popup'})
    .setLngLat([wp.lng, wp.lat])
    .setHTML(`<div class="navi-popup-body" style="font-family:var(--font);padding:2px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;">
        <span style="font-size:11px;font-weight:800;color:#ffd600;letter-spacing:.05em;">🏁 ${label} erreicht!</span>
        <button onclick="document.querySelector('.navi-wp-pass-popup')?.remove()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;padding:0 2px;">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
        <div style="background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.2);border-radius:6px;padding:5px 7px;">
          <div style="font-size:15px;font-weight:700;color:var(--accent);">${distKm}</div>
          <div style="font-size:8px;color:var(--muted);">km gefahren</div>
        </div>
        <div style="background:rgba(255,61,107,.08);border:1px solid rgba(255,61,107,.2);border-radius:6px;padding:5px 7px;">
          <div style="font-size:15px;font-weight:700;color:var(--red);">${upM}</div>
          <div style="font-size:8px;color:var(--muted);">hm ↑</div>
        </div>
        <div style="background:rgba(0,230,118,.08);border:1px solid rgba(0,230,118,.2);border-radius:6px;padding:5px 7px;">
          <div style="font-size:15px;font-weight:700;color:var(--green);">${fmtTime(elapsedSec)}</div>
          <div style="font-size:8px;color:var(--muted);">Zeit</div>
        </div>
        <div style="background:rgba(255,214,0,.08);border:1px solid rgba(255,214,0,.2);border-radius:6px;padding:5px 7px;">
          <div style="font-size:15px;font-weight:700;color:var(--yellow);">${avgKmh}</div>
          <div style="font-size:8px;color:var(--muted);">Ø km/h</div>
        </div>
      </div>
    </div>`)
    .addTo(map);
  setTimeout(() => document.querySelector('.navi-wp-pass-popup')?.remove(), 12000);
}

/* ── KONFETTI ────────────────────────────────────── */
function triggerConfetti(cx, cy, count=36){
  const canvas = document.createElement('canvas');
  canvas.style.cssText='position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9200;';
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const cols = ['#ffd600','#ff9100','#00d4ff','#00e676','#ff3d6b','#fff','#a855f7'];
  const parts = Array.from({length:count},()=>({
    x:cx, y:cy,
    vx:(Math.random()-0.5)*10,
    vy:(Math.random()*-9)-1,
    r:Math.random()*4+1.5,
    col:cols[Math.floor(Math.random()*cols.length)],
    a:1, rot:Math.random()*Math.PI*2, rv:(Math.random()-.5)*.25
  }));
  let fr = 0;
  function tick(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    parts.forEach(p=>{
      p.x+=p.vx; p.y+=p.vy; p.vy+=0.28; p.vx*=.97; p.rot+=p.rv; p.a-=.016;
      if(p.a<=0) return;
      ctx.save(); ctx.globalAlpha=Math.max(0,p.a);
      ctx.translate(p.x,p.y); ctx.rotate(p.rot);
      ctx.fillStyle=p.col; ctx.fillRect(-p.r,-p.r*.45,p.r*2,p.r*.9);
      ctx.restore();
    });
    fr++;
    if(fr<130&&parts.some(p=>p.a>0)) requestAnimationFrame(tick); else canvas.remove();
  }
  tick();
}

/* ── STATS-WIEDERHERSTELLUNG NACH BILDSCHIRM-AUS ── */
function naviRecoverStatsFromRoute(){
  const coords = fullRoute.coords;
  const elevs  = fullRoute.elevs;
  if(!coords.length || naviRouteIdx < 1) return;
  // Distanz aus Routengeometrie bis zum letzten bekannten Index
  let dist = 0;
  for(let i=0; i<Math.min(naviRouteIdx, coords.length-1); i++){
    dist += haversineM(coords[i], coords[i+1]);
  }
  if(dist > naviRiddenM) naviRiddenM = dist;
  // Aufstieg aus Routenhöhenprofil
  let up = 0;
  for(let i=0; i<Math.min(naviRouteIdx, elevs.length-1); i++){
    const de = (elevs[i+1]||0) - (elevs[i]||0);
    if(de > 0) up += de;
  }
  if(up > naviClimbM) naviClimbM = up;
}

/* ── ZIEL-MODAL ──────────────────────────────────── */
function showNaviFinish(){
  const elapsedSec = Math.floor((Date.now() - naviStartTime) / 1000);
  const distKm     = (naviRiddenM / 1000).toFixed(2);
  const avgKmh     = elapsedSec > 0 ? ((naviRiddenM/1000)/(elapsedSec/3600)).toFixed(1) : '—';
  const w          = parseFloat(document.getElementById('weight-inp')?.value||75);
  const cal        = calcCalories(naviRiddenM, naviClimbM, w, parseFloat(avgKmh)||15);

  setEl('nf-dist',  distKm);
  setEl('nf-time',  fmtTime(elapsedSec));
  setEl('nf-climb', Math.round(naviClimbM) + ' m');
  setEl('nf-speed', avgKmh + ' km/h');
  setEl('nf-cal',   cal + ' kcal');
  setEl('nf-wps',   naviPassedWps.size + ' / ' + waypoints.length);

  const modal = document.getElementById('navi-finish-modal');
  modal.classList.add('show');

  // Rein-Zoom + Stopp
  stopNavi(true);
  setTimeout(()=> mapFitRoute(), 800);

  // Konfetti im Modal
  const canvas = document.getElementById('navi-finish-confetti');
  canvas.width  = canvas.offsetWidth  || 380;
  canvas.height = canvas.offsetHeight || 380;
  const ctx = canvas.getContext('2d');
  const cols = ['#ffd600','#ff9100','#00d4ff','#00e676','#ff3d6b','#fff'];
  const parts = Array.from({length:55},()=>({
    x:Math.random()*canvas.width, y:-10,
    vx:(Math.random()-.5)*4, vy:Math.random()*3+1,
    r:Math.random()*4+2, col:cols[Math.floor(Math.random()*cols.length)],
    a:1, rot:Math.random()*Math.PI*2, rv:(Math.random()-.5)*.18
  }));
  let fr=0;
  function tick(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    parts.forEach(p=>{
      p.x+=p.vx; p.y+=p.vy; p.rot+=p.rv;
      if(p.y>canvas.height) p.a-=.04; else if(fr>80) p.a-=.008;
      if(p.a<=0) return;
      ctx.save(); ctx.globalAlpha=Math.max(0,p.a);
      ctx.translate(p.x,p.y); ctx.rotate(p.rot);
      ctx.fillStyle=p.col; ctx.fillRect(-p.r,-p.r*.45,p.r*2,p.r*.9);
      ctx.restore();
    });
    fr++;
    if(fr<220&&parts.some(p=>p.a>0)) requestAnimationFrame(tick);
  }
  tick();

  // Statistik speichern (lokal)
  try {
    const saved = JSON.parse(localStorage.getItem('vn_rides')||'[]');
    saved.unshift({date:new Date().toISOString().slice(0,10),km:parseFloat(distKm),hm:Math.round(naviClimbM),time:fmtTime(elapsedSec),cal,avgKmh});
    localStorage.setItem('vn_rides', JSON.stringify(saved.slice(0,50)));
  } catch(e){}

  // ☁️ Cloud-Speicherung falls eingeloggt
  if(typeof window._awSaveRoute === 'function' && typeof window._awCurrentUser === 'function' && window._awCurrentUser()){
    const w   = parseFloat(document.getElementById('weight-inp')?.value||75);
    const sp  = parseInt(localStorage.getItem('vn_speed')||'16');
    const rideMin = elapsedSec > 0 ? Math.round(elapsedSec / 60) : 0;
    window._awSaveRoute({
      name: `Tour ${new Date().toLocaleDateString('de-DE')}`,
      distance: Math.round(naviRiddenM),
      coordinates: fullRoute.coords.slice(0, 200), // max 200 Punkte
      waypoints: waypoints.map(wp=>({lat:wp.lat,lng:wp.lng,label:wp.label||''})),
      elevation: Math.round(naviClimbM),
      calories: cal,
      date: new Date().toISOString().slice(0,10),
      weight: w,
      ridetime: rideMin,
      speed: sp
    });
  }

  // ⏱ Auto-Save Countdown starten
  setTimeout(() => startAutoSave(), 600);
}

/* ── AUTO-SAVE COUNTDOWN ──────────────────────────── */
let _autoSaveTimer = null;

function startAutoSave(){
  let sec = 20;
  const bar   = document.getElementById('nf-autosave-bar');
  const fill  = document.getElementById('nf-autosave-fill');
  const cntEl = document.getElementById('nf-countdown');
  if(!bar) return;
  bar.classList.remove('cancelled');
  if(cntEl) cntEl.textContent = sec;
  if(fill)  fill.style.transition = 'none';
  if(fill){ fill.style.width = '100%'; void fill.offsetWidth; fill.style.transition = 'width 1s linear'; }

  _autoSaveTimer = setInterval(() => {
    sec--;
    if(cntEl) cntEl.textContent = sec;
    if(fill)  fill.style.width = (sec / 20 * 100) + '%';
    if(sec <= 0){
      clearInterval(_autoSaveTimer);
      _autoSaveTimer = null;
      // Route direkt in Cloud speichern (kein lokaler Umweg)
      const routeName = `Tour ${new Date().toLocaleDateString('de-DE')} ${new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}`;
      ['save-name-inp','mob-save-inp'].forEach(id => {
        const el = document.getElementById(id);
        if(el && !el.value.trim()) el.value = routeName;
      });
      if(typeof window._awSaveRoute === 'function' && typeof window._awCurrentUser === 'function' && window._awCurrentUser()){
        const w   = parseFloat(document.getElementById('weight-inp')?.value || 75);
        const effSpd = currentSpeedKmh || parseInt(localStorage.getItem('vn_speed')||'16') || 16;
        const cal = typeof calcCalories === 'function' ? calcCalories(fullRoute.dist||0, fullRoute.up||0, w, effSpd) : 0;
        const rideMin = fullRoute.dist > 0 ? Math.round((fullRoute.dist/1000)/effSpd*60) : 0;
        window._awSaveRoute({
          name: routeName,
          distance:    Math.round(fullRoute.dist || 0),
          coordinates: (fullRoute.coords||[]).slice(0, 200),
          waypoints:   waypoints.map(wp=>({lat:wp.lat,lng:wp.lng,label:wp.label||''})),
          elevation:   Math.round(fullRoute.up || 0),
          calories:    cal,
          date:        new Date().toISOString().slice(0,10),
          weight:      w, coins: 0,
          ridetime:    rideMin,
          speed:       effSpd
        });
      }
      closeNaviFinish();
    }
  }, 1000);
}

window.cancelAutoSave = function(){
  if(_autoSaveTimer){ clearInterval(_autoSaveTimer); _autoSaveTimer = null; }
  const bar   = document.getElementById('nf-autosave-bar');
  const txtEl = document.getElementById('nf-autosave-txt');
  if(bar)   bar.classList.add('cancelled');
  if(txtEl) txtEl.innerHTML = '✕ Auto-Schliessen deaktiviert';
};

function closeNaviFinish(){
  if(_autoSaveTimer){ clearInterval(_autoSaveTimer); _autoSaveTimer = null; }
  document.getElementById('navi-finish-modal').classList.remove('show');
}

/* ══════════════════════════════════════════════════════════
   REC — Strecken-Aufzeichnung
   ══════════════════════════════════════════════════════════ */
let recActive      = false;
let recWatchId     = null;
let recCoords      = [];   // [[lng, lat], …]
let recStartTime   = null;
let recDistM       = 0;
let recLastPos     = null;
let recUiTimer     = null;
let recBearing     = 0;
let recHiddenAt    = null; // Zeitstempel: Bildschirm wurde ausgeschaltet
let recGapFromPos  = null; // letzte bekannte Position vor der Bildschirm-Lücke
let recUserLastTouch = 0;  // timestamp of last manual map touch during REC
const REC_RETURN_MS  = 20000; // 20s inactivity → return to follow mode

function toggleRec(){
  if(recActive) stopRec();
  else          startRec();
}

function startRec(){
  if(recActive) return;
  if(!navigator.geolocation){ showToast('📍 GPS nicht verfügbar'); return; }

  recActive    = true;
  recCoords    = [];
  recDistM     = 0;
  recLastPos   = null;
  recStartTime = Date.now();
  recHiddenAt  = null;
  recGapFromPos= null;
  recUserLastTouch = 0; // Kamera folgt sofort beim Start

  // ── Crash-Recovery: abgebrochene Session wiederherstellen ──────────────
  try {
    const ckpt = JSON.parse(localStorage.getItem('vn_rec_checkpoint')||'null');
    if(ckpt && ckpt.coords && ckpt.coords.length >= 5 && (Date.now() - ckpt.ts) < 3600000){
      // Weniger als 1h alt → fortsetzen
      recCoords  = ckpt.coords;
      recDistM   = ckpt.distM || 0;
      recStartTime = ckpt.startTime || recStartTime;
      showToast(`♻️ Letzte Aufzeichnung fortgesetzt (${(recDistM/1000).toFixed(1)} km)`);
    }
  } catch(e){}
  // Checkpoint sofort mit leerem/aktuellem Stand anlegen
  _recSaveCheckpoint();

  // Live-Track leeren
  if(map.getSource('vn-rec-live')) map.getSource('vn-rec-live').setData(emptyFC());
  // GPS-Dot einblenden
  if(map.getLayer('vn-gps-dot')) map.setLayoutProperty('vn-gps-dot','visibility','visible');

  // Activate REC overlay
  const recOverlay = document.getElementById('rec-overlay');
  if(recOverlay){ recOverlay.classList.add('active'); recOverlay.style.pointerEvents='none'; }
  // Show REC UI elements
  ['rec-top','rec-bottom'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ el.style.opacity='1'; el.style.pointerEvents='auto'; }
  });
  // Hide old FAB, header, bottom sheet (same as navi-mode)
  document.body.classList.add('navi-mode'); // reuse navi-mode CSS to hide sidebar/bsheet/header
  const recFab = document.getElementById('rec-start-fab');
  if(recFab) recFab.style.display = 'none';
  // Collapse bsheet on mobile
  if(window.innerWidth <= 860) setSheetState(0);
  // Add touch listener to re-show UI
  if(recOverlay){
    recOverlay.addEventListener('touchstart', recShowUI, {passive:true});
    recOverlay.addEventListener('click', recShowUI, {passive:true});
  }
  // Start auto-hide timer
  recStartAutoHide();

  updateRecFab();
  showToast('⏺ Aufzeichnung gestartet');

  // Suspend background GPS watch while recording (saves battery, avoids two watches)
  if(window._bgGpsWatchId != null){
    navigator.geolocation.clearWatch(window._bgGpsWatchId);
    window._bgGpsWatchId = null;
  }

  let _recLastGpsTs = 0;
  recWatchId = navigator.geolocation.watchPosition(pos => {
    const _now = Date.now();
    if(_now - _recLastGpsTs < 800){ return; }
    _recLastGpsTs = _now;
    const {longitude:lng, latitude:lat, speed, heading} = pos.coords;
    const now = [lng, lat];

    if(recLastPos){
      const d = haversineM(recLastPos, now);
      if(d < 200) recDistM += d; // Ausreißer ignorieren
      // Bearing für GPS-Dot
      if(speed != null && speed > 0.3 && heading != null && !isNaN(heading)) recBearing = heading;
      else if(d > 5) recBearing = calcBearing(recLastPos, now);
    }

    recCoords.push(now);
    // Keep memory in check on very long rides (downsample on-the-fly every 2000 pts)
    if(recCoords.length > 2000) recCoords = downsampleCoords(recCoords, 1000);
    recLastPos = now;

    // ── Checkpoint alle ~100m in localStorage (Crash-Recovery) ────────────
    if(recCoords.length % 5 === 0){  // every ~5 GPS points ≈ every few seconds
      _recSaveCheckpoint();
    }

    // GPS-Dot aktualisieren
    if(map.getSource('vn-gps')){
      map.getSource('vn-gps').setData({type:'Feature',geometry:{type:'Point',coordinates:now},properties:{bearing:recBearing}});
    }

    // Live-Track zeichnen
    if(map.getSource('vn-rec-live') && recCoords.length >= 2){
      map.getSource('vn-rec-live').setData({type:'Feature',geometry:{type:'LineString',coordinates:recCoords}});
    }

    // Update REC HUD
    const distEl = document.getElementById('rec-hud-dist');
    if(distEl) distEl.textContent = (recDistM/1000).toFixed(1);

    // Karte nachführen — nur wenn der Nutzer nicht gerade manuell scrollt/zoomt
    const recSinceTouch = Date.now() - recUserLastTouch;
    const recShouldFollow = recUserLastTouch === 0 || recSinceTouch >= REC_RETURN_MS;
    if(recShouldFollow){
      if(!map._recLastCamPos || haversineM(map._recLastCamPos, now) > 15 || Math.abs(recBearing - (map._recLastCamBearing||0)) > 8){
        map._recLastCamPos     = now;
        map._recLastCamBearing = recBearing;
        map.easeTo({center:now, bearing:recBearing, pitch:30, zoom:15.5, duration:700, easing:t=>t, essential:true});
      }
    }

    updateRecFab();
  }, err => {
    console.warn('REC GPS error:', err.message);
  }, {enableHighAccuracy:true, maximumAge:1000, timeout:10000});

  recUiTimer = setInterval(()=>{
    updateRecFab();
    // Update REC HUD time
    if(recStartTime){
      const sec = Math.floor((Date.now() - recStartTime) / 1000);
      const h = Math.floor(sec/3600);
      const m = Math.floor((sec%3600)/60);
      const s = sec%60;
      const timeStr = h>0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
      const timeEl = document.getElementById('rec-hud-time');
      if(timeEl) timeEl.textContent = timeStr;
      const distEl = document.getElementById('rec-hud-dist');
      if(distEl) distEl.textContent = (recDistM/1000).toFixed(1);
    }
  }, 1000);
}

function stopRec(){
  if(!recActive) return;
  recActive = false;
  if(recWatchId !== null){ navigator.geolocation.clearWatch(recWatchId); recWatchId = null; }
  if(recUiTimer){ clearInterval(recUiTimer); recUiTimer = null; }
  clearTimeout(recHideTimer);

  // Deactivate REC overlay
  const recOverlay = document.getElementById('rec-overlay');
  if(recOverlay){ recOverlay.classList.remove('active'); }
  // Remove navi-mode (was added to hide sidebar/header during REC)
  document.body.classList.remove('navi-mode');
  // Hide REC watermark logo
  const recWm = document.getElementById('rec-watermark-logo');
  if(recWm){ recWm.style.opacity='0'; recWm.style.pointerEvents='none'; }
  // Restore REC UI elements opacity (for next time)
  ['rec-top','rec-bottom'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ el.style.opacity='1'; el.style.pointerEvents='auto'; }
  });
  // Show REC FAB again
  const recFab = document.getElementById('rec-start-fab');
  if(recFab && !naviActive && fullRoute.coords.length < 2) recFab.style.display = 'flex';

  // Kamera zurücksetzen
  map.easeTo({pitch:0, bearing:0, duration:800, essential:true});

  // Rote Live-Linie sofort ausblenden
  if(map.getSource('vn-rec-live')) map.getSource('vn-rec-live').setData(emptyFC());

  updateRecFab();

  // Restore background GPS dot watch
  if(!naviActive && navigator.geolocation && window._bgGpsWatchId == null){
    window._bgGpsWatchId = navigator.geolocation.watchPosition(pos => {
      if(naviActive) return;
      if(recActive)  return;
      const {longitude:lng, latitude:lat} = pos.coords;
      if(map.getSource('vn-gps'))
        map.getSource('vn-gps').setData({type:'Feature',geometry:{type:'Point',coordinates:[lng,lat]}});
    }, ()=>{}, {enableHighAccuracy:false, maximumAge:15000, timeout:25000});
  }

  if(recCoords.length < 5){
    localStorage.removeItem('vn_rec_checkpoint');
    showToast('⏹ Aufzeichnung zu kurz');
    return;
  }

  saveRecordedRoute();
}

/* ── Checkpoint: aktuellen Track in localStorage sichern (Crash-Recovery) ── */
function _recSaveCheckpoint(){
  try {
    const stored = recCoords.length > 500 ? downsampleCoords(recCoords, 500) : recCoords;
    localStorage.setItem('vn_rec_checkpoint', JSON.stringify({
      coords: stored,
      distM:  recDistM,
      startTime: recStartTime,
      ts: Date.now()
    }));
  } catch(e){ console.warn('REC checkpoint save failed:', e); }
}

function saveRecordedRoute(){
  const saves    = getSaves();
  const id       = Date.now();
  const now      = new Date();
  const name     = `Aufzeichnung ${now.toLocaleDateString('de-DE')} ${now.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}`;

  // Maximal 500 Punkte speichern (GPS-Tracks können riesig werden)
  const stored   = recCoords.length > 500 ? downsampleCoords(recCoords, 500) : recCoords;

  // ── Wegpunkte: Start + je 1 Wegpunkt pro km + Ziel ──────────────────────
  const wps = _recCoordsToKmWaypoints(stored, recDistM);

  saves.push({
    id, name,
    date:   now.toLocaleDateString('de-DE'),
    wps,
    rawCoords: stored,
    isRecording: true,
    stats:  { dist: recDistM, up: 0 }
  });

  if(saves.length > 10) saves.splice(0, saves.length - 10);
  localStorage.setItem('vn_saves', JSON.stringify(saves));
  // Checkpoint löschen — Route ist jetzt sicher gespeichert
  localStorage.removeItem('vn_rec_checkpoint');
  renderSavesList();
  showToast(`✅ "${name}" gespeichert`);

  // ☁️ Cloud-Speicherung der REC-Strecke
  if(typeof window._awSaveRoute === 'function' && typeof window._awCurrentUser === 'function' && window._awCurrentUser()){
    const wKg = parseFloat(document.getElementById('weight-inp')?.value || 75);
    const distKm = recDistM / 1000;
    const cal = typeof calcCalories === 'function' ? calcCalories(recDistM, 0, wKg, 15) : 0;
    window._awSaveRoute({
      name,
      distance: Math.round(recDistM),
      coordinates: stored.slice(0, 200),
      waypoints: wps.map(wp=>({lat:wp.lat,lng:wp.lng,label:wp.label||''})),
      elevation: 0,
      calories: cal,
      date: now.toISOString().slice(0,10),
      weight: wKg,
      coins: 0
    });
  }
}

/* Erzeugt Wegpunkte: Start + alle ~1 km + Ziel */
function _recCoordsToKmWaypoints(coords, totalDistM){
  if(!coords || coords.length < 2) return [];
  const wps = [];
  wps.push({lat:coords[0][1], lng:coords[0][0], label:'Start', hidden:false, manualLine:false, customCoords:null});

  const stepM = 1000; // 1 km
  let accumulated = 0;
  let nextThreshold = stepM;
  let kmCount = 1;

  for(let i = 1; i < coords.length; i++){
    accumulated += haversineM(coords[i-1], coords[i]);
    if(accumulated >= nextThreshold && i < coords.length - 1){
      wps.push({lat:coords[i][1], lng:coords[i][0], label:`${kmCount} km`, hidden:false, manualLine:false, customCoords:null});
      kmCount++;
      nextThreshold += stepM;
    }
  }

  const last = coords[coords.length-1];
  wps.push({lat:last[1], lng:last[0], label:'Ziel', hidden:false, manualLine:false, customCoords:null});
  return wps;
}

/* Gleichmäßig verteilte Wegpunkte aus Koordinaten-Array ableiten */
function coordsToWaypoints(coords, nMid){
  const result = [];
  const labels = ['Start', ...Array.from({length:nMid},(_,i)=>`P${i+1}`), 'Ziel'];
  const total  = nMid + 2;
  for(let i = 0; i < total; i++){
    const idx = Math.round(i * (coords.length - 1) / (total - 1));
    result.push({lat:coords[idx][1], lng:coords[idx][0], label:labels[i]||`P${i}`, hidden:false, manualLine:false, customCoords:null});
  }
  return result;
}

/* Koordinaten-Array gleichmäßig auf n Punkte reduzieren */
function downsampleCoords(coords, n){
  if(coords.length <= n) return coords;
  const result = [];
  for(let i = 0; i < n; i++){
    result.push(coords[Math.round(i * (coords.length - 1) / (n - 1))]);
  }
  return result;
}

function updateRecFab(){
  const btn = document.getElementById('rec-start-fab');
  if(!btn) return;
  const icon = btn.querySelector('.rec-icon');
  const lbl  = btn.querySelector('.rec-lbl');
  const dist = btn.querySelector('.rec-dist');

  if(recActive){
    // Overlay takes over — hide the old FAB completely
    btn.style.display = 'none';
  } else {
    btn.classList.remove('is-recording');
    btn.style.display = ''; // restore default (flex via CSS)
    if(icon) icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;"><circle cx="9" cy="9" r="7" fill="#ff3d6b"/></svg>';
    if(lbl)  lbl.textContent  = 'REC';
    if(dist) dist.textContent = '';
  }
}

/* ── REC PAUSE / RESUME ────────────────────────────────────── */
let _recPaused = false;
let _recPausedData = null;

function pauseRec(){
  if(!recActive || _recPaused) return;
  _recPaused = true;

  _recPausedData = {
    startTime: recStartTime,
    distM:     recDistM,
    coords:    [...recCoords],
    lastPos:   recLastPos,
    bearing:   recBearing
  };

  // Stop GPS + UI timer
  if(recWatchId !== null){ navigator.geolocation.clearWatch(recWatchId); recWatchId = null; }
  if(recUiTimer){ clearInterval(recUiTimer); recUiTimer = null; }

  // Hide rec overlay → back to normal app view
  const recOverlay = document.getElementById('rec-overlay');
  if(recOverlay){ recOverlay.classList.remove('active'); }

  // Show resume FAB
  document.getElementById('rec-start-fab').style.display = 'none';
  document.getElementById('rec-resume-fab').style.display = 'flex';

  // Restore normal GPS dot
  if(map.getLayer('vn-gps-dot-nav')) map.setLayoutProperty('vn-gps-dot-nav','visibility','none');
  if(map.getLayer('vn-gps-dot'))     map.setLayoutProperty('vn-gps-dot',    'visibility','visible');

  showToast('⏸ Aufzeichnung pausiert');
}

function resumeRec(){
  if(!_recPaused || !_recPausedData) return;
  _recPaused = false;

  recStartTime = _recPausedData.startTime;
  recDistM     = _recPausedData.distM;
  recCoords    = _recPausedData.coords;
  recLastPos   = _recPausedData.lastPos;
  recBearing   = _recPausedData.bearing;
  _recPausedData = null;

  // Re-activate rec overlay
  const recOverlay = document.getElementById('rec-overlay');
  if(recOverlay){ recOverlay.classList.add('active'); recOverlay.style.pointerEvents='none'; }

  document.getElementById('rec-resume-fab').style.display = 'none';
  document.getElementById('rec-start-fab').style.display  = 'none';

  // Re-switch to nav dot if moving
  if(map.getLayer('vn-gps-dot')) map.setLayoutProperty('vn-gps-dot','visibility','visible');

  // Restart GPS + UI
  recWatchId = navigator.geolocation.watchPosition(
    pos => recOnPosition(pos),
    err => console.warn('REC GPS:', err.message),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 12000 }
  );
  recUiTimer = setInterval(recTickUI, 1000);
  ['rec-top','rec-bottom'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ el.style.opacity='1'; el.style.pointerEvents='auto'; }
  });
  recStartAutoHide();
  showToast('▶ Aufzeichnung fortgesetzt!');
}

window.pauseRec = pauseRec;
window.resumeRec = resumeRec;

/* ── Hintergrund-Lücken-Füllung (Bildschirm aus/ein während REC) ─────────
   Wenn der Bildschirm >20 s weg war, wird die Lücke nicht mehr als gerade
   Linie, sondern per BRouter (Trekking-Profil) → OSRM-Fallback geroutet.  */
document.addEventListener('visibilitychange', () => {
  if(!recActive) return;

  if(document.hidden){
    // Bildschirm geht aus: letzte bekannte Position merken
    recHiddenAt   = Date.now();
    recGapFromPos = recLastPos ? [...recLastPos] : null;
  } else if(recHiddenAt && recGapFromPos){
    const gapMs = Date.now() - recHiddenAt;
    recHiddenAt = null;

    if(gapMs < 20000){   // <20 s → GPS-Watch hat selbst alles, kein Routing nötig
      recGapFromPos = null;
      return;
    }

    const gapMin = Math.max(1, Math.round(gapMs / 60000));
    showToast(`📡 ${gapMin} min Pause – Route wird berechnet…`);

    // Aktuellen GPS-Standort holen, dann routen
    navigator.geolocation.getCurrentPosition(async pos => {
      const curPos = [pos.coords.longitude, pos.coords.latitude];
      const from   = recGapFromPos;
      recGapFromPos = null;

      try {
        const routedCoords = await _routeRecGap(from, curPos);

        if(routedCoords && routedCoords.length >= 2){
          // Entfernung der gerouteten Strecke akkumulieren
          let gapDistM = 0;
          for(let i = 1; i < routedCoords.length; i++){
            gapDistM += haversineM(routedCoords[i - 1], routedCoords[i]);
          }

          // Lücken-Koordinaten anhängen (erster Punkt ist already in recCoords)
          recCoords.push(...routedCoords.slice(1));
          recDistM += gapDistM;
          recLastPos = curPos;

          // Live-Track aktualisieren
          if(map.getSource('vn-rec-live') && recCoords.length >= 2){
            map.getSource('vn-rec-live').setData({
              type:'Feature',
              geometry:{type:'LineString', coordinates:recCoords}
            });
          }
          if(map.getSource('vn-gps')){
            map.getSource('vn-gps').setData({
              type:'Feature',
              geometry:{type:'Point', coordinates:curPos},
              properties:{bearing:recBearing}
            });
          }
          map.easeTo({center:curPos, bearing:recBearing, pitch:30, zoom:15.5, duration:800, essential:true});

          showToast(`✓ Lücke geroutet: ${gapMin} min · ${(gapDistM/1000).toFixed(1)} km`);
        }
      } catch(e){
        console.warn('REC gap routing failed:', e);
        showToast('⚠️ Routing fehlgeschlagen – GPS-Aufzeichnung läuft weiter');
      }
      updateRecFab();

    }, () => {
      recGapFromPos = null;
      showToast('⚠️ GPS-Position nach Pause nicht verfügbar');
      updateRecFab();
    }, {enableHighAccuracy:true, timeout:10000, maximumAge:0});
  }
});

/* Routet zwei Positionen [lng,lat] über BRouter (Trekking) → OSRM → gerade Linie */
async function _routeRecGap(fromPos, toPos){
  const a = {lng: fromPos[0], lat: fromPos[1]};
  const b = {lng: toPos[0],   lat: toPos[1]  };

  // ── 1. BRouter Trekking ──────────────────────────────────────────────
  try {
    const url = `https://brouter.de/brouter?lonlats=${a.lng},${a.lat}|${b.lng},${b.lat}&profile=trekking&alternativeidx=0&format=geojson`;
    const res  = await fetch(url, {signal: AbortSignal.timeout(12000)});
    const data = await res.json();
    if(data.features?.length){
      const coords = data.features[0].geometry.coordinates.map(c => [c[0], c[1]]);
      if(coords.length >= 2){
        console.log(`REC gap: BRouter trekking → ${coords.length} pts`);
        return coords;
      }
    }
  } catch(e){ console.warn('REC gap BRouter failed:', e.message); }

  // ── 2. OSRM cycling fallback ─────────────────────────────────────────
  try {
    const url = `https://router.project-osrm.org/route/v1/cycling/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
    const res  = await fetch(url, {signal: AbortSignal.timeout(8000)});
    const data = await res.json();
    if(data.routes?.length){
      const coords = data.routes[0].geometry.coordinates;
      if(coords.length >= 2){
        console.log(`REC gap: OSRM fallback → ${coords.length} pts`);
        return coords;
      }
    }
  } catch(e){ console.warn('REC gap OSRM failed:', e.message); }

  // ── 3. Gerade Linie als letzter Ausweg (6 Punkte) ────────────────────
  console.warn('REC gap: straight-line fallback');
  const pts = [];
  for(let i = 0; i <= 5; i++){
    pts.push([
      fromPos[0] + (toPos[0] - fromPos[0]) * (i / 5),
      fromPos[1] + (toPos[1] - fromPos[1]) * (i / 5)
    ]);
  }
  return pts;
}

/* ══════════════════════════════════════════════════════════ */

/* ── LUCKY: RANDOM ROUTE ─────────────────────────── */
let _randomRouteKm = 15;

window.updateLuckyKm = function(val){
  _randomRouteKm = parseInt(val);
  // Sync both sliders
  const dsk = document.getElementById('lucky-slider');
  const mob = document.getElementById('mob-lucky-slider');
  if(dsk && dsk !== document.activeElement) dsk.value = val;
  if(mob && mob !== document.activeElement) mob.value = val;
  // Update display values
  ['lucky-km-val','mob-lucky-km-val'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.textContent = val + ' km';
  });
};

window.generateRandomRoute = function(btnEl){
  if(!navigator.geolocation){ showToast('📍 GPS-Zugriff nicht verfügbar'); return; }

  // Dice spin animation
  if(btnEl){
    const dice = btnEl.querySelector('span[id^="lucky-dice"]');
    if(dice){ dice.classList.remove('lucky-spin'); void dice.offsetWidth; dice.classList.add('lucky-spin'); }
  }

  showToast('🎲 Zufallsroute wird berechnet…');
  document.getElementById('loading').style.display = 'flex';
  setEl('load-txt', '🎲 Zufallsroute…');

  navigator.geolocation.getCurrentPosition(async pos => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const targetKm = _randomRouteKm;

    // --- RUNDWEG-LOGIK ---
    // Gesamtumfang ≈ 2πr  →  r = targetKm / (2π)
    // NICHT Durchmesser verwechseln! Wir brauchen den Radius des Kreises,
    // auf dem die Wegpunkte liegen, sodass der Umfang ≈ targetKm ist.
    // Faktor /2 weil BRouter-Routing via Straßen ca. 2× länger ist als Luftlinie.
    const rKm     = targetKm / (2 * Math.PI * 2);
    // Umrechnung in Grad Breite (1° ≈ 111.32 km)
    const rDegLat = rKm / 111.32;
    // Längengrad-Korrektur wegen Breitengrad
    const rDegLon = rDegLat / Math.cos(lat * Math.PI / 180);

    // 4 Wegpunkte mit leichter Zufallsstreuung (neue Route bei jedem Klick)
    const nPts = 4;
    const a0   = Math.random() * Math.PI * 2; // zufälliger Startwinkel

    clearAll();
    // Start = aktueller Standort
    waypoints.push({lat, lng:lon, label:'Start', hidden:false, manualLine:false, customCoords:null});

    for(let i = 0; i < nPts; i++){
      // Gleichmäßig verteilt + kleine Zufallsabweichung im Winkel & Radius
      const angle   = a0 + i * (Math.PI * 2 / nPts) + (Math.random() - 0.5) * 0.55;
      const rFactor = 0.82 + Math.random() * 0.36; // ±18% Radius-Variation
      const wLat = lat + Math.sin(angle) * rDegLat * rFactor;
      const wLon = lon + Math.cos(angle) * rDegLon * rFactor;
      waypoints.push({lat:wLat, lng:wLon, label:`P${i+1}`, hidden:false, manualLine:false, customCoords:null});
    }

    // Ende = Start (Rundweg schließen)
    waypoints.push({lat, lng:lon, label:'Ziel', hidden:false, manualLine:false, customCoords:null});

    renderWpMarkers();
    renderWpList();

    try {
      await rerouteAll();
      mapFitRoute();
      // Switch to Route tab to show waypoints
      if(window.innerWidth <= 860){
        switchSheetTab('st-route', document.querySelectorAll('.sh-tab')[0]);
      } else {
        switchTab('t-route', document.querySelectorAll('.tab-btn')[0]);
      }
      showToast(`🎲 Zufallsroute ~${targetKm} km generiert!`);
    } catch(e){
      showToast('❌ Routing fehlgeschlagen – BRouter erreichbar?');
    }
    document.getElementById('loading').style.display = 'none';
  }, err => {
    document.getElementById('loading').style.display = 'none';
    showToast('📍 GPS-Position nicht verfügbar');
  }, {enableHighAccuracy:true, timeout:9000, maximumAge:15000});
};

function naviFinishShare(){
  const txt = `🚴 GravelGuide – Tour beendet!\n`
    + `📏 ${document.getElementById('nf-dist').textContent} km\n`
    + `⏱ ${document.getElementById('nf-time').textContent}\n`
    + `⛰ ${document.getElementById('nf-climb').textContent}\n`
    + `⚡ ${document.getElementById('nf-speed').textContent}\n`
    + `🔥 ${document.getElementById('nf-cal').textContent}\n`
    + `Geplant mit GravelGuide 3D`;
  if(navigator.share){
    navigator.share({title:'GravelGuide Tour', text:txt}).catch(()=>{});
  } else {
    navigator.clipboard?.writeText(txt).then(()=> showToast('✓ In Zwischenablage kopiert')).catch(()=> showToast(txt));
  }
}

function naviFinishGPX(){ exportGPX(); }

/* ── createNavDotIcon (Teardrop für Navigations-Richtung) ── */
function createNavDotIcon(){
  const S=32, cx=S/2, cy=S/2+2.5, r=7, tip=4.5;
  const canvas=document.createElement('canvas'); canvas.width=S; canvas.height=S;
  const ctx=canvas.getContext('2d'); ctx.clearRect(0,0,S,S);
  function teardrop(rr,tt){
    ctx.beginPath();
    ctx.moveTo(cx,cy-rr-tt);
    ctx.bezierCurveTo(cx+rr*.55,cy-rr-tt*.12,cx+rr,cy-rr*.38,cx+rr,cy);
    ctx.arc(cx,cy,rr,0,Math.PI);
    ctx.bezierCurveTo(cx-rr,cy-rr*.38,cx-rr*.55,cy-rr-tt*.12,cx,cy-rr-tt);
    ctx.closePath();
  }
  teardrop(r+2.5,tip+1.5); ctx.fillStyle='rgba(255,255,255,.97)'; ctx.fill();
  teardrop(r,tip);          ctx.fillStyle='#00d4ff';               ctx.fill();
  const grd=ctx.createRadialGradient(cx-.5,cy-r*.5,0,cx,cy,r*1.1);
  grd.addColorStop(0,'rgba(255,255,255,.52)'); grd.addColorStop(.55,'rgba(255,255,255,.08)'); grd.addColorStop(1,'rgba(255,255,255,0)');
  teardrop(r,tip); ctx.fillStyle=grd; ctx.fill();
  const imgData=ctx.getImageData(0,0,S,S);
  return {width:S,height:S,data:new Uint8Array(imgData.data.buffer)};
}

// ══════════════════════════════════════════════════
// TURN-BY-TURN NAVIGATION
// ══════════════════════════════════════════════════
let turnByTurnEnabled = (localStorage.getItem('vn_turnbyturn') === '1');

window.toggleTurnByTurn = function(){
  turnByTurnEnabled = !turnByTurnEnabled;
  localStorage.setItem('vn_turnbyturn', turnByTurnEnabled ? '1' : '0');
  ['t-turnbyturn','mob-t-turnbyturn'].forEach(id => {
    document.getElementById(id)?.classList.toggle('active', turnByTurnEnabled);
  });
  const panel = document.getElementById('navi-turn-panel');
  if(!turnByTurnEnabled && panel){ panel.style.opacity='0'; panel.style.pointerEvents='none'; }
  showToast(turnByTurnEnabled ? '🔀 Abbiegungspfeile aktiviert' : '🔀 Abbiegungspfeile deaktiviert');
};

/* Called from naviOnPosition — updates content only, visibility handled by naviShowUI/naviStartAutoHide */
function naviUpdateTurnArrow(){
  if(!naviActive) return;
  const coords = fullRoute.coords;
  if(!coords || coords.length < 2) return;

  // ── Find the next significant turn ahead ──────────────────────────────
  const LOOK_AHEAD  = Math.min(coords.length - 1, naviRouteIdx + 300);
  const TURN_THRESH = 25;
  const SHARP_THRESH= 60;

  let turnIdx   = -1;
  let turnAngle = 0;

  for(let i = Math.max(1, naviRouteIdx); i < LOOK_AHEAD - 1; i++){
    const a = _tbtBearing(coords[i-1], coords[i]);
    const b = _tbtBearing(coords[i],   coords[i+1]);
    let diff = b - a;
    while(diff >  180) diff -= 360;
    while(diff < -180) diff += 360;
    if(Math.abs(diff) >= TURN_THRESH){ turnIdx = i; turnAngle = diff; break; }
  }

  // ── Distance to turn ─────────────────────────────────────────────────
  let distToTurn = 0;
  if(turnIdx > naviRouteIdx){
    for(let i = naviRouteIdx; i < turnIdx; i++){
      distToTurn += haversineM(coords[i], coords[i+1]);
    }
  }

  // ── Arrow & label ────────────────────────────────────────────────────
  const arrowEl  = document.getElementById('navi-turn-arrow');
  const distEl   = document.getElementById('navi-turn-dist');
  const streetEl = document.getElementById('navi-turn-street');
  if(!arrowEl || !distEl || !streetEl) return;

  let arrow, label, color;
  if(turnIdx === -1 || distToTurn > 2500){
    arrow = '↑'; label = 'Geradeaus'; color = 'var(--text)';
  } else if(turnAngle > 0){
    if(turnAngle > SHARP_THRESH){ arrow = '↱'; label = 'Scharf rechts'; color = 'var(--orange)'; }
    else { arrow = '↗'; label = 'Rechts abbiegen'; color = 'var(--accent)'; }
  } else {
    if(turnAngle < -SHARP_THRESH){ arrow = '↰'; label = 'Scharf links'; color = 'var(--orange)'; }
    else { arrow = '↖'; label = 'Links abbiegen'; color = 'var(--accent)'; }
  }

  arrowEl.textContent  = arrow;
  arrowEl.style.color  = color;
  streetEl.textContent = label;

  if(turnIdx === -1 || distToTurn > 2500){
    distEl.textContent = '';
  } else if(distToTurn >= 1000){
    distEl.textContent = (distToTurn / 1000).toFixed(1) + ' km';
  } else {
    distEl.textContent = Math.round(distToTurn / 10) * 10 + ' m';
  }
  distEl.style.color = distToTurn < 100 ? 'var(--red)' : distToTurn < 300 ? 'var(--orange)' : 'var(--accent)';
}

function _tbtBearing(a, b){
  const R = Math.PI / 180;
  const dL = (b[0] - a[0]) * R;
  const φ1 = a[1] * R, φ2 = b[1] * R;
  const y  = Math.sin(dL) * Math.cos(φ2);
  const x  = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dL);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ══════════════════════════════════════════════════
// REC OVERLAY: AUTO-HIDE (same logic as navi)
// ══════════════════════════════════════════════════
let recHideTimer = null;

function recShowUI(){
  if(!recActive) return;
  clearTimeout(recHideTimer);
  ['rec-top','rec-bottom'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ el.style.opacity='1'; el.style.pointerEvents='auto'; }
  });
  const wm = document.getElementById('rec-watermark-logo');
  if(wm){ wm.style.opacity='0'; wm.style.pointerEvents='none'; }
  recStartAutoHide();
}

function recStartAutoHide(){
  clearTimeout(recHideTimer);
  recHideTimer = setTimeout(()=>{
    if(!recActive) return;
    ['rec-top','rec-bottom'].forEach(id=>{
      const el=document.getElementById(id);
      if(el){ el.style.opacity='0'; el.style.pointerEvents='none'; }
    });
    // Show REC watermark logo
    const wm = document.getElementById('rec-watermark-logo');
    if(wm){ wm.style.opacity='0.80'; wm.style.pointerEvents='auto'; }
  }, 20000);
}

function recLogoTap(){
  const wm = document.getElementById('rec-watermark-logo');
  if(wm){ wm.style.opacity='0'; wm.style.pointerEvents='none'; }
  recShowUI();
}

// ══════════════════════════════════════════════════
// AUTO-REROUTE FEATURE
// ══════════════════════════════════════════════════
let autoRerouteEnabled  = false;
let autoRerouteTimer    = null;
let autoRerouteOrigCoords = null; // original route coords (shown as dashed yellow)
const AUTO_REROUTE_DIST_M = 60;  // metres off-route before rerouting triggers
const AUTO_REROUTE_COOLDOWN_MS = 30000; // min 30s between reroutes

let _autoRerouteLastMs  = 0;
let _autoRerouteRunning = false;

window.toggleNaviArrowBig = function(){
  const big = localStorage.getItem('vn_navi_arrow_big') === '1';
  const next = !big;
  localStorage.setItem('vn_navi_arrow_big', next ? '1' : '0');
  ['t-navi-arrow-big','mob-t-navi-arrow-big'].forEach(id=>{
    document.getElementById(id)?.classList.toggle('active', next);
  });
  if(map && map.getLayer && map.getLayer('vn-gps-dot-nav'))
    map.setLayoutProperty('vn-gps-dot-nav', 'icon-size', next ? 3 : 1);
  showToast(next ? '🔵 Navi-Pfeil: Groß' : '🔵 Navi-Pfeil: Normal');
};

window.toggleAutoReroute = function(){
  autoRerouteEnabled = !autoRerouteEnabled;
  ['btn-auto-reroute','mob-btn-auto-reroute'].forEach(id=>{
    document.getElementById(id)?.classList.toggle('active', autoRerouteEnabled);
  });
  if(!autoRerouteEnabled){
    // Remove old-route ghost layer
    _clearOrigRouteLayer();
    autoRerouteOrigCoords = null;
    showToast('🔄 Auto-Rerouting deaktiviert');
  } else {
    showToast('🔄 Auto-Rerouting aktiviert');
  }
};

function _ensureOrigRouteLayer(){
  if(!map) return;
  if(!map.getSource('vn-orig-route')){
    map.addSource('vn-orig-route', {type:'geojson', data:{type:'Feature',geometry:{type:'LineString',coordinates:[]}}});
    map.addLayer({
      id: 'vn-orig-route-line',
      type: 'line',
      source: 'vn-orig-route',
      paint:{
        'line-color':'#ffd600',
        'line-width': 3,
        'line-dasharray':[4,4],
        'line-opacity': 0.7
      },
      layout:{'line-join':'round','line-cap':'round'}
    });
  }
}

function _clearOrigRouteLayer(){
  if(map && map.getSource('vn-orig-route')){
    map.getSource('vn-orig-route').setData({type:'Feature',geometry:{type:'LineString',coordinates:[]}});
  }
}

function _showOrigRoute(coords){
  _ensureOrigRouteLayer();
  if(map && map.getSource('vn-orig-route')){
    map.getSource('vn-orig-route').setData({type:'Feature',geometry:{type:'LineString',coordinates:coords}});
  }
}

/* Called from naviOnPosition to check if we're off-route */
async function autoRerouteCheck(now){
  if(!autoRerouteEnabled || !naviActive) return;
  if(_autoRerouteRunning) return;
  const sinceLastMs = Date.now() - _autoRerouteLastMs;
  if(sinceLastMs < AUTO_REROUTE_COOLDOWN_MS) return;

  // Find nearest point on current route
  const coords = fullRoute.coords;
  if(!coords.length) return;
  let minD = Infinity;
  const start = Math.max(0, naviRouteIdx - 20);
  const end   = Math.min(coords.length-1, naviRouteIdx + 60);
  for(let i=start; i<=end; i++){
    const d = haversineM(now, coords[i]);
    if(d < minD) minD = d;
  }

  if(minD < AUTO_REROUTE_DIST_M) return; // still on route

  // Off-route detected!
  _autoRerouteRunning = true;
  _autoRerouteLastMs  = Date.now();
  showToast('🔄 Von Route abgewichen – neu berechne…');

  // Save original route as ghost if not already saved
  if(!autoRerouteOrigCoords){
    // Show remaining orig route from nearest point onward (not from start)
    autoRerouteOrigCoords = fullRoute.coords.slice(naviRouteIdx);
  }
  _showOrigRoute(autoRerouteOrigCoords);

  // Destination is the last waypoint
  const dest = waypoints[waypoints.length - 1];
  if(!dest){ _autoRerouteRunning = false; return; }

  try {
    // Build new route from current position to destination
    const newWps = [
      {lng:now[0], lat:now[1], label:'Aktuell', hidden:false, manualLine:false, customCoords:null},
      {lng:dest.lng, lat:dest.lat, label:'Ziel', hidden:false, manualLine:false, customCoords:null}
    ];

    // Fetch new route via BRouter
    let newCoords = null;
    try {
      const url = `https://brouter.de/brouter?lonlats=${now[0]},${now[1]}|${dest.lng},${dest.lat}&profile=${brouterProfile}&alternativeidx=0&format=geojson`;
      const res  = await fetch(url, {signal: AbortSignal.timeout(12000)});
      const data = await res.json();
      if(data.features?.length){
        newCoords = data.features[0].geometry.coordinates.map(c=>[c[0],c[1]]);
      }
    } catch(e){
      // OSRM fallback
      try {
        const url = `https://router.project-osrm.org/route/v1/${osrmProfile}/${now[0]},${now[1]};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
        const res  = await fetch(url, {signal: AbortSignal.timeout(8000)});
        const data = await res.json();
        if(data.routes?.length) newCoords = data.routes[0].geometry.coordinates;
      } catch(e2){ console.warn('AutoReroute fallback failed:', e2); }
    }

    if(newCoords && newCoords.length >= 2){
      // Replace active route
      const elevs = await fetchElevations(newCoords);
      fullRoute.coords = newCoords;
      fullRoute.elevs  = elevs;
      naviRouteIdx = 0;
      _naviRiddenLastIdx = -1;
      renderRoute();
      // Render on map
      showToast('✅ Route neu berechnet!');
    } else {
      showToast('⚠️ Neurouting fehlgeschlagen');
    }
  } catch(e){
    console.warn('autoRerouteCheck error:', e);
  } finally {
    _autoRerouteRunning = false;
  }
}
let skyOn = false;
let optikBrightness = 100;
let optikContrast   = 100;

window.toggleSky = function(){
  skyOn = !skyOn;
  document.querySelectorAll('.optik-sky-btn').forEach(b => b.classList.toggle('active', skyOn));
  _applySky();
  showToast(skyOn ? '☁️ Himmel eingeblendet' : '☁️ Himmel ausgeblendet');
};

function _applySky(){
  if(!map) return;
  if(!map.getLayer('vn-sky')){
    // Layer fehlt (z.B. nach Stilwechsel) — neu anlegen
    try {
      map.addLayer({
        id:'vn-sky', type:'sky',
        layout:{ visibility: skyOn ? 'visible' : 'none' },
        paint:{
          'sky-type':'atmosphere',
          'sky-atmosphere-color':'rgba(100,181,246,1)',
          'sky-atmosphere-sun-intensity':12,
          'sky-opacity':['interpolate',['linear'],['zoom'],0,0,5,0.5,8,1]
        }
      });
    } catch(e){ console.warn('sky layer add failed:', e); }
  } else {
    map.setLayoutProperty('vn-sky', 'visibility', skyOn ? 'visible' : 'none');
  }
}

function _applyMapFilter(){
  const f = `brightness(${optikBrightness}%) contrast(${optikContrast}%)`;
  document.getElementById('map').style.filter = f;
}

window.setOptikBrightness = function(v){
  optikBrightness = parseInt(v);
  document.querySelectorAll('.optik-brightness-inp').forEach(el => el.value = v);
  document.querySelectorAll('.optik-brightness-val').forEach(el => el.textContent = v + '%');
  _applyMapFilter();
};

window.setOptikContrast = function(v){
  optikContrast = parseInt(v);
  document.querySelectorAll('.optik-contrast-inp').forEach(el => el.value = v);
  document.querySelectorAll('.optik-contrast-val').forEach(el => el.textContent = v + '%');
  _applyMapFilter();
};

// ── BIG FONT ───────────────────────────────────────────────────
let _bigFontOn = false;
window.toggleBigFont = function(){
  _bigFontOn = !_bigFontOn;
  document.querySelectorAll('#t-big-font,#mob-t-big-font').forEach(b => b.classList.toggle('active', _bigFontOn));
  document.documentElement.style.setProperty('--big-font-scale', _bigFontOn ? '1.28' : '1');
  if(_bigFontOn){
    if(!document.getElementById('_big-font-style')){
      const s = document.createElement('style');
      s.id = '_big-font-style';
      s.textContent = `
        body { font-size: calc(1em * var(--big-font-scale, 1)) !important; }
        .sb-title,.set-lbl,.wp-tag,.sr-name,.srt-name,.tab-btn,.sh-tab,.btn,.mc-btn,.tool-btn,.bp-btn,.nvbtn,.navi-lbl,.nf-l,.cal-l,.sl,.sc .sl,.wp-coord,.sr-sub,.srt-meta { font-size: calc(1em * 1.22) !important; }
        .sv,.navi-big,.navi-elapsed,.nf-v,.cal-v { font-size: calc(1em * 1.18) !important; }
        #bp-grid-dsk, #mob-bp-grid { grid-template-columns: repeat(2,1fr) !important; }
      `;
      document.head.appendChild(s);
    }
  } else {
    document.getElementById('_big-font-style')?.remove();
  }
  showToast(_bigFontOn ? '🔡 Große Schrift aktiviert' : '🔡 Normale Schrift');
};

// ── BRIGHT MODE ────────────────────────────────────────────────
let _brightModeOn = false;
window.toggleBrightMode = function(){
  _brightModeOn = !_brightModeOn;
  document.querySelectorAll('#t-bright-mode,#mob-t-bright-mode').forEach(b => b.classList.toggle('active', _brightModeOn));
  if(_brightModeOn){
    if(!document.getElementById('_bright-mode-style')){
      const s = document.createElement('style');
      s.id = '_bright-mode-style';
      s.textContent = `
        :root {
          --bg:#f0f2f0 !important;
          --glass:rgba(236,240,236,0.92) !important;
          --glass-lite:rgba(0,0,0,0.04) !important;
          --glass-hover:rgba(0,0,0,0.07) !important;
          --border:rgba(0,0,0,0.12) !important;
          --shadow:0 4px 18px rgba(0,0,0,0.12) !important;
          --accent:#2e7d52 !important;
          --accent-dim:rgba(46,125,82,0.12) !important;
          --accent-glow:rgba(46,125,82,0.25) !important;
          --green:#2e7d52 !important;
          --text:#1a2a1a !important;
          --dim:#4a5a4a !important;
          --muted:#8a9a8a !important;
        }
        body { background: #f0f2f0 !important; color: #1a2a1a !important; }
        #sidebar,#bsheet,.g { background: rgba(236,240,236,0.96) !important; border-color: rgba(0,0,0,0.10) !important; }
        .tab-btn.active { color: #2e7d52 !important; border-bottom-color: #2e7d52 !important; }
        .sh-tab.active { color: #2e7d52 !important; border-bottom-color: #2e7d52 !important; }
        .btn.active,.mc-btn.active,.tool-btn.active { background: rgba(46,125,82,0.15) !important; border-color: #2e7d52 !important; color: #2e7d52 !important; }
        .logo { color: #2e7d52 !important; text-shadow: none !important; }
        #navi-hud-bar { background: rgba(240,242,240,0.95) !important; border-color: rgba(46,125,82,0.4) !important; }
        .navi-big,.navi-elapsed { color: #2e7d52 !important; }
        .sv { color: #2e7d52 !important; }
        #srch-inp, .set-inp { background: rgba(255,255,255,0.8) !important; border-color: rgba(0,0,0,0.14) !important; color: #1a2a1a !important; }
        .sc,.wp-item,.srt-item,.gc-item { background: rgba(255,255,255,0.7) !important; }
        .maplibregl-popup-content { background: rgba(240,242,240,0.98) !important; color: #1a2a1a !important; }
      `;
      document.head.appendChild(s);
    }
  } else {
    document.getElementById('_bright-mode-style')?.remove();
  }
  showToast(_brightModeOn ? '☀️ Bright Mode aktiviert' : '🌙 Dark Mode aktiviert');
};

// ══════════════════════════════════════════════════
// TILE PREFETCHER
// Lädt Satelliten-Tiles für Zoom ±1 im Hintergrund
// in den Browser-HTTP-Cache → kein Re-Download beim Zoomen
// ══════════════════════════════════════════════════
function _lngLatToTileXY(lng, lat, z){
  const n = 1 << z;
  const x = Math.floor((lng + 180) / 360 * n);
  const lr = Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180));
  const y = Math.floor((1 - lr / Math.PI) / 2 * n);
  return [Math.max(0, Math.min(n-1, x)), Math.max(0, Math.min(n-1, y))];
}

function prefetchSatTiles(){
  if(!map || !apiKey || !satelliteOn) return;
  const zoom   = Math.round(map.getZoom());
  const bounds = map.getBounds();
  const W = bounds.getWest(), E = bounds.getEast(),
        N = bounds.getNorth(), S = bounds.getSouth();

  // Viewport leicht vergrößern (1 Tile Puffer an jeder Seite)
  const padLng = (E - W) * 0.25;
  const padLat = (N - S) * 0.25;

  const urls = [];
  // Aktueller Zoom + 1 höher + 1 tiefer
  for(const z of [zoom - 1, zoom, zoom + 1]){
    if(z < 2 || z > 19) continue;
    const [x1, y1] = _lngLatToTileXY(W - padLng, N + padLat, z);
    const [x2, y2] = _lngLatToTileXY(E + padLng, S - padLat, z);
    for(let x = x1; x <= x2; x++){
      for(let y = y1; y <= y2; y++){
        urls.push(`https://api.maptiler.com/tiles/satellite-v2/${z}/${x}/${y}.jpg?key=${apiKey}`);
      }
    }
  }

  // Max. 16 Tiles pro Prefetch (weniger Requests, kein force-cache da instabil auf iOS Safari)
  const batch = urls.slice(0, 16);
  batch.forEach(url => {
    fetch(url, { mode:'cors', credentials:'omit' }).catch(() => {});
  });
}

// Auto-start: probe pool keys first, start with the first working one
(async function autoStart(){
  const customKey = localStorage.getItem('custom_maptiler_key');
  if(customKey){
    // User has a custom key saved – use it directly, no probing
    _poolKeyIndex = -1;
    apiKey = customKey;
    launch(apiKey);
    return;
  }

  // Test each pool key with a lightweight style.json HEAD-style fetch
  for(let i = 0; i < DEFAULT_KEYS.length; i++){
    const testKey = DEFAULT_KEYS[i];
    try {
      const res = await fetch(
        `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${testKey}`,
        { method: 'GET', cache: 'no-store' }
      );
      if(res.ok){
        // This key works – start with it
        _poolKeyIndex = i;
        apiKey = testKey;
        console.log(`MapTiler: using pool key #${i + 1}`);
        launch(apiKey);
        return;
      }
      // 402 / 403 → try next key
      console.log(`MapTiler: pool key #${i + 1} exhausted (${res.status}), trying next…`);
    } catch(e){
      // Network error – still try next key
      console.warn(`MapTiler: pool key #${i + 1} fetch error`, e);
    }
  }

  // All pool keys exhausted – start in fallback/demo mode immediately
  limitReachedShown = true;
  apiKey = '';
  launch('');
  document.getElementById('limit-overlay').classList.add('show');
})();

