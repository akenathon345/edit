const fs = require('fs');
const path = require('path');

/**
 * Recursively delete a file or directory. Never throws.
 */
function cleanupPath(targetPath) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return;
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(targetPath);
    }
    console.log(`[cleanup] Deleted: ${targetPath}`);
  } catch (err) {
    console.warn(`[cleanup] Failed to delete ${targetPath}:`, err.message);
  }
}

/**
 * Cleanup old files in a directory (older than maxAge ms). Never throws.
 */
function cleanupOldFiles(dir, maxAgeMs = 2 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    const entries = fs.readdirSync(dir);
    let cleaned = 0;
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
          cleaned++;
        }
      } catch {}
    }
    if (cleaned > 0) console.log(`[cleanup] Evicted ${cleaned} old entries from ${dir}`);
  } catch (err) {
    console.warn(`[cleanup] Sweep error in ${dir}:`, err.message);
  }
}

module.exports = { cleanupPath, cleanupOldFiles };
