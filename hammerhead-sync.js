/*
 * Hammerhead-Anbindung für gravel-guide.de
 * Einbinden in gg7.html:  <script src="hammerhead-sync.js"></script>
 *
 * Benötigte Elemente (optional, id genau so):
 *   <button id="hh-login">Mit Hammerhead anmelden</button>
 *   <button id="hh-logout" hidden>Abmelden</button>
 *   <span id="hh-status"></span>
 *
 * Neue Daten melden: document.addEventListener("hammerhead:update", e => ...)
 * Fahrten lesen:      await HammerheadSync.getActivities()
 */
(() => {
  "use strict";

  const CONFIG = {
    clientId: "d63f191b-e73f-4c60-b413-286d19df8da6",
    worker: "https://gravel-guide-auth.denkenfeld.workers.dev",
    redirectUri: "https://gravel-guide.de/gg7.html", // muss exakt im Hammerhead-Dashboard stehen
    authorizeUrl: "https://api.hammerhead.io/v1/auth/oauth/authorize",
    scope: "activity:read",
    pollMs: 5 * 60 * 1000, // alle 5 Minuten nach neuen Fahrten schauen
  };

  /* ---------- IndexedDB ---------- */
  const dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("gravel-guide-hh", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("kv");
      db.createObjectStore("activities", { keyPath: "_id" });
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
    Promise.all([
      tx("kv", "readwrite", (s) => s.clear()),
      tx("activities", "readwrite", (s) => s.clear()),
    ]);

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

  /* ---------- Sync ---------- */
  function extractList(data) {
    if (Array.isArray(data)) return data;
    return data.activities || data.data || data.items || data.results || [];
  }
  function hasMorePages(data) {
    if (!data || Array.isArray(data)) return false;
    return Boolean(
      data.next || data.nextPage || data.nextCursor || data.nextPageToken || data.hasMore
    );
  }

  let syncing = false;
  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      const token = await getAccessToken();
      if (!token) return;

      const last = await kvGet("lastSync");
      const params = new URLSearchParams();
      if (last) params.set("startDate", new Date(last - 24 * 3600 * 1000).toISOString());

      setStatus("Lade Fahrten …");
      const res = await fetch(CONFIG.worker + "/activities?" + params.toString(), {
        headers: { Authorization: "Bearer " + token },
      });
      if (!res.ok) {
        console.error("Activities-Abruf fehlgeschlagen:", res.status, await res.text());
        setStatus("Fahrten konnten nicht geladen werden (Details in der Konsole).");
        return;
      }
      const data = await res.json();
      console.debug("Hammerhead-Antwort (Struktur):", data);

      const list = extractList(data);
      await tx("activities", "readwrite", (s) => {
        list.forEach((a) => {
          const id = String(a.id ?? a.activityId ?? a.startedAt ?? a.startDate);
          s.put({ ...a, _id: id });
        });
      });

      if (hasMorePages(data)) {
        console.warn("Es gibt weitere Seiten, Paginierung ist noch nicht eingebaut.");
        setStatus(list.length + " Fahrten geladen (weitere Seiten folgen).");
      } else {
        await kvSet("lastSync", Date.now());
        const all = await getActivities();
        setStatus(all.length + " Fahrten gespeichert.");
      }
      notify({ count: list.length });
    } catch (e) {
      console.error(e);
      setStatus("Fehler beim Laden der Fahrten.");
    } finally {
      syncing = false;
    }
  }

  const getActivities = () => tx("activities", "readonly", (s) => s.getAll());

  /* ---------- Logout ---------- */
  async function logout() {
    await clearAll();
    updateUI(false);
    notify({ count: 0 });
  }

  /* ---------- Start ---------- */
  async function init() {
    if ($("hh-login")) $("hh-login").addEventListener("click", login);
    if ($("hh-logout")) $("hh-logout").addEventListener("click", logout);

    await handleCallback();
    const t = await kvGet("tokens");
    updateUI(Boolean(t));
    if (t) {
      await sync();
      setInterval(sync, CONFIG.pollMs);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) sync();
      });
    }
  }

  window.HammerheadSync = { login, logout, sync, getActivities };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
