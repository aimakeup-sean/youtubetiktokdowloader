const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TMP_DIR = os.tmpdir();
const YT_DLP_TMP = path.join(TMP_DIR, 'yt-dlp');

// Returns { cmd, args_prefix } — supports both binary and python3 -m yt_dlp
function getYtDlpRunner() {
  const systemPaths = ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) return { cmd: p, prefix: [] };
  }
  try {
    const bin = execSync('which yt-dlp', { stdio: 'pipe' }).toString().trim();
    if (bin) return { cmd: bin, prefix: [] };
  } catch {}
  // Fallback: python3 -m yt_dlp
  try {
    execSync('python3 -m yt_dlp --version', { stdio: 'pipe' });
    return { cmd: 'python3', prefix: ['-m', 'yt_dlp'] };
  } catch {}
  return null;
}

let YT_DLP_RUNNER = getYtDlpRunner();

async function ensureYtDlp() {
  if (YT_DLP_RUNNER) return YT_DLP_RUNNER;
  // Download Linux binary (for Railway/Docker)
  if (fs.existsSync(YT_DLP_TMP)) {
    YT_DLP_RUNNER = { cmd: YT_DLP_TMP, prefix: [] };
    return YT_DLP_RUNNER;
  }
  console.log('yt-dlp 다운로드 중...');
  execSync(
    `curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o "${YT_DLP_TMP}" && chmod +x "${YT_DLP_TMP}"`,
    { timeout: 60000 }
  );
  YT_DLP_RUNNER = { cmd: YT_DLP_TMP, prefix: [] };
  console.log('yt-dlp 준비 완료');
  return YT_DLP_RUNNER;
}

function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  if (/tiktok\.com/.test(url)) return 'tiktok';
  if (/instagram\.com/.test(url)) return 'instagram';
  return 'generic';
}

// Only YouTube needs special args — TikTok/Instagram work with yt-dlp defaults
function getPlatformArgs(platform) {
  if (platform === 'youtube') {
    return ['--extractor-args', 'youtube:player_client=android,web'];
  }
  return [];
}

function runYtDlp(runner, args, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(runner.cmd, [...runner.prefix, ...args]);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `exit code ${code}`));
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// Get video info
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다.' });

  let runner;
  try { runner = await ensureYtDlp(); } catch (e) {
    return res.status(500).json({ error: 'yt-dlp 초기화 실패: ' + e.message });
  }

  const safeUrl = url.replace(/['"<>]/g, '').trim();
  const platform = detectPlatform(safeUrl);

  const args = [
    '--dump-json',
    '--no-playlist',
    '--no-check-certificates',
    ...getPlatformArgs(platform),
    safeUrl,
  ];

  try {
    const stdout = await runYtDlp(runner, args);
    const info = JSON.parse(stdout.trim().split('\n')[0]);
    const formats = (info.formats || [])
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext)
      .map(f => ({
        format_id: f.format_id,
        ext: f.ext,
        resolution: f.resolution || (f.height ? `${f.height}p` : 'unknown'),
        filesize: f.filesize || f.filesize_approx || null,
        format_note: f.format_note || '',
      }))
      .slice(-8);

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      uploader: info.uploader,
      platform,
      formats,
    });
  } catch (e) {
    console.error('[info error]', e.message.slice(0, 300));
    res.status(400).json({ error: '동영상 정보를 가져올 수 없습니다. URL을 다시 확인해주세요.' });
  }
});

// Download: save to temp file (needed for ffmpeg merging), then stream to client
app.get('/api/download', async (req, res) => {
  const { url, format, title } = req.query;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다.' });

  let runner;
  try { runner = await ensureYtDlp(); } catch (e) {
    return res.status(500).end();
  }

  const safeUrl = url.replace(/['"<>]/g, '').trim();
  const safeTitle = (title || 'video').replace(/[^\w가-힣\s\-_.]/g, '').trim() || 'video';
  const platform = detectPlatform(safeUrl);
  const timestamp = Date.now();
  const tmpTemplate = path.join(TMP_DIR, `vdl_${timestamp}.%(ext)s`);

  const args = [
    '--no-playlist',
    '-o', tmpTemplate,
    '--no-warnings',
    '--no-check-certificates',
    '--merge-output-format', 'mp4',
    ...getPlatformArgs(platform),
  ];

  if (format && format !== 'best') {
    args.push('-f', format);
  } else {
    args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
  }
  args.push(safeUrl);

  console.log('[download]', platform, safeUrl.slice(0, 60));

  const proc = spawn(runner.cmd, [...runner.prefix, ...args]);
  proc.stderr.on('data', d => console.error('[dl]', d.toString().trim()));

  proc.on('close', (code) => {
    if (code !== 0) {
      if (!res.headersSent) res.status(500).json({ error: '다운로드 실패' });
      return;
    }

    // Find the downloaded file
    let outFile = path.join(TMP_DIR, `vdl_${timestamp}.mp4`);
    if (!fs.existsSync(outFile)) {
      // yt-dlp might have used a different extension
      const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(`vdl_${timestamp}`));
      if (files.length === 0) {
        return res.status(500).json({ error: '다운로드된 파일을 찾을 수 없습니다.' });
      }
      outFile = path.join(TMP_DIR, files[0]);
    }

    const ext = path.extname(outFile).slice(1) || 'mp4';
    const filename = `${safeTitle}.${ext}`;

    res.setHeader('Content-Type', ext === 'mp4' ? 'video/mp4' : 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Length', fs.statSync(outFile).size);

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(outFile, () => {}));
    stream.on('error', () => { fs.unlink(outFile, () => {}); res.destroy(); });
  });

  proc.on('error', (err) => {
    console.error('spawn error:', err);
    if (!res.headersSent) res.status(500).json({ error: '다운로드 실패' });
  });

  req.on('close', () => proc.kill('SIGTERM'));
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
