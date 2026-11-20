/*
 * Hammerhead-Anbindung für gravel-guide.de  (Version 4)
 * Einbinden in gg7.html:  <script src="hammerhead-sync.js"></script>
 *
 * Elemente (optional, id genau so):
 *   <button id="hh-login">Mit Hammerhead anmelden</button>
 *   <button id="hh-logout" hidden>Abmelden</button>
 *   <span id="hh-status"></span>
 *
 * Die Fahrten werden als FIT-Dateien geladen und wie ein manueller Upload an das
 * Datei-Eingabefeld deiner App übergeben (siehe CONFIG.fileInputSelector).
 *
 * Eigene Auswertung:
 *   document.addEventListener("hammerhead:update", e => e.detail.files)  // neue File-Objekte
 *   await HammerheadSync.getFitFiles()                                    // alle gespeicherten
 */
(() => {
  "use strict";

  const CONFIG = {
    clientId: "d63f191b-e73f-4c60-b413-286d19df8da6",
    worker: "https://gravel-guide-auth.denkenfeld.workers.dev",
    redirectUri: "https://gravel-guide.de/gg7.html", // muss exakt im Hammerhead-Dashboard stehen
    authorizeUrl: "https://api.hammerhead.io/v1/auth/oauth/authorize",
    scope: "activity:read route:read route:write", // route:write = Routen an den Karoo senden (nach der Änderung einmal neu anmelden)
    pollMs: 5 * 60 * 1000, // alle 5 Minuten nach neuen Fahrten schauen
    earliestDate: "2026-10-01", // nichts laden, was vor diesem Datum liegt (JJJJ-MM-TT)
    minMinutes: 3, // Fahrten unter dieser Dauer (Minuten) werden nicht geladen
    minKm: 1, // Fahrten unter dieser Strecke (km) werden nicht geladen
    perPage: 100, // Maximum der API
    // Datei-Eingabefeld deiner App; "" = nichts automatisch übergeben.
    // Besser eine eindeutige Auswahl, z. B. "#fitUpload"
    fileInputSelector: "#fi",
  };

  /* ---------- IndexedDB ---------- */
  const dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("gravel-guide-hh", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("activities"))
        db.createObjectStore("activities", { keyPath: "_id" });
      if (!db.objectStoreNames.contains("fits"))
        db.createObjectStore("fits", { keyPath: "_id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  function tx(store, mode, fn) {
    return dbPromise.then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(store, mode);
          const result = fn(t.objectStore(store));
          t.oncomplete = () => resolve(result && result.result);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  }
  const kvGet = (k) => tx("kv", "readonly", (s) => s.get(k));
  const kvSet = (k, v) => tx("kv", "readwrite", (s) => s.put(v, k));
  const clearAll = () =>
    Promise.all(
      ["kv", "activities", "fits"].map((n) => tx(n, "readwrite", (s) => s.clear()))
    );

  /* ---------- UI ---------- */
  const $ = (id) => document.getElementById(id);
  function setStatus(text) {
    const el = $("hh-status");
    if (el) el.textContent = text; // textContent, nie innerHTML
  }
  function updateUI(loggedIn) {
    const li = $("hh-login");
    const lo = $("hh-logout");
    if (li) li.hidden = loggedIn;
    if (lo) lo.hidden = !loggedIn;
    if (!loggedIn) setStatus("Nicht mit Hammerhead verbunden.");
  }
  function notify(detail) {
    document.dispatchEvent(new CustomEvent("hammerhead:update", { detail }));
  }

  /* ---------- Login ---------- */
  function login() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const state = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    sessionStorage.setItem("hh_state", state);
    const u = new URL(CONFIG.authorizeUrl);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: CONFIG.clientId,
      redirect_uri: CONFIG.redirectUri,
      scope: CONFIG.scope,
      state,
    }).toString();
    location.assign(u.toString());
  }

  async function handleCallback() {
    const p = new URLSearchParams(location.search);
    if (!p.has("code") && !p.has("error")) return false;

    const expected = sessionStorage.getItem("hh_state");
    sessionStorage.removeItem("hh_state");
    const code = p.get("code");
    const state = p.get("state");
    const err = p.get("error");
    history.replaceState(null, "", location.pathname + location.hash); // Code aus der URL entfernen

    if (err) {
      setStatus("Anmeldung abgebrochen oder abgelehnt.");
      return false;
    }
    if (!expected || state !== expected) {
      setStatus("Anmeldung abgebrochen: ungültiger state-Wert.");
      return false;
    }
    setStatus("Anmeldung wird abgeschlossen …");
    try {
      const res = await fetch(CONFIG.worker + "/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, redirect_uri: CONFIG.redirectUri }),
      });
      if (!res.ok) {
        console.error("Token-Austausch fehlgeschlagen:", res.status, await res.text());
        setStatus("Token-Austausch fehlgeschlagen (Details in der Konsole).");
        return false;
      }
      await saveTokens(await res.json());
      return true;
    } catch (e) {
      console.error(e);
      setStatus("Netzwerkfehler beim Anmelden.");
      return false;
    }
  }

  /* ---------- Tokens ---------- */
  async function saveTokens(t, old) {
    const rec = {
      access_token: t.access_token || t.accessToken,
      refresh_token: t.refresh_token || t.refreshToken || (old && old.refresh_token),
      expires_at: Date.now() + (t.expires_in || t.expiresIn || 3600) * 1000,
      user_id: t.user_id || t.userId || (old && old.user_id) || null,
    };
    await kvSet("tokens", rec); // rotierenden Refresh-Token sofort speichern
    return rec;
  }

  const withLock = (fn) =>
    navigator.locks ? navigator.locks.request("hh-token", fn) : fn();

  function getAccessToken() {
    return withLock(async () => {
      const t = await kvGet("tokens");
      if (!t) return null;
      if (t.expires_at - 60000 > Date.now()) return t.access_token;
      try {
        const res = await fetch(CONFIG.worker + "/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: t.refresh_token }),
        });
        if (!res.ok) {
          if (res.status >= 400 && res.status < 500) {
            await clearAll();
            setStatus("Sitzung abgelaufen, bitte neu anmelden.");
            updateUI(false);
          }
          return null;
        }
        return (await saveTokens(await res.json(), t)).access_token;
      } catch (e) {
        console.error(e); // Netzwerkfehler: Tokens behalten, später erneut versuchen
        return null;
      }
    });
  }

  /* ---------- Hilfsfunktionen ---------- */
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD, wie die API es verlangt

  function extractList(data) {
    if (Array.isArray(data)) return data;
    return data.activities || data.routes || data.data || data.items || data.results || [];
  }
  const idOf = (a) => (a.id ?? a.activityId) == null ? null : String(a.id ?? a.activityId);

  function toFile(rec) {
    const ts = Date.parse(rec.createdAt);
    return new File([rec.buf], rec.name, {
      type: "application/vnd.ant.fit",
      lastModified: Number.isNaN(ts) ? Date.now() : ts,
    });
  }

  /* ---------- Fahrten laden ---------- */
  async function listActivities(token, startDate) {
    const all = [];
    let page = 1;
    let totalPages = 1;
    do {
      const q = new URLSearchParams({
        page: String(page),
        perPage: String(CONFIG.perPage),
        startDate,
      });
      const res = await fetch(CONFIG.worker + "/activities?" + q.toString(), {
        headers: { Authorization: "Bearer " + token },
      });
      if (!res.ok) throw new Error("Activities " + res.status + " " + (await res.text()));
      const data = await res.json();
      const items = extractList(data);
      if (page === 1) {
        listActivities.keys = Array.isArray(data) ? ["(Array)"] : Object.keys(data);
        console.log("Hammerhead-Antwort, Felder:", listActivities.keys);
        console.log("Felder einer Aktivität:", items[0] ? Object.keys(items[0]) : "keine Aktivität");
      }
      all.push(...items);
      totalPages = Number(data.totalPages ?? (data.pagination && data.pagination.totalPages) ?? 1) || 1;
      page += 1;
    } while (page <= totalPages && page <= 50);
    return all;
  }

  /* ---------- An die App übergeben ---------- */
  const delivered = new Set();

  function feedApp(files) {
    if (!files.length) return;
    notify({ count: files.length, files });
    if (!CONFIG.fileInputSelector) return;
    const input = document.querySelector(CONFIG.fileInputSelector);
    if (!input) {
      console.warn("Kein Datei-Eingabefeld gefunden:", CONFIG.fileInputSelector);
      return;
    }
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true })); // wie ein manueller Upload
  }

  // ids: Set der neu geladenen Fahrten, oder null = alle noch nicht übergebenen
  async function deliver(ids) {
    const recs = await tx("fits", "readonly", (s) => s.getAll());
    const fresh = recs.filter((r) => !delivered.has(r._id) && (!ids || ids.has(r._id)));
    fresh.forEach((r) => delivered.add(r._id));
    feedApp(fresh.map(toFile));
  }

  // Deine App speichert ihre Fahrten selbst im localStorage (Schlüssel "axon1").
  // Nur wenn dort nichts liegt, geben wir alle zwischengespeicherten FIT-Dateien erneut ab.
  function appHasRides() {
    if (typeof window.appRideCount === "function") return window.appRideCount() > 0;
    try {
      return Boolean(localStorage.getItem("axon1")); // ältere Version der App
    } catch (e) {
      return false;
    }
  }

  /* ---------- Sync ---------- */
  let syncing = false;
  // override: optionales Startdatum "JJJJ-MM-TT", um ältere Fahrten gezielt nachzuladen
  async function sync(override) {
    if (syncing) return;
    syncing = true;
    const manualStart = typeof override === "string" && /^\d{4}-\d{2}-\d{2}$/.test(override) ? override : null;
    try {
      let token = await getAccessToken();
      if (!token) return;

      const last = await kvGet("lastSync");
      const wanted =
        manualStart ||
        (last
          ? ymd(last - 24 * 3600 * 1000) // 1 Tag Überlappung
          : CONFIG.earliestDate);
      // nie weiter zurück als earliestDate (Datumsformat JJJJ-MM-TT lässt sich als Text vergleichen)
      const startDate = wanted < CONFIG.earliestDate ? CONFIG.earliestDate : wanted;

      setStatus("Suche Fahrten …");
      const list = await listActivities(token, startDate);
      if (list.length === 0 && !last) {
        // lastSync bewusst NICHT setzen, damit ein späterer Versuch alles nachholt
        setStatus(
          "Keine Fahrten seit " + startDate + " gefunden. Antwortfelder: " +
            (listActivities.keys || []).join(", ")
        );
        return;
      }
      const got = new Set(); // neu heruntergeladene Fahrten
      const have = new Set(await tx("fits", "readonly", (s) => s.getAllKeys()));
      // Fahrten, die vor dem Stichtag liegen (oder die die App nicht lesen kann), merken wir uns
      const skipped = new Set((await kvGet("skipped")) || []);
      let newSkipped = 0;
      const cutoff = Date.parse(CONFIG.earliestDate + "T00:00:00"); // lokale Mitternacht
      const todo = list.filter((a) => idOf(a) && !have.has(idOf(a)) && !skipped.has(idOf(a)));

      await tx("activities", "readwrite", (s) => {
        list.forEach((a) => idOf(a) && s.put({ ...a, _id: idOf(a) }));
      });

      let failed = 0;
      for (let i = 0; i < todo.length; i++) {
        const a = todo[i];
        const id = idOf(a);
        setStatus("Lade Fahrt " + (i + 1) + " von " + todo.length + " …");
        token = await getAccessToken();
        if (!token) {
          failed += todo.length - i;
          break;
        }
        try {
          const res = await fetch(
            CONFIG.worker + "/activity-file?id=" + encodeURIComponent(id),
            { headers: { Authorization: "Bearer " + token } }
          );
          if (!res.ok) {
            console.warn("FIT-Download fehlgeschlagen:", id, res.status);
            failed++;
            continue;
          }
          const buf = await res.arrayBuffer();

          // Fahrtdatum, Dauer und Strecke aus der FIT-Datei prüfen (die API-Liste filtert nur
          // nach dem Anlage-Datum des Eintrags, nicht nach dem Fahrtdatum)
          if (window.GravelGuide && typeof window.GravelGuide.fitInfo === "function") {
            let info = null;
            try {
              info = window.GravelGuide.fitInfo(buf);
            } catch (e) {} // nicht lesbar, z. B. ohne GPS: die App würde sie ohnehin ablehnen
            if (
              !info ||
              info.t < cutoff ||
              info.min < CONFIG.minMinutes ||
              info.km < CONFIG.minKm
            ) {
              skipped.add(id);
              newSkipped++;
              continue;
            }
          }
          await tx("fits", "readwrite", (s) =>
            s.put({ _id: id, name: "hammerhead-" + id + ".fit", createdAt: a.createdAt || null, buf })
          );
          got.add(id);
        } catch (e) {
          console.error(e);
          failed++;
        }
      }

      if (newSkipped) await kvSet("skipped", [...skipped]);
      if (failed === 0 && !manualStart) await kvSet("lastSync", Date.now());
      await deliver(got);

      const total = (await tx("fits", "readonly", (s) => s.getAllKeys())).length;
      setStatus(
        list.length + " gefunden, " + got.size + " neu geladen, " + total + " gespeichert" +
          (newSkipped ? ", " + newSkipped + " übersprungen (zu alt, zu kurz oder nicht lesbar)" : "") +
          (failed ? " – " + failed + " fehlgeschlagen, neuer Versuch folgt" : "")
      );
    } catch (e) {
      console.error("Sync-Fehler:", e);
      setStatus("Fahrten konnten nicht geladen werden (Details in der Konsole).");
    } finally {
      syncing = false;
    }
  }

  /* ---------- Route an den Karoo senden ---------- */
  // gpx: GPX-Text, name: Routenname. Braucht den Worker-Pfad POST /route-file (siehe worker-route-snippet.js)
  async function sendRoute(gpx, name, routeId) {
    const token = await getAccessToken();
    if (!token) {
      const e = new Error("not-connected");
      e.status = 401;
      throw e;
    }
    const safe = String(name || "route").replace(/[^\w\-. äöüÄÖÜß]/g, "_").slice(0, 60);
    const fd = new FormData();
    fd.append("file", new Blob([gpx], { type: "application/gpx+xml" }), safe + ".gpx");
    // mit routeId: bestehende Route ersetzen (PUT), sonst neu anlegen (POST)
    const res = await fetch(
      CONFIG.worker + "/route-file" + (routeId ? "?id=" + encodeURIComponent(routeId) : ""),
      {
      method: routeId ? "PUT" : "POST",
      headers: { Authorization: "Bearer " + token },
      body: fd,
      }
    );
    if (res.status === 404 && routeId) return sendRoute(gpx, name); // Route im Dashboard gelöscht: neu anlegen
    if (!res.ok) {
      const e = new Error("HTTP " + res.status);
      e.status = res.status;
      e.body = await res.text().catch(() => "");
      throw e;
    }
    return res.json().catch(() => ({}));
  }
  // Alle Routen aus dem Hammerhead-Dashboard (nur lesen; gelöscht wird bewusst nur im Dashboard)
  async function listRoutes() {
    const token = await getAccessToken();
    if (!token) {
      const e = new Error("not-connected");
      e.status = 401;
      throw e;
    }
    const all = [];
    let page = 1;
    let totalPages = 1;
    do {
      const res = await fetch(CONFIG.worker + "/routes?page=" + page + "&perPage=100", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!res.ok) {
        const e = new Error("HTTP " + res.status);
        e.status = res.status;
        throw e;
      }
      const data = await res.json();
      all.push(...extractList(data));
      totalPages = Number(data.totalPages) || 1;
      page += 1;
    } while (page <= totalPages && page <= 20);
    return all;
  }
  // Google-Polyline (Genauigkeit 5) -> [[lon, lat], ...]
  function decodePolyline(str) {
    const out = [];
    let i = 0, lat = 0, lon = 0;
    while (i < str.length) {
      for (let k = 0; k < 2; k++) {
        let shift = 0, res = 0, b;
        do {
          b = str.charCodeAt(i++) - 63;
          res |= (b & 31) << shift;
          shift += 5;
        } while (b >= 32 && i < str.length + 1);
        const d = res & 1 ? ~(res >> 1) : res >> 1;
        if (k === 0) lat += d; else lon += d;
      }
      out.push([lon / 1e5, lat / 1e5]);
    }
    return out;
  }
  // Strecke einer Dashboard-Route holen (Polyline, ohne Höhen); braucht GET /route im Worker
  async function getRoute(routeId) {
    const token = await getAccessToken();
    if (!token) {
      const e = new Error("not-connected");
      e.status = 401;
      throw e;
    }
    const res = await fetch(CONFIG.worker + "/route?id=" + encodeURIComponent(routeId), {
      headers: { Authorization: "Bearer " + token },
    });
    if (!res.ok) {
      const e = new Error("HTTP " + res.status);
      e.status = res.status;
      e.body = await res.text().catch(() => "");
      console.warn("getRoute fehlgeschlagen:", routeId, res.status, e.body);
      throw e;
    }
    const j = await res.json();
    const r = j.data && !Array.isArray(j.data) ? j.data : j;
    const line = r.polyline || (r.route && r.route.polyline) || "";
    if (!line) {
      const e = new Error("no-polyline");
      e.status = 0;
      throw e;
    }
    return { id: r.id, name: r.name, distance: r.distance, gain: r.gain, coords: decodePolyline(line) };
  }
  const isConnected = async () => Boolean(await kvGet("tokens"));

  const getActivities = () => tx("activities", "readonly", (s) => s.getAll());
  const getFitFiles = async () =>
    (await tx("fits", "readonly", (s) => s.getAll())).map(toFile);

  /* ---------- Logout ---------- */
  async function logout() {
    await clearAll();
    delivered.clear();
    updateUI(false);
    notify({ count: 0, files: [] });
  }

  /* ---------- Start ---------- */
  async function init() {
    if ($("hh-login")) $("hh-login").addEventListener("click", login);
    if ($("hh-logout")) $("hh-logout").addEventListener("click", logout);

    // Browser bitten, den Speicher nicht von sich aus aufzuräumen (er entscheidet selbst)
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }

    await handleCallback();
    const t = await kvGet("tokens");
    updateUI(Boolean(t));
    if (t) {
      // warten, bis die App ihre gespeicherten Fahrten geladen hat
      try {
        await (window.appReady || Promise.resolve());
      } catch (e) {}
      if (!appHasRides()) await deliver(null); // Cache in die App laden, falls sie leer ist
      await sync();
      setInterval(sync, CONFIG.pollMs);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) sync();
      });
    }
  }

  window.HammerheadSync = {
    login,
    logout,
    sync,
    loadSince: (date) => sync(date), // z. B. HammerheadSync.loadSince("2023-01-01")
    getActivities,
    getFitFiles,
    sendRoute,
    listRoutes,
    getRoute,
    decodePolyline,
    isConnected,
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
