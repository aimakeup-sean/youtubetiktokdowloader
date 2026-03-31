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

function getYtDlpPath() {
  const systemPaths = ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) return p;
  }
  try { execSync('which yt-dlp', { stdio: 'pipe' }); return 'yt-dlp'; } catch {}
  return null;
}

let YT_DLP = getYtDlpPath();

async function ensureYtDlp() {
  if (YT_DLP) return YT_DLP;
  if (fs.existsSync(YT_DLP_TMP)) { YT_DLP = YT_DLP_TMP; return YT_DLP; }
  console.log('yt-dlp 다운로드 중...');
  execSync(
    `curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o "${YT_DLP_TMP}" && chmod +x "${YT_DLP_TMP}"`,
    { timeout: 60000 }
  );
  YT_DLP = YT_DLP_TMP;
  console.log('yt-dlp 준비 완료');
  return YT_DLP;
}

function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  if (/tiktok\.com/.test(url)) return 'tiktok';
  if (/instagram\.com/.test(url)) return 'instagram';
  return 'generic';
}

function getPlatformArgs(platform) {
  switch (platform) {
    case 'youtube':
      return [
        '--extractor-args', 'youtube:player_client=android,web',
        '--add-headers', 'User-Agent:Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 Chrome/90.0.4430.91 Mobile Safari/537.36',
      ];
    case 'tiktok':
      return [
        '--add-headers', 'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1',
        '--add-headers', 'Referer:https://www.tiktok.com/',
      ];
    case 'instagram':
      return [
        '--add-headers', 'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1',
        '--add-headers', 'Referer:https://www.instagram.com/',
      ];
    default:
      return [];
  }
}

function runYtDlp(ytdlp, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytdlp, args);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `exit code ${code}`));
    });
    proc.on('error', reject);
    setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 40000);
  });
}

// Get video info
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다.' });

  let ytdlp;
  try { ytdlp = await ensureYtDlp(); } catch (e) {
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
    const stdout = await runYtDlp(ytdlp, args);
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
    console.error('[info error]', e.message);
    res.status(400).json({ error: '동영상 정보를 가져올 수 없습니다. URL을 다시 확인해주세요.' });
  }
});

// Download: pipe yt-dlp stdout directly to response
app.get('/api/download', async (req, res) => {
  const { url, format, title } = req.query;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다.' });

  let ytdlp;
  try { ytdlp = await ensureYtDlp(); } catch (e) {
    return res.status(500).end();
  }

  const safeUrl = url.replace(/['"<>]/g, '').trim();
  const safeTitle = (title || 'video').replace(/[^\w가-힣\s\-_.]/g, '').trim() || 'video';
  const platform = detectPlatform(safeUrl);

  const args = [
    '--no-playlist',
    '-o', '-',
    '--no-warnings',
    '--no-check-certificates',
    ...getPlatformArgs(platform),
  ];

  if (format && format !== 'best') {
    args.push('-f', format);
  } else {
    args.push('-f', 'best[ext=mp4]/best');
  }
  args.push(safeUrl);

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeTitle + '.mp4')}`);

  const proc = spawn(ytdlp, args);
  proc.stdout.pipe(res);
  proc.stderr.on('data', d => console.error('[dl]', d.toString().trim()));
  proc.on('error', err => {
    console.error('spawn error:', err);
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  req.on('close', () => proc.kill('SIGTERM'));
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
