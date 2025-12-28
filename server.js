import express from "express";
import { nanoid } from "nanoid";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);

// Telegram
const TG_BOT_TOKEN = (process.env.TG_BOT_TOKEN || "").trim();
const TG_CHAT_ID = (process.env.TG_CHAT_ID || "").trim();

// Binaries (bisa dioverride)
const YTDLP = (process.env.YTDLP_PATH || "yt-dlp").trim();
const SPOTDL = (process.env.SPOTDL_PATH || "spotdl").trim();
const ARIA2C = (process.env.ARIA2C_PATH || "aria2c").trim();
const FFMPEG = (process.env.FFMPEG_PATH || "ffmpeg").trim();

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 1);
const AUTO_CLEANUP_MINUTES = Number(process.env.AUTO_CLEANUP_MINUTES || 60);

if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
  console.warn("[WARN] TG_BOT_TOKEN / TG_CHAT_ID belum di-set. Nanti pengiriman TG akan gagal.");
}

const OUT_DIR = path.resolve(process.cwd(), "downloads");
fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * jobs:
 * id -> { id, url, status, created_at, updated_at, error, file_path, file_name, log }
 */
const jobs = new Map();
let running = 0;
const queue = [];

// ===== Helpers =====
function nowISO() {
  return new Date().toISOString();
}

function isValidUrl(u) {
  try {
    const url = new URL(u);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function setJob(id, patch) {
  const cur = jobs.get(id);
  if (!cur) return;
  jobs.set(id, { ...cur, ...patch, updated_at: nowISO() });
}

function pushLog(id, s) {
  const cur = jobs.get(id);
  if (!cur) return;
  const log = (cur.log || "") + s;
  jobs.set(id, { ...cur, log, updated_at: nowISO() });
}

function extOf(fp) {
  return path.extname(fp).toLowerCase();
}

function classify(rawUrl) {
  const u = new URL(rawUrl);
  const host = u.hostname.toLowerCase();
  const pathname = u.pathname.toLowerCase();

  const isDirect =
    /\.(mp4|mkv|webm|mov|mp3|m4a|wav|flac|ogg|zip|rar|7z|pdf|jpg|jpeg|png|webp)$/i.test(pathname);

  const isM3u8 = pathname.endsWith(".m3u8");
  const isSpotify = host.includes("spotify.com");

  return { isDirect, isM3u8, isSpotify, host };
}

function safeEnv() {
  // Biar systemd / env minimal tetap bisa nemu binary
  const extra = ":/usr/local/bin:/usr/bin:/bin";
  return { ...process.env, PATH: (process.env.PATH || "") + extra };
}

// ===== Telegram =====
async function tgSendMessage(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

  const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`TG sendMessage failed: ${r.status} ${t}`);
  }
}

async function tgSendFileChecked(filePath, caption) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

  const ext = extOf(filePath);
  const fileName = path.basename(filePath);

  const kind =
    [".mp3", ".m4a", ".wav", ".flac", ".ogg"].includes(ext) ? "audio" :
    [".mp4", ".mkv", ".webm", ".mov"].includes(ext) ? "video" :
    "document";

  const blob = new Blob([fs.readFileSync(filePath)]);
  const form = new FormData();
  form.append("chat_id", TG_CHAT_ID);
  if (caption) form.append("caption", caption);

  let endpoint = "sendDocument";
  if (kind === "audio") {
    endpoint = "sendAudio";
    form.append("audio", blob, fileName);
  } else if (kind === "video") {
    endpoint = "sendVideo";
    form.append("video", blob, fileName);
  } else {
    form.append("document", blob, fileName);
  }

  const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/${endpoint}`, {
    method: "POST",
    body: form,
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`TG upload failed: ${r.status} ${t}`);
  }
}

// ===== Download engines =====

// 1) yt-dlp (general)
function runYtDlpSingle(id, url) {
  return new Promise((resolve, reject) => {
    const baseName = `job_${id}`;
    const outTemplate = path.join(OUT_DIR, `${baseName}.%(ext)s`);

    const args = [
      // NOTE: biar playlist gak meledak, default no-playlist
      "--no-playlist",
      "-f", "bv*+ba/best",
      "--merge-output-format", "mp4",
      "--restrict-filenames",
      "-o", outTemplate,
      "--print", "after_move:filepath",
      url,
    ];

    const p = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"], env: safeEnv() });

    let finalPath = "";
    let stderr = "";

    p.stdout.on("data", (d) => {
      const s = d.toString();
      pushLog(id, s);

      const lines = s.split("\n").map(x => x.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.includes(OUT_DIR)) finalPath = line;
      }
    });

    p.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      pushLog(id, s);
    });

    p.on("error", (e) => reject(e));

    p.on("close", (code) => {
      if (code === 0 && finalPath && fs.existsSync(finalPath)) return resolve(finalPath);
      reject(new Error(`yt-dlp exit code ${code}. ${stderr.slice(-400)}`));
    });
  });
}

// 2) aria2c (direct file)
function runAria2Single(id, url) {
  return new Promise((resolve, reject) => {
    const outDir = path.join(OUT_DIR, `job_${id}`);
    fs.mkdirSync(outDir, { recursive: true });

    const args = [
      "--allow-overwrite=true",
      "--auto-file-renaming=false",
      "--continue=true",
      "--max-connection-per-server=8",
      "--split=8",
      "--dir", outDir,
      url,
    ];

    const p = spawn(ARIA2C, args, { stdio: ["ignore", "pipe", "pipe"], env: safeEnv() });

    let stderr = "";

    p.stdout.on("data", (d) => pushLog(id, d.toString()));
    p.stderr.on("data", (d) => { const s = d.toString(); stderr += s; pushLog(id, s); });

    p.on("error", (e) => reject(e));

    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`aria2c exit code ${code}. ${stderr.slice(-400)}`));

      const files = fs.readdirSync(outDir)
        .map(f => path.join(outDir, f))
        .filter(fp => fs.statSync(fp).isFile());

      if (!files.length) return reject(new Error("aria2c selesai tapi file tidak ditemukan."));
      resolve(files[0]);
    });
  });
}

// 3) ffmpeg m3u8
function runFfmpegM3u8Single(id, url) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(OUT_DIR, `job_${id}.mp4`);
    const args = ["-y", "-i", url, "-c", "copy", outPath];

    const p = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"], env: safeEnv() });

    p.stdout.on("data", (d) => pushLog(id, d.toString()));
    p.stderr.on("data", (d) => pushLog(id, d.toString()));

    p.on("error", (e) => reject(e));

    p.on("close", (code) => {
      if (code === 0 && fs.existsSync(outPath)) return resolve(outPath);
      reject(new Error(`ffmpeg exit code ${code}`));
    });
  });
}

// 4) spotdl (spotify) -> returns array of files (Mode A: send one-by-one)
function runSpotdlMulti(id, url) {
  return new Promise((resolve, reject) => {
    const outDir = path.join(OUT_DIR, `job_${id}`);
    fs.mkdirSync(outDir, { recursive: true });

    // spotdl akan download track/playlist ke folder
    const args = ["download", url, "--output", outDir];

    const p = spawn(SPOTDL, args, { stdio: ["ignore", "pipe", "pipe"], env: safeEnv() });

    let stderr = "";

    p.stdout.on("data", (d) => pushLog(id, d.toString()));
    p.stderr.on("data", (d) => { const s = d.toString(); stderr += s; pushLog(id, s); });

    p.on("error", (e) => reject(e));

    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`spotdl exit code ${code}. ${stderr.slice(-400)}`));

      const files = fs.readdirSync(outDir)
        .map(f => path.join(outDir, f))
        .filter(fp => fs.statSync(fp).isFile());

      if (!files.length) return reject(new Error("spotdl selesai tapi file tidak ditemukan."));
      resolve(files);
    });
  });
}

// Router: returns string OR array<string>
async function runDownload(id, url) {
  const c = classify(url);

  if (c.isDirect) return await runAria2Single(id, url);
  if (c.isM3u8) return await runFfmpegM3u8Single(id, url);
  if (c.isSpotify) return await runSpotdlMulti(id, url);

  // fallback luas
  return await runYtDlpSingle(id, url);
}

// ===== Queue processor =====
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

    const result = await runDownload(id, job.url);

    setJob(id, { status: "uploading" });

    if (Array.isArray(result)) {
      // MODE A: kirim satu-satu
      const files = result.sort();
      setJob(id, { file_name: `${files.length} files`, file_path: null });

      await tgSendMessage(`Playlist/multi-item.\nJob: ${id}\nItems: ${files.length}\nMulai upload satu-satu...`);

      let sent = 0;
      for (const fp of files) {
        sent++;
        const name = path.basename(fp);
        const caption = `(${sent}/${files.length})\nJob: ${id}\nFile: ${name}`;
        await tgSendFileChecked(fp, caption);

        // cleanup per item (biar disk gak bengkak)
        try { fs.unlinkSync(fp); } catch {}
      }

      setJob(id, { status: "done" });
      await tgSendMessage(`Selesai upload playlist.\nJob: ${id}\nTotal: ${files.length} files`);
    } else {
      const filePath = result;
      const fileName = path.basename(filePath);
      setJob(id, { file_path: filePath, file_name: fileName });

      const caption = `Selesai download.\nJob: ${id}\nFile: ${fileName}\nSource: ${job.url}`;
      await tgSendFileChecked(filePath, caption);

      setJob(id, { status: "done" });
      await tgSendMessage(`Upload beres.\nJob: ${id}`);

      // cleanup terjadwal untuk single file
      setTimeout(() => {
        const cur = jobs.get(id);
        if (cur?.file_path && fs.existsSync(cur.file_path)) {
          try { fs.unlinkSync(cur.file_path); } catch {}
        }
      }, Math.max(1, AUTO_CLEANUP_MINUTES) * 60 * 1000);
    }

  } catch (e) {
    setJob(id, { status: "error", error: String(e?.message || e) });
    try { await tgSendMessage(`Job gagal.\nJob: ${id}\nError: ${String(e?.message || e)}`); } catch {}
  } finally {
    running--;
    setImmediate(processQueue);
  }
}

// ===== Routes =====

// UI simple
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
    body{font-family:system-ui;background:#0a0a0a;color:#eaeaea;max-width:820px;margin:40px auto;padding:0 16px}
    .card{background:#141414;border:1px solid #2a2a2a;border-radius:14px;padding:16px}
    input{width:100%;padding:12px;border-radius:12px;border:1px solid #2a2a2a;background:#0f0f0f;color:#eaeaea}
    button{padding:10px 14px;border-radius:12px;border:1px solid #2a2a2a;background:#1f1f1f;color:#eaeaea;cursor:pointer}
    button:hover{background:#252525}
    pre{white-space:pre-wrap;background:#0f0f0f;border:1px solid #2a2a2a;border-radius:12px;padding:12px;max-height:320px;overflow:auto}
    .row{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap}
    .muted{color:#a1a1a1}
    .hint{font-size:13px;color:#bdbdbd;margin-top:8px}
  </style>
</head>
<body>
  <h1>Web Download -> Telegram</h1>
  <p class="muted">Tempel link. Server akan coba engine terbaik (aria2/ffmpeg/spotdl/yt-dlp) lalu kirim ke Telegram.</p>
  <div class="card">
    <input id="url" placeholder="https://..." />
    <div class="row">
      <button onclick="submitJob()">Download</button>
      <button onclick="checkJob()">Cek Status</button>
    </div>
    <p class="muted">Job ID: <span id="jobid">-</span></p>
    <div class="hint">
      Tips: Spotify playlist = Mode A (kirim satu-satu). DRM services kemungkinan gagal.
    </div>
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
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: "URL tidak valid." });

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
    log: "",
  });

  queue.push({ id });
  setImmediate(processQueue);

  res.json({ id, status: "queued" });
});

// Get job status (trim log biar gak bengkak)
app.get("/api/jobs/:id", (req, res) => {
  const id = req.params.id;
  const job = jobs.get(id);
  if (!job) return res.status(404).json({ error: "Job tidak ditemukan." });

  res.json({
    ...job,
    log: (job.log || "").slice(-8000),
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`OUT_DIR: ${OUT_DIR}`);
});
