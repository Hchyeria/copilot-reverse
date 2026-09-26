// A self-contained, dependency-free dashboard served at GET /. It polls the control API
// (/api/status, /api/metrics, /api/doctor, /api/clients, /api/models) every 2s and renders worker
// health, GitHub login, web-search backend, the advertised model list, per-scope client config, and —
// most usefully — real lifetime request totals + a per-model breakdown + recent errors with messages.
//
// Totals come from /api/metrics (a real SQL COUNT(*)/SUM over the WHOLE request_log), NOT a capped
// /api/requests fetch — the old page aggregated the last 100 rows, so "total 100" was a meaningless
// ceiling and the flat "recent requests" dump was just 30 identical 200s. Errors are flagged with the
// same shared isError rule as the TUI (status >= 400 OR error != null), computed server-side in SQL, so
// a runaway-tagged 200 (a degenerate stream cut early) is counted here too. /api/doctor is polled
// WITHOUT ?ping so the 2s cadence never fires real model requests.
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>copilot-reverse dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0b0e14; color: #c7d0e0; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 16px 20px; border-bottom: 1px solid #1c2230; flex-wrap: wrap; }
  h1 { font-size: 16px; margin: 0; color: #8ab4f8; }
  .muted { color: #6b7689; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 20px; }
  section { background: #11151f; border: 1px solid #1c2230; border-radius: 8px; padding: 14px 16px; }
  section.wide { grid-column: 1 / -1; }
  h2 { font-size: 13px; margin: 0 0 10px; color: #9aa7bd; text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #161b27; vertical-align: top; }
  th { color: #6b7689; font-weight: 600; }
  .badge { padding: 1px 8px; border-radius: 999px; font-size: 12px; }
  .ok { color: #6ee7b7; } .bad { color: #f87171; } .warn { color: #fbbf24; }
  /* Expandable error rows: a one-line summary, click to reveal the full upstream body (a 502 can be a
     whole HTML page). <details> keeps it dependency-free; .open state is preserved across the 2s poll. */
  details.errrow { border-bottom: 1px solid #161b27; }
  details.errrow > summary { cursor: pointer; padding: 4px 8px; display: flex; gap: 10px; align-items: baseline; list-style: none; white-space: nowrap; overflow: hidden; }
  details.errrow > summary::-webkit-details-marker { display: none; }
  details.errrow > summary::before { content: "▸"; color: #6b7689; }
  details.errrow[open] > summary::before { content: "▾"; }
  details.errrow > summary .msg { color: #f87171; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  details.errrow > summary time { color: #6b7689; }
  details.errrow > summary .st { color: #f87171; font-weight: 600; }
  details.errrow > summary .ep { color: #9aa7bd; }
  details.errrow > pre.full { margin: 0; padding: 8px 8px 12px 26px; color: #f87171; white-space: pre-wrap; word-break: break-word; background: #160d10; }
  .pill-ready { background: #064e3b; color: #6ee7b7; }
  .pill-bad { background: #4c1d24; color: #f87171; }
  .empty { color: #6b7689; font-style: italic; }
  .chip { display: inline-block; padding: 1px 8px; margin: 2px 4px 2px 0; border-radius: 6px; background: #161b27; font-size: 12px; }
  .chip.tag { color: #8ab4f8; }
  .kv { display: flex; gap: 8px; } .kv .k { color: #6b7689; min-width: 92px; }
</style>
</head>
<body>
<header>
  <h1>✳ copilot-reverse</h1>
  <span class="muted">worker <span id="state" class="badge">…</span></span>
  <span class="muted">github <span id="gh">…</span></span>
  <span class="muted">web search <span id="web">…</span></span>
  <span class="muted" id="updated"></span>
</header>
<main>
  <section>
    <h2>Health</h2>
    <div id="doctor"><span class="empty">loading…</span></div>
  </section>
  <section>
    <h2>Requests</h2>
    <div id="metrics"><span class="empty">loading…</span></div>
  </section>
  <section>
    <h2>Clients</h2>
    <div id="clients"><span class="empty">loading…</span></div>
  </section>
  <section>
    <h2>Models</h2>
    <div id="models"><span class="empty">loading…</span></div>
  </section>
  <section class="wide">
    <h2>By model</h2>
    <div id="bymodel"><span class="empty">loading…</span></div>
  </section>
  <section class="wide">
    <h2>Recent errors</h2>
    <div id="errors"><span class="empty">loading…</span></div>
  </section>
</main>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const fmt = (ts) => new Date(ts).toLocaleTimeString();
// Totals + per-model counts come pre-computed from the SQL rollup (/api/metrics), which flags failures
// with the shared rule (status >= 400 OR error IS NOT NULL) — so the dashboard no longer re-derives
// errors from a capped row fetch. recentErrors arrives already filtered to the failed rows.
const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
async function getJson(p) { const r = await fetch(p); if (!r.ok) throw new Error(p + " -> " + r.status); return r.json(); }

// Which error rows the user has expanded, keyed by ts — the 2s poll rebuilds the table's innerHTML, so
// without this every open <details> would snap shut twice a second. Toggled from each summary's onclick.
const openErrors = new Set();
function toggleErr(ts, isOpen) { if (isOpen) openErrors.add(ts); else openErrors.delete(ts); }

function pill(el, label, ok) {
  el.textContent = label;
  el.className = "badge " + (ok ? "pill-ready" : "pill-bad");
}
function renderState(s) { pill(document.getElementById("state"), s, s === "ready"); }
function renderGithub(gh) {
  const el = document.getElementById("gh");
  if (!gh) { el.textContent = "…"; el.className = "muted"; return; }
  const ok = gh.ok;
  el.textContent = ok ? "✓ connected" : (gh.hasToken ? "✗ expired — /login" : "✗ signed out — /login");
  el.className = ok ? "ok" : "bad";
}
function renderWeb(checks) {
  const c = (checks || []).find((x) => x.name === "web-search");
  const el = document.getElementById("web");
  if (!c) { el.textContent = "…"; el.className = "muted"; return; }
  el.textContent = c.detail; el.className = c.ok ? "ok" : "bad";
}
function renderDoctor(checks) {
  const el = document.getElementById("doctor");
  if (!checks.length) { el.innerHTML = '<span class="empty">no checks</span>'; return; }
  el.innerHTML = "<table>" + checks.map((c) =>
    '<tr><td class="' + (c.ok ? "ok" : "bad") + '">' + (c.ok ? "✓" : "✗") + "</td><td>" + esc(c.name) + '</td><td class="muted">' + esc(c.detail) + "</td></tr>"
  ).join("") + "</table>";
}
function scopeCell(s, model) { return s ? '<span class="ok">✓ ' + esc((model || "on").replace(/\\[1m\\]$/, "")) + "</span>" : '<span class="muted">○</span>'; }
function renderClients(cl) {
  const el = document.getElementById("clients");
  if (!cl || (!cl.claude && !cl.codex && !cl.pi)) { el.innerHTML = '<span class="empty">no client config</span>'; return; }
  // pi has no project-scoped config, so its project cell is n/a ("–"), not an "○" that would read as
  // "configured for the user but off for this project".
  const row = (name, c, projectCell) => "<tr><td>" + name + "</td><td>" + scopeCell(c.user, c.userModel) + "</td><td>" + (projectCell || scopeCell(c.project, c.projectModel)) + "</td></tr>";
  el.innerHTML = "<table><tr><th>client</th><th>user</th><th>project</th></tr>"
    + row("claude", cl.claude) + row("codex", cl.codex)
    + (cl.pi ? row("pi", cl.pi, '<span class="muted" title="pi has no project-level config">–</span>') : "")
    + "</table>";
}
function renderModels(models) {
  const el = document.getElementById("models");
  if (!models || !models.length) { el.innerHTML = '<span class="empty">discovery unavailable</span>'; return; }
  el.innerHTML = '<div class="muted">' + models.length + " advertised</div>" + models.map((m) => {
    const oneM = /\\[1m\\]$/.test(m.id);
    return '<span class="chip">' + esc((m.display_name || m.id)) + (oneM ? ' <span class="tag">1M</span>' : "") + "</span>";
  }).join("");
}
// Render the SQL rollup from /api/metrics: real lifetime + 24h totals (a true COUNT(*), not min(rows,
// 100)), the recent error rows (from the WHOLE table, so failures past the last-100 window still show),
// and a per-model breakdown — far more useful than a flat dump of 30 identical 200s.
function renderMetrics(m) {
  const all = m.all || { total: 0, errors: 0, tokensIn: 0, tokensOut: 0, byModel: [] };
  const day = m.day || { total: 0, errors: 0 };
  const line = (label, w) =>
    '<div class="kv"><span class="k">' + label + '</span><span><b>' + w.total + '</b> reqs &nbsp; <b class="' +
    (w.errors ? "bad" : "ok") + '">' + w.errors + '</b> err</span></div>';
  document.getElementById("metrics").innerHTML =
    line("all-time", all) + line("last 24h", day) +
    '<div class="kv"><span class="k">tokens</span><span>' + k(all.tokensIn || 0) + " ↑ / " + k(all.tokensOut || 0) + " ↓</span></div>";

  const errs = (m.recentErrors || []).slice(0, 30);
  // Each error is a <details> row: the summary is a single contained line (long upstream bodies are
  // ellipsised by CSS, not truncated here, so the full text is still available on expand); clicking
  // reveals the whole message. flat() collapses newlines for the summary so a 502 HTML page can't break
  // the one-line layout — the <pre> below keeps the original formatting.
  const flat = (s) => String(s == null ? "(no message)" : s).replace(/\\s+/g, " ").trim();
  document.getElementById("errors").innerHTML = errs.length
    ? errs.map((r) => {
        const full = r.error == null ? "(no message)" : String(r.error);
        const open = openErrors.has(r.ts) ? " open" : "";
        return '<details class="errrow"' + open + ' ontoggle="toggleErr(' + r.ts + ', this.open)">' +
          '<summary><time>' + fmt(r.ts) + '</time><span class="st">' + r.status + '</span><span class="ep">' +
          esc(r.endpoint) + " " + esc(r.model) + '</span><span class="msg">' + esc(flat(r.error)) + "</span></summary>" +
          '<pre class="full">' + esc(full) + "</pre></details>";
      }).join("")
    : '<span class="empty">no request errors — everything\\'s green ✓</span>';

  const rows = all.byModel || [];
  document.getElementById("bymodel").innerHTML = rows.length
    ? "<table><tr><th>model</th><th>reqs</th><th>errors</th><th>avg ms</th><th>tokens in/out</th></tr>" + rows.map((r) =>
        "<tr><td>" + esc(r.model) + "</td><td>" + r.count + '</td><td class="' + (r.errors ? "bad" : "ok") + '">' + r.errors + "</td><td>" + r.avgMs + '</td><td class="muted">' + k(r.tokensIn || 0) + " / " + k(r.tokensOut || 0) + "</td></tr>"
      ).join("") + "</table>"
    : '<span class="empty">no requests yet</span>';
}
async function tick() {
  try {
    // Light doctor only (no ?ping) — the 2s cadence must never fire real model requests. Totals come
    // from /api/metrics (SQL rollup over the whole request_log), not a capped /api/requests fetch.
    const [status, metrics, doctor, clients, models] = await Promise.all([
      getJson("/api/status"), getJson("/api/metrics"), getJson("/api/doctor"),
      getJson("/api/clients"), getJson("/api/models"),
    ]);
    renderState(status.workerState);
    renderGithub(status.github);
    renderDoctor(doctor.checks || []);
    renderWeb(doctor.checks || []);
    renderClients(clients);
    renderModels(models.models || []);
    renderMetrics(metrics);
    document.getElementById("updated").textContent = "updated " + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById("updated").textContent = "control API unreachable: " + e.message;
  }
}
tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
}
