// ══════════════════════════════════════════════════
// MAP INIT
// ══════════════════════════════════════════════════
function launch(key){
  apiKey = key;
  document.getElementById('api-overlay').style.display='none';
  initMap();
  renderSavesList();
  renderBrouterProfileBtns();
  checkURLHash();
}

let _keySwitching = false; // debounce: ignore errors during a key switch

function handleLimitReached(){
  if(limitReachedShown) return;
  if(_keySwitching) return; // already switching – ignore flood of concurrent errors

  // If we're currently on a pool key, try the next one first
  if(_poolKeyIndex >= 0 && _poolKeyIndex < DEFAULT_KEYS.length - 1){
    _keySwitching = true;
    _poolKeyIndex++;
    apiKey = DEFAULT_KEYS[_poolKeyIndex];
    console.log(`MapTiler key exhausted – switching to pool key #${_poolKeyIndex + 1}`);

    if(map){
      const newStyle = `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${apiKey}`;
      try {
        map.once('style.load', () => {
          _keySwitching = false; // unlock after new style fully loaded
          onStyleLoad();
        });
        map.setStyle(newStyle);
      } catch(e){ _keySwitching = false; }

      // Update satellite source key if active
      try {
        if(map.getSource('vn-satellite')){
          map.getSource('vn-satellite').setTiles([`https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${apiKey}`]);
        }
      } catch(e){}
    } else {
      _keySwitching = false;
    }
    return; // don't show overlay
  }

  // All pool keys exhausted → show the user overlay
  limitReachedShown = true;
  if(map){
    try { map.setStyle(buildFallbackStyle()); } catch(e){}
  }
  document.getElementById('limit-overlay').classList.add('show');
}

function dismissLimitModal(){
  document.getElementById('limit-overlay').classList.remove('show');
  showToast('Demo-Modus aktiv · 3D & Satellit deaktiviert');
}

function applyCustomKey(){
  const key = document.getElementById('limit-key-inp').value.trim();
  if(!key){ showToast('Bitte einen gültigen Key eingeben'); return; }
  localStorage.setItem('custom_maptiler_key', key);
  document.getElementById('limit-overlay').classList.remove('show');
  location.reload();
}

function buildFallbackStyle(){
  return {
    version:8,
    glyphs:'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources:{
      osm:{type:'raster',tiles:['https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'],tileSize:256,attribution:'© OpenStreetMap, © Carto'}
    },
    layers:[{id:'osm-bg',type:'raster',source:'osm',paint:{'raster-opacity':1}}]
  };
}

class ResetCtrl{
  onAdd(map){ this._m=map; this._c=document.createElement('div'); this._c.className='maplibregl-ctrl maplibregl-ctrl-group'; const b=document.createElement('button'); b.type='button'; b.title='Reset Ansicht'; b.innerHTML='<span style="font-size:15px;font-weight:700;color:var(--text)">⌂</span>'; b.onclick=()=>map.flyTo({pitch:55,bearing:-10,zoom:13}); this._c.appendChild(b); return this._c; }
  onRemove(){ this._c.parentNode.removeChild(this._c); this._m=undefined; }
}

function initMap(){
  // Mehr parallele Tile-Requests → schnelleres Laden beim Zoomen/Drehen
  if(maplibregl.config) maplibregl.config.MAX_PARALLEL_IMAGE_REQUESTS = 32;

  // Start center: letzter bekannter Standort aus localStorage, sonst Hechingen
  let startCenter = [8.856553, 48.247994];
  let startZoom   = 13;
  try {
    const lastPos = JSON.parse(localStorage.getItem('vn_last_pos')||'null');
    if(lastPos && lastPos.lng && lastPos.lat){
      startCenter = [lastPos.lng, lastPos.lat];
      startZoom   = 14;
    }
  } catch(e){}

  const style = apiKey ? `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${apiKey}` : buildFallbackStyle();
  map = new maplibregl.Map({
    container:'map', style,
    center: startCenter, zoom: startZoom,
    pitch:55, bearing:-10, maxPitch:85, antialias:true,
    touchPitch: true, touchZoomRotate: true, dragRotate: true,
    maxTileCacheSize: 1200,
    fadeDuration: 150
  });
  map.addControl(new maplibregl.NavigationControl({visualizePitch:true}),'top-left');
  map.addControl(new ResetCtrl(),'top-left');
  map.addControl(new maplibregl.FullscreenControl(),'top-left');
  map.addControl(new maplibregl.ScaleControl({unit:'metric'}),'bottom-left');

  map.once('style.load', onStyleLoad);

  // GPS-Standort beim Start ermitteln und Karte dorthin fliegen
  if(navigator.geolocation){
    navigator.geolocation.getCurrentPosition(pos => {
      const {longitude: lng, latitude: lat} = pos.coords;
      // Standort für nächsten App-Start merken
      try { localStorage.setItem('vn_last_pos', JSON.stringify({lng, lat})); } catch(e){}
      // GPS-Dot zeigen und Karte sanft hinbewegen
      if(map.isStyleLoaded()){
        if(map.getSource('vn-gps'))
          map.getSource('vn-gps').setData({type:'Feature',geometry:{type:'Point',coordinates:[lng,lat]}});
        map.flyTo({center:[lng, lat], zoom:14, pitch:55, bearing:-10, duration:1800, essential:true});
      } else {
        map.once('style.load', () => {
          if(map.getSource('vn-gps'))
            map.getSource('vn-gps').setData({type:'Feature',geometry:{type:'Point',coordinates:[lng,lat]}});
          map.flyTo({center:[lng, lat], zoom:14, pitch:55, bearing:-10, duration:1800, essential:true});
        });
      }
    }, () => {}, {enableHighAccuracy:false, timeout:8000, maximumAge:60000});
  }
  
  // Detect API limit (402) or invalid key (403) from tile errors
  map.on('error', (e) => {
    const status = e?.error?.status || e?.error?.statusCode || (e?.error?.message||'').match(/\b(402|403)\b/)?.[0];
    if(status == 402 || status == 403) handleLimitReached();
  });
  
  // Update Mesh on Move if enabled
  map.on('moveend', () => { if(meshOn && !naviActive && !recActive) updateMesh(); });

  // ── Tile Prefetcher ──────────────────────────────────────────────────
  // Nach jeder Bewegung / Zoom-Änderung werden Sat-Tiles der Zoom-Level
  // ±1 im Hintergrund per fetch() in den Browser-HTTP-Cache geladen.
  // MapLibre greift dann beim nächsten Zoom auf gecachte Ressourcen zurück
  // → kein Nachladen, kein Flackern.
  let _prefetchTimer = null;
  function schedulePrefetch(){
    // Während der Navigation/Aufzeichnung löst jede GPS-Kamerabewegung moveend aus →
    // parallele fetch()-Requests → Browser-Crash. Prefetch daher deaktivieren.
    if(naviActive || recActive) return;
    clearTimeout(_prefetchTimer);
    _prefetchTimer = setTimeout(prefetchSatTiles, 600);
  }
  map.on('moveend', schedulePrefetch);
  map.on('zoomend', schedulePrefetch);

  // Record user touch time — used to decide whether to follow GPS or let user explore
  map.getCanvas().addEventListener('touchstart', () => {
    if(naviActive) naviUserLastTouch = Date.now();
    if(recActive)  recUserLastTouch  = Date.now();
  }, {passive: true});
  map.getCanvas().addEventListener('mousedown', () => {
    if(naviActive) naviUserLastTouch = Date.now();
    if(recActive)  recUserLastTouch  = Date.now();
  }, {passive: true});

  setupMapEvents();
  // Restore turn-by-turn button state
  if(turnByTurnEnabled){
    ['t-turnbyturn','mob-t-turnbyturn'].forEach(id => document.getElementById(id)?.classList.add('active'));
  }
  updateMobBtns();
}

// ══════════════════════════════════════════════════
// MAP EVENTS & LOGIC
// ══════════════════════════════════════════════════

// ── Helper: ring FX at screen coords ──
function spawnRingFX(cx, cy, color){
  const ring = document.createElement('div');
  ring.className = 'wp-ring-fx';
  ring.style.cssText = `left:${cx}px;top:${cy}px;border-color:${color||'var(--accent)'};`;
  document.body.appendChild(ring);
  setTimeout(() => ring.remove(), 700);
}

// ── Hold-to-place state ──
let mapHoldTimer   = null;
let mapHoldActive  = false;
let mapHoldStartPt = null;
let mapHoldMoved   = false;
let mapHoldRafId   = null;
const MAP_HOLD_MS  = 380;

function startMapHold(clientX, clientY){
  if(naviActive || drawModeIdx >= 0) return;
  mapHoldActive  = false;
  mapHoldMoved   = false;
  mapHoldStartPt = {x: clientX, y: clientY};

  // Show ghost pin at cursor position
  const ghost = document.getElementById('wp-ghost-pin');
  const nextColor = waypoints.length === 0 ? '#00e676' : '#ff3d6b';
  ghost.innerHTML = makePinSVG(nextColor, waypoints.length + 1, 30);
  ghost.style.left = clientX + 'px';
  ghost.style.top  = clientY + 'px';
  ghost.classList.add('visible');

  // Animate hold ring
  const ring    = document.getElementById('wp-hold-ring');
  const prog    = document.getElementById('wp-hold-prog');
  ring.style.display = 'block';
  ring.style.left    = clientX + 'px';
  ring.style.top     = clientY + 'px';
  prog.style.strokeDashoffset = '138.2';
  prog.style.stroke  = nextColor;

  const start = performance.now();
  function animRing(ts){
    const elapsed = ts - start;
    const t = Math.min(elapsed / MAP_HOLD_MS, 1);
    prog.style.strokeDashoffset = (138.2 * (1 - t)).toFixed(2);
    if(t < 1) mapHoldRafId = requestAnimationFrame(animRing);
  }
  mapHoldRafId = requestAnimationFrame(animRing);

  mapHoldTimer = setTimeout(() => {
    mapHoldActive = true;
    cancelAnimationFrame(mapHoldRafId);
    ring.style.display = 'none';
    ghost.classList.remove('visible');

    const rect = map.getCanvas().getBoundingClientRect();
    const lngLat = map.unproject([clientX - rect.left, clientY - rect.top]);
    addWaypointWithFX(lngLat.lng, lngLat.lat, clientX, clientY);
  }, MAP_HOLD_MS);
}

function cancelMapHold(){
  clearTimeout(mapHoldTimer);
  cancelAnimationFrame(mapHoldRafId);
  document.getElementById('wp-ghost-pin').classList.remove('visible');
  document.getElementById('wp-hold-ring').style.display = 'none';
  mapHoldActive = false;
}

function addWaypointWithFX(lng, lat, cx, cy){
  const color = waypoints.length === 0 ? '#00e676' : '#ffd600';
  spawnRingFX(cx, cy, color);
  addWaypoint(lng, lat);
}

function setupMapEvents() {
  // ── Mouse: hold-to-place on empty map ──────────────────
  map.getCanvas().addEventListener('mousedown', (e) => {
    if(naviActive) return;
    // Only handle direct canvas clicks (not on existing pins)
    if(e.target !== map.getCanvas()) return;
    const bbox = [[e.offsetX-10, e.offsetY-10],[e.offsetX+10, e.offsetY+10]];
    const onPin = map.queryRenderedFeatures(bbox, {layers:['vn-wps']}).length > 0;
    const onRoute = map.queryRenderedFeatures(bbox, {layers:['route-segs-hit']}).length > 0;
    if(onPin || onRoute) return;
    startMapHold(e.clientX, e.clientY);
  }, {passive:true});

  map.getCanvas().addEventListener('mousemove', (e) => {
    if(mapHoldTimer && mapHoldStartPt){
      const dx = e.clientX - mapHoldStartPt.x;
      const dy = e.clientY - mapHoldStartPt.y;
      if(Math.sqrt(dx*dx+dy*dy) > 8){ cancelMapHold(); }
    }
    // Update ghost pin position
    const ghost = document.getElementById('wp-ghost-pin');
    if(ghost.classList.contains('visible')){
      ghost.style.left = e.clientX + 'px';
      ghost.style.top  = e.clientY + 'px';
      document.getElementById('wp-hold-ring').style.left = e.clientX + 'px';
      document.getElementById('wp-hold-ring').style.top  = e.clientY + 'px';
    }
  });

  map.getCanvas().addEventListener('mouseup', () => { /* handled on window below */ });

  // Cancel hold-to-place when mouse is released anywhere (even outside the canvas)
  window.addEventListener('mouseup', () => {
    if(mapHoldTimer || mapHoldRafId) cancelMapHold();
  });

  // ── Mouse: drag existing pin on vn-wps layer (desktop fallback for GeoJSON hit) ──
  map.on('mousedown', 'vn-wps', (e) => {
      e.preventDefault();
      cancelMapHold(); // cancel place-hold if clicked on existing pin
      // Pin drag is now handled by the HTML marker element listeners in renderWpMarkers
  });

  // ── Mouse drag of waypoint (driven by renderWpMarkers el mousedown → isDraggingWp) ──
  map.on('mousemove', (e) => {
      if(!map.getStyle()) return;
      
      if (isDraggingWp && dragWpId !== null) {
          clearTimeout(longPressTimer); 
          map.getCanvas().style.cursor = 'grabbing';
          waypoints[dragWpId].lng = e.lngLat.lng;
          waypoints[dragWpId].lat = e.lngLat.lat;
          // Only move the marker, do NOT call renderWpMarkers (that recreates all pins)
          const m = wpMarkers.find(mk => mk._wpIdx === dragWpId);
          if(m) m.setLngLat([e.lngLat.lng, e.lngLat.lat]);
      } 
      else if (drawModeIdx >= 0 && e.originalEvent.buttons === 1) {
          drawCoords.push([e.lngLat.lng, e.lngLat.lat]);
          map.getSource('vn-draw').setData({type:'Feature', geometry:{type:'LineString', coordinates:drawCoords}});
      }

      if(map.getLayer('route-segs-hit') && map.queryRenderedFeatures(e.point, {layers:['route-segs-hit']}).length) {
          if(!isDraggingWp) map.getCanvas().style.cursor='move';
      } else if (!isDraggingWp && drawModeIdx < 0) {
          map.getCanvas().style.cursor='crosshair';
          document.getElementById('rt-tip').style.display='none';
      }
  });

  map.on('mouseup', (e) => {
      clearTimeout(longPressTimer);

      if (isDraggingWp && dragWpId !== null) {
          isDraggingWp = false;
          map.getCanvas().style.cursor = '';
          // Skip rerouteAll here when the HTML pin element already handled it (_activePinDrag).
          // _activePinDrag is set in startPinDrag() and cleared in endPinDrag().
          if (!isLongPress && !_activePinDrag) rerouteAll();
          if (!_activePinDrag) dragWpId = null; // endPinDrag handles cleanup for pin drags
      }

      if (drawModeIdx >= 0 && drawCoords.length > 1) {
          const end = drawCoords[drawCoords.length-1];
          const newIdx = drawModeIdx + 1;
          waypoints.splice(newIdx, 0, {lng: end[0], lat: end[1], label: `P${newIdx+1}`, manualLine: true, customCoords: drawCoords, hidden: false});
          
          drawModeIdx = -1;
          drawCoords = [];
          if(map.getSource('vn-draw')) map.getSource('vn-draw').setData(emptyFC());
          map.dragPan.enable(); map.dragRotate.enable(); map.touchZoomRotate.enable(); map.touchPitch.enable(); map.scrollZoom.enable();  document.body.style.overscrollBehavior = ''; document.documentElement.style.overscrollBehavior = '';
          
          renderWpMarkers();
          renderWpList();
          rerouteAll();
          showToast("✓ Freihand-Route erstellt");
      }
  });

  // ── Click: only used for route-segment insert and warning popups ──
  map.on('click', (e) => {
      if(naviActive) return;
      if(suppressClick){ suppressClick = false; return; }
      if(hadMultiTouch) return;
      if(isDraggingWp || isLongPress || drawModeIdx >= 0) return;
      if(!map.getStyle() || !map.getLayer('vn-wps') || !map.getLayer('vn-warn')) return;

      const hitRadius = window.innerWidth <= 860 ? 20 : 8;
      const bbox = [[e.point.x-hitRadius, e.point.y-hitRadius],[e.point.x+hitRadius, e.point.y+hitRadius]];
      const fs = map.queryRenderedFeatures(bbox, {layers:['vn-warn']});

      if(fs.length){
          new maplibregl.Popup({closeButton:false,anchor:'bottom',offset:10})
              .setLngLat(fs[0].geometry.coordinates)
              .setHTML(`<div style="padding:6px;font-family:var(--font);font-size:12px;color:var(--text);font-weight:600">${fs[0].properties.msg}</div>`).addTo(map);
      }
      // Note: waypoints are now placed via hold-to-place, not on click
  });

  // Route segment: hold-to-insert (mouse) — same hold duration as placing new pins
  map.on('mousedown', 'route-segs-hit', (e) => {
    if (dragWpId !== null || drawModeIdx >= 0) return;
    e.preventDefault();
    cancelMapHold();

    let minDist = Infinity, insertIdx = 1;
    segments.forEach((seg, i) => {
      seg.coords.forEach(c => {
        const d = haversineM([e.lngLat.lng, e.lngLat.lat], c);
        if(d < minDist){ minDist = d; insertIdx = i + 1; }
      });
    });
    const insertLng = e.lngLat.lng, insertLat = e.lngLat.lat;
    const cx = e.originalEvent.clientX, cy = e.originalEvent.clientY;

    const ghost = document.getElementById('wp-ghost-pin');
    ghost.innerHTML = makePinSVG('#ffd600', insertIdx + 1, 30);
    ghost.style.left = cx + 'px'; ghost.style.top = cy + 'px';
    ghost.classList.add('visible');
    const ring = document.getElementById('wp-hold-ring');
    const prog = document.getElementById('wp-hold-prog');
    ring.style.left = cx + 'px'; ring.style.top = cy + 'px';
    ring.style.display = 'block';
    prog.style.strokeDashoffset = '138.2';
    prog.style.stroke = '#ffd600';

    let segHoldFired = false, segRafId = null;
    const start = performance.now();
    function animSegMouse(ts){
      const frac = Math.min((ts - start) / MAP_HOLD_MS, 1);
      prog.style.strokeDashoffset = (138.2 * (1 - frac)).toFixed(2);
      if(frac < 1) segRafId = requestAnimationFrame(animSegMouse);
    }
    segRafId = requestAnimationFrame(animSegMouse);

    const segTimer = setTimeout(() => {
      segHoldFired = true;
      cancelAnimationFrame(segRafId);
      ring.style.display = 'none'; ghost.classList.remove('visible');
      spawnRingFX(cx, cy, '#ffd600');
      waypoints.splice(insertIdx, 0, {lng:insertLng, lat:insertLat, label:`P${insertIdx+1}`, hidden:false, manualLine:false, customCoords:null});
      dragWpId = insertIdx; isDraggingWp = true;
      map.getCanvas().style.cursor = 'grab';
      renderWpMarkers(); renderWpList();
    }, MAP_HOLD_MS);

    const onSegUp = () => {
      if(!segHoldFired){
        clearTimeout(segTimer); cancelAnimationFrame(segRafId);
        ring.style.display = 'none'; ghost.classList.remove('visible');
      }
      window.removeEventListener('mouseup', onSegUp);
      window.removeEventListener('mousemove', onSegMove);
    };

    // Desktop: Mausbewegung > 8px bricht den Hold ab (wie Touchmove auf Mobile)
    const onSegMove = (me) => {
      if(segHoldFired){ window.removeEventListener('mousemove', onSegMove); return; }
      const dx = me.clientX - cx, dy = me.clientY - cy;
      if(Math.sqrt(dx*dx+dy*dy) > 8){
        clearTimeout(segTimer); cancelAnimationFrame(segRafId);
        ring.style.display = 'none'; ghost.classList.remove('visible');
        window.removeEventListener('mousemove', onSegMove);
        window.removeEventListener('mouseup', onSegUp);
      }
    };

    window.addEventListener('mouseup', onSegUp);
    window.addEventListener('mousemove', onSegMove);
  });

  map.on('mousemove','route-segs-hit', e=>{
    if(isDraggingWp || !map.getLayer('route-segs-hit')) return;
    const fs = map.queryRenderedFeatures(e.point, {layers:['route-segs']});
    if(!fs.length) return;
    const p = fs[0].properties;
    const g=+p.grade, el=+p.elev;
    document.getElementById('rt-tip').innerHTML=`<span style="color:${gradeColor(g)}">▲ ${g.toFixed(1)}%</span>${el?` <span style="color:var(--dim)"> · ${Math.round(el)} m</span>`:''}`;
    const pt=map.project(e.lngLat);
    const tt=document.getElementById('rt-tip');
    tt.style.display='block';
    tt.style.left=(pt.x+14)+'px'; tt.style.top=(pt.y-14)+'px';
  });

  // ── TOUCH EVENTS (mobile) ──────────────────────────
  // Touch on empty map: hold-to-place
  let mapTouchHoldTimer = null;
  let mapTouchHoldStart = null;
  let mapTouchMoved     = false;

  map.getCanvas().addEventListener('touchstart', (e) => {
    if(naviActive || e.touches.length > 1) return;
    const t = e.touches[0];
    // Check if touching an existing pin (HTML markers are above canvas, so this mainly catches empty space)
    mapTouchMoved = false;
    mapTouchHoldStart = {x: t.clientX, y: t.clientY};

    const rect = map.getCanvas().getBoundingClientRect();
    const pt = {x: t.clientX - rect.left, y: t.clientY - rect.top};
    const onPin = map.queryRenderedFeatures([
      [pt.x-18, pt.y-18], [pt.x+18, pt.y+18]
    ], {layers:['vn-wps']}).length > 0;
    const onRoute = map.queryRenderedFeatures([
      [pt.x-18, pt.y-18], [pt.x+18, pt.y+18]
    ], {layers:['route-segs-hit']}).length > 0;
    if(onPin || onRoute || drawModeIdx >= 0) return;

    // Show ghost pin
    const ghost = document.getElementById('wp-ghost-pin');
    const nextColor = waypoints.length === 0 ? '#00e676' : '#ff3d6b';
    ghost.innerHTML = makePinSVG(nextColor, waypoints.length + 1, 30);
    ghost.style.left = t.clientX + 'px';
    ghost.style.top  = t.clientY + 'px';
    ghost.classList.add('visible');

    const ring    = document.getElementById('wp-hold-ring');
    const prog    = document.getElementById('wp-hold-prog');
    ring.style.display = 'block';
    ring.style.left = t.clientX + 'px';
    ring.style.top  = t.clientY + 'px';
    prog.style.strokeDashoffset = '138.2';
    prog.style.stroke = nextColor;

    const start = performance.now();
    function animRingT(ts){
      const elapsed = ts - start;
      const frac = Math.min(elapsed / MAP_HOLD_MS, 1);
      prog.style.strokeDashoffset = (138.2 * (1 - frac)).toFixed(2);
      if(frac < 1) mapHoldRafId = requestAnimationFrame(animRingT);
    }
    mapHoldRafId = requestAnimationFrame(animRingT);

    mapTouchHoldTimer = setTimeout(() => {
      cancelAnimationFrame(mapHoldRafId);
      ring.style.display = 'none';
      ghost.classList.remove('visible');
      if(mapTouchMoved) return;
      const lngLat = map.unproject([pt.x, pt.y]);
      addWaypointWithFX(lngLat.lng, lngLat.lat, t.clientX, t.clientY);
      suppressClick = true;
    }, MAP_HOLD_MS);
  }, {passive:true});

  map.getCanvas().addEventListener('touchmove', (e) => {
    if(e.touches.length > 1) return;
    const t = e.touches[0];
    if(mapTouchHoldStart){
      const dx = t.clientX - mapTouchHoldStart.x;
      const dy = t.clientY - mapTouchHoldStart.y;
      if(Math.sqrt(dx*dx+dy*dy) > 10){
        mapTouchMoved = true;
        clearTimeout(mapTouchHoldTimer);
        cancelAnimationFrame(mapHoldRafId);
        // Also cancel segment hold on move
        if(!segTouchHoldFired){
          clearTimeout(segTouchHoldTimer);
          cancelAnimationFrame(segTouchRafId);
        }
        document.getElementById('wp-ghost-pin').classList.remove('visible');
        document.getElementById('wp-hold-ring').style.display = 'none';
      }
    }
  }, {passive:true});

  map.getCanvas().addEventListener('touchend', () => {
    clearTimeout(mapTouchHoldTimer);
    cancelAnimationFrame(mapHoldRafId);
    // Also cancel route-segment hold if it hasn't fired yet
    if(!segTouchHoldFired){
      clearTimeout(segTouchHoldTimer);
      cancelAnimationFrame(segTouchRafId);
    }
    document.getElementById('wp-ghost-pin').classList.remove('visible');
    document.getElementById('wp-hold-ring').style.display = 'none';
    mapTouchHoldStart = null;
  }, {passive:true});

  // Touch on waypoint: handled via HTML marker listeners in renderWpMarkers
  // (kept as no-op to avoid double-handling)
  map.on('touchstart', 'vn-wps', (e) => {
    if(naviActive) return;
    // HTML marker handles it; just prevent map from adding a waypoint
    suppressClick = true;
  });

  // Touch on route segment: hold-to-insert — same hold duration as placing new pins
  let segTouchHoldTimer = null, segTouchRafId = null, segTouchHoldFired = false;

  map.on('touchstart', 'route-segs-hit', (e) => {
    if(naviActive || dragWpId !== null || drawModeIdx >= 0) return;
    if(e.originalEvent.touches.length > 1) return;
    // Also cancel any map-hold that started simultaneously (canvas touchstart fires too)
    cancelMapHold();

    let minDist = Infinity, insertIdx = 1;
    segments.forEach((seg, i) => {
      seg.coords.forEach(c => {
        const d = haversineM([e.lngLat.lng, e.lngLat.lat], c);
        if(d < minDist){ minDist = d; insertIdx = i + 1; }
      });
    });
    const insertLng = e.lngLat.lng, insertLat = e.lngLat.lat;
    const t0 = e.originalEvent.touches[0];
    const cx = t0.clientX, cy = t0.clientY;

    segTouchHoldFired = false;
    const ghost = document.getElementById('wp-ghost-pin');
    ghost.innerHTML = makePinSVG('#ffd600', insertIdx + 1, 30);
    ghost.style.left = cx + 'px'; ghost.style.top = cy + 'px';
    ghost.classList.add('visible');
    const ring = document.getElementById('wp-hold-ring');
    const prog = document.getElementById('wp-hold-prog');
    ring.style.left = cx + 'px'; ring.style.top = cy + 'px';
    ring.style.display = 'block';
    prog.style.strokeDashoffset = '138.2';
    prog.style.stroke = '#ffd600';

    const start = performance.now();
    function animSegTouch(ts){
      const frac = Math.min((ts - start) / MAP_HOLD_MS, 1);
      prog.style.strokeDashoffset = (138.2 * (1 - frac)).toFixed(2);
      if(frac < 1) segTouchRafId = requestAnimationFrame(animSegTouch);
    }
    segTouchRafId = requestAnimationFrame(animSegTouch);

    segTouchHoldTimer = setTimeout(() => {
      segTouchHoldFired = true;
      cancelAnimationFrame(segTouchRafId);
      ring.style.display = 'none'; ghost.classList.remove('visible');
      spawnRingFX(cx, cy, '#ffd600');
      waypoints.splice(insertIdx, 0, {lng:insertLng, lat:insertLat, label:`P${insertIdx+1}`, hidden:false, manualLine:false, customCoords:null});
      dragWpId = insertIdx; isDraggingWp = false; isLongPress = false;
      renderWpMarkers(); renderWpList();
    }, MAP_HOLD_MS);
  });

  // Global touchmove: handle waypoint drag (driven by HTML marker, update GeoJSON)
  map.on('touchmove', (e) => {
    if(naviActive) return;
    if(isDraggingWp && dragWpId !== null && !isLongPress){
      clearTimeout(longPressTimer);
      const lngLat = map.unproject(e.point);
      waypoints[dragWpId].lng = lngLat.lng;
      waypoints[dragWpId].lat = lngLat.lat;
      const m = wpMarkers.find(mk => mk._wpIdx === dragWpId);
      if(m) m.setLngLat([lngLat.lng, lngLat.lat]);
    } else if(drawModeIdx >= 0 && e.originalEvent.touches.length === 1){
      const lngLat = map.unproject(e.point);
      drawCoords.push([lngLat.lng, lngLat.lat]);
      if(map.getSource('vn-draw')) map.getSource('vn-draw').setData({type:'Feature',geometry:{type:'LineString',coordinates:drawCoords}});
    }
  });

  map.getCanvas().addEventListener('touchmove', (e) => {
    if(drawModeIdx >= 0) {
      e.preventDefault();
      return;
    }
    if(isDraggingWp) e.preventDefault();
  }, {passive: false});

  document.addEventListener('touchmove', (e) => {
    if(drawModeIdx >= 0) e.preventDefault();
  }, {passive: false});

  let activeTouchCount = 0;
  let hadMultiTouch = false;
  map.getCanvas().addEventListener('touchstart', e => {
    activeTouchCount = e.touches.length;
    if(e.touches.length > 1){
      hadMultiTouch = true;
      // Cancel any in-progress hold so no pin fires after pinch
      clearTimeout(mapTouchHoldTimer);
      clearTimeout(segTouchHoldTimer);
      cancelAnimationFrame(mapHoldRafId);
      cancelAnimationFrame(segTouchRafId);
      document.getElementById('wp-ghost-pin').classList.remove('visible');
      document.getElementById('wp-hold-ring').style.display = 'none';
      mapTouchHoldStart = null;
    }
  }, {passive:true});
  map.getCanvas().addEventListener('touchend', e => {
    activeTouchCount = e.touches.length;
    if(e.touches.length === 0) setTimeout(() => { hadMultiTouch = false; }, 400);
  }, {passive:true});

  map.on('touchend', () => {
    clearTimeout(longPressTimer);
    if(hadMultiTouch){ touchedWpIdx = null; touchedWpCoord = null; return; }

    if(isDraggingWp && dragWpId !== null){
      isDraggingWp = false;
      map.dragPan.enable(); map.dragRotate.enable(); map.touchZoomRotate.enable(); map.touchPitch.enable(); map.scrollZoom.enable();  document.body.style.overscrollBehavior = ''; document.documentElement.style.overscrollBehavior = '';
      if(!isLongPress) rerouteAll();
      dragWpId = null;
      suppressClick = true;
    }

    touchedWpIdx = null; touchedWpCoord = null;

    if(drawModeIdx >= 0 && drawCoords.length > 1){
      const end = drawCoords[drawCoords.length-1];
      const newIdx = drawModeIdx + 1;
      waypoints.splice(newIdx, 0, {lng:end[0],lat:end[1],label:`P${newIdx+1}`,manualLine:true,customCoords:drawCoords,hidden:false});
      drawModeIdx = -1; drawCoords = [];
      if(map.getSource('vn-draw')) map.getSource('vn-draw').setData(emptyFC());
      map.dragPan.enable(); map.dragRotate.enable(); map.touchZoomRotate.enable(); map.touchPitch.enable(); map.scrollZoom.enable();  document.body.style.overscrollBehavior = ''; document.documentElement.style.overscrollBehavior = '';
      renderWpMarkers(); renderWpList(); rerouteAll();
      showToast('✓ Freihand-Route erstellt');
      suppressClick = true;
    }
  });
}

window.startDraw = function(idx) {
    document.querySelector('.maplibregl-popup')?.remove();
    drawModeIdx = idx;
    drawCoords = [[waypoints[idx].lng, waypoints[idx].lat]];
    // Lock ALL map interactions while drawing
    map.dragPan.disable();
    map.dragRotate.disable();
    map.touchZoomRotate.disable();
    map.touchPitch.disable();
    map.scrollZoom.disable();
    // Block pull-to-refresh (overscroll) — don't set touch-action, MapLibre needs touch events
    document.body.style.overscrollBehavior = 'none';
    document.documentElement.style.overscrollBehavior = 'none';
    showToast("✏️ Mit Finger zeichnen · Karte gesperrt");
}

function onStyleLoad(){
  try {
    if(apiKey){
      if(!map.getSource('dem')) map.addSource('dem',{type:'raster-dem',url:`https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${apiKey}`,tileSize:256});
      map.setTerrain({source:'dem',exaggeration:1.5});
      document.getElementById('btn-3d').classList.add('active');
    }

    // MapLibre sky layer — Zustand aus skyOn-Variable wiederherstellen
    _applySky();

    // Set a neutral background for non-satellite mode
    const layers = map.getStyle().layers;
    if(layers){
      layers.forEach(l => {
        if(l.type === 'background'){
          map.setPaintProperty(l.id,'background-color','#e8e8e0');
          map.setPaintProperty(l.id,'background-opacity',1);
        }
      });
    }

    mapLayerIds=(map.getStyle().layers||[]).filter(l=>!l.id.startsWith('vn-')&&!l.id.startsWith('route-')).map(l=>l.id);
    addLayers();
    applyMapLayers();
    renderWpMarkers();
    rebuildRoute();

    // Satellit ist der Startzustand – direkt aktivieren
    if(satelliteOn) ensureSatLayer();
  } catch(e){ console.error('Style load error:',e); }
}

// ══════════════════════════════════════════════════
// MAP LAYERS & BOOSTS
// ══════════════════════════════════════════════════
let layerStyles = {};
let layerBoosts = { roads:false, cycle:false, paths:false };
let layerVis = { roads:false, cycle:false, paths:false };

function getLayerCats() {
  if(!map||!map.getStyle()) return {};
  const all = map.getStyle().layers;
  return {
    roads: all.filter(l => (l.id.includes('road') || l.id.includes('highway') || l.id.includes('motorway') || l.id.includes('street')) && !l.id.includes('path') && !l.id.includes('track') && !l.id.includes('cycle')),
    cycle: all.filter(l => l.id.includes('cycle') || l.id.includes('bicycle') || l.id.includes('bike')),
    paths: all.filter(l => l.id.includes('path') || l.id.includes('track') || l.id.includes('trail') || l.id.includes('footway') || l.id.includes('steps') || l.id.includes('pedestrian') || l.id.includes('dirt'))
  };
}

window.layerToggle = function(type, show) {
  layerVis[type] = show;
  applyMapLayers();
};

window.boostToggle = function(type, boost) {
  layerBoosts[type] = boost;
  applyMapLayers();
};

function applyMapLayers() {
  if(!map || !map.getStyle()) return;
  const cats = getLayerCats();
  for (let type in cats) {
    const show = layerVis[type];
    const boost = layerBoosts[type];
    cats[type].forEach(l => {
      if(map.getLayer(l.id)) map.setLayoutProperty(l.id, 'visibility', show ? (mapHidden?'none':'visible') : 'none');
      
      if (!layerStyles[l.id] && l.type === 'line') {
        layerStyles[l.id] = { width: map.getPaintProperty(l.id, 'line-width') || 1, color: map.getPaintProperty(l.id, 'line-color') || '#000' };
      }
      if (l.type === 'line') {
        if (show && boost) {
          map.setPaintProperty(l.id, 'line-width', ['*', 4, layerStyles[l.id].width]); 
          let c = type==='roads' ? '#ffffff' : type==='cycle' ? '#00ffff' : '#aeea00';
          map.setPaintProperty(l.id, 'line-color', c);
          if(map.getPaintProperty(l.id, 'line-opacity') !== undefined) {
             map.setPaintProperty(l.id, 'line-opacity', 1);
          }
        } else if (show && !boost) {
          map.setPaintProperty(l.id, 'line-width', layerStyles[l.id].width);
          map.setPaintProperty(l.id, 'line-color', layerStyles[l.id].color);
        }
      }
    });
  }
}

function addLayers(){
  if(!map.getSource('vn-draw')) map.addSource('vn-draw',{type:'geojson',data:emptyFC()});
  if(!map.getLayer('vn-draw')) map.addLayer({id:'vn-draw',type:'line',source:'vn-draw',paint:{'line-color':'#ff9100','line-width':4,'line-dasharray':[2,2]}});

  if(!map.getSource('vn-mesh')) map.addSource('vn-mesh', {type: 'geojson', data: emptyFC()});
  if(!map.getLayer('vn-mesh')) map.addLayer({id:'vn-mesh', type:'line', source:'vn-mesh', paint:{'line-color':'rgba(0,212,255,0.15)', 'line-width':1}, layout:{visibility:'none'}});

  if(!map.getSource('vn-mesh-dots')) map.addSource('vn-mesh-dots', {type: 'geojson', data: emptyFC()});
  if(!map.getLayer('vn-mesh-dots')) map.addLayer({id:'vn-mesh-dots', type:'circle', source:'vn-mesh-dots', paint:{'circle-color':'#00d4ff', 'circle-radius':3, 'circle-blur':0.3, 'circle-opacity':0.9}, layout:{visibility:'none'}});

  if(!map.getSource('vn-route')) map.addSource('vn-route',{type:'geojson',data:emptyFC()});
  
  if(!map.getLayer('route-segs-hit')) map.addLayer({id:'route-segs-hit',type:'line',source:'vn-route',paint:{'line-width':25,'line-opacity':0},layout:{'line-join':'round','line-cap':'round'}});
  if(!map.getLayer('vn-shad')) map.addLayer({id:'vn-shad',type:'line',source:'vn-route',paint:{'line-color':'#000','line-width':9,'line-opacity':0.3,'line-blur':7,'line-offset':2.5},layout:{'line-join':'round','line-cap':'round'}});
  if(!map.getLayer('route-manual-bg')) map.addLayer({id:'route-manual-bg',type:'line',source:'vn-route',filter:['==',['get','isManual'],true],paint:{'line-color':'#ff9100','line-width':9,'line-offset':2.5},layout:{'line-join':'round','line-cap':'round'}});
  if(!map.getLayer('route-segs')) map.addLayer({id:'route-segs',type:'line',source:'vn-route',paint:{'line-color':['get','color'],'line-width':5,'line-opacity':.96,'line-offset':2.5},layout:{'line-join':'round','line-cap':'round'}});

  if(!map.getSource('vn-km')) map.addSource('vn-km',{type:'geojson',data:emptyFC()});
  if(!map.getLayer('vn-km-dot')) map.addLayer({id:'vn-km-dot',type:'circle',source:'vn-km',paint:{'circle-radius':5,'circle-color':'#fff','circle-stroke-width':1.5,'circle-stroke-color':'#000','circle-opacity':.85},layout:{visibility:'none'}});
  if(!map.getLayer('vn-km-lbl')) map.addLayer({id:'vn-km-lbl',type:'symbol',source:'vn-km',layout:{visibility:'none','text-field':['get','label'],'text-font':['Noto Sans Regular','Open Sans Regular','Arial Unicode MS Regular'],'text-size':11,'text-offset':[0,-1.5],'text-allow-overlap':true,'text-ignore-placement':true},paint:{'text-color':'#fff','text-halo-color':'rgba(0,0,0,.8)','text-halo-width':1.5}});
  
  if(!map.getSource('vn-warn')) map.addSource('vn-warn',{type:'geojson',data:emptyFC()});
  if(!map.getLayer('vn-warn')) map.addLayer({id:'vn-warn',type:'symbol',source:'vn-warn',layout:{'text-field':'!','text-font':['Noto Sans Bold','Open Sans Bold','Arial Unicode MS Bold'],'text-size':16,'text-allow-overlap':true},paint:{'text-color':'#fff','text-halo-color':'#ff3d6b','text-halo-width':3}});

  if(!map.getSource('vn-wps')) map.addSource('vn-wps',{type:'geojson',data:emptyFC()});
  // Invisible hit-detection layer — HTML pin markers are used for visuals
  if(!map.getLayer('vn-wp-pulse')) map.addLayer({id:'vn-wp-pulse',type:'circle',source:'vn-wps',filter:['==',['get','isEnd'],true],paint:{'circle-radius':0,'circle-color':'transparent','circle-opacity':0}});
  if(!map.getLayer('vn-wp-shad'))  map.addLayer({id:'vn-wp-shad', type:'circle',source:'vn-wps',paint:{'circle-radius':0,'circle-color':'transparent','circle-opacity':0}});
  if(!map.getLayer('vn-wps'))      map.addLayer({id:'vn-wps',     type:'circle',source:'vn-wps',paint:{'circle-radius':16,'circle-color':'transparent','circle-opacity':0.001,'circle-stroke-width':0}});
  if(!map.getLayer('vn-wp-lbl'))   map.addLayer({id:'vn-wp-lbl',  type:'circle',source:'vn-wps',paint:{'circle-radius':0,'circle-opacity':0}});

  // Navi ridden track (gefahrene Strecke)
  if(!map.getSource('vn-ridden')) map.addSource('vn-ridden',{type:'geojson',data:emptyFC()});
  if(!map.getLayer('vn-ridden-shadow')) map.addLayer({id:'vn-ridden-shadow',type:'line',source:'vn-ridden',paint:{'line-color':'rgba(0,0,0,.4)','line-width':11,'line-blur':5,'line-offset':2.5},layout:{'line-join':'round','line-cap':'round'}});
  if(!map.getLayer('vn-ridden')) map.addLayer({id:'vn-ridden',type:'line',source:'vn-ridden',paint:{'line-color':'#1565C0','line-width':6,'line-opacity':.92,'line-offset':2.5},layout:{'line-join':'round','line-cap':'round'}});
  if(!map.getLayer('vn-ridden-glow')) map.addLayer({id:'vn-ridden-glow',type:'line',source:'vn-ridden',paint:{'line-color':'rgba(100,181,246,.5)','line-width':12,'line-blur':8,'line-offset':2.5},layout:{'line-join':'round','line-cap':'round'}});
  // REC live track
  if(!map.getSource('vn-rec-live')) map.addSource('vn-rec-live',{type:'geojson',data:emptyFC()});
  if(!map.getLayer('vn-rec-live-shadow')) map.addLayer({id:'vn-rec-live-shadow',type:'line',source:'vn-rec-live',paint:{'line-color':'rgba(0,0,0,.35)','line-width':9,'line-blur':5},layout:{'line-join':'round','line-cap':'round'}});
  if(!map.getLayer('vn-rec-live-line')) map.addLayer({id:'vn-rec-live-line',type:'line',source:'vn-rec-live',paint:{'line-color':'#ff3d6b','line-width':5,'line-opacity':.9},layout:{'line-join':'round','line-cap':'round'}});
  if(!map.getLayer('vn-rec-live-glow')) map.addLayer({id:'vn-rec-live-glow',type:'line',source:'vn-rec-live',paint:{'line-color':'rgba(255,61,107,.4)','line-width':11,'line-blur':7},layout:{'line-join':'round','line-cap':'round'}});

  // GPS position dot for navi
  if(!map.getSource('vn-gps')) map.addSource('vn-gps',{type:'geojson',data:emptyFC()});
  if(!map.getLayer('vn-gps-ring')) map.addLayer({id:'vn-gps-ring',type:'circle',source:'vn-gps',paint:{'circle-radius':18,'circle-color':'rgba(0,212,255,.15)','circle-stroke-width':2,'circle-stroke-color':'rgba(0,212,255,.5)'}});
  if(!map.getLayer('vn-gps-dot')) map.addLayer({id:'vn-gps-dot',type:'circle',source:'vn-gps',paint:{'circle-radius':8,'circle-color':'#00d4ff','circle-stroke-width':2.5,'circle-stroke-color':'#fff','circle-pitch-alignment':'map'}});

  // Navigations-Richtungs-Layer (Teardrop)
  if(!map.hasImage('vn-nav-dot')) map.addImage('vn-nav-dot', createNavDotIcon());
  if(!map.getLayer('vn-gps-dot-nav')) map.addLayer({id:'vn-gps-dot-nav',type:'symbol',source:'vn-gps',layout:{'icon-image':'vn-nav-dot','icon-size':1,'icon-allow-overlap':true,'icon-ignore-placement':true,'icon-rotation-alignment':'map','icon-rotate':['coalesce',['get','bearing'],0],'visibility':'none'}});

  // Show current position dot during planning (low-power background watch)
  if(navigator.geolocation){
    window._bgGpsWatchId = navigator.geolocation.watchPosition(pos => {
      if(naviActive) return; // navi has its own handler
      if(recActive)  return; // rec has its own handler
      const {longitude:lng, latitude:lat} = pos.coords;
      // Letzten Standort für nächsten App-Start merken
      try { localStorage.setItem('vn_last_pos', JSON.stringify({lng, lat})); } catch(e){}
      if(map.getSource('vn-gps'))
        map.getSource('vn-gps').setData({type:'Feature',geometry:{type:'Point',coordinates:[lng,lat]}});
    }, ()=>{}, {enableHighAccuracy:false, maximumAge:15000, timeout:25000});
  }
}

// ══════════════════════════════════════════════════
// ROUTING
// ══════════════════════════════════════════════════
function addWaypoint(lng, lat){
  const idx = waypoints.length;
  waypoints.push({lng, lat, label:`P${idx+1}`, hidden: false, manualLine: false, customCoords: null});
  renderWpMarkers(); renderWpList();
  if(waypoints.length>=2) rerouteAll();
  else { updateWpDists(); renderElevChart(); }
}

async function rerouteAll(){
  showLoad('Route wird berechnet…');
  segments=[]; warnings=[];

  const osrmProfile = prefForest ? 'foot' : (PROFILES[activeProfile]?.osrm || 'cycling');

  for(let i=0;i<waypoints.length-1;i++){
    const a=waypoints[i], b=waypoints[i+1];

    if (b.manualLine) {
        let coords = [];
        if (b.customCoords) {
            coords = [...b.customCoords];
        } else {
            const steps = 10;
            for(let j=0; j<=steps; j++){
                coords.push([ a.lng + (b.lng - a.lng) * (j/steps), a.lat + (b.lat - a.lat) * (j/steps) ]);
            }
        }
        const elevs = await fetchElevations(coords);
        segments.push({coords, elevs});
        continue;
    }

    try {
      await sleep(80);

      if(usebrouter){
        // ── BRouter ──────────────────────────────────
        const seg = await fetchBRouterSegment(a, b);
        if(seg){
          // Fill any missing elevations via Open-Elevation
          const elevs = seg.elevs.some(e=>e==null) ? await fetchElevations(seg.coords) : seg.elevs;
          segments.push({coords:seg.coords, elevs});
        }
      } else {
        // ── OSRM fallback ────────────────────────────
        const res = await fetch(`https://router.project-osrm.org/route/v1/${osrmProfile}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson&annotations=true`);
        const data = await res.json();
        if(!data.routes?.length) continue;
        const coords = data.routes[0].geometry.coordinates;
        if (prefForest && data.routes[0].legs[0].annotation?.surface) {
            const surfs = data.routes[0].legs[0].annotation.surface;
            let lastWarn = -100;
            surfs.forEach((s, idx) => {
                if (['unpaved', 'sand', 'dirt', 'grass', 'mud', 'gravel'].includes(s) && (idx - lastWarn > 30)) {
                    warnings.push({coord: coords[idx], msg: `⚠️ ${s}`});
                    lastWarn = idx;
                }
            });
        }
        const elevs = await fetchElevations(coords);
        segments.push({coords, elevs});
      }
    } catch(e){
      console.error('Routing error:', e);
      // Try OSRM as fallback if BRouter fails
      if(usebrouter){
        try{
          const res = await fetch(`https://router.project-osrm.org/route/v1/${osrmProfile}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`);
          const data = await res.json();
          if(data.routes?.length){
            const coords = data.routes[0].geometry.coordinates;
            const elevs = await fetchElevations(coords);
            segments.push({coords, elevs});
          }
        } catch(e2){ console.error(e2); }
      }
    }
  }

  rebuildRoute(); hideLoad();
}

function rebuildRoute(){
  fullRoute.coords=[]; fullRoute.elevs=[];
  for(const seg of segments){ fullRoute.coords.push(...seg.coords); fullRoute.elevs.push(...seg.elevs); }
  calcFullStats();
  updateWpDists();
  renderRoute();
  renderWarnings();
  renderStats();
  renderElevChart();
  updateKmMarkers();
  // Show navi FAB when route exists, rec FAB when no route and not recording-active
  const fab = document.getElementById('navi-start-fab');
  const recFab = document.getElementById('rec-start-fab');
  const hasRoute = fullRoute.coords.length >= 2;
  if(fab)    fab.style.display    = hasRoute ? 'flex' : 'none';
  if(recFab) recFab.style.display = (!hasRoute && !naviActive) ? 'flex' : 'none';
  // Start route pulse animation
  if(fullRoute.coords.length >= 2){
    startPulseAnimation(fullRoute.coords);
  } else if(pulseReqId){
    cancelAnimationFrame(pulseReqId); pulseReqId=null;
    if(map.getSource('vn-pulse')) map.getSource('vn-pulse').setData({type:'Feature',geometry:{type:'Point',coordinates:[0,0]}});
  }
}

function renderWarnings() {
  if(!map.getSource('vn-warn')) return;
  map.getSource('vn-warn').setData({
      type: 'FeatureCollection',
      features: warnings.map(w => ({
          type: 'Feature', geometry: {type: 'Point', coordinates: w.coord}, properties: {msg: w.msg}
      }))
  });
}

function toggleWald() {
    prefForest = !prefForest;
    document.getElementById('btn-wald')?.classList.toggle('active', prefForest);
    document.getElementById('mob-btn-wald')?.classList.toggle('active', prefForest);
    if(waypoints.length > 1) rerouteAll();
}

function toggleRouter(){
  usebrouter = !usebrouter;
  // Sync all engine toggle buttons (stats quick-toggle + plan tab)
  ['btn-brouter','mob-btn-brouter','mob-btn-brouter2','dsk-btn-brouter'].forEach(id=>{
    document.getElementById(id)?.classList.toggle('active', usebrouter);
  });
  ['mob-btn-osrm','dsk-btn-osrm'].forEach(id=>{
    document.getElementById(id)?.classList.toggle('active', !usebrouter);
  });
  // Show/hide BRouter profile grids
  ['dsk-brouter-profs','mob-brouter-profs'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.style.display = usebrouter ? '' : 'none';
  });
  showToast(usebrouter ? '🔀 BRouter aktiviert' : '🔁 Standard-Router (OSRM)');
  if(waypoints.length > 1) rerouteAll();
}

function setBrouterProfile(id, btn){
  brouterProfile = id;
  document.querySelectorAll('.bp-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll(`.bp-btn[data-pid="${id}"]`).forEach(b => b.classList.add('active'));
  if(waypoints.length > 1 && usebrouter) rerouteAll();
}

function renderBrouterProfileBtns(){
  ['bp-grid-dsk', 'mob-bp-grid'].forEach(gridId => {
    const g = document.getElementById(gridId);
    if(!g) return;
    g.innerHTML = BROUTER_PROFILES.map(p=>`
      <button class="bp-btn${p.id===brouterProfile?' active':''}" data-pid="${p.id}" onclick="setBrouterProfile('${p.id}',this)">
        ${p.icon} ${p.label}
      </button>`).join('');
  });
  // Also sync the engine button states
  ['btn-brouter','mob-btn-brouter','mob-btn-brouter2','dsk-btn-brouter'].forEach(id=>{
    document.getElementById(id)?.classList.toggle('active', usebrouter);
  });
  ['mob-btn-osrm','dsk-btn-osrm'].forEach(id=>{
    document.getElementById(id)?.classList.toggle('active', !usebrouter);
  });
}

// ══════════════════════════════════════════════════
// RENDER ROUTE & WPS
// ══════════════════════════════════════════════════
function renderRoute(){
  const {coords,elevs} = fullRoute;
  if(!map.getSource('vn-route')) return;
  if(coords.length<2){
    map.getSource('vn-route').setData(emptyFC());
    if(map.getSource('vn-shad')) map.getSource('vn-shad').setData(emptyFC());
    return;
  }
  const cum=[0];
  for(let i=0;i<coords.length-1;i++) cum.push(cum[cum.length-1]+haversineM(coords[i],coords[i+1]));
  
  const feats=[];
  const win=120;
  for(let i=0;i<coords.length-1;i++){
    let ip=i,in2=i+1;
    while(ip>0&&cum[i]-cum[ip]<win/2) ip--;
    while(in2<coords.length-1&&cum[in2]-cum[i]<win/2) in2++;
    const span=cum[in2]-cum[ip];
    const grade=span>0.5?((elevs[in2]-elevs[ip])/span)*100:0;
    
    let isManual = false;
    for(let w=1; w<waypoints.length; w++) {
        if(waypoints[w].manualLine && cum[i] >= window.wpDistKm[w-1]*1000 && cum[i] <= window.wpDistKm[w]*1000) {
            isManual = true; break;
        }
    }
    
    feats.push({type:'Feature',properties:{color:gradeColor(grade),grade:grade.toFixed(1),elev:(elevs[i]||0).toFixed(0), isManual: isManual},geometry:{type:'LineString',coordinates:[coords[i],coords[i+1]]}});
  }
  map.getSource('vn-route').setData({type:'FeatureCollection',features:feats});
}

window.toggleGlobalWps = function() {
    globalWpVisible = !globalWpVisible;
    if(globalWpVisible) waypoints.forEach(w => w.hidden = false);
    document.getElementById('btn-wp-vis').classList.toggle('active', globalWpVisible);
    const mwv=document.getElementById('mob-btn-wp-vis'); if(mwv) mwv.classList.toggle('active',globalWpVisible);
    renderWpMarkers();
    renderWpList();
};

window.routeFromHereToWp = function(wpIdx){
  document.querySelector('.maplibregl-popup')?.remove();
  if(!navigator.geolocation){ showToast('GPS nicht verfügbar'); return; }
  showToast('📍 Standort wird ermittelt…');
  navigator.geolocation.getCurrentPosition(pos => {
    const {longitude:lng, latitude:lat} = pos.coords;
    const dest = waypoints[wpIdx];
    if(!dest){ showToast('Wegpunkt nicht gefunden'); return; }
    // Standort als neuen ersten Wegpunkt einfügen; falls WP 0 bereits "Standort" → ersetzen
    const startWp = {lat, lng, label:'Standort', hidden:false, manualLine:false, customCoords:null};
    if(waypoints.length > 0 && waypoints[0].label === 'Standort'){
      waypoints[0] = startWp;
    } else {
      waypoints.unshift(startWp);
    }
    renderWpMarkers();
    renderWpList();
    showToast('🗺 Route wird berechnet…');
    rerouteAll().then(() => {
      mapFitRoute();
      showToast(`✅ Route von Standort zu WP ${wpIdx + 1}`);
    });
  }, () => showToast('❌ Standort nicht verfügbar'), {enableHighAccuracy:true, timeout:8000});
};

window.hideSingleWp = function(idx) {
    waypoints[idx].hidden = true;
    document.querySelector('.maplibregl-popup')?.remove();
    renderWpMarkers();
    renderWpList();
};

window.unhideWp = function(idx) {
    waypoints[idx].hidden = false;
    renderWpMarkers();
    renderWpList();
};

function makePinSVG(color, label, size=34){
  const h = Math.round(size * 1.36);
  const cx = size/2, cy = size*0.44;
  const r  = size*0.46, ri = size*0.28;
  const tip = h;
  return `<svg width="${size}" height="${tip}" viewBox="0 0 ${size} ${tip}" xmlns="http://www.w3.org/2000/svg">
    <path d="M${cx} 0 C${cx-r} 0 ${cx-r} ${cy*2} ${cx} ${cy*2+r*0.9} C${cx+r} ${cy*2} ${cx+r} 0 ${cx} 0Z" fill="${color}" opacity="0.15"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(0,0,0,0.18)"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>
    <path d="M${cx-r*0.7} ${cy+r*0.6} Q${cx} ${tip} ${cx+r*0.7} ${cy+r*0.6}" fill="${color}"/>
    <circle cx="${cx}" cy="${cy}" r="${ri}" fill="white" opacity="0.92"/>
    <text x="${cx}" y="${cy+4}" text-anchor="middle" font-family="-apple-system,system-ui,sans-serif" font-size="${size*0.29}" font-weight="800" fill="${color}">${label}</text>
    <rect x="${cx-size*0.7}" y="0" width="${size*1.4}" height="${tip}" fill="transparent"/>
  </svg>`;
}

// Pin dimensions for default size=34
const PIN_W = 34;
const PIN_H = Math.round(34 * 1.36); // 46px

function renderWpMarkers(){
  if(!map||!map.getSource('vn-wps')) return;

  // Update invisible GeoJSON for hit detection
  map.getSource('vn-wps').setData({
    type:'FeatureCollection',
    features:waypoints.map((wp,i)=>{
      const isEnd = i === 0 || i === waypoints.length - 1;
      const visible = isEnd || (globalWpVisible && !wp.hidden);
      if(!visible) return null;
      return {
        type:'Feature',
        properties:{index:i, color:i===0?'#00e676':i===waypoints.length-1?'#ff3d6b':'#ffd600', isEnd},
        geometry:{type:'Point',coordinates:[wp.lng,wp.lat]}
      };
    }).filter(Boolean)
  });

  // Remove old HTML markers
  wpMarkers.forEach(m => m.remove());
  wpMarkers = [];

  // Create new HTML pin markers with hold-to-drag / tap-for-popup
  waypoints.forEach((wp, i) => {
    const isEnd  = i === 0 || i === waypoints.length - 1;
    const visible = isEnd || (globalWpVisible && !wp.hidden);
    if(!visible) return;
    const color = i===0 ? '#00e676' : i===waypoints.length-1 ? '#ff3d6b' : '#ffd600';
    const el = document.createElement('div');
    el.className = 'wp-pin-wrap';
    // Explicit size so MapLibre can measure correctly before animation starts
    el.style.width  = PIN_W + 'px';
    el.style.height = PIN_H + 'px';
    el.style.display = 'block';
    el.innerHTML = '<div class="wp-pin-inner">' + makePinSVG(color, i+1) + '</div>';

    // ── Hold-to-drag / tap-for-popup logic ──────────────────
    let pinHoldTimer = null;
    let pinIsDragging = false;
    let pinMoved = false;
    const HOLD_MS = 350;

    function pinShowPopup(){
      document.querySelector('.maplibregl-popup')?.remove();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 400);
      new maplibregl.Popup({closeButton:false, anchor:'bottom', offset:6})
        .setLngLat([wp.lng, wp.lat])
        .setHTML(`<div style="position:relative;text-align:center;min-width:150px;font-family:var(--font);padding-top:4px;">
          <div class="popup-x" onclick="document.querySelector('.maplibregl-popup')?.remove()">✕</div>
          <div style="font-size:14px;font-weight:600;margin-bottom:11px;">Wegpunkt ${i+1}</div>
          <button class="btn" style="width:100%;justify-content:center;padding:7px;margin-bottom:5px;border-color:rgba(0,212,255,.4);color:var(--accent);" onclick="routeFromHereToWp(${i})">📍 Route von Standort</button>
          <button class="btn ok" style="width:100%;justify-content:center;padding:7px;margin-bottom:5px;" onclick="startDraw(${i})">✏️ Freihand zeichnen</button>
          ${i!==0&&i!==waypoints.length-1?`<button class="btn" style="width:100%;justify-content:center;padding:7px;margin-bottom:5px;" onclick="hideSingleWp(${i})">👁 Verbergen</button>`:''}
          <button class="btn danger" style="width:100%;justify-content:center;padding:7px;" onclick="removeWp(${i});document.querySelector('.maplibregl-popup')?.remove()">✕ Löschen</button>
        </div>`)
        .addTo(map);
    }

    function startPinDrag(){
      _activePinDrag = true;
      pinIsDragging = true;
      dragWpId = i;
      isDraggingWp = true;
      el.querySelector('.wp-pin-inner').classList.add('wp-pin-dragging');
      el.querySelector('.wp-pin-inner').classList.remove('wp-pin-drop-in');
      map.dragPan.disable();
      document.querySelector('.maplibregl-popup')?.remove();
    }

    function endPinDrag(){
      if(!pinIsDragging) return;
      pinIsDragging = false;
      el.querySelector('.wp-pin-inner').classList.remove('wp-pin-dragging');
      isDraggingWp = false;
      map.dragPan.enable();
      // Ring FX at final position (convert map coords → screen coords)
      const rect = map.getCanvas().getBoundingClientRect();
      const pt = map.project([wp.lng, wp.lat]);
      spawnRingFX(pt.x + rect.left, pt.y + rect.top, color);
      if(!isLongPress) rerouteAll();
      _activePinDrag = false;
      dragWpId = null;
    }

    // Mouse events
    el.addEventListener('mousedown', (ev) => {
      if(naviActive) return;
      ev.stopPropagation(); ev.preventDefault();
      pinMoved = false;
      suppressClick = true;

      // Sofort dragPan sperren – verhindert dass die Karte unter dem Pin
      // wegscrollt und es so aussieht als würde der Pin der Maus folgen.
      map.dragPan.disable();

      pinHoldTimer = setTimeout(() => {
        startPinDrag();
      }, HOLD_MS);

      // End drag on mouseup anywhere
      const onMouseUp = () => {
        clearTimeout(pinHoldTimer);
        if(pinIsDragging){
          endPinDrag();
        } else {
          // Kein Drag → dragPan wiederherstellen, Popup zeigen
          map.dragPan.enable();
          pinShowPopup();
        }
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 400);
        window.removeEventListener('mouseup', onMouseUp);
      };
      window.addEventListener('mouseup', onMouseUp);
    });

    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // popup is handled by mouseup above; suppress map click
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 400);
    });

    // Touch events
    el.addEventListener('touchstart', (ev) => {
      if(naviActive) return;
      ev.stopPropagation();
      pinMoved = false;
      pinHoldTimer = setTimeout(() => {
        startPinDrag();
      }, HOLD_MS);
    }, {passive:true});

    el.addEventListener('touchend', (ev) => {
      ev.stopPropagation();
      clearTimeout(pinHoldTimer);
      if(pinIsDragging){
        endPinDrag();
      } else if(!pinMoved){
        pinShowPopup();
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 400);
      }
      touchedWpIdx = null; touchedWpCoord = null;
    });

    el.addEventListener('touchmove', (ev) => {
      pinMoved = true;
      clearTimeout(pinHoldTimer);
      if(!pinIsDragging) return;
      ev.preventDefault();
      const t = ev.touches[0];
      const rect = map.getCanvas().getBoundingClientRect();
      const lngLat = map.unproject([t.clientX - rect.left, t.clientY - rect.top]);
      waypoints[i].lng = lngLat.lng;
      waypoints[i].lat = lngLat.lat;
      marker.setLngLat([lngLat.lng, lngLat.lat]);
    }, {passive:false});

    // anchor:'bottom' + offset centers the pin tip on the coordinate.
    // We set it explicitly so MapLibre uses our known PIN_W/PIN_H, not a live measurement.
    const marker = new maplibregl.Marker({element:el, anchor:'bottom', offset:[0, 0]})
      .setLngLat([wp.lng, wp.lat])
      .addTo(map);
    marker._wpIdx = i;
    wpMarkers.push(marker);
    // Add drop-in animation AFTER marker is in DOM (avoids animation-offset confusing MapLibre)
    requestAnimationFrame(() => { el.querySelector('.wp-pin-inner').classList.add('wp-pin-drop-in'); });
  });
}

// Stats
function calcFullStats(){
  const {coords,elevs} = fullRoute;
  let dist=0, up=0, dn=0, maxG=0;
  for(let i=0;i<coords.length-1;i++){
    const d = haversineM(coords[i],coords[i+1]);
    dist += d;
    const de=(elevs[i+1]||0)-(elevs[i]||0);
    if(de>0&&elevs[i]>0) up+=de;
    else if(de<0&&elevs[i]>0) dn+=Math.abs(de);
    if(d>0.5) maxG=Math.max(maxG,Math.abs(de/d)*100);
  }
  fullRoute.dist=dist; fullRoute.up=up; fullRoute.dn=dn; fullRoute.maxGrade=maxG;
}

function renderStats(){
  const {dist,up,dn,maxGrade} = fullRoute;
  const w = parseFloat(document.getElementById('weight-inp')?.value||75);
  const cal = calcCalories(dist, up, w, currentSpeedKmh);
  const timeSec = dist>0 ? (dist/1000/currentSpeedKmh)*3600 : 0;

  // Desktop stats
  setEl('s-dist', dist>0?fmtDist(dist):'—');
  setEl('s-up', dist>0?`${Math.round(up)} m`:'—');
  setEl('s-down', dist>0?`${Math.round(dn)} m`:'—');
  setEl('s-grade', dist>0?`${maxGrade.toFixed(1)}%`:'—');
  setEl('s-time', dist>0?fmtTime(timeSec):'—');
  setEl('s-speed', dist>0?`${currentSpeedKmh} km/h`:'—');
  setEl('s-cal', dist>0?`${cal}`:'—');
  setEl('dur-val', dist>0?fmtTime(timeSec):'—');
  setEl('wp-count', waypoints.length);

  // Mobile peek stats
  setEl('pm-dist', dist>0?(dist/1000).toFixed(1):'—');
  setEl('pm-up', dist>0?`${Math.round(up)}`:'—');
  setEl('pm-time', dist>0?fmtTime(timeSec):'—');
  setEl('pm-cal', dist>0?`${cal}`:'—');

  // Mobile sheet stats
  setEl('ms-dist', dist>0?fmtDist(dist):'—');
  setEl('ms-time', dist>0?fmtTime(timeSec):'—');
  setEl('ms-up', dist>0?`${Math.round(up)} m`:'—');
  setEl('ms-down', dist>0?`${Math.round(dn)} m`:'—');
  setEl('ms-grade', dist>0?`${maxGrade.toFixed(1)}%`:'—');
  setEl('ms-speed', dist>0?`${currentSpeedKmh} km/h`:'—');
  setEl('ms-cal', dist>0?`${cal}`:'—');
}

function setEl(id, val){ const el=document.getElementById(id); if(el) el.textContent=val; }
function recalcStats(){ renderStats(); }

function renderWpList(){
  setEl('wp-count', waypoints.length);
  const html = waypoints.length===0 ?
    '<div class="wp-empty">Klicke auf die Karte<br>um Wegpunkte zu setzen</div>' :
    waypoints.map((wp,i)=>{
      const isF=i===0, isL=i===waypoints.length-1;
      const col=isF?'#00e676':isL?'#ff3d6b':'#ffd600';
      const tag=isF?'Start':isL?'Ziel':`WP ${i}`;
      return `<div class="wp-item" draggable="true" ondragstart="wdStart(event,${i})" ondragend="wdEnd(event)" ondragover="wdOver(event)" ondrop="wdDrop(event,${i})" ondragenter="wdEnter(event)" ondragleave="wdLeave(event)">
        <div class="wp-handle">☰</div>
        <div class="wp-dot" style="background:${col};color:#000">${i+1}</div>
        <div class="wp-info">
          <div class="wp-tag" style="color:${col}">${tag} ${wp.manualLine?' <span style="font-size:9px;color:var(--orange)">(Manuell)</span>':''}</div>
          <div class="wp-coord">${wp.lat.toFixed(5)}°N ${wp.lng.toFixed(5)}°E</div>
        </div>
        ${wp.hidden ? `<button class="wp-del" onclick="unhideWp(${i})" title="Wieder einblenden">👁️</button>` : `<button class="wp-del" onclick="removeWp(${i})" title="Löschen">✕</button>`}
      </div>`;
    }).join('');
  document.getElementById('wp-list').innerHTML=html;
  // Also update mobile list
  const mobList = document.getElementById('mob-wp-list');
  if(mobList) mobList.innerHTML = html;
}

let wdSrcIdx=null;
function wdStart(e,i){ wdSrcIdx=i; e.dataTransfer.effectAllowed='move'; e.target.style.opacity='.4'; }
function wdOver(e){ e.preventDefault(); e.dataTransfer.dropEffect='move'; }
function wdEnter(e){ e.currentTarget.classList.add('drag-over'); }
function wdLeave(e){ e.currentTarget.classList.remove('drag-over'); }
function wdEnd(e){ e.target.style.opacity='1'; }
async function wdDrop(e,ti){
  e.stopPropagation(); e.currentTarget.classList.remove('drag-over');
  if(wdSrcIdx===null||wdSrcIdx===ti) return;
  const m=waypoints.splice(wdSrcIdx,1)[0];
  waypoints.splice(ti,0,m);
  waypoints.forEach((wp,i)=>wp.label=`P${i+1}`);
  renderWpMarkers(); renderWpList();
  if(waypoints.length>=2) await rerouteAll(); else rebuildRoute();
}

async function removeWp(idx){
  waypoints.splice(idx,1);
  waypoints.forEach((wp,i)=>wp.label=`P${i+1}`);
  renderWpMarkers(); renderWpList();
  if(waypoints.length>=2) await rerouteAll(); else rebuildRoute();
}

function undoWp(){
  if(!waypoints.length) return;
  waypoints.pop();
  renderWpMarkers(); renderWpList();
  if(waypoints.length>=2) rerouteAll(); else rebuildRoute();
}

function clearAll(){
  waypoints=[]; segments=[]; window.wpDistKm=[]; warnings=[];
  fullRoute={coords:[],elevs:[],dist:0,up:0,dn:0,maxGrade:0};
  // Remove all HTML pin markers
  if(typeof wpMarkers !== 'undefined'){ wpMarkers.forEach(m=>m.remove()); wpMarkers=[]; }
  ['vn-route','vn-shad','vn-wps','vn-km','vn-warn','vn-draw'].forEach(id=>{ if(map&&map.getSource(id)) map.getSource(id).setData(emptyFC()); });
  renderWpList(); renderStats();
  setEl('dur-val','—');
  if(elevChart){ elevChart.data.datasets[0].data=[]; elevChart.update('none'); }
  const mobEl=document.getElementById('mob-elev-chart'); if(mobEl&&mobEl._chart){ mobEl._chart.data.datasets[0].data=[]; mobEl._chart.update('none'); }
  // Hide navi FAB, show rec FAB (no route active → recording possible again)
  const fab=document.getElementById('navi-start-fab'); if(fab) fab.style.display='none';
  const recFab=document.getElementById('rec-start-fab'); if(recFab && !naviActive) recFab.style.display='flex';
  // Stop pulse animation
  if(typeof pulseReqId!=='undefined'&&pulseReqId){ cancelAnimationFrame(pulseReqId); pulseReqId=null; }
  if(map&&map.getSource('vn-pulse')) try{ map.getSource('vn-pulse').setData({type:'Feature',geometry:{type:'Point',coordinates:[0,0]}}); }catch(e){}
  showToast('✓ Route und Wegpunkte gelöscht');
}

function updateWpDists(){
  window.wpDistKm=[0]; let run=0;
  for(const seg of segments){
    let d=0;
    for(let i=0;i<seg.coords.length-1;i++) d+=haversineM(seg.coords[i],seg.coords[i+1]);
    run+=d;
    window.wpDistKm.push(run/1000);
  }
}

