// ── Gültige Invite-Codes ──────────────────────────────
// Einen Code hier entfernen = Zugang sofort entzogen.
// Groß-/Kleinschreibung wird ignoriert.
const INVITE_CODES = [
  'gravel2024',
  // 'familie',
  // 'freunde42',
];
// ─────────────────────────────────────────────────────

const INVITE_KEY = 'gg_invite_ok';   // localStorage-Key
const INVITE_VER = 'v1';             // Versionsstempel – erhöhen um ALLE rauszuwerfen

(function checkInvite(){
  const stored = localStorage.getItem(INVITE_KEY);
  // Gespeicherter Code noch gültig?
  if(stored){
    const [ver, code] = stored.split('|');
    if(ver === INVITE_VER && INVITE_CODES.map(c=>c.toLowerCase()).includes(code)){
      return; // ✅ bekannt & gültig → App läuft normal
    }
    localStorage.removeItem(INVITE_KEY); // Code entzogen → löschen
  }
  // Gate anzeigen, App-Body verbergen
  document.getElementById('invite-gate').style.display = 'flex';
  document.body.style.overflow = 'hidden';
})();

function submitInvite(){
  const val = document.getElementById('invite-inp').value.trim().toLowerCase();
  if(INVITE_CODES.map(c=>c.toLowerCase()).includes(val)){
    localStorage.setItem(INVITE_KEY, INVITE_VER + '|' + val);
    const gate = document.getElementById('invite-gate');
    gate.style.transition = 'opacity .4s';
    gate.style.opacity = '0';
    setTimeout(()=>{ gate.style.display='none'; document.body.style.overflow=''; }, 420);
  } else {
    const err = document.getElementById('invite-err');
    err.style.opacity = '1';
    const inp = document.getElementById('invite-inp');
    inp.style.borderColor = '#ff3d6b';
    setTimeout(()=>inp.style.borderColor='rgba(255,255,255,0.085)', 1200);
  }
}
