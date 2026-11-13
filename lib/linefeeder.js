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
 * 识别 wget / curl / apt 的进度行。
 *
 * 非交互执行（没有 PTY）时，wget 不再用 \r 原地刷新，而是每 50K 打一行：
 *   6150K .......... 12% 14.4M 3s
 * 这类行必须继续走进度通道，否则前端会被成千上万行日志拖死。
 */
function isStreamProgress(s) {
  if (!s) return false;
  if (/^\[安装器\]/.test(s)) return false;
  return /^\s*[\d.]+[KMG]?\s+[.\s]{5,}\s*\d+%\s+[\d.]+[KMG]?\s+(\d+s|--\.-)/.test(s)
    || /^\s*\d+%\s*\[[=>.\s]+\]/.test(s);
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
        const line = buffer;
        buffer = '';
        if (isStreamProgress(line.trim())) emitProgress(line.trim());
        else emitLine(line);
      }
    }
  }

  function flush() {
    if (buffer && buffer.trim()) emitLine(buffer);
    buffer = '';
    if (progressLine) { onOutput && onOutput(progressLine); progressLine = ''; }
  }

  /** 当前尚未换行的尾巴：交互式提示（read -p）通常不带换行 */
  function getPartial() {
    return buffer;
  }

  return { feed, flush, getPartial };
}

module.exports = { createLineFeeder, isProgressText, isStreamProgress };