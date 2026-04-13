const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Use OpenCV extractor by default (no ffmpeg dependency), fallback to original
const EXTRACT_SCRIPT = process.env.EXTRACT_SCRIPT_PATH
  || path.join(__dirname, '..', 'scripts', 'extract_cv.py');
const BUNDLE_TMP_DIR = process.env.BUNDLE_TMP_DIR || '/tmp/ve-edit-bundles';
const EXTRACT_TIMEOUT_MS = parseInt(process.env.EXTRACT_TIMEOUT_MS || '300000', 10); // 5 min default

/**
 * Extract video into a bundle (frames/ + index.json) using extract.py
 * @param {string} videoPath - path to the video file
 * @returns {Promise<string>} - path to the bundle directory
 */
async function extractBundle(videoPath) {
  const videoName = path.basename(videoPath, path.extname(videoPath));
  const outputDir = path.join(BUNDLE_TMP_DIR, `${videoName}_${Date.now()}`);

  fs.mkdirSync(outputDir, { recursive: true });

  return new Promise((resolve, reject) => {
    console.log(`[extract] Running: python3 ${EXTRACT_SCRIPT} ${videoPath} -o ${outputDir}`);

    const proc = spawn('python3', [EXTRACT_SCRIPT, videoPath, '-o', outputDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Timeout — kill subprocess if it takes too long
    const timer = setTimeout(() => {
      console.error(`[extract] Timeout after ${EXTRACT_TIMEOUT_MS / 1000}s, killing subprocess`);
      proc.kill('SIGKILL');
    }, EXTRACT_TIMEOUT_MS);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error(`[extract] Failed (code ${code}):`, stderr);
        return reject(new Error(`extract.py failed (code ${code}): ${stderr.substring(0, 500)}`));
      }

      // Find the actual bundle dir (extract.py creates a subdirectory)
      const entries = fs.readdirSync(outputDir);
      const bundleSubdir = entries.find(e => {
        const p = path.join(outputDir, e);
        return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'index.json'));
      });

      const bundlePath = bundleSubdir
        ? path.join(outputDir, bundleSubdir)
        : outputDir;

      // Verify bundle structure
      if (!fs.existsSync(path.join(bundlePath, 'index.json'))) {
        return reject(new Error('Bundle invalide: index.json manquant'));
      }
      if (!fs.existsSync(path.join(bundlePath, 'frames'))) {
        return reject(new Error('Bundle invalide: dossier frames/ manquant'));
      }

      console.log(`[extract] Bundle ready: ${bundlePath}`);
      resolve(bundlePath);
    });

    proc.on('error', (err) => {
      reject(new Error(`extract.py spawn error: ${err.message}`));
    });
  });
}

/**
 * Load frames as base64 from an existing bundle
 * @param {string} bundlePath - path to bundle directory containing frames/ + index.json
 * @returns {{ index: object, frames: Array<{filename, timecode, base64, spoken_text}> }}
 */
function loadBundle(bundlePath) {
  const indexPath = path.join(bundlePath, 'index.json');
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Bundle invalide: impossible de lire index.json — ${err.message}`);
  }

  const framesDir = path.join(bundlePath, 'frames');
  const frames = [];

  for (let i = 0; i < (index.frames || []).length; i++) {
    const f = index.frames[i];
    const imgPath = path.join(framesDir, f.filename);
    try {
      const base64 = fs.readFileSync(imgPath).toString('base64');
      frames.push({
        index: i,
        filename: f.filename,
        timecode: f.timecode || `${(i * 0.5).toFixed(1)}s`,
        timecode_s: f.timecode_s || i * 0.5,
        spoken_text: f.spoken_text || '',
        base64,
      });
    } catch (err) {
      console.warn(`[loadBundle] Skipping frame ${f.filename}: ${err.message}`);
    }
  }

  return { index, frames };
}

/**
 * Check if a path is already a bundle (has index.json + frames/)
 */
function isBundle(dirPath) {
  try {
    return fs.existsSync(path.join(dirPath, 'index.json'))
      && fs.existsSync(path.join(dirPath, 'frames'));
  } catch { return false; }
}

module.exports = { extractBundle, loadBundle, isBundle };
