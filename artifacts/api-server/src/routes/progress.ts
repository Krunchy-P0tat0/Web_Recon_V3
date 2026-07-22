import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, scrapeJobsTable } from "@workspace/db";
import { eventBus } from "../lib/event-bus.js";
import { getJob, listJobs } from "../lib/master-orchestrator.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// GET /api/progress — self-contained pipeline dashboard (HTML)
// ---------------------------------------------------------------------------

router.get("/progress", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(DASHBOARD_HTML);
});

// ---------------------------------------------------------------------------
// GET /api/pipeline-sse/:jobId — Server-Sent Events stream
// ---------------------------------------------------------------------------

router.get("/pipeline-sse/:jobId", (req: Request, res: Response) => {
  const { jobId } = req.params;

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (eventType: string, data: unknown) => {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 1. Send current job snapshot immediately
  const snap = getJob(jobId);
  if (snap) send("snapshot", snap);

  // 2. Replay buffered events for this job
  const buffered = eventBus.getBuffer(jobId);
  for (const evt of buffered) {
    send("pipeline-event", evt);
  }

  // 3. Subscribe to live events
  const onEvent = (evt: unknown) => send("pipeline-event", evt);
  eventBus.on(`job:${jobId}`, onEvent);

  // 4. Heartbeat every 15 s (keeps connection alive through proxies)
  const heartbeat = setInterval(() => {
    const live = getJob(jobId);
    if (live) send("snapshot", live);
    else res.write(": heartbeat\n\n");
  }, 15_000);

  // 5. Cleanup on disconnect
  req.on("close", () => {
    eventBus.off(`job:${jobId}`, onEvent);
    clearInterval(heartbeat);
  });
});

// ---------------------------------------------------------------------------
// GET /api/pipeline-sse — stream ALL pipeline events (no job filter)
// ---------------------------------------------------------------------------

router.get("/pipeline-sse", (req: Request, res: Response) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (eventType: string, data: unknown) => {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send current jobs list
  send("jobs-list", listJobs());

  // Replay last 50 buffered events
  const buffered = eventBus.getBuffer().slice(-50);
  for (const evt of buffered) send("pipeline-event", evt);

  const onEvent = (evt: unknown) => {
    send("pipeline-event", evt);
    send("jobs-list", listJobs());
  };
  eventBus.on("event", onEvent);

  const heartbeat = setInterval(() => {
    send("jobs-list", listJobs());
  }, 10_000);

  req.on("close", () => {
    eventBus.off("event", onEvent);
    clearInterval(heartbeat);
  });
});

// ---------------------------------------------------------------------------
// GET /api/scrape-progress/:scrapeJobId — live scrape article progress from DB
// ---------------------------------------------------------------------------

router.get("/scrape-progress/:scrapeJobId", async (req: Request, res: Response) => {
  try {
    const [row] = await db
      .select({
        jobId:             scrapeJobsTable.jobId,
        status:            scrapeJobsTable.status,
        totalArticles:     scrapeJobsTable.totalArticles,
        completedArticles: scrapeJobsTable.completedArticles,
        currentArticle:    scrapeJobsTable.currentArticle,
        crawlAllPages:     scrapeJobsTable.crawlAllPages,
        coverageThreshold: scrapeJobsTable.coverageThreshold,
      })
      .from(scrapeJobsTable)
      .where(eq(scrapeJobsTable.jobId, req.params.scrapeJobId))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "Scrape job not found" });
      return;
    }

    const pct = row.totalArticles > 0
      ? Math.round((row.completedArticles / row.totalArticles) * 100)
      : 0;

    res.json({ ...row, coveragePct: pct });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

const STAGE_META: Record<string, { icon: string; label: string; desc: string }> = {
  crawl:            { icon: "🌐", label: "Crawl",           desc: "BFS discovery + full-site scraping" },
  manifest:         { icon: "📋", label: "Manifest",         desc: "Verify content manifest & coverage gate" },
  diff:             { icon: "🔀", label: "Diff",             desc: "Detect changes vs baseline" },
  intelligence:     { icon: "🧠", label: "Intelligence",     desc: "Deployment environment analysis" },
  "design-dna":     { icon: "🎨", label: "Design DNA",       desc: "Archetype & brand classification" },
  "visual-dna":     { icon: "👁️",  label: "Visual DNA",      desc: "Layout & colour extraction" },
  stencil:          { icon: "🖼️",  label: "Stencil",         desc: "Select & assemble stencil" },
  "website-prime":  { icon: "⚡", label: "Website Prime",   desc: "Generate site blueprint" },
  merge:            { icon: "🔧", label: "Merge",            desc: "Compile merge plan" },
  "deployment-plan":{ icon: "📐", label: "Deployment Plan", desc: "Multi-framework deployment plan" },
  deploy:           { icon: "🚀", label: "Deploy",           desc: "Execute & verify deployment" },
};

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<title>Pipeline Progress</title>
<style>
  :root {
    --bg: #0d0d0f;
    --surface: #16161a;
    --border: #2a2a30;
    --accent: #7c6af7;
    --accent2: #4ecca3;
    --warn: #f0a500;
    --error: #f05454;
    --text: #e8e8f0;
    --muted: #888;
    --success: #4ecca3;
    --running-glow: 0 0 12px rgba(124,106,247,0.6);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; }

  header { padding: 20px 16px 0; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 18px; font-weight: 700; letter-spacing: -0.3px; }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent2); flex-shrink: 0; animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.7)} }

  .job-selector { padding: 14px 16px 0; }
  select { width: 100%; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; font-size: 14px; outline: none; }
  .start-form { display: flex; gap: 8px; margin-top: 8px; }
  .start-form input { flex: 1; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; font-size: 14px; outline: none; }
  .start-form input::placeholder { color: var(--muted); }
  .btn { background: var(--accent); color: #fff; border: none; border-radius: 10px; padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .btn:active { opacity: .8; }

  .status-card { margin: 14px 16px 0; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px; }
  .status-row { display: flex; justify-content: space-between; align-items: center; font-size: 13px; margin-bottom: 6px; }
  .status-row:last-child { margin-bottom: 0; }
  .badge { padding: 2px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; }
  .badge-running  { background: rgba(124,106,247,.2); color: var(--accent); border: 1px solid var(--accent); }
  .badge-complete { background: rgba(78,204,163,.2); color: var(--accent2); border: 1px solid var(--accent2); }
  .badge-failed   { background: rgba(240,84,84,.2);  color: var(--error);   border: 1px solid var(--error); }
  .badge-pending  { background: rgba(136,136,136,.15); color: var(--muted); border: 1px solid var(--border); }

  .coverage-bar-wrap { margin: 10px 0 4px; }
  .coverage-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .bar-track { height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: width .6s ease; }

  .stages { padding: 10px 16px 24px; display: flex; flex-direction: column; gap: 8px; }
  .stage { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; display: flex; align-items: center; gap: 12px; transition: border-color .3s, box-shadow .3s; }
  .stage.running  { border-color: var(--accent); box-shadow: var(--running-glow); }
  .stage.complete { border-color: var(--accent2); }
  .stage.failed   { border-color: var(--error); }
  .stage.skipped  { opacity: .5; }

  .stage-icon { font-size: 22px; flex-shrink: 0; width: 30px; text-align: center; }
  .stage-body { flex: 1; min-width: 0; }
  .stage-name { font-size: 14px; font-weight: 600; }
  .stage-desc { font-size: 11px; color: var(--muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stage-meta { font-size: 11px; color: var(--muted); margin-top: 3px; }
  .stage-right { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .stage-status { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; }
  .status-pending  { color: var(--muted); }
  .status-running  { color: var(--accent); }
  .status-complete { color: var(--accent2); }
  .status-failed   { color: var(--error); }
  .status-skipped  { color: var(--muted); }
  .stage-dur { font-size: 10px; color: var(--muted); }

  .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .scrape-progress { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .scrape-bar-track { height: 4px; background: var(--border); border-radius: 2px; margin-top: 4px; overflow: hidden; }
  .scrape-bar-fill { height: 100%; border-radius: 2px; background: var(--accent); transition: width .6s ease; }

  .error-box { margin: 0 16px 16px; background: rgba(240,84,84,.1); border: 1px solid var(--error); border-radius: 12px; padding: 12px 14px; font-size: 12px; color: var(--error); word-break: break-word; }

  .empty { text-align: center; padding: 60px 16px; color: var(--muted); font-size: 14px; }
  .conn-status { font-size: 11px; color: var(--muted); padding: 0 16px 8px; margin-top: 4px; }
  .conn-status span { margin-right: 6px; }
</style>
</head>
<body>

<header>
  <div class="live-dot" id="liveDot"></div>
  <h1>Pipeline Progress</h1>
</header>

<div class="job-selector">
  <select id="jobSelect" onchange="selectJob(this.value)">
    <option value="">— select a pipeline job —</option>
  </select>
  <div class="start-form">
    <input id="urlInput" type="url" placeholder="https://example.com — start new pipeline" autocomplete="off"/>
    <button class="btn" onclick="startJob()">▶ Run</button>
  </div>
</div>

<div class="conn-status" id="connStatus"><span>⚡</span>Connecting…</div>

<div id="main"></div>

<script>
const STAGES = [
  {id:'crawl',           icon:'🌐', label:'Crawl',           desc:'BFS discovery + full-site scraping'},
  {id:'manifest',        icon:'📋', label:'Manifest',         desc:'Verify content manifest & 96% coverage gate'},
  {id:'diff',            icon:'🔀', label:'Diff',             desc:'Detect changes vs baseline'},
  {id:'intelligence',    icon:'🧠', label:'Intelligence',     desc:'Deployment environment analysis'},
  {id:'design-dna',      icon:'🎨', label:'Design DNA',       desc:'Archetype & brand classification'},
  {id:'visual-dna',      icon:'👁️', label:'Visual DNA',       desc:'Layout & colour extraction'},
  {id:'stencil',         icon:'🖼️', label:'Stencil',          desc:'Select & assemble stencil'},
  {id:'website-prime',   icon:'⚡', label:'Website Prime',    desc:'Generate site blueprint'},
  {id:'merge',           icon:'🔧', label:'Merge',            desc:'Compile merge plan'},
  {id:'deployment-plan', icon:'📐', label:'Deployment Plan',  desc:'Multi-framework deployment plan'},
  {id:'deploy',          icon:'🚀', label:'Deploy',           desc:'Execute & verify deployment'},
];

let currentJobId = null;
let scrapeJobId  = null;
let sseGlobal    = null;
let sseJob       = null;
let scrapeTimer  = null;
let jobData      = null;
let scrapeData   = null;

// Read jobId from URL query param
const params = new URLSearchParams(location.search);
const initJobId = params.get('jobId');

// ── Global SSE (all jobs list) ──────────────────────────────────────────────
function connectGlobalSSE() {
  sseGlobal = new EventSource('pipeline-sse');
  sseGlobal.addEventListener('jobs-list', e => {
    const jobs = JSON.parse(e.data);
    updateJobSelect(jobs);
    if (initJobId && !currentJobId) selectJob(initJobId);
  });
  sseGlobal.addEventListener('pipeline-event', e => {
    if (!currentJobId) return;
    const evt = JSON.parse(e.data);
    if (evt.pipelineJobId === currentJobId) applyEvent(evt);
  });
  sseGlobal.onopen  = () => setConn('connected');
  sseGlobal.onerror = () => { setConn('reconnecting'); setTimeout(connectGlobalSSE, 3000); };
}

// ── Per-job SSE ─────────────────────────────────────────────────────────────
function connectJobSSE(jobId) {
  if (sseJob) { sseJob.close(); sseJob = null; }
  sseJob = new EventSource('pipeline-sse/' + jobId);
  sseJob.addEventListener('snapshot', e => {
    jobData = JSON.parse(e.data);
    render();
  });
  sseJob.addEventListener('pipeline-event', e => {
    const evt = JSON.parse(e.data);
    applyEvent(evt);
  });
  sseJob.onerror = () => setTimeout(() => connectJobSSE(jobId), 4000);
}

function applyEvent(evt) {
  if (!jobData) return;
  // Re-fetch full snapshot after any event for this job
  fetch('orchestrate/' + currentJobId)
    .then(r => r.json())
    .then(j => { jobData = j; render(); })
    .catch(() => {});
}

function selectJob(jobId) {
  if (!jobId) return;
  currentJobId = jobId;
  jobData = null;
  scrapeData = null;
  scrapeJobId = null;
  clearInterval(scrapeTimer);

  const sel = document.getElementById('jobSelect');
  if (sel.value !== jobId) sel.value = jobId;

  // Update URL without reload
  const u = new URL(location.href);
  u.searchParams.set('jobId', jobId);
  history.replaceState({}, '', u);

  connectJobSSE(jobId);
  fetchSnapshot();
}

function fetchSnapshot() {
  if (!currentJobId) return;
  fetch('orchestrate/' + currentJobId)
    .then(r => r.json())
    .then(j => {
      jobData = j;
      render();
      // Start scrape progress polling if crawl is running
      if (j.underlyingJobId && j.currentStage === 'crawl') {
        scrapeJobId = j.underlyingJobId;
        startScrapePolling();
      }
    })
    .catch(() => setTimeout(fetchSnapshot, 3000));
}

function startScrapePolling() {
  clearInterval(scrapeTimer);
  if (!scrapeJobId) return;
  const poll = () => {
    fetch('scrape-progress/' + scrapeJobId)
      .then(r => r.json())
      .then(d => {
        scrapeData = d;
        render();
        if (d.status !== 'done' && d.status !== 'failed') scrapeTimer = setTimeout(poll, 2000);
      })
      .catch(() => { scrapeTimer = setTimeout(poll, 4000); });
  };
  poll();
}

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  const el = document.getElementById('main');
  if (!jobData) { el.innerHTML = '<div class="empty">Loading job…</div>'; return; }

  const j = jobData;
  const statusBadge = \`<span class="badge badge-\${j.status}">\${j.status}</span>\`;
  const elapsed = j.totalDurationMs
    ? formatMs(j.totalDurationMs)
    : j.startedAt ? formatMs(Date.now() - new Date(j.startedAt)) : '—';

  const completed = j.completedStages.length;
  const total     = STAGES.length;
  const progPct   = Math.round((completed / total) * 100);

  let html = '<div class="status-card">';
  html += \`<div class="status-row"><span style="font-weight:600;font-size:14px">\${truncate(j.url,40)}</span>\${statusBadge}</div>\`;
  html += \`<div class="status-row"><span style="color:var(--muted)">Stage</span><span>\${j.currentStage ?? (j.status==='complete'?'✅ All done':'—')}</span></div>\`;
  html += \`<div class="status-row"><span style="color:var(--muted)">Elapsed</span><span>\${elapsed}</span></div>\`;
  html += \`<div class="status-row"><span style="color:var(--muted)">Coverage gate</span><span>\${j.coverageThreshold}%</span></div>\`;

  html += '<div class="coverage-bar-wrap">';
  html += \`<div class="coverage-label"><span>Pipeline progress</span><span>\${completed}/\${total} stages</span></div>\`;
  html += \`<div class="bar-track"><div class="bar-fill" style="width:\${progPct}%"></div></div>\`;
  html += '</div>';
  html += '</div>';

  // Error box
  if (j.error) {
    html += \`<div class="error-box">⚠️ \${j.error}</div>\`;
  }

  // Stages list
  html += '<div class="stages">';
  for (const meta of STAGES) {
    const stg = j.stages.find(s => s.id === meta.id) || { status: 'pending', durationMs: null, error: null, metadata: {} };
    const st = stg.status;
    const isCurrent = j.currentStage === meta.id;

    html += \`<div class="stage \${st}">\`;
    html += \`<div class="stage-icon">\${meta.icon}</div>\`;
    html += \`<div class="stage-body">\`;
    html += \`<div class="stage-name">\${meta.label}</div>\`;
    html += \`<div class="stage-desc">\${meta.desc}</div>\`;

    // Crawl stage: show scrape article progress
    if (meta.id === 'crawl' && scrapeData && (st === 'running' || scrapeData.status !== 'done')) {
      const sd = scrapeData;
      const sp = sd.totalArticles > 0 ? Math.round((sd.completedArticles / sd.totalArticles) * 100) : 0;
      const cur = sd.currentArticle ? \`Scraping: \${truncate(sd.currentArticle, 38)}\` : (sd.totalArticles === 0 ? 'Discovering pages…' : 'Starting…');
      html += \`<div class="scrape-progress">\${cur}</div>\`;
      if (sd.totalArticles > 0) {
        html += \`<div class="scrape-progress">\${sd.completedArticles}/\${sd.totalArticles} pages — \${sp}%</div>\`;
        html += \`<div class="scrape-bar-track"><div class="scrape-bar-fill" style="width:\${sp}%"></div></div>\`;
      }
    }

    // Manifest: show coverage info
    if (meta.id === 'manifest' && stg.metadata && stg.metadata.coveragePct != null) {
      const cp = stg.metadata.coveragePct;
      const threshold = j.coverageThreshold;
      const ok = cp >= threshold;
      html += \`<div class="stage-meta" style="color:\${ok?'var(--accent2)':'var(--warn)'}">\${cp}% coverage (\${stg.metadata.completed}/\${stg.metadata.totalNodes})</div>\`;
    }

    html += '</div>'; // stage-body

    html += '<div class="stage-right">';
    if (st === 'running') {
      html += \`<div class="stage-status status-running"><span class="spinner"></span></div>\`;
    } else {
      html += \`<div class="stage-status status-\${st}">\${STATUS_LABEL[st] ?? st}</div>\`;
    }
    if (stg.durationMs) html += \`<div class="stage-dur">\${formatMs(stg.durationMs)}</div>\`;
    if (stg.error && st === 'failed') html += \`<div class="stage-dur" style="color:var(--error);max-width:80px;word-break:break-word">\${truncate(stg.error,60)}</div>\`;
    html += '</div>'; // stage-right

    html += '</div>'; // stage
  }
  html += '</div>';

  el.innerHTML = html;

  // Keep scrape polling alive while crawl stage is running
  if (j.currentStage === 'crawl' && j.underlyingJobId && !scrapeTimer) {
    scrapeJobId = j.underlyingJobId;
    startScrapePolling();
  }
}

const STATUS_LABEL = { pending:'WAITING', running:'RUNNING', complete:'✓ DONE', failed:'✗ FAILED', skipped:'SKIPPED', retrying:'RETRY…' };

function updateJobSelect(jobs) {
  const sel = document.getElementById('jobSelect');
  const prev = sel.value;
  const opts = jobs.map(j =>
    \`<option value="\${j.id}" \${j.id===prev?'selected':''}>\${truncate(j.url,35)} — \${j.status} \${j.id.slice(0,8)}</option>\`
  ).join('');
  sel.innerHTML = '<option value="">— select a pipeline job —</option>' + opts;
  if (prev) sel.value = prev;

  // Auto-select most recent running job if none selected
  if (!currentJobId && jobs.length > 0) {
    const running = jobs.find(j => j.status === 'running' || j.status === 'pending');
    const pick = running ?? jobs[0];
    if (pick) {
      sel.value = pick.id;
      selectJob(pick.id);
    }
  }
}

function setConn(state) {
  const el = document.getElementById('connStatus');
  const dot = document.getElementById('liveDot');
  if (state === 'connected') {
    el.innerHTML = '<span>⚡</span>Live';
    dot.style.background = 'var(--accent2)';
  } else {
    el.innerHTML = '<span>🔄</span>Reconnecting…';
    dot.style.background = 'var(--warn)';
  }
}

async function startJob() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url.startsWith('http')) { alert('Enter a valid URL starting with http/https'); return; }
  try {
    const r = await fetch('orchestrate', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ url, coverageThreshold: 96 }),
    });
    const j = await r.json();
    document.getElementById('urlInput').value = '';
    if (j.jobId) setTimeout(() => selectJob(j.jobId), 500);
  } catch(e) { alert('Failed to start: ' + e.message); }
}

function formatMs(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms/1000).toFixed(1) + 's';
  const m = Math.floor(ms/60000), s = Math.round((ms%60000)/1000);
  return m + 'm ' + s + 's';
}

function truncate(s, n) {
  if (!s) return '—';
  return s.length > n ? s.slice(0,n) + '…' : s;
}

connectGlobalSSE();
</script>
</body>
</html>`;

export default router;
