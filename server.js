const express = require('express');
const cors = require('cors');
const { exec, spawn, execSync } = require('child_process');
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

  if (fs.existsSync(YT_DLP_TMP)) {
    YT_DLP = YT_DLP_TMP;
    return YT_DLP;
  }

  console.log('yt-dlp 다운로드 중...');
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  execSync(`curl -fsSL "${url}" -o "${YT_DLP_TMP}" && chmod +x "${YT_DLP_TMP}"`, { timeout: 60000 });
  YT_DLP = YT_DLP_TMP;
  console.log('yt-dlp 준비 완료');
  return YT_DLP;
}

// Get video info
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다.' });

  let ytdlp;
  try { ytdlp = await ensureYtDlp(); } catch (e) {
    return res.status(500).json({ error: 'yt-dlp 초기화 실패: ' + e.message });
  }

  const safeUrl = url.replace(/['"]/g, '');
  const infoArgs = [
    '--dump-json', '--no-playlist',
    '--extractor-args', 'youtube:player_client=android,web',
    '--no-check-certificates',
    '--user-agent', 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
    safeUrl,
  ].map(a => `"${a}"`).join(' ');

  exec(`"${ytdlp}" ${infoArgs}`, { timeout: 40000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[info error]', stderr);
      return res.status(400).json({ error: '동영상 정보를 가져올 수 없습니다. URL을 확인해주세요.' });
    }
    try {
      const info = JSON.parse(stdout);
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
        formats,
      });
    } catch (e) {
      res.status(500).json({ error: '응답 파싱 오류' });
    }
  });
});

// Download video: pipe yt-dlp output directly to response
app.get('/api/download', async (req, res) => {
  const { url, format, title } = req.query;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다.' });

  let ytdlp;
  try { ytdlp = await ensureYtDlp(); } catch (e) {
    return res.status(500).json({ error: 'yt-dlp 초기화 실패' });
  }

  const safeUrl = url.replace(/['"]/g, '');
  const safeTitle = (title || 'video').replace(/[^\w가-힣\s\-_.]/g, '').trim() || 'video';
  const filename = `${safeTitle}.mp4`;

  const args = [
    '--no-playlist',
    '-o', '-',
    '--no-warnings',
    '--extractor-args', 'youtube:player_client=android,web',
    '--no-check-certificates',
    '--user-agent', 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
  ];

  if (format && format !== 'best') {
    args.push('-f', format);
  } else {
    args.push('-f', 'best[ext=mp4]/best');
  }
  args.push(safeUrl);

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);

  const proc = spawn(ytdlp, args);

  proc.stdout.pipe(res);
  proc.stderr.on('data', d => console.error('[yt-dlp]', d.toString().trim()));

  proc.on('error', (err) => {
    console.error('spawn error:', err);
    if (!res.headersSent) res.status(500).json({ error: '다운로드 실패' });
    else res.destroy();
  });

  req.on('close', () => proc.kill('SIGTERM'));
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
