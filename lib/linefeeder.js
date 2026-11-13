/**
 * 终端输出行处理
 *
 * wget / curl / apt 的进度条用 \r 原地刷新同一行。若把 \r 当作换行，
 * 一次 100MB 的下载会产生数千行进度垃圾，前端逐行追加 DOM 会把 WebView 拖死
 * （表现为「界面卡在 28%」）。
 *
 * 这里把 \r 识别为「覆盖当前行」：
 *   - 进度类文本 → 通过 onProgress 单独通道推送，前端只更新一行
 *   - 真正的换行 → 通过 onOutput 落地为普通日志行
 */

const PROGRESS_RE = /\d+K\s|%|\bETA\b/;

function isProgressText(s) {
  if (!s) return false;
  if (/^\[安装器\]/.test(s)) return false;
  return PROGRESS_RE.test(s);
}

/**
 * @param {(line:string)=>void} onOutput   普通行
 * @param {(text:string)=>void} onProgress 进度行（原地刷新）
 * @param {string} [initialBuffer]         起始缓冲
 * @returns {{ feed:(chunk:string)=>void, flush:()=>void }}
 */
function createLineFeeder(onOutput, onProgress, initialBuffer) {
  let buffer = initialBuffer || '';
  let progressLine = '';

  function emitProgress(text) {
    progressLine = text;
    onProgress && onProgress(text);
  }

  function emitLine(line) {
    // 有进度行未落地时先把它收尾
    if (progressLine) {
      onOutput && onOutput(progressLine);
      progressLine = '';
    }
    onOutput && onOutput(line);
  }

  function feed(text) {
    const norm = String(text).replace(/\r\n/g, '\n');
    let i = 0;
    while (i < norm.length) {
      const nl = norm.indexOf('\n', i);
      const cr = norm.indexOf('\r', i);
      if (nl === -1 && cr === -1) {
        buffer += norm.slice(i);
        break;
      }
      let next, isCr;
      if (nl === -1) { next = cr; isCr = true; }
      else if (cr === -1) { next = nl; isCr = false; }
      else if (nl < cr) { next = nl; isCr = false; }
      else { next = cr; isCr = true; }

      buffer += norm.slice(i, next);
      i = next + 1;

      if (isCr) {
        const seg = buffer;
        buffer = '';
        const trimmed = seg.trim();
        if (!trimmed) continue;
        if (isProgressText(trimmed)) emitProgress(trimmed);
        else emitLine(seg);
      } else {
        emitLine(buffer);
        buffer = '';
      }
    }
  }

  function flush() {
    if (buffer && buffer.trim()) emitLine(buffer);
    buffer = '';
    if (progressLine) { onOutput && onOutput(progressLine); progressLine = ''; }
  }

  return { feed, flush };
}

module.exports = { createLineFeeder, isProgressText };