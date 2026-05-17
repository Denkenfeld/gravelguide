  import { Client, Account, Databases, ID, Query } from 'https://cdn.jsdelivr.net/npm/appwrite@16/dist/esm/sdk.js';

  // ── Appwrite Konfiguration ────────────────────
  const AW_ENDPOINT  = 'https://cloud.appwrite.io/v1';
  const AW_PROJECT   = '69ff896300258f20e17a';
  const AW_DB        = '69ff8f4c003d6fd82f1e';
  const AW_COL       = 'routes';

  // Fix: Chrome/iOS bug — ensure endpoint is always a clean, non-empty string
  // The error "t.split is not a function" is caused by setEndpoint receiving
  // undefined or a non-string value (e.g. from localStorage returning null).
  const _safeEndpoint = (typeof AW_ENDPOINT === 'string' && AW_ENDPOINT)
    ? AW_ENDPOINT.replace(/\/+$/, '')   // strip trailing slashes
    : 'https://cloud.appwrite.io/v1';
  const client = new Client().setEndpoint(_safeEndpoint).setProject(AW_PROJECT);
  const account = new Account(client);
  const db      = new Databases(client);

  // ── Session-State ────────────────────────────
  let currentUser = null;

  async function initAuth(){
    // Passwort-Reset via E-Mail-Link?
    const params = new URLSearchParams(window.location.search);
    if(params.get('userId') && params.get('secret')){
      showRecoveryModal();
      return; // Kein Auto-Login während Recovery
    }
    updateUserAvatars(); // show ? immediately
    try {
      currentUser = await account.get();
    } catch(e){ currentUser = null; }

    if(currentUser){
      // Gewicht + Cloud-Daten zuerst laden, DANN Profil rendern
      // so dass buildLoggedInHTML den richtigen Gewichtswert kennt
      await loadCloudRoutes();
      renderProfileTab();
    } else {
      renderProfileTab();
    }
  }

  // ── Hilfsfunktion: Feld innerhalb des Containers finden ──
  // Buttons übergeben sich selbst (this), wir gehen zum nächsten .sb-Container hoch
  // und suchen dort das Input per data-field Attribut. Keine doppelten IDs nötig.
  function fieldVal(btn, dataField){
    const container = btn.closest('.sb');
    if(!container) return '';
    const el = container.querySelector(`[data-field="${dataField}"]`);
    return el ? el.value.trim() : '';
  }
  function fieldValRaw(btn, dataField){
    const container = btn.closest('.sb');
    if(!container) return '';
    const el = container.querySelector(`[data-field="${dataField}"]`);
    return el ? el.value : '';
  }

  // ── Registrierung ────────────────────────────
  window.registerUser = async function(btn){
    const email = fieldVal(btn,'reg-email');
    const pass  = fieldValRaw(btn,'reg-pass');
    const name  = fieldVal(btn,'reg-name') || email;
    if(!email||!pass){ showToast('E-Mail und Passwort eingeben'); return; }
    btn.disabled = true; btn.textContent = '⏳ Bitte warten…';
    try {
      await account.create(ID.unique(), email, pass, name);
      await account.createEmailPasswordSession(email, pass);
      currentUser = await account.get();
      await loadCloudRoutes();
      renderProfileTab();
      showToast('✓ Account erstellt & eingeloggt!');
    } catch(e){
      showToast('Fehler: ' + (e.message||'Registrierung fehlgeschlagen'));
      btn.disabled = false; btn.textContent = '✨ Account erstellen';
    }
  };

  // ── Login ─────────────────────────────────────
  window.loginUser = async function(btn){
    const email = fieldVal(btn,'login-email');
    const pass  = fieldValRaw(btn,'login-pass');
    if(!email||!pass){ showToast('E-Mail und Passwort eingeben'); return; }
    btn.disabled = true; btn.textContent = '⏳ Bitte warten…';
    try {
      await account.createEmailPasswordSession(email, pass);
      currentUser = await account.get();
      await loadCloudRoutes();
      renderProfileTab();
      showToast('✓ Willkommen zurück, ' + (currentUser.name||currentUser.email) + '!');
    } catch(e){
      showToast('Login fehlgeschlagen: ' + (e.message||''));
      btn.disabled = false; btn.textContent = '🔑 Einloggen';
    }
  };

  // ── Logout ────────────────────────────────────
  window.logoutUser = async function(){
    try { await account.deleteSession('current'); } catch(e){}
    currentUser = null;
    renderProfileTab();
    renderCloudRoutes([]);
    showToast('Abgemeldet');
  };

  // ── Passwort vergessen ────────────────────────
  window.showResetForm = function(btn){
    const sb = btn.closest('.sb');
    if(!sb) return;
    sb.querySelector('.auth-form-login').style.display = 'none';
    sb.querySelector('.auth-form-reg').style.display   = 'none';
    sb.querySelector('.auth-form-reset').style.display = '';
    sb.querySelectorAll('.auth-tab-btn').forEach(b =>
      Object.assign(b.style, {background:'none', color:'var(--dim)'})
    );
  };

  window.cancelResetForm = function(btn){
    const sb = btn.closest('.sb');
    if(!sb) return;
    sb.querySelector('.auth-form-reset').style.display = 'none';
    sb.querySelector('.auth-form-login').style.display = '';
    // Login-Tab optisch reaktivieren
    const loginTabBtn = sb.querySelector('.auth-tab-btn');
    if(loginTabBtn) Object.assign(loginTabBtn.style, {background:'var(--accent-dim)', color:'var(--accent)'});
  };

  window.sendPasswordReset = async function(btn){
    const sb = btn.closest('.sb');
    if(!sb) return;
    const emailEl = sb.querySelector('[data-field="reset-email"]');
    const email = emailEl ? emailEl.value.trim() : '';
    if(!email){ showToast('Bitte E-Mail eingeben'); return; }
    btn.disabled = true; btn.textContent = '⏳ Wird gesendet…';
    try {
      const redirectUrl = window.location.origin + window.location.pathname;
      await account.createRecovery(email, redirectUrl);
      // Erfolgs-View zeigen
      const form = sb.querySelector('.auth-form-reset');
      if(form) form.innerHTML = `
        <div style="text-align:center;padding:8px 0 4px;">
          <div style="font-size:32px;margin-bottom:8px;">📬</div>
          <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:6px;">E-Mail gesendet!</div>
          <div style="font-size:11px;color:var(--dim);line-height:1.6;margin-bottom:12px;">Prüfe dein Postfach (<b style="color:var(--accent)">${email}</b>) und klicke den Link zum Zurücksetzen.</div>
          <button class="btn" style="width:100%;justify-content:center;padding:9px;" onclick="cancelResetForm(this)">← Zurück zum Login</button>
        </div>`;
    } catch(e){
      showToast('Fehler: ' + (e.message || 'Reset fehlgeschlagen'));
      btn.disabled = false; btn.textContent = '📤 Reset-Link senden';
    }
  };

  // ── Neues Passwort nach Recovery-Link setzen ─
  window.submitNewPassword = async function(btn){
    const sb = btn.closest('.sb') || btn.closest('.dlg-body');
    if(!sb) return;
    const p1 = sb.querySelector('[data-field="new-pass"]')?.value || '';
    const p2 = sb.querySelector('[data-field="new-pass2"]')?.value || '';
    if(p1.length < 8){ showToast('Passwort muss mind. 8 Zeichen haben'); return; }
    if(p1 !== p2){ showToast('Passwörter stimmen nicht überein'); return; }
    btn.disabled = true; btn.textContent = '⏳ Bitte warten…';
    try {
      const params = new URLSearchParams(window.location.search);
      await account.updateRecovery(params.get('userId'), params.get('secret'), p1);
      showToast('✓ Passwort geändert! Du kannst dich jetzt einloggen.');
      // URL bereinigen & Recovery-Modal schließen
      window.history.replaceState({}, '', window.location.pathname);
      document.getElementById('recovery-modal')?.remove();
      renderProfileTab();
    } catch(e){
      showToast('Fehler: ' + (e.message || 'Reset fehlgeschlagen'));
      btn.disabled = false; btn.textContent = '🔑 Passwort speichern';
    }
  };

  // ── Gewicht via Appwrite User-Preferences speichern ─────
  // account.updatePrefs() speichert beliebige Key-Value-Daten direkt am User-Account.
  // Kein eigener DB-Eintrag, kein Index-Problem, kein Duplikat-Risiko.
  window.saveWeightToCloud = async function(weightKg){
    if(!currentUser) return;
    const w = parseFloat(weightKg);
    if(!w || w < 20 || w > 300) return;
    localStorage.setItem('vn_weight', String(w));
    const h = document.getElementById('weight-inp');
    if(h) h.value = w;
    try {
      const curSpd = parseInt(localStorage.getItem('vn_speed')||'16');
      const curBike = parseFloat(localStorage.getItem('vn_bike_weight')||'12');
      await account.updatePrefs({ weight: w, speed: curSpd, bikeWeight: curBike });
    } catch(e){ console.warn('Weight prefs save failed:', e); }
  };

  window.saveBikeWeightToCloud = async function(weightKg){
    if(!currentUser) return;
    const bw = parseFloat(weightKg);
    if(!bw || bw < 1 || bw > 50) return;
    localStorage.setItem('vn_bike_weight', String(bw));
    try {
      const curW   = parseFloat(localStorage.getItem('vn_weight')||'75');
      const curSpd = parseInt(localStorage.getItem('vn_speed')||'16');
      await account.updatePrefs({ weight: curW, speed: curSpd, bikeWeight: bw });
    } catch(e){ console.warn('Bike weight prefs save failed:', e); }
  };

  window.saveSpeedToCloud = async function(speedKmh){
    const sp = parseInt(speedKmh);
    if(!sp || sp < 10 || sp > 30) return;
    localStorage.setItem('vn_speed', String(sp));
    if(typeof window.setSpeedFromProfile === 'function') window.setSpeedFromProfile(sp);
    if(!currentUser) return;
    try {
      const curW   = parseFloat(localStorage.getItem('vn_weight')||'75');
      const curBike = parseFloat(localStorage.getItem('vn_bike_weight')||'12');
      await account.updatePrefs({ speed: sp, weight: curW, bikeWeight: curBike });
    } catch(e){ console.warn('Speed prefs save failed:', e); }
  };

  // ── Route in Cloud speichern ──────────────────
  window.saveRouteToCloud = async function(routeData){
    if(!currentUser){ showToast('Bitte zuerst einloggen'); return; }
    try {
      const w = parseFloat(routeData.weight) || parseFloat(document.getElementById('weight-inp')?.value) || 75;
      const spd = parseFloat(routeData.speed) || parseFloat(localStorage.getItem('vn_speed')) || 16;
      const doc = {
        userId:      currentUser.$id,
        routeName:   routeData.name,
        distance:    Math.round(routeData.distance || 0),
        coordinates: JSON.stringify((routeData.coordinates||[]).slice(0,200)),
        waypoints:   JSON.stringify((routeData.waypoints||[]).slice(0,50)),
        elevation:   Math.round(routeData.elevation || 0),
        calories:    Math.round(routeData.calories || 0),
        date:        routeData.date || new Date().toISOString().slice(0,10),
        weight:      w,
        coins:       routeData.coins || 0,
        ridetime:    Math.round(routeData.ridetime || 0),
        speed:       Math.round(spd)
      };
      await db.createDocument(AW_DB, AW_COL, ID.unique(), doc);
      showToast('☁️ Route in Cloud gespeichert!');
      renderProfileTab(); // lädt Cloud-Routen + baut Statistiken neu auf
    } catch(e){
      showToast('Cloud-Fehler: ' + (e.message||''));
    }
  };

  // ── Pagination State ─────────────────────────
  let _cloudAllDocs    = [];  // akkumulierte Dokumente
  let _cloudHasMore    = false;
  let _cloudNextOffset = 0;  // tracks raw DB offset (includes skipped docs)
  let _cloudRawOffset  = 0;  // actual DB cursor position
  const CLOUD_PAGE_INIT = 9;
  const CLOUD_PAGE_MORE = 10;

  // ── Cloud-Routen laden & anzeigen ────────────
  async function loadCloudRoutes(append){
    if(!currentUser) return;
    if(!append){
      _cloudAllDocs    = [];
      _cloudNextOffset = 0;
      _cloudRawOffset  = 0;
      _cloudHasMore    = false;
    }
    const limit = append ? CLOUD_PAGE_MORE : CLOUD_PAGE_INIT;
    try {
      // ── Gewicht aus User-Preferences laden ──────────────────
      if(!append){
        try {
          const prefs = await account.getPrefs();
          if(prefs.weight && prefs.weight >= 20 && prefs.weight <= 300){
            const w = prefs.weight;
            localStorage.setItem('vn_weight', String(w));
            const h = document.getElementById('weight-inp');
            if(h) h.value = w;
            document.querySelectorAll('input[type="number"][min="30"][max="200"]').forEach(el => {
              if(el.id !== 'weight-inp') el.value = w;
            });
          }
          if(prefs.bikeWeight && prefs.bikeWeight >= 1 && prefs.bikeWeight <= 50){
            const bw = prefs.bikeWeight;
            localStorage.setItem('vn_bike_weight', String(bw));
            // Update any visible bike weight inputs
            document.querySelectorAll('input[type="number"][min="1"][max="50"]').forEach(el => { el.value = bw; });
          }
          if(prefs.speed && prefs.speed >= 10 && prefs.speed <= 30){
            const sp = prefs.speed;
            localStorage.setItem('vn_speed', String(sp));
          }
        } catch(e){}
      }

      // Fetch more than needed to compensate for filtered-out __weight__ docs.
      // We keep fetching in batches until we have enough valid docs or exhaust results.
      const FETCH_BATCH = limit + 10; // overfetch to cover __weight__ / zero-distance docs
      let newDocs = [];
      let rawCursor = _cloudRawOffset;

      while(newDocs.length < limit){
        const res = await db.listDocuments(AW_DB, AW_COL, [
          Query.equal('userId', currentUser.$id),
          Query.orderDesc('$createdAt'),
          Query.limit(FETCH_BATCH),
          Query.offset(rawCursor)
        ]);

        const fetched = res.documents;
        if(!fetched.length) break; // no more docs in DB

        const valid = fetched.filter(d => d.routeName !== '__weight__' && (d.distance||0) > 0);
        rawCursor += fetched.length;

        for(const d of valid){
          if(newDocs.length < limit) newDocs.push(d);
          else break;
        }

        // If DB returned fewer than requested, we've reached the end
        if(fetched.length < FETCH_BATCH) break;
      }

      // Check if there are more docs beyond what we just loaded
      // by trying to peek one more valid doc
      let hasMoreCheck = false;
      if(newDocs.length >= limit){
        const peekRes = await db.listDocuments(AW_DB, AW_COL, [
          Query.equal('userId', currentUser.$id),
          Query.orderDesc('$createdAt'),
          Query.limit(10),
          Query.offset(rawCursor)
        ]);
        hasMoreCheck = peekRes.documents.some(d => d.routeName !== '__weight__' && (d.distance||0) > 0);
      }

      _cloudRawOffset  = rawCursor;
      _cloudHasMore    = hasMoreCheck;
      _cloudAllDocs    = [..._cloudAllDocs, ...newDocs];
      _cloudNextOffset = _cloudAllDocs.length;

      // Merge cloud rides into local stats
      window._cloudRides = _cloudAllDocs.map(d => ({
        date: d.date||'', km:(d.distance||0)/1000,
        hm: d.elevation||0, cal: d.calories||0,
        ridetime: d.ridetime||0,
        speed: d.speed||16,
        time:'',
        name: d.routeName||'Tour', cloud:true
      }));
      let local = [];
      try { local = JSON.parse(localStorage.getItem('vn_rides')||'[]'); } catch(e){}
      const merged = [...local];
      window._cloudRides.forEach(cr => {
        if(!merged.some(lr => lr.date===cr.date && Math.abs(lr.km-cr.km)<0.2)) merged.push(cr);
      });
      localStorage.setItem('vn_rides', JSON.stringify(merged.slice(0,100)));

      renderCloudRoutes(_cloudAllDocs, _cloudHasMore);
      setTimeout(() => {
        initProfileChart();
        // initD2Stats nur wenn Profil-Tab gerade sichtbar ist
        const profVisible = document.getElementById('t-profil')?.classList.contains('on')
                         || document.getElementById('st-profil')?.classList.contains('on');
        if(profVisible && typeof initD2Stats === 'function') initD2Stats();
      }, 80);

    } catch(e){ console.warn('Cloud-Routen Fehler:', e); }
  }

  function _routeTypeLabel(name){
    const n = (name||'').trim();
    if(n.startsWith('Aufzeichnung')) return '<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(255,61,107,.18);color:var(--red);margin-right:5px;vertical-align:1px;">⏺ REC</span>';
    if(n.startsWith('Tour '))        return '<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(0,230,118,.15);color:var(--green);margin-right:5px;vertical-align:1px;">🚴 Gefahren</span>';
    return                                  '<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(0,212,255,.12);color:var(--accent);margin-right:5px;vertical-align:1px;">🗺 Geplant</span>';
  }

  function renderCloudRoutes(docs, hasMore){
    // Target containers: in Route tab (desktop + mobile) AND any legacy cloud-routes-list
    const targets = [
      document.getElementById('cloud-routes-dsk'),
      document.getElementById('cloud-routes-mob'),
      ...Array.from(document.querySelectorAll('.cloud-routes-list:not(#cloud-routes-dsk):not(#cloud-routes-mob)'))
    ].filter(Boolean);

    const moreBtns = [
      document.getElementById('cloud-load-more-dsk'),
      document.getElementById('cloud-load-more-mob')
    ];

    if(!docs.length){
      targets.forEach(c => c.innerHTML = '<div class="wp-empty" style="padding:12px 0;">Noch keine Routen gespeichert.</div>');
      moreBtns.forEach(b => b && (b.style.display='none'));
      return;
    }

    const html = docs.map(d => {
      const distKm    = d.distance ? (d.distance/1000).toFixed(1) : '—';
      const docId     = d.$id;
      const safeName  = (d.routeName||'Route').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');
      const safeCoords= encodeURIComponent(d.coordinates||'[]');
      const safeWps   = encodeURIComponent(d.waypoints||'[]');
      const distEnc   = encodeURIComponent(d.distance||0);
      const elevEnc   = encodeURIComponent(d.elevation||0);
      const calEnc    = encodeURIComponent(d.calories||0);
      const dateEnc   = encodeURIComponent(d.date||'');
      const badge     = _routeTypeLabel(d.routeName);
      let wpCount = 0;
      try { wpCount = JSON.parse(d.waypoints||'[]').length; } catch(e){}
      const wpBadge = wpCount > 2 ? `<span style="font-size:9px;color:var(--muted);margin-left:4px;">${wpCount} WP</span>` : '';
      return `<div class="srt-item" id="crd-${docId}" style="flex-wrap:wrap;gap:5px 0;">
        <button class="srt-load" style="min-width:0;" onclick="loadCloudRouteOnMap('${safeName}','${safeCoords}','${safeWps}')">
          <div class="srt-name">${badge}${d.routeName||'Route'}</div>
          <div class="srt-meta">${d.date||''} · ${distKm} km · ↑${d.elevation||0} hm · ${d.calories||0} kcal${wpBadge}</div>
        </button>
        <div style="display:flex;gap:3px;flex-shrink:0;align-items:center;">
          <button class="srt-del" title="Teilen" onclick="shareCloudRoute('${safeName}','${distEnc}','${elevEnc}','${calEnc}','${dateEnc}','${safeCoords}','${safeWps}')" style="font-size:13px;">🔗</button>
          <button class="srt-del" title="Umbenennen" onclick="renameCloudRoute('${docId}','${safeName}')" style="font-size:13px;">✏️</button>
          <button class="srt-del" title="GPX Download" onclick="downloadCloudGPX('${safeName}','${safeCoords}')" style="font-size:13px;">⬇️</button>
          <button class="srt-del" title="Löschen" onclick="deleteCloudRoute('${docId}')" style="font-size:13px;">🗑</button>
        </div>
      </div>`;
    }).join('');

    targets.forEach(c => c.innerHTML = html);
    moreBtns.forEach(b => { if(b) b.style.display = hasMore ? 'block' : 'none'; });
  }

  window.loadMoreCloudRoutes = function(){ loadCloudRoutes(true); };

  // ── Route speichern (Cloud, aus Route-Tab) ────
  window.saveCurrentRouteToCloud = async function(inputId){
    if(!currentUser){ showToast('Bitte zuerst einloggen'); return; }
    const rd  = window.getRouteData ? window.getRouteData() : {};
    const wps = rd.waypoints || [];
    const fr  = rd.fullRoute  || {dist:0, up:0, coords:[]};
    const spd = rd.currentSpeedKmh || 15;
    if(wps.length < 2){ showToast('Mindestens 2 Wegpunkte nötig'); return; }
    const inp  = document.getElementById(inputId);
    const name = inp?.value.trim() || `Route ${new Date().toLocaleDateString('de-DE')}`;
    const w    = parseFloat(document.getElementById('weight-inp')?.value||75);
    const profileSpd = parseInt(localStorage.getItem('vn_speed')||'16');
    const effectiveSpd = Math.max(spd, profileSpd, 5);
    const cal  = typeof calcCalories === 'function' ? calcCalories(fr.dist||0, fr.up||0, w, effectiveSpd) : 0;
    const rideMinutes = fr.dist > 0 ? Math.round((fr.dist/1000)/effectiveSpd*60) : 0;
    // Build a compact waypoints list for cloud storage
    const wpsToSave = wps.map(wp => ({ lat: wp.lat, lng: wp.lng, label: wp.label||'' }));
    try {
      await saveRouteToCloud({
        name, distance: Math.round(fr.dist||0),
        coordinates: (fr.coords||[]).slice(0,200),
        waypoints: wpsToSave,
        elevation: Math.round(fr.up||0),
        calories: cal,
        date: new Date().toISOString().slice(0,10),
        weight: w, coins: 0,
        ridetime: rideMinutes,
        speed: effectiveSpd
      });
      if(inp) inp.value = '';
    } catch(e){}
  };

  window.loadCloudRouteOnMap = async function(name, coordsEncoded, wpsEncoded){
    try {
      clearAll();

      // Try to restore full waypoints list first (new format)
      let wpsRestored = false;
      if(wpsEncoded){
        try {
          const wpsData = JSON.parse(decodeURIComponent(wpsEncoded));
          if(Array.isArray(wpsData) && wpsData.length >= 2){
            wpsData.forEach((wp, i) => {
              const label = wp.label || (i===0?'Start':i===wpsData.length-1?'Ziel':`P${i+1}`);
              waypoints.push({lat:wp.lat, lng:wp.lng, label, hidden:false, manualLine:false, customCoords:null});
            });
            wpsRestored = true;
          }
        } catch(e){}
      }

      // Fallback: derive start+end from coordinates (old format)
      if(!wpsRestored){
        const coords = JSON.parse(decodeURIComponent(coordsEncoded));
        if(!coords||!coords.length){ showToast('Keine Koordinaten gespeichert'); return; }
        const toLatLng = c => Array.isArray(c) ? {lat:c[1],lng:c[0]} : c;
        const first = toLatLng(coords[0]);
        const last  = toLatLng(coords[coords.length-1]);
        waypoints.push({lat:first.lat,lng:first.lng,label:'Start',hidden:false,manualLine:false,customCoords:null});
        waypoints.push({lat:last.lat, lng:last.lng, label:'Ziel', hidden:false,manualLine:false,customCoords:null});
      }

      renderWpMarkers(); renderWpList();
      if(waypoints.length>=2){
        map.flyTo({center:[waypoints[0].lng,waypoints[0].lat],zoom:11});
        await rerouteAll();
        mapFitRoute();
      }
      showToast('✓ "'+name+'" geladen' + (wpsRestored && waypoints.length>2 ? ` (${waypoints.length} Wegpunkte)` : ''));
      if(window.innerWidth<=860){ switchSheetTab('st-route', document.querySelectorAll('.sh-tab')[0]); }
      else { switchTab('t-route', document.querySelectorAll('.tab-btn')[0]); }
    } catch(e){ showToast('Fehler beim Laden: '+(e.message||'')); }
  };

  window.deleteCloudRoute = async function(docId){
    if(!confirm('Route wirklich löschen?')) return;
    try {
      await db.deleteDocument(AW_DB, AW_COL, docId);
      showToast('✓ Route gelöscht');
      _cloudAllDocs = _cloudAllDocs.filter(d => d.$id !== docId);
      _cloudNextOffset = Math.max(0, _cloudNextOffset - 1);
      renderCloudRoutes(_cloudAllDocs, _cloudHasMore);
    } catch(e){ showToast('Löschen fehlgeschlagen'); }
  };

  window.renameCloudRoute = async function(docId, currentName){
    const newName = prompt('Neuer Name:', currentName);
    if(!newName || newName.trim() === currentName) return;
    try {
      await db.updateDocument(AW_DB, AW_COL, docId, { routeName: newName.trim() });
      const doc = _cloudAllDocs.find(d => d.$id === docId);
      if(doc) doc.routeName = newName.trim();
      renderCloudRoutes(_cloudAllDocs, _cloudHasMore);
      showToast('✓ Route umbenannt');
    } catch(e){ showToast('Umbenennen fehlgeschlagen: '+(e.message||'')); }
  };

  window.shareCloudRoute = async function(name, distEnc, elevEnc, calEnc, dateEnc, coordsEncoded, wpsEncoded){
    let shareUrl = '';
    try {
      // Bevorzuge gespeicherte Wegpunkte (vollständig), Fallback auf Koordinaten
      let wpsForShare = null;
      if(wpsEncoded){
        try { wpsForShare = JSON.parse(decodeURIComponent(wpsEncoded)); } catch(e){}
      }

      if(wpsForShare && wpsForShare.length >= 2){
        const data = wpsForShare.map(w => ({
          a: parseFloat((w.lat||w[1]).toFixed(6)),
          o: parseFloat((w.lng||w[0]).toFixed(6)),
          l: w.label || '',
          h: 0, m: 0
        }));
        const b64 = await _compressToB64(JSON.stringify(data));
        shareUrl = window.location.origin + window.location.pathname + '?r=' + b64;
      } else {
        const coords = JSON.parse(decodeURIComponent(coordsEncoded));
        if(coords && coords.length >= 2){
          const step = Math.max(1, Math.floor(coords.length / 10));
          const pts  = [];
          for(let i = 0; i < coords.length; i += step) pts.push(coords[i]);
          const last = coords[coords.length-1];
          if(pts[pts.length-1] !== last) pts.push(last);
          const data = pts.map((c,i) => ({
            a: parseFloat((Array.isArray(c)?c[1]:c.lat).toFixed(6)),
            o: parseFloat((Array.isArray(c)?c[0]:c.lng).toFixed(6)),
            l: i===0?'Start':i===pts.length-1?'Ziel':`WP ${i}`,
            h: 0, m: 0
          }));
          const b64 = await _compressToB64(JSON.stringify(data));
          shareUrl = window.location.origin + window.location.pathname + '?r=' + b64;
        }
      }
    } catch(e){ console.warn('shareCloudRoute encode error:', e); }

    if(!shareUrl){ showToast('Teilen fehlgeschlagen'); return; }

    // Nur die reine URL teilen — kein Text-Mischmasch
    if(navigator.share){
      navigator.share({title:'GravelGuide – ' + decodeURIComponent(name), url: shareUrl}).catch(()=>{});
    } else {
      navigator.clipboard?.writeText(shareUrl)
        .then(()=>showToast('🔗 Link kopiert!'))
        .catch(()=>{ const ta=document.createElement('textarea'); ta.value=shareUrl; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy');showToast('🔗 Link kopiert!');}catch(e){} document.body.removeChild(ta); });
    }
  };

  window.downloadCloudGPX = function(name, coordsEncoded){
    try {
      const coords = JSON.parse(decodeURIComponent(coordsEncoded));
      if(!coords||coords.length<2){ showToast('Keine Koordinaten verfügbar'); return; }
      const pts = coords.map(c => {
        const lng = Array.isArray(c) ? c[0] : c.lng;
        const lat = Array.isArray(c) ? c[1] : c.lat;
        const ele = Array.isArray(c) && c[2] ? c[2] : 0;
        return `    <trkpt lat="${parseFloat(lat).toFixed(7)}" lon="${parseFloat(lng).toFixed(7)}"><ele>${Math.round(ele)}</ele></trkpt>`;
      }).join('\n');
      const safeName = (name||'Route').replace(/[<>&"]/g,'');
      const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GravelGuide 3D" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${safeName}</name><trkseg>\n${pts}\n  </trkseg></trk>\n</gpx>`;
      const blob = new Blob([gpx],{type:'application/gpx+xml'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `gravelguide-${safeName.replace(/\s+/g,'-').toLowerCase()}.gpx`;
      a.click(); URL.revokeObjectURL(a.href);
      showToast('✓ GPX exportiert');
    } catch(e){ showToast('GPX-Export fehlgeschlagen'); }
  };

  // ── Profil-Tab rendern ────────────────────────
  function renderProfileTab(){
    const pane    = document.getElementById('t-profil');
    const mobPane = document.getElementById('st-profil');
    if(currentUser){
      if(pane)    pane.innerHTML    = buildLoggedInHTML();
      if(mobPane) mobPane.innerHTML = buildLoggedInHTML();
      // initD2Stats() wird von loadCloudRoutes() aufgerufen sobald Daten geladen sind
      loadCloudRoutes();
      // Route-Tab: Speicher-Form einblenden
      ['cloud-save-loggedout-dsk','cloud-save-loggedout-mob'].forEach(id=>{
        const el=document.getElementById(id); if(el) el.style.display='none';
      });
      ['cloud-save-form-dsk','cloud-save-form-mob'].forEach(id=>{
        const el=document.getElementById(id); if(el) el.style.display='';
      });
    } else {
      if(pane)    pane.innerHTML    = buildAuthHTML();
      if(mobPane) mobPane.innerHTML = buildAuthHTML();
      // Route-Tab: Speicher-Form ausblenden, Hinweis einblenden
      ['cloud-save-loggedout-dsk','cloud-save-loggedout-mob'].forEach(id=>{
        const el=document.getElementById(id); if(el) el.style.display='';
      });
      ['cloud-save-form-dsk','cloud-save-form-mob'].forEach(id=>{
        const el=document.getElementById(id); if(el) el.style.display='none';
      });
      // Leere Cloud-Listen
      ['cloud-routes-dsk','cloud-routes-mob'].forEach(id=>{
        const el=document.getElementById(id);
        if(el) el.innerHTML='<div class="wp-empty" style="padding:12px 0;">Einloggen um Routen zu sehen →&nbsp;<button onclick="openProfileTab()" style="background:none;border:none;color:var(--accent);font-family:var(--font);font-size:11px;font-weight:700;cursor:pointer;text-decoration:underline;text-underline-offset:3px;">Profil</button></div>';
      });
    }
    updateUserAvatars();
  }

  // ── Statistik-Chart ───────────────────────────
  let _statsRange  = 'week';
  let _statsMetric = 'km';
  let _profileChart = null;

  window.switchStatsRange = function(range, btn){
    _statsRange = range;
    document.querySelectorAll('#stats-range-btns button').forEach(b=>{
      b.style.background = 'none'; b.style.color = 'var(--dim)'; b.style.borderColor = 'var(--border)';
    });
    if(btn){ btn.style.background='var(--accent-dim)'; btn.style.color='var(--accent)'; btn.style.borderColor='rgba(0,212,255,.4)'; }
    initProfileChart();
  };

  window.switchStatsMetric = function(metric, btn){
    _statsMetric = metric;
    document.querySelectorAll('#stats-metric-btns button').forEach(b=>{
      b.style.background = 'none'; b.style.color = 'var(--dim)'; b.style.borderColor = 'var(--border)';
    });
    const colors = {km:'rgba(0,212,255,.4)', hm:'rgba(255,61,107,.4)', cal:'rgba(255,145,0,.4)'};
    const fgColors = {km:'var(--accent)', hm:'var(--red)', cal:'var(--orange)'};
    if(btn){ btn.style.background=`rgba(${_statsMetric==='km'?'0,212,255':_statsMetric==='hm'?'255,61,107':'255,145,0'},.12)`; btn.style.color=fgColors[metric]||'var(--accent)'; btn.style.borderColor=colors[metric]||'rgba(0,212,255,.4)'; }
    initProfileChart();
  };

  function initProfileChart(){
    const canvas = document.getElementById('profile-stats-chart');
    if(!canvas) return;

    // Merge localStorage + _cloudRides so the chart works on fresh devices too
    let local = [];
    try { local = JSON.parse(localStorage.getItem('vn_rides')||'[]'); } catch(e){}
    const cloudRides = window._cloudRides || [];
    const merged = [...local];
    cloudRides.forEach(cr => {
      if(!merged.some(lr => lr.date===cr.date && Math.abs((lr.km||0)-(cr.km||0))<0.2)) merged.push(cr);
    });
    let rides = merged;

    const now = new Date();
    let labels = [], dataPoints = [], dateKeys = [];

    if(_statsRange === 'week'){
      for(let i=6;i>=0;i--){
        const d = new Date(now); d.setDate(now.getDate()-i);
        const key = d.toISOString().slice(0,10);
        const days = ['So','Mo','Di','Mi','Do','Fr','Sa'];
        labels.push(days[d.getDay()]);
        dateKeys.push(key);
      }
    } else if(_statsRange === 'month'){
      const dInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
      for(let i=1;i<=dInMonth;i++){
        const d = new Date(now.getFullYear(), now.getMonth(), i);
        const key = d.toISOString().slice(0,10);
        labels.push(i % 5 === 1 ? String(i) : '');
        dateKeys.push(key);
      }
    } else if(_statsRange === 'year'){
      const months = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
      for(let m=0;m<12;m++){
        labels.push(months[m]);
        dateKeys.push(`${now.getFullYear()}-${String(m+1).padStart(2,'0')}`);
      }
    } else { // all — group by month across all time
      const monthMap = {};
      rides.forEach(r=>{
        if(!r.date) return;
        const k = r.date.slice(0,7);
        if(!monthMap[k]) monthMap[k] = 0;
        monthMap[k] += (_statsMetric==='km'?(r.km||0):_statsMetric==='hm'?(r.hm||0):(r.cal||0));
      });
      const sortedKeys = Object.keys(monthMap).sort();
      sortedKeys.forEach(k => {
        const [y,m] = k.split('-');
        labels.push(`${m}/${y.slice(2)}`);
        dateKeys.push(k);
      });
      dataPoints = sortedKeys.map(k => monthMap[k]);
    }

    if(_statsRange !== 'all'){
      dataPoints = dateKeys.map(key => {
        return rides.filter(r => {
          if(!r.date) return false;
          if(_statsRange==='year') return r.date.startsWith(key);
          return r.date === key;
        }).reduce((sum, r) => sum + (_statsMetric==='km'?(r.km||0):_statsMetric==='hm'?(r.hm||0):(r.cal||0)), 0);
      });
    }

    const metricColors = { km:'rgba(0,212,255,1)', hm:'rgba(255,61,107,1)', cal:'rgba(255,145,0,1)' };
    const metricGlow   = { km:'rgba(0,212,255,.25)', hm:'rgba(255,61,107,.2)', cal:'rgba(255,145,0,.2)' };
    const color = metricColors[_statsMetric] || metricColors.km;
    const glow  = metricGlow[_statsMetric]  || metricGlow.km;

    // Period summary
    const periodSum  = dataPoints.reduce((a,v)=>a+v,0);
    const maxVal     = Math.max(...dataPoints, 0.001);
    const avgVal     = dataPoints.filter(v=>v>0).length ? (periodSum / dataPoints.filter(v=>v>0).length).toFixed(1) : '0';
    const label      = _statsMetric==='km'?'km':_statsMetric==='hm'?'hm':'kcal';
    const periodEl   = document.getElementById('stats-period-summary');
    if(periodEl) periodEl.innerHTML = `
      <div style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:var(--r-md);padding:8px 10px;text-align:center;">
        <div style="font-family:var(--mono);font-size:16px;font-weight:700;color:${color};">${periodSum.toFixed(_statsMetric==='km'?1:0)}</div>
        <div style="font-size:8px;color:var(--dim);text-transform:uppercase;margin-top:2px;">${label} gesamt</div>
      </div>
      <div style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:var(--r-md);padding:8px 10px;text-align:center;">
        <div style="font-family:var(--mono);font-size:16px;font-weight:700;color:${color};">${maxVal.toFixed(_statsMetric==='km'?1:0)}</div>
        <div style="font-size:8px;color:var(--dim);text-transform:uppercase;margin-top:2px;">${label} best</div>
      </div>
      <div style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:var(--r-md);padding:8px 10px;text-align:center;">
        <div style="font-family:var(--mono);font-size:16px;font-weight:700;color:${color};">${avgVal}</div>
        <div style="font-size:8px;color:var(--dim);text-transform:uppercase;margin-top:2px;">${label} ø tour</div>
      </div>`;

    // Destroy old chart
    if(_profileChart){ try { _profileChart.destroy(); } catch(e){} _profileChart = null; }

    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0,0,0,110);
    grad.addColorStop(0, glow);
    grad.addColorStop(1, 'rgba(0,0,0,0)');

    _profileChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: dataPoints,
          backgroundColor: dataPoints.map(v => v > 0 ? glow : 'rgba(255,255,255,.04)'),
          borderColor:     dataPoints.map(v => v > 0 ? color : 'rgba(255,255,255,.08)'),
          borderWidth: 1.5,
          borderRadius: 3,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend:{display:false}, tooltip:{
          callbacks:{ label: ctx => `${ctx.raw.toFixed(_statsMetric==='km'?1:0)} ${label}` },
          backgroundColor:'rgba(8,12,20,.95)', borderColor:'rgba(255,255,255,.12)', borderWidth:1,
          titleFont:{family:'JetBrains Mono'}, bodyFont:{family:'JetBrains Mono'}
        }},
        scales:{
          x:{ grid:{color:'rgba(255,255,255,.04)'}, ticks:{color:'rgba(139,155,180,.7)', font:{size:8, family:'JetBrains Mono'}} },
          y:{ grid:{color:'rgba(255,255,255,.04)'}, ticks:{color:'rgba(139,155,180,.7)', font:{size:8, family:'JetBrains Mono'}, maxTicksLimit:4},
              beginAtZero:true }
        }
      }
    });

    const emptyEl = document.getElementById('profile-chart-empty');
    if(emptyEl) emptyEl.style.display = periodSum===0 ? 'flex' : 'none';
  }

  function updateUserAvatars(){
    const initial = currentUser
      ? ((currentUser.name||currentUser.email||'?').trim()[0] || '?')
      : '?';
    const loggedIn = !!currentUser;
    ['user-avatar-desk','user-avatar-mob'].forEach(id=>{
      const el = document.getElementById(id);
      if(!el) return;
      el.textContent = initial;
      el.classList.toggle('logged-in', loggedIn);
      el.title = loggedIn ? (currentUser.name||currentUser.email||'Profil') : 'Einloggen';
    });
  }

  window.openProfileTab = function(){
    // Desktop: activate Profil tab in sidebar
    const btn = Array.from(document.querySelectorAll('.tab-btn'))
      .find(b => b.textContent.trim() === 'Profil');
    if(btn) switchTab('t-profil', btn);
  };

  window.openProfileMob = function(){
    // Mobile: expand sheet fully and switch to Profil tab
    setSheetState(1);
    const tab = Array.from(document.querySelectorAll('.sh-tab'))
      .find(b => b.textContent.trim() === 'Profil');
    if(tab) switchSheetTab('st-profil', tab);
  };

  // Kein pfx, keine IDs auf Inputs — Buttons lesen aus dem eigenen .sb-Container
  function buildAuthHTML(){
    return `
    <div class="sb" style="background:linear-gradient(135deg,rgba(0,212,255,.06),rgba(0,230,118,.04));border-color:rgba(0,212,255,.2);">
      <div style="text-align:center;padding:8px 0 14px;">
        <div style="font-size:36px;margin-bottom:8px;">🚴</div>
        <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:4px;">GravelGuide 3D</div>
        <div style="font-size:11px;color:var(--dim);">Einloggen um Routen zu speichern</div>
      </div>
      <div style="display:flex;margin-bottom:12px;border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;">
        <button class="auth-tab-btn" onclick="switchAuthTab(this,'login')" style="flex:1;padding:8px;background:var(--accent-dim);border:none;color:var(--accent);font-family:var(--font);font-size:12px;font-weight:700;letter-spacing:.08em;cursor:pointer;text-transform:uppercase;">Einloggen</button>
        <button class="auth-tab-btn" onclick="switchAuthTab(this,'reg')"   style="flex:1;padding:8px;background:none;border:none;color:var(--dim);font-family:var(--font);font-size:12px;font-weight:700;letter-spacing:.08em;cursor:pointer;text-transform:uppercase;">Registrieren</button>
      </div>
      <div class="auth-form-login">
        <div style="margin-bottom:8px;"><input data-field="login-email" type="email" placeholder="E-Mail" class="set-inp" style="width:100%;text-align:left;padding:9px 12px;" autocomplete="email"></div>
        <div style="margin-bottom:10px;"><input data-field="login-pass" type="password" placeholder="Passwort" class="set-inp" style="width:100%;text-align:left;padding:9px 12px;" autocomplete="current-password"></div>
        <button class="btn ok" style="width:100%;justify-content:center;padding:10px;" onclick="loginUser(this)">🔑 Einloggen</button>
        <div style="text-align:center;margin-top:10px;">
          <button onclick="showResetForm(this)" style="background:none;border:none;color:var(--dim);font-family:var(--font);font-size:11px;cursor:pointer;letter-spacing:.04em;text-decoration:underline;text-underline-offset:3px;">Passwort vergessen?</button>
        </div>
      </div>
      <div class="auth-form-reset" style="display:none;">
        <div style="margin-bottom:6px;font-size:11px;color:var(--dim);line-height:1.6;">Gib deine E-Mail ein – wir senden dir einen Link zum Zurücksetzen.</div>
        <div style="margin-bottom:10px;"><input data-field="reset-email" type="email" placeholder="Deine E-Mail-Adresse" class="set-inp" style="width:100%;text-align:left;padding:9px 12px;" autocomplete="email"></div>
        <button class="btn ok" style="width:100%;justify-content:center;padding:10px;margin-bottom:8px;" onclick="sendPasswordReset(this)">📤 Reset-Link senden</button>
        <button onclick="cancelResetForm(this)" style="width:100%;background:none;border:1px solid var(--border);color:var(--dim);font-family:var(--font);font-size:11px;font-weight:600;letter-spacing:.06em;padding:8px;border-radius:var(--r-md);cursor:pointer;text-transform:uppercase;">← Zurück</button>
      </div>
      <div class="auth-form-reg" style="display:none;">
        <div style="margin-bottom:8px;"><input data-field="reg-name" type="text" placeholder="Name (optional)" class="set-inp" style="width:100%;text-align:left;padding:9px 12px;" autocomplete="name"></div>
        <div style="margin-bottom:8px;"><input data-field="reg-email" type="email" placeholder="E-Mail" class="set-inp" style="width:100%;text-align:left;padding:9px 12px;" autocomplete="email"></div>
        <div style="margin-bottom:10px;"><input data-field="reg-pass" type="password" placeholder="Passwort (min. 8 Zeichen)" class="set-inp" style="width:100%;text-align:left;padding:9px 12px;" autocomplete="new-password"></div>
        <button class="btn ok" style="width:100%;justify-content:center;padding:10px;" onclick="registerUser(this)">✨ Account erstellen</button>
      </div>
    </div>
    <div class="sb" style="border-bottom:none;">
      <div style="font-size:11px;color:var(--dim);line-height:1.7;text-align:center;">
        <div style="margin-bottom:6px;">Mit einem Account kannst du:</div>
        <div>☁️ Routen in der Cloud speichern</div>
        <div>📊 Fahrtstatistiken tracken</div>
        <div>🔄 Geräteübergreifend synchronisieren</div>
      </div>
    </div>`;
  }

  function buildLoggedInHTML(){
    const name = currentUser.name || currentUser.email;
    const initials = name.slice(0,2).toUpperCase();
    const weight = document.getElementById('weight-inp')?.value || localStorage.getItem('vn_weight') || 75;
    let rides = [];
    try { rides = JSON.parse(localStorage.getItem('vn_rides')||'[]'); } catch(e){}

    // Merge cloud rides (stored in _cloudRides global) with local
    const cloudRides = window._cloudRides || [];
    const allRides = [...rides];
    cloudRides.forEach(cr => {
      if(!allRides.some(lr => lr.date===cr.date && Math.abs((lr.km||0)-(cr.km||0))<0.2)) allRides.push(cr);
    });

    function ridesInRange(range){
      const now = new Date();
      return allRides.filter(r => {
        if(!r.date) return range === 'all';
        const d = new Date(r.date);
        if(range==='week'){
          const weekAgo = new Date(now); weekAgo.setDate(now.getDate()-6);
          return d >= weekAgo;
        } else if(range==='month'){
          return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
        } else if(range==='year'){
          return d.getFullYear()===now.getFullYear();
        }
        return true; // 'all'
      });
    }

    const totalKm  = allRides.reduce((a,r)=>a+(r.km||0),0).toFixed(1);
    const totalHm  = allRides.reduce((a,r)=>a+(r.hm||0),0);
    const totalCal = allRides.reduce((a,r)=>a+(r.cal||0),0);
    // ridetime in Minuten (aus Cloud) oder aus time-String (lokal)
    const totalMin = allRides.reduce((a,r)=>{
      if(r.ridetime) return a + (r.ridetime||0);
      const t=r.time||''; const p=t.split(':');
      return a+(p.length>=2 ? +p[0]*60+ +p[1] : 0);
    },0);
    const totalH = (totalMin/60).toFixed(1);
    const savedSpeed = parseInt(localStorage.getItem('vn_speed')||'16');

    return `
    <div class="sb" style="background:linear-gradient(135deg,rgba(0,212,255,.06),rgba(0,230,118,.04));border-color:rgba(0,212,255,.2);">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
        <div style="width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--green));display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:800;color:#000;flex-shrink:0;">${initials}</div>
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--text);">${name}</div>
          <div style="font-size:10px;color:var(--dim);">${currentUser.email}</div>
        </div>
        <button class="btn danger" style="margin-left:auto;padding:5px 10px;font-size:10px;" onclick="logoutUser()">Logout</button>
      </div>
    </div>

    <!-- Fahrerprofil / Gewicht & Speed -->
    <div class="sb">
      <div class="sb-title">Fahrerprofil</div>
      <div class="set-row">
        <div class="set-lbl">Körpergewicht (kg)</div>
        <input class="set-inp" type="number" value="${weight}" min="30" max="200"
          oninput="var h=document.getElementById('weight-inp');if(h)h.value=this.value;localStorage.setItem('vn_weight',this.value);recalcStats();"
          onchange="localStorage.setItem('vn_weight',this.value);if(typeof window.saveWeightToCloud==='function')window.saveWeightToCloud(this.value);">
      </div>
      <div class="set-row" style="margin-top:6px;">
        <div class="set-lbl">Fahrradgewicht (kg)</div>
        <input class="set-inp" type="number" value="${parseFloat(localStorage.getItem('vn_bike_weight')||'12')}" min="1" max="50" step="0.5"
          oninput="localStorage.setItem('vn_bike_weight',this.value);recalcStats();"
          onchange="localStorage.setItem('vn_bike_weight',this.value);if(typeof window.saveBikeWeightToCloud==='function')window.saveBikeWeightToCloud(this.value);">
      </div>
      <div style="margin-top:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <div class="set-lbl" style="display:flex;align-items:center;gap:6px;">⚡ Durchschnittsgeschwindigkeit <span style="font-size:9px;color:var(--muted);">(für kcal)</span></div>
          <span id="profile-speed-val" style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--accent);">${savedSpeed} km/h</span>
        </div>
        <div class="sl-row">
          <span style="font-size:10px;">10</span>
          <input type="range" min="10" max="30" step="1" value="${savedSpeed}"
            oninput="
              document.querySelectorAll('#profile-speed-val').forEach(el=>el.textContent=this.value+' km/h');
              localStorage.setItem('vn_speed',this.value);
              if(typeof window.setSpeedFromProfile==='function')window.setSpeedFromProfile(parseInt(this.value));
              recalcStats();
            "
            onchange="if(typeof window.saveSpeedToCloud==='function')window.saveSpeedToCloud(this.value);"
            style="flex:1;accent-color:var(--accent);">
          <span style="font-size:10px;">30</span>
        </div>
        <div style="font-size:9px;color:var(--muted);margin-top:4px;text-align:center;">Basis für Kalorienberechnung zusammen mit Gewicht, km &amp; Höhenmetern</div>
      </div>
    </div>

    <!-- ── STATS (aus GravelData) ── -->
    <hr class="d2-stats-divider">
    <div class="sb" style="padding-top:14px;">
      <div class="sb-title" style="font-size:11px;color:var(--text);margin-bottom:12px;">📊 Stats</div>

      <!-- KPIs -->
      <div class="d2-kpi-grid">
        <div class="d2-kpi-card highlight"><div class="d2-kpi-icon">🚴</div><div class="d2-kpi-label">Distanz gesamt</div><div class="d2-kpi-value d2-kpi-km">—</div></div>
        <div class="d2-kpi-card"><div class="d2-kpi-icon">⛰</div><div class="d2-kpi-label">Höhenmeter</div><div class="d2-kpi-value d2-kpi-hm">—</div></div>
        <div class="d2-kpi-card"><div class="d2-kpi-icon">🔥</div><div class="d2-kpi-label">Kalorien</div><div class="d2-kpi-value d2-kpi-cal">—</div></div>
        <div class="d2-kpi-card"><div class="d2-kpi-icon">📍</div><div class="d2-kpi-label">Touren</div><div class="d2-kpi-value d2-kpi-tours">—</div></div>
      </div>

      <!-- Distanz-Chart -->
      <div class="d2-chart-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;">
          <div><div class="d2-card-title">Distanz-Verlauf</div><div class="d2-card-sub d2-chart-period-label">Dieses Jahr</div></div>
          <div class="d2-sum-badge d2-sum-km">—</div>
        </div>
        <div class="d2-period-btns">
          <button class="d2-period-btn" onclick="d2SetPeriod('week',this)">7T</button>
          <button class="d2-period-btn" onclick="d2SetPeriod('month',this)">Monat</button>
          <button class="d2-period-btn active" onclick="d2SetPeriod('year',this)">Jahr</button>
          <button class="d2-period-btn" onclick="d2SetPeriod('all',this)">Gesamt</button>
        </div>
        <div class="d2-chart-wrap"><canvas class="d2-main-chart"></canvas></div>
      </div>

      <!-- Höhenmeter-Chart -->
      <div class="d2-chart-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;">
          <div><div class="d2-card-title">Höhenmeter-Verlauf</div><div class="d2-card-sub d2-chart-period-label">Dieses Jahr</div></div>
          <div class="d2-sum-badge d2-sum-hm">—</div>
        </div>
        <div class="d2-chart-wrap"><canvas class="d2-hm-chart"></canvas></div>
      </div>

      <!-- Kalorien-Chart -->
      <div class="d2-chart-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;">
          <div><div class="d2-card-title">Kalorien-Verlauf</div><div class="d2-card-sub d2-chart-period-label">Dieses Jahr</div></div>
          <div class="d2-sum-badge d2-sum-cal">—</div>
        </div>
        <div class="d2-chart-wrap"><canvas class="d2-cal-chart"></canvas></div>
      </div>

      <!-- Wochentag + Touren-Längen -->
      <div class="d2-two-col">
        <div class="d2-chart-card" style="margin-bottom:0;">
          <div class="d2-card-title">Aktivität</div>
          <div class="d2-card-sub">je Wochentag</div>
          <div class="d2-chart-wrap-sm"><canvas class="d2-weekday-chart"></canvas></div>
          <div style="margin-top:8px;">
            <div class="d2-mini-row"><span class="d2-mini-label">Lieblingstag</span><span class="d2-mini-val d2-fav-day" style="color:var(--green);">—</span></div>
            <div class="d2-mini-row"><span class="d2-mini-label">Ø Touren/Wo</span><span class="d2-mini-val d2-avg-per-week">—</span></div>
          </div>
        </div>
        <div class="d2-chart-card" style="margin-bottom:0;">
          <div class="d2-card-title">Touren-Längen</div>
          <div class="d2-card-sub">&nbsp;</div>
          <div style="display:flex;justify-content:center;padding:4px 0;">
            <svg class="d2-doughnut-svg" width="110" height="110" viewBox="0 0 110 110">
              <circle cx="55" cy="55" r="40" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="18"/>
              <path class="d2-arc-s" fill="none" stroke="rgba(0,230,118,0.85)"  stroke-width="18" stroke-linecap="butt"/>
              <path class="d2-arc-m" fill="none" stroke="rgba(0,212,255,0.75)"  stroke-width="18" stroke-linecap="butt"/>
              <path class="d2-arc-l" fill="none" stroke="rgba(255,145,0,0.85)"  stroke-width="18" stroke-linecap="butt"/>
            </svg>
          </div>
          <div style="margin-top:8px;">
            <div style="display:flex;align-items:center;gap:6px;font-size:10px;margin-bottom:4px;"><span style="width:10px;height:10px;border-radius:50%;background:rgba(0,230,118,0.85);flex-shrink:0;"></span><span style="color:var(--muted);">&lt;10 km</span><span class="d2-mini-val d2-count-s" style="margin-left:auto;">—</span></div>
            <div style="display:flex;align-items:center;gap:6px;font-size:10px;margin-bottom:4px;"><span style="width:10px;height:10px;border-radius:50%;background:rgba(0,212,255,0.75);flex-shrink:0;"></span><span style="color:var(--muted);">10–20 km</span><span class="d2-mini-val d2-count-m" style="margin-left:auto;">—</span></div>
            <div style="display:flex;align-items:center;gap:6px;font-size:10px;margin-bottom:4px;"><span style="width:10px;height:10px;border-radius:50%;background:rgba(255,145,0,0.85);flex-shrink:0;"></span><span style="color:var(--muted);">&gt;20 km</span><span class="d2-mini-val d2-count-l" style="margin-left:auto;">—</span></div>
            <div class="d2-mini-row"><span class="d2-mini-label">Längste</span><span class="d2-mini-val d2-longest-tour">—</span></div>
            <div class="d2-mini-row"><span class="d2-mini-label">Ø Distanz</span><span class="d2-mini-val d2-avg-dist">—</span></div>
          </div>
        </div>
      </div>

      <!-- Aktivitäts-Stats + Jahresziel -->
      <div class="d2-two-col" style="margin-top:8px;">
        <div class="d2-chart-card" style="margin-bottom:0;">
          <div class="d2-card-title">Aktivitäts-Stats</div>
          <div style="margin-top:8px;">
            <div class="d2-mini-row"><span class="d2-mini-label">Aktive Wochen</span><span class="d2-mini-val d2-active-weeks">—</span></div>
            <div class="d2-mini-row"><span class="d2-mini-label">Bester Monat</span><span class="d2-mini-val d2-best-month" style="color:var(--accent);">—</span></div>
            <div class="d2-mini-row"><span class="d2-mini-label">Längster Streak</span><span class="d2-mini-val d2-streak">—</span></div>
            <div class="d2-mini-row"><span class="d2-mini-label">Ø Höhenmeter</span><span class="d2-mini-val d2-avg-hm">—</span></div>
            <div class="d2-mini-row"><span class="d2-mini-label">Ø Kalorien</span><span class="d2-mini-val d2-avg-cal">—</span></div>
          </div>
        </div>
        <div class="d2-chart-card" style="margin-bottom:0;">
          <div class="d2-card-title">Jahresziel</div>
          <div class="d2-card-sub d2-goal-sub">5.000 km</div>
          <div class="d2-ring-wrap" style="width:90px;height:90px;">
            <svg width="90" height="90" viewBox="0 0 90 90">
              <circle cx="45" cy="45" r="37" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="8"/>
              <circle cx="45" cy="45" r="37" fill="none" stroke="var(--green)" stroke-width="8"
                stroke-linecap="round" stroke-dasharray="232" class="d2-goal-ring" stroke-dashoffset="232"
                transform="rotate(-90 45 45)" style="transition:stroke-dashoffset 1s ease;filter:drop-shadow(0 0 5px rgba(0,230,118,0.5));"/>
            </svg>
            <div class="d2-ring-inner">
              <div class="d2-ring-pct d2-goal-pct">0%</div>
              <div class="d2-ring-sub d2-goal-reached">— km</div>
            </div>
          </div>
          <div style="margin-top:8px;">
            <div class="d2-mini-row"><span class="d2-mini-label">Verbleibend</span><span class="d2-mini-val d2-goal-remaining" style="color:var(--green);">—</span></div>
          </div>
        </div>
      </div>

      <!-- Aktivitäts-Kalender -->
      <div class="d2-chart-card" style="margin-top:8px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
          <div><div class="d2-card-title">Aktivitäts-Kalender <span class="d2-heatmap-year"></span></div><div class="d2-card-sub">Touren nach Häufigkeit</div></div>
          <div style="display:flex;align-items:center;gap:4px;font-size:8px;color:var(--muted);">
            <span>Wenig</span>
            <div style="display:flex;gap:2px;">
              <div style="width:10px;height:10px;border-radius:2px;background:rgba(255,255,255,0.04);"></div>
              <div style="width:10px;height:10px;border-radius:2px;background:rgba(0,230,118,0.2);"></div>
              <div style="width:10px;height:10px;border-radius:2px;background:rgba(0,230,118,0.45);"></div>
              <div style="width:10px;height:10px;border-radius:2px;background:rgba(0,230,118,0.7);"></div>
              <div style="width:10px;height:10px;border-radius:2px;background:rgba(0,230,118,0.95);"></div>
            </div>
            <span>Viel</span>
          </div>
        </div>
        <div class="d2-heatmap-container"></div>
        <div class="d2-chip-row d2-heatmap-chips"></div>
      </div>

      <!-- Letzte Touren -->
      <div class="d2-chart-card" style="margin-top:8px;margin-bottom:0;">
        <div class="d2-card-title" style="margin-bottom:10px;">Letzte Touren</div>
        <div class="d2-tour-list d2-tour-list">
          <div style="text-align:center;padding:16px;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;">Noch keine Touren</div>
        </div>
      </div>

    </div>`;
  }

  // ── Recovery-Modal (nach Klick auf Reset-Link) ──
  function showRecoveryModal(){
    if(document.getElementById('recovery-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'recovery-modal';
    modal.style.cssText = `position:fixed;inset:0;z-index:9600;background:rgba(0,0,0,.82);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);display:flex;align-items:center;justify-content:center;padding:20px;`;
    modal.innerHTML = `
      <div class="g" style="width:100%;max-width:360px;padding:22px 20px;">
        <div style="text-align:center;margin-bottom:18px;">
          <div style="font-size:32px;margin-bottom:8px;">🔑</div>
          <div style="font-size:17px;font-weight:800;color:var(--text);letter-spacing:.08em;text-transform:uppercase;">Neues Passwort</div>
          <div style="font-size:11px;color:var(--dim);margin-top:4px;">Gib dein neues Passwort ein.</div>
        </div>
        <div class="dlg-body" style="padding:0;">
          <div style="margin-bottom:8px;"><input data-field="new-pass" type="password" placeholder="Neues Passwort (min. 8 Zeichen)" class="set-inp" style="width:100%;text-align:left;padding:9px 12px;" autocomplete="new-password"></div>
          <div style="margin-bottom:14px;"><input data-field="new-pass2" type="password" placeholder="Passwort wiederholen" class="set-inp" style="width:100%;text-align:left;padding:9px 12px;" autocomplete="new-password"></div>
          <button class="btn ok" style="width:100%;justify-content:center;padding:11px;" onclick="submitNewPassword(this)">🔑 Passwort speichern</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }

  // ── Körpergewicht + Fahrradgewicht aus localStorage wiederherstellen ─
  document.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('vn_weight');
    if(saved){
      const inp = document.getElementById('weight-inp');
      if(inp) inp.value = saved;
    }
    // Fahrradgewicht: kein eigenes verstecktes Input nötig, wird via buildLoggedInHTML gesetzt
    if(!localStorage.getItem('vn_bike_weight')){
      localStorage.setItem('vn_bike_weight', '12'); // Default 12 kg
    }
  });

  // switchAuthTab: btn = geklickter Button, tab = 'login'|'reg'
  // Sucht NUR im eigenen .sb-Container — funktioniert für Desktop UND Mobile
  window.switchAuthTab = function(btn, tab){
    const sb = btn.closest('.sb');
    if(!sb) return;
    sb.querySelectorAll('.auth-tab-btn').forEach(b =>
      Object.assign(b.style, {background:'none', color:'var(--dim)'})
    );
    Object.assign(btn.style, {background:'var(--accent-dim)', color:'var(--accent)'});
    const loginForm = sb.querySelector('.auth-form-login');
    const regForm   = sb.querySelector('.auth-form-reg');
    const resetForm = sb.querySelector('.auth-form-reset');
    resetForm && (resetForm.style.display = 'none');
    if(tab === 'login'){
      loginForm && (loginForm.style.display = '');
      regForm   && (regForm.style.display   = 'none');
    } else {
      loginForm && (loginForm.style.display = 'none');
      regForm   && (regForm.style.display   = '');
    }
  };

  // ── Expose saveRouteToCloud für showNaviFinish ─
  // d2-Stats: CSS + Logik in d2-stats.js (extern eingebunden)

  window._awSaveRoute = saveRouteToCloud;
  window._awCurrentUser = () => currentUser;
  window._awLoadCloudRoutes = loadCloudRoutes;

  // ── Init ──────────────────────────────────────
  // Warten bis DOM fertig ist
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', initAuth);
  } else {
    initAuth();
  }
