/**
 * Static HTML for the staff-facing pages served by the server.
 *
 *  - LOGIN_PAGE_HTML: shown at `/` when the visitor has no valid session. Posts the
 *    admin username/password to /login, which sets an HttpOnly session cookie.
 *  - WEB_FORM_HTML: the audit form, shown at `/` once authenticated. It calls /audit
 *    with the session cookie (sent automatically, same-origin) — no token to paste.
 *
 * NOTE: the embedded <script> blocks avoid backticks and ${...} so they survive being
 * embedded inside these TypeScript template literals.
 */

const STYLE = `
  :root { --navy:#1F3A5F; --blue:#2E6DA4; --gold:#E0B000; --gold-fill:#FFF8E1;
          --green:#E2EFDA; --red:#FCE4E4; --yellow:#FFF2CC; --grey:#BFBFBF; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color:#222; margin:0;
         background:#f6f7f9; line-height:1.5; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; }
  .login { max-width: 380px; margin: 8vh auto 0; }
  h1 { color: var(--navy); margin: 0 0 4px; font-size: 26px; }
  .sub { color: var(--blue); margin: 0 0 24px; }
  .topbar { display:flex; justify-content:space-between; align-items:baseline; }
  .topbar a { color: var(--blue); font-size:13px; text-decoration:none; }
  .card { background:#fff; border:1px solid #e3e6ea; border-radius:10px; padding:20px;
          margin-bottom:20px; box-shadow:0 1px 2px rgba(0,0,0,.04); }
  label { display:block; font-weight:bold; color:var(--navy); margin:14px 0 4px; font-size:14px; }
  input[type=text], input[type=number], input[type=password] {
    width:100%; padding:9px 11px; border:1px solid var(--grey); border-radius:6px; font-size:15px; }
  .row { display:flex; gap:16px; flex-wrap:wrap; }
  .row > div { flex:1; min-width:160px; }
  .checks { display:flex; gap:22px; flex-wrap:wrap; margin-top:14px; }
  .checks label { display:flex; align-items:center; gap:8px; font-weight:normal; margin:0; }
  button { background:var(--navy); color:#fff; border:0; border-radius:6px; padding:12px 22px;
           font-size:15px; font-weight:bold; cursor:pointer; margin-top:18px; }
  button:disabled { background:var(--grey); cursor:not-allowed; }
  .hint { color:#666; font-size:13px; margin-top:4px; }
  .err { background:var(--red); border:1px solid #e0a0a0; color:#7a1f1f; padding:10px 12px;
         border-radius:6px; margin-top:14px; }
  .badge { display:inline-block; padding:3px 10px; border-radius:12px; font-weight:bold; font-size:13px; }
  table { border-collapse:collapse; width:100%; margin-top:8px; font-size:14px; }
  th, td { border:1px solid var(--grey); padding:6px 10px; text-align:left; }
  th { background:#DCE6F1; color:var(--navy); }
  .prog { height:10px; background:#e3e6ea; border-radius:6px; overflow:hidden; margin-top:10px; }
  .prog > div { height:100%; background:var(--blue); width:0%; transition:width .3s; }
  .links a { display:inline-block; margin:4px 12px 4px 0; color:var(--blue); }
  .sevHIGH { background:var(--red); } .sevMEDIUM { background:var(--yellow); } .sevLOW { background:#EEF3F8; }
  .muted { color:#777; font-size:13px; }
`;

export const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in — Privacy Audit</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap login">
  <h1>Privacy &amp; Tracking Audit</h1>
  <p class="sub">Planeteria Media — staff sign in</p>
  <div class="card">
    <label for="username">Username</label>
    <input type="text" id="username" autocomplete="username" />
    <label for="password">Password</label>
    <input type="password" id="password" autocomplete="current-password" />
    <button id="signin">Sign in</button>
    <div id="error"></div>
  </div>
</div>
<script>
  var $ = function(id){ return document.getElementById(id); };
  function signin(){
    $("error").innerHTML = "";
    var body = { username: $("username").value, password: $("password").value };
    $("signin").disabled = true;
    fetch("/login", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) })
      .then(function(r){ return r.json().then(function(j){ return { code:r.status, j:j }; }); })
      .then(function(res){
        if (res.code === 200){ location.href = "/"; return; }
        $("signin").disabled = false;
        $("error").innerHTML = '<div class="err">' + (res.j.error || "Sign in failed.") + '</div>';
      })
      .catch(function(e){ $("signin").disabled = false; $("error").innerHTML = '<div class="err">' + e.message + '</div>'; });
  }
  $("signin").addEventListener("click", signin);
  $("password").addEventListener("keydown", function(e){ if (e.key === "Enter") signin(); });
</script>
</body>
</html>`;

export const WEB_FORM_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Privacy & Tracking Audit</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <div>
      <h1>Website Privacy &amp; Tracking Audit</h1>
      <p class="sub">Planeteria Media — internal tool</p>
    </div>
    <a href="/logout">Log out</a>
  </div>

  <div class="card">
    <label for="domain">Website URL</label>
    <input type="text" id="domain" placeholder="https://www.example.com" />

    <div class="row">
      <div>
        <label for="maxPages">Max pages</label>
        <input type="number" id="maxPages" value="50" min="1" />
      </div>
      <div>
        <label for="client">Client name (for Word report)</label>
        <input type="text" id="client" placeholder="Client Inc" />
      </div>
    </div>

    <div class="checks">
      <label><input type="checkbox" id="sample" /> Sample one page per template (large sites)</label>
      <label><input type="checkbox" id="reject" checked /> Test the decline/opt-out path</label>
    </div>

    <button id="run">Run audit</button>
    <div id="error"></div>
  </div>

  <div class="card" id="statusCard" style="display:none">
    <div id="statusLine"></div>
    <div class="prog"><div id="progBar"></div></div>
  </div>

  <div class="card" id="resultCard" style="display:none">
    <h2 style="color:var(--navy);margin-top:0">Results</h2>
    <div id="result"></div>
  </div>
</div>

<script>
  var $ = function(id){ return document.getElementById(id); };
  var pollTimer = null;

  function showError(msg){ $("error").innerHTML = '<div class="err">' + msg + '</div>'; }
  function clearError(){ $("error").innerHTML = ""; }
  function setRunning(on){ $("run").disabled = on; $("run").textContent = on ? "Running…" : "Run audit"; }

  function start(){
    clearError();
    var domain = $("domain").value.trim();
    if (!domain){ showError("Enter a website URL."); return; }

    var body = {
      domain: domain,
      maxPages: parseInt($("maxPages").value, 10) || 50,
      sampleByTemplate: $("sample").checked,
      reject: $("reject").checked,
      client: $("client").value.trim() || undefined
    };

    setRunning(true);
    $("resultCard").style.display = "none";
    $("statusCard").style.display = "block";
    $("statusLine").textContent = "Submitting…";
    $("progBar").style.width = "0%";

    fetch("/audit", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) })
      .then(function(r){ return r.json().then(function(j){ return { code:r.status, j:j }; }); })
      .then(function(res){
        if (res.code === 401){ location.href = "/"; return; }
        if (res.code === 403){ throw new Error(res.j.error || "Domain not allowed."); }
        if (res.code >= 400){ throw new Error(res.j.error || ("HTTP " + res.code)); }
        poll(res.j.id);
      })
      .catch(function(e){ setRunning(false); $("statusCard").style.display="none"; showError(e.message); });
  }

  function poll(id){
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function(){
      fetch("/audit/" + id)
        .then(function(r){ if (r.status === 401){ location.href = "/"; return null; } return r.json(); })
        .then(function(j){
          if (!j) return;
          if (j.progress){
            var pct = j.progress.total ? Math.round(100 * j.progress.done / j.progress.total) : 0;
            $("progBar").style.width = pct + "%";
            $("statusLine").textContent = "Status: " + j.status + "  (" + j.progress.done + "/" + j.progress.total + " pages)  " + (j.progress.url || "");
          } else {
            $("statusLine").textContent = "Status: " + j.status;
          }
          if (j.status === "done"){ clearInterval(pollTimer); setRunning(false); renderResult(j); }
          else if (j.status === "error"){ clearInterval(pollTimer); setRunning(false); $("statusCard").style.display="none"; showError(j.error || "Audit failed."); }
        })
        .catch(function(e){ clearInterval(pollTimer); setRunning(false); showError(e.message); });
    }, 5000);
  }

  function esc(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  function renderResult(j){
    var r = j.result.report;
    var u = j.result.urls;
    var s = r.summary;
    var level = s.privacyScore <= 40 ? ["Elevated","sevHIGH"] : s.privacyScore <= 70 ? ["Moderate","sevMEDIUM"] : ["Low","sevLOW"];

    var html = "";
    html += '<p>Privacy score: <span class="badge ' + level[1] + '">' + s.privacyScore + "/100 — " + level[0] + " risk</span> <span class='muted'>(100 = best)</span></p>";

    html += "<table><tr><th>Metric</th><th>Value</th></tr>";
    html += "<tr><td>Pages scanned</td><td>" + r.scan.pagesScanned.length + "</td></tr>";
    html += "<tr><td>Third-party services</td><td>" + s.thirdPartyServices + "</td></tr>";
    html += "<tr><td>Trackers before consent</td><td>" + s.trackersBeforeConsent + "</td></tr>";
    html += "<tr><td>Cookies before consent</td><td>" + s.cookiesBeforeConsent + "</td></tr>";
    html += "<tr><td>Third-party domains before consent</td><td>" + s.domainsBeforeConsent + "</td></tr>";
    html += "</table>";

    if (r.findings && r.findings.length){
      html += "<h3 style='color:#1F3A5F'>Findings</h3><table><tr><th>Severity</th><th>Finding</th></tr>";
      for (var i=0;i<r.findings.length;i++){
        var f = r.findings[i];
        html += "<tr><td><span class='badge sev" + esc(f.severity.toUpperCase()) + "'>" + esc(f.severity.toUpperCase()) + "</span></td><td><b>" + esc(f.title) + "</b><br><span class='muted'>" + esc(f.detail) + "</span></td></tr>";
      }
      html += "</table>";
    }

    html += "<h3 style='color:#1F3A5F'>Downloads</h3><div class='links'>";
    if (u.reportDocx) html += "<a href='" + esc(u.reportDocx) + "'>Word report (.docx)</a>";
    if (u.reportJson) html += "<a href='" + esc(u.reportJson) + "'>Report JSON</a>";
    if (u.evidence) for (var k=0;k<u.evidence.length;k++){ html += "<a href='" + esc(u.evidence[k].url) + "'>" + esc(u.evidence[k].name) + "</a>"; }
    html += "</div>";
    if (!u.reportDocx) html += "<p class='muted'>Object storage isn't configured, so download links aren't available — the report data is shown above.</p>";

    $("result").innerHTML = html;
    $("resultCard").style.display = "block";
    $("statusLine").textContent = "Status: done";
    $("progBar").style.width = "100%";
  }

  $("run").addEventListener("click", start);
</script>
</body>
</html>`;
