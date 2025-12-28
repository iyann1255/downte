import express from "express";
import { nanoid } from "nanoid";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const TG_BOT_TOKEN = (process.env.TG_BOT_TOKEN || "").trim();
const TG_CHAT_ID = (process.env.TG_CHAT_ID || "").trim();

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 1);
const AUTO_CLEANUP_MINUTES = Number(process.env.AUTO_CLEANUP_MINUTES || 60);

if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
  console.warn("[WARN] TG_BOT_TOKEN / TG_CHAT_ID belum di-set. Nanti pengiriman TG akan gagal.");
}

const OUT_DIR = path.resolve(process.cwd(), "downloads");
fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * jobs: {
 *   id: { status, url, created_at, updated_at, file_path, file_name, error, log }
 * }
 */
const jobs = new Map();
let running = 0;
const queue = [];

// ===== helpers =====
function isValidUrl(u) {
  try {
    const url = new URL(u);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function nowISO() {
  return new Date().toISOString();
}

function setJob(id, patch) {
  const cur = jobs.get(id);
  if (!cur) return;
  jobs.set(id, { ...cur, ...patch, updated_at: nowISO() });
}

function pushLog(id, line) {
  const cur = jobs.get(id);
  if (!cur) return;
  const log = (cur.log || "") + line;
  jobs.set(id, { ...cur, log, updated_at: nowISO() });
}

// ===== Telegram send =====
async function tgSendMessage(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

  const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      disable_web_page_preview: true
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`TG sendMessage failed: ${r.status} ${t}`);
  }
}

async function tgSendDocument(filePath, caption) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

  const fileName = path.basename(filePath);
  const form = new FormData();
  form.append("chat_id", TG_CHAT_ID);
  form.append("caption", caption || "");
  form.append("document", new Blob([fs.readFileSync(filePath)]), fileName);

  const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`TG sendDocument failed: ${r.status} ${t}`);
  }
}

// ===== yt-dlp runner =====
function runYtDlp(id, url) {
  return new Promise((resolve, reject) => {
    const baseName = `job_${id}`;
    const outTemplate = path.join(OUT_DIR, `${baseName}.%(ext)s`);

    // Argumen aman & umum:
    // - bestvideo+bestaudio/best: ambil kualitas terbaik, merge (butuh ffmpeg)
    // - --no-playlist: biar 1 link 1 item (kecuali kamu mau playlist)
    // - --restrict-filenames: nama file aman
    // - --print after_move: ambil path final file
    const args = [
      "--no-playlist",
      "-f", "bv*+ba/best",
      "--merge-output-format", "mp4",
      "--restrict-filenames",
      "-o", outTemplate,
      "--print", "after_move:filepath",
      url
    ];

    const p = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });

    let finalPath = "";
    p.stdout.on("data", (d) => {
      const s = d.toString();
      pushLog(id, s);

      // yt-dlp akan print filepath di akhir (after_move)
      // Ambil baris terakhir yang looks like path
      const lines = s.split("\n").map(x => x.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.includes(OUT_DIR)) finalPath = line;
      }
    });

    p.stderr.on("data", (d) => {
      const s = d.toString();
      pushLog(id, s);
    });

    p.on("close", (code) => {
      if (code === 0 && finalPath && fs.existsSync(finalPath)) {
        resolve(finalPath);
      } else {
        reject(new Error(`yt-dlp exit code ${code}. finalPath=${finalPath || "(none)"}`));
      }
    });
  });
}

// ===== queue processor =====
async function processQueue() {
  if (running >= MAX_CONCURRENT) return;
  const next = queue.shift();
  if (!next) return;

  running++;
  const { id } = next;
  const job = jobs.get(id);
  if (!job) { running--; return; }

  setJob(id, { status: "downloading" });

  try {
    await tgSendMessage(`Mulai download.\nJob: ${id}\nURL: ${job.url}`);

    const filePath = await runYtDlp(id, job.url);
    const fileName = path.basename(filePath);

    setJob(id, { status: "uploading", file_path: filePath, file_name: fileName });

    const caption =
      `Selesai download.\nJob: ${id}\nFile: ${fileName}\nSource: ${job.url}`;

    await tgSendDocument(filePath, caption);

    setJob(id, { status: "done" });
    await tgSendMessage(`Upload ke Telegram beres.\nJob: ${id}`);

    // cleanup terjadwal
    setTimeout(() => {
      const cur = jobs.get(id);
      if (cur?.file_path && fs.existsSync(cur.file_path)) {
        try { fs.unlinkSync(cur.file_path); } catch {}
      }
    }, Math.max(1, AUTO_CLEANUP_MINUTES) * 60 * 1000);

  } catch (e) {
    setJob(id, { status: "error", error: String(e?.message || e) });
    try { await tgSendMessage(`Job gagal.\nJob: ${id}\nError: ${String(e?.message || e)}`); } catch {}
  } finally {
    running--;
    // lanjutkan proses queue
    setImmediate(processQueue);
  }
}

// ===== routes =====

// Simple UI
app.get("/", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Downloader -> Telegram</title>
  <style>
    body{font-family:system-ui;background:#0a0a0a;color:#eaeaea;max-width:760px;margin:40px auto;padding:0 16px}
    .card{background:#141414;border:1px solid #2a2a2a;border-radius:14px;padding:16px}
    input{width:100%;padding:12px;border-radius:12px;border:1px solid #2a2a2a;background:#0f0f0f;color:#eaeaea}
    button{padding:10px 14px;border-radius:12px;border:1px solid #2a2a2a;background:#1f1f1f;color:#eaeaea;cursor:pointer}
    button:hover{background:#252525}
    pre{white-space:pre-wrap;background:#0f0f0f;border:1px solid #2a2a2a;border-radius:12px;padding:12px;max-height:260px;overflow:auto}
    .row{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap}
    .muted{color:#a1a1a1}
  </style>
</head>
<body>
  <h1>Web Download -> Telegram</h1>
  <p class="muted">Tempel link apa aja yang didukung <b>yt-dlp</b>. Nanti kalau selesai, file auto dikirim ke Telegram.</p>
  <div class="card">
    <input id="url" placeholder="https://..." />
    <div class="row">
      <button onclick="submitJob()">Download</button>
      <button onclick="checkJob()">Cek Status</button>
    </div>
    <p class="muted">Job ID: <span id="jobid">-</span></p>
    <pre id="out">Ready.</pre>
  </div>

<script>
let JOB = null;

async function submitJob(){
  const url = document.getElementById("url").value.trim();
  const out = document.getElementById("out");
  out.textContent = "Submitting...";
  const r = await fetch("/api/jobs", {
    method:"POST",
    headers:{"content-type":"application/json"},
    body: JSON.stringify({ url })
  });
  const j = await r.json();
  if(!r.ok){ out.textContent = "ERROR: " + (j.error || r.status); return; }
  JOB = j.id;
  document.getElementById("jobid").textContent = JOB;
  out.textContent = JSON.stringify(j, null, 2);
}

async function checkJob(){
  const out = document.getElementById("out");
  if(!JOB){ out.textContent = "Belum ada Job ID."; return; }
  const r = await fetch("/api/jobs/" + JOB);
  const j = await r.json();
  out.textContent = JSON.stringify(j, null, 2);
}
</script>
</body>
</html>
  `);
});

// Create job
app.post("/api/jobs", (req, res) => {
  const url = String(req.body?.url || "").trim();

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "URL tidak valid." });
  }

  const id = nanoid(10);
  jobs.set(id, {
    id,
    url,
    status: "queued",
    created_at: nowISO(),
    updated_at: nowISO(),
    file_path: null,
    file_name: null,
    error: null,
    log: ""
  });

  queue.push({ id });
  setImmediate(processQueue);

  res.json({ id, status: "queued" });
});

// Get job
app.get("/api/jobs/:id", (req, res) => {
  const id = req.params.id;
  const job = jobs.get(id);
  if (!job) return res.status(404).json({ error: "Job tidak ditemukan." });

  // Jangan kebablasan ngirim log terlalu panjang
  const trimmed = {
    ...job,
    log: (job.log || "").slice(-8000)
  };

  res.json(trimmed);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`OUT_DIR: ${OUT_DIR}`);
});
