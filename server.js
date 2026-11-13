/* ------------------------------------------------------------------ */
/*  宝塔面板一键安装器 · 桌面版  后端服务                                */
/*  Express + Socket.IO + SSH2                                          */
/*  仅监听 127.0.0.1，凭据不落盘、不上传第三方                            */
/* ------------------------------------------------------------------ */

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('ssh2');
const { createLineFeeder } = require('./lib/linefeeder');

const PORT = process.env.PORT || 3940;
const HOST = '127.0.0.1';

/* ------------------------------------------------------------------ */
/*  主机密钥校验（known_hosts）                                         */
/*  首次连接记录 SHA256 指纹，之后每次比对；指纹变化一律阻断，           */
/*  避免中间人冒充目标服务器窃取 root 密码。                            */
/* ------------------------------------------------------------------ */

const DATA_DIR = process.env.BT_DATA_DIR || path.join(__dirname, '..', 'data');
const KNOWN_HOSTS_FILE = path.join(DATA_DIR, 'known_hosts.json');
const pendingHostKeys = new Map();   // host:port -> { hash, reason, knownHash }

function loadKnownHosts() {
  try {
    const obj = JSON.parse(fs.readFileSync(KNOWN_HOSTS_FILE, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}
let knownHosts = loadKnownHosts();

function saveKnownHosts() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = KNOWN_HOSTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(knownHosts, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, KNOWN_HOSTS_FILE);
}

function hostKeyId(cfg) {
  const host = String((cfg && cfg.host) || '').trim().toLowerCase();
  return host + ':' + (Number(cfg && cfg.sshPort) || 22);
}

/** ssh2 返回的是十六进制摘要，转成 ssh-keygen 同款的 SHA256:base64 便于用户核对 */
function fingerprintOf(hash) {
  try {
    const b64 = Buffer.from(String(hash), 'hex').toString('base64').replace(/=+$/, '');
    return b64 ? 'SHA256:' + b64 : 'SHA256:' + hash;
  } catch (_) {
    return 'SHA256:' + hash;
  }
}

/** 接受 SHA256:base64 或纯十六进制两种写法，统一还原成十六进制摘要 */
function hashFromFingerprint(fp) {
  const v = String(fp || '').replace(/^SHA256:/i, '').trim();
  if (!v) return '';
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
  try {
    const hex = Buffer.from(v, 'base64').toString('hex');
    return /^[0-9a-f]{64}$/i.test(hex) ? hex : '';
  } catch (_) {
    return '';
  }
}

/** 取最近一次连接留下的指纹问题（存在即说明主机密钥校验失败） */
function hostKeyFailure(cfg) {
  const p = pendingHostKeys.get(hostKeyId(cfg));
  if (!p) return null;
  const mismatch = p.reason === 'mismatch';
  return {
    code: mismatch ? 'HOSTKEY_MISMATCH' : 'HOSTKEY_UNKNOWN',
    host: String((cfg && cfg.host) || '').trim(),
    port: Number(cfg && cfg.sshPort) || 22,
    fingerprint: p.hash ? fingerprintOf(p.hash) : '',
    knownFingerprint: p.knownHash ? fingerprintOf(p.knownHash) : '',
    msg: mismatch
      ? '服务器主机密钥与本地记录不一致，已阻止连接。可能是服务器重装，也可能有人冒充该服务器。'
      : '首次连接该服务器，需要先确认主机指纹。',
  };
}

/* 宝塔面板自带反爬：curl / wget / python 等非浏览器 UA 一律回 404。
   探活必须带浏览器 UA，否则会把正常面板误判成打不开。 */
const PANEL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/* 只允许本地回环页面的脚本与样式；动态文本已在渲染层全部转义 */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
    "img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*");
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ------------------------------------------------------------------ */
/*  宝塔官方脚本清单（依据 https://www.bt.cn/new/download.html）         */
/*  参数说明：脚本支持 -u 用户名 -p 密码 -P 端口 --safe-path 安全入口 -y */
/* ------------------------------------------------------------------ */

const BT_VERSIONS = {
  stable12: {
    label: '稳定版 12.0.0（推荐生产环境）',
    script: 'installStable_12.sh',
    code: '3Tmtilpm',
    note: '纯净版、无 AI、免绑定账号，只修 BUG 不加功能',
  },
  formal13: {
    label: '正式版 13.2.0（含 AI 运维）',
    script: 'install_panel.sh',
    code: 'rU2tN9mZ',
    note: '功能最新，每月更新，含 AI 助手',
  },
  lts9: {
    label: '稳定版 9.0.0（LTS 长期支持）',
    script: 'install_lts.sh',
    code: 'TDKGeDpB',
    note: '老牌稳定版，兼容性最好',
  },
};

const BT_MIRRORS = {
  auto: { label: '自动测速（脚本自选最快节点）', host: 'https://download.bt.cn', node: null },
  cdn: { label: 'CDN 线路（download-cdn1.bt.cn）', host: 'https://download-cdn1.bt.cn', node: 'https://download-cdn1.bt.cn' },
  cn: { label: '电信线路（cmcc1-node.bt.cn）', host: 'https://cmcc1-node.bt.cn', node: 'https://cmcc1-node.bt.cn' },
  hk: { label: '香港线路（hk1-node.bt.cn）', host: 'https://hk1-node.bt.cn', node: 'https://hk1-node.bt.cn' },
  eu: { label: '欧美线路（cf1-node.aapanel.com）', host: 'https://cf1-node.aapanel.com', node: 'https://cf1-node.aapanel.com' },
};

/** 系统支持矩阵：依据官方兼容列表 */
function judgeSystem(info) {
  const id = (info.id || '').toLowerCase();
  const ver = parseInt(String(info.versionId || '').split('.')[0], 10) || 0;
  const arch = info.arch || 'x86_64';

  if (arch === 'loongarch64' || /loong/i.test(arch)) {
    return { supported: true, family: 'loongarch', script: '0/loongarch64/loongarch64_install_panel.sh', reason: '龙芯架构，使用官方 loongarch64 专用脚本' };
  }
  if (arch !== 'x86_64' && arch !== 'aarch64') {
    return { supported: false, family: arch, script: null, reason: '当前架构 ' + arch + ' 不在官方支持范围内（仅 x86_64 / aarch64 / loongarch64）' };
  }
  if (/^(debian)$/.test(id)) {
    if (ver >= 11) return { supported: true, family: 'debian', script: null, reason: 'Debian ' + ver + ' 受支持' };
    return { supported: false, family: 'debian', script: null, reason: 'Debian ' + ver + ' 官方已停止支持，请换 Debian 11 / 12' };
  }
  if (/^(ubuntu)$/.test(id)) {
    if (ver >= 18 && ver % 2 === 0) return { supported: true, family: 'ubuntu', script: null, reason: 'Ubuntu ' + ver + '（LTS）受支持' };
    if (ver >= 18) return { supported: true, family: 'ubuntu', script: null, reason: 'Ubuntu ' + ver + ' 非 LTS 版本，官方脚本可能拒绝安装' };
    return { supported: false, family: 'ubuntu', script: null, reason: 'Ubuntu ' + ver + ' 版本过低，请换 20.04 / 22.04 / 24.04' };
  }
  if (/centos|rocky|almalinux|alibaba|opencloudos|anolis|tencentos|openeuler|kylin|uos|uniontech|openkylin|fedora/.test(id)) {
    if (/centos/.test(id) && ver === 7) {
      return { supported: true, family: 'rhel', script: null, reason: 'CentOS 7 已停止维护，官方脚本仍可安装但不再推荐' };
    }
    if (/centos/.test(id) && ver > 0 && ver < 7) {
      return { supported: false, family: 'rhel', script: null, reason: 'CentOS ' + ver + ' 版本过低，请换 CentOS 9 / Alma / Rocky 9' };
    }
    return { supported: true, family: 'rhel', script: null, reason: 'RHEL 系（' + (info.pretty || id) + '）受支持' };
  }
  return { supported: false, family: id || 'unknown', script: null, reason: '未能识别的系统（' + (info.pretty || id || '未知') + '），官方仅支持 Debian 11+ / Ubuntu 18+ / RHEL 系 / 国产系统' };
}

/** 构造安装命令：下载官方脚本 → 带参执行 */
function buildInstallCommand(cfg) {
  const version = BT_VERSIONS[cfg.btVersion] || BT_VERSIONS.stable12;
  const mirror = BT_MIRRORS[cfg.mirror] || BT_MIRRORS.auto;
  // 龙芯等专用脚本由 judgeSystem 给出 scriptPath，必须优先使用，否则会跑错架构的脚本
  const scriptPath = safeScriptPath(cfg.scriptPath, version.script);
  const fileName = scriptPath.split('/').pop();
  const url = mirror.host + '/install/' + scriptPath;

  const args = [];
  if (cfg.panelUser) args.push('-u ' + shQuote(cfg.panelUser));
  if (cfg.panelPass) args.push('-p ' + shQuote(cfg.panelPass));
  if (cfg.panelPort) args.push('-P ' + parseInt(cfg.panelPort, 10));
  // 注意：官方脚本会自己补前导斜杠，这里必须传不含斜杠的裸路径，否则会变成 //xxx
  if (cfg.safePath) args.push('--safe-path ' + shQuote(bareSafePath(cfg.safePath)));
  args.push('-y');  // 跳过官方脚本的交互确认

  // 关键：官方脚本会把测速结果缓存到 /www/node.pl，之后每次安装直接复用、不再测速。
  // 一旦首次选中的节点很慢，重装就会一直卡在同一处。这里强制重置这个缓存：
  //   选了具体线路 → 直接写入该节点；选自动 → 删除缓存，让脚本重新测速
  const nodeUrl = mirror.node;
  const prep = nodeUrl
    ? 'mkdir -p /www; echo ' + shQuote(nodeUrl) + ' > /www/node.pl; echo "使用下载节点: ' + nodeUrl + '"'
    : 'rm -f /www/node.pl; echo "已清空节点缓存，脚本将重新测速选择"';

  const download = [
    'cd /tmp',
    'rm -f ' + fileName,
    '(command -v curl >/dev/null 2>&1 && curl -fsSL --connect-timeout 15 -m 180 -o ' + fileName + ' ' + url + ') || wget -q -T 180 -O ' + fileName + ' ' + url,
    'test -s ' + fileName,
  ].join('; ') + ' || { echo "===BT_DOWNLOAD_FAILED==="; exit 10; }';

const run = 'bash /tmp/' + fileName + ' ' + args.join(' ');
  const readInfo = [
    'echo "===BT_INFO_BEGIN==="',
    'PORT=$(cat /www/server/panel/data/port.pl 2>/dev/null)',
    'ADMIN_PATH=$(cat /www/server/panel/data/admin_path.pl 2>/dev/null)',
    // 双斜杠会让宝塔把登录路由注册成 //xxx，Werkzeug 合并斜杠后登录页必然 404 → 自动纠正并重启一次
    'case "$ADMIN_PATH" in //*) ADMIN_PATH=$(printf "%s" "$ADMIN_PATH" | sed "s#^//*#/#"); printf "%s" "$ADMIN_PATH" > /www/server/panel/data/admin_path.pl; /etc/init.d/bt restart >/dev/null 2>&1; sleep 3; ADMIN_PATH=$(cat /www/server/panel/data/admin_path.pl 2>/dev/null); echo "PATH_FIXED=1";; esac',
    'UA="' + PANEL_UA + '"',
    'C_HTTPS=$(curl -s -k -A "$UA" -o /dev/null -w "%{http_code}" --max-time 8 "https://127.0.0.1:$PORT$ADMIN_PATH" 2>/dev/null)',
    'C_PLAIN=$(curl -s -k -A "$UA" -o /dev/null -w "%{http_code}" --max-time 8 "http://127.0.0.1:$PORT$ADMIN_PATH" 2>/dev/null)',
    'BEST=$C_HTTPS',
    'case "$BEST" in 200|302) ;; *) BEST=$C_PLAIN;; esac',
    'echo "DEFAULT_PASS=$(cat /www/server/panel/default.pl 2>/dev/null)"',
    'echo "SERVICE=$( (pgrep -f BT-Panel >/dev/null 2>&1 && echo running) || (/etc/init.d/bt status 2>/dev/null | head -1 | grep -qi running && echo running) || echo stopped )"',
    'echo "LOCAL_HTTP=$BEST"',
    'echo "HTTPS_HTTP=$C_HTTPS"',
    'echo "PLAIN_HTTP=$C_PLAIN"',
    'echo "PORT=$PORT"',
    'echo "ADMIN_PATH=$ADMIN_PATH"',
    'echo "===BT_INFO_END==="',
  ].join('; ');

  return { prep, download, run, readInfo, url, fileName, full: prep + '; ' + download + ' && ' + run + '; ' + readInfo };
}

/** 只生成给用户手动执行的命令 */
function buildManualCommand(cfg) {
  const version = BT_VERSIONS[cfg.btVersion] || BT_VERSIONS.stable12;
  const mirror = BT_MIRRORS[cfg.mirror] || BT_MIRRORS.auto;
  const scriptPath = safeScriptPath(cfg.scriptPath, version.script);
  const url = mirror.host + '/install/' + scriptPath;
  const fileName = scriptPath.split('/').pop();
  const args = [];
  if (cfg.panelUser) args.push('-u ' + shQuote(cfg.panelUser));
  if (cfg.panelPass) args.push('-p ' + shQuote(cfg.panelPass));
  if (cfg.panelPort) args.push('-P ' + parseInt(cfg.panelPort, 10));
  if (cfg.safePath) args.push('--safe-path ' + shQuote(bareSafePath(cfg.safePath)));
  args.push('-y');
  const base = 'bash /tmp/' + fileName + ' ' + args.join(' ');
  const nodePrep = mirror.node
    ? 'mkdir -p /www; echo ' + shQuote(mirror.node) + ' > /www/node.pl; '
    : 'rm -f /www/node.pl; ';
  return nodePrep + 'cd /tmp && (command -v curl >/dev/null 2>&1 && curl -fsSL -o ' + fileName + ' ' + url + ' || wget -O ' + fileName + ' ' + url + ') && ' + base;
}

function safeScriptPath(p, fallback) {
  const s = String(p || '').trim();
  if (!s || !/^[A-Za-z0-9._\/-]+$/.test(s) || s.split('/').indexOf('..') !== -1) return fallback;
  return s.replace(/^\/+/, '') || fallback;
}

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** 去掉所有前导/尾随斜杠，供官方脚本 --safe-path 使用（脚本会自己补一个 /） */
function bareSafePath(p) {
  return String(p || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeSafePath(p) {
  let s = String(p || '').trim();
  if (!s) return '';
  s = '/' + s.replace(/^\/+/, '').replace(/\/+$/, '');
  return s;
}

function randomToken(n) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const crypto = require('crypto');
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += chars[bytes[i] % chars.length];
  return out;
}

/* ------------------------------------------------------------------ */
/*  SSH 基础层                                                          */
/* ------------------------------------------------------------------ */

/**
 * 认证处理器：先探测服务器支持的认证方式，再依次尝试 password / keyboard-interactive
 * （部分服务器只把密码提供为 keyboard-interactive，直接试 password 会误报认证失败）
 */
function buildAuthHandler(cfg) {
  const password = cfg.privateKey ? '' : String(cfg.password == null ? '' : cfg.password);
  const detail = { offered: null, partial: false, tried: [], kiPrompts: 0 };
  let stage = 'probe';

  const handler = (authsLeft, partialSuccess, cb) => {
    if (Array.isArray(authsLeft) && authsLeft.length) detail.offered = authsLeft.slice();
    if (partialSuccess) detail.partial = true;

    const offers = (m) => !detail.offered || detail.offered.indexOf(m) !== -1;
    const triedIt = (m) => detail.tried.indexOf(m) !== -1;

    if (stage === 'probe') { stage = 'auth'; return 'none'; }

    if (cfg.privateKey && !triedIt('publickey') && offers('publickey')) {
      detail.tried.push('publickey');
      return 'publickey';
    }
    if (password) {
      if (!triedIt('password') && offers('password')) {
        detail.tried.push('password');
        return 'password';
      }
      if (!triedIt('keyboard-interactive') && offers('keyboard-interactive')) {
        detail.tried.push('keyboard-interactive');
        return {
          type: 'keyboard-interactive',
          username: cfg.sshUser || 'root',
          prompt: (name, instructions, lang, prompts, finish) => {
            const list = Array.isArray(prompts) ? prompts : [];
            detail.kiPrompts = list.length;
            finish(list.map((p, i) => (i === 0 ? password : '')));
          },
        };
      }
    }
    return false;
  };

  return { handler, detail };
}

function inspectCreds(cfg) {
  const user = String(cfg.sshUser == null ? '' : cfg.sshUser);
  if (!user.trim()) return { ok: false, msg: '请先填写 SSH 用户名（绝大多数服务器是 root）。' };

  if (cfg.privateKey) {
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(String(cfg.privateKey))) {
      return { ok: false, msg: '私钥内容不完整：需要包含 BEGIN / END 行的 OpenSSH 或 RSA 私钥；PuTTY 的 .ppk 需要先转换格式。' };
    }
    return { ok: true };
  }

  const pwd = String(cfg.password == null ? '' : cfg.password);
  if (!pwd) return { ok: false, msg: '没有收到 SSH 密码：请确认登录方式为密码登录并已填写密码。' };
  if (!pwd.trim()) return { ok: false, msg: 'SSH 密码里只有空格/换行：请重新输入。' };

  const hints = [];
  if (pwd !== pwd.trim()) hints.push('密码首尾有多余的空格或换行');
  if (/[\uFF01-\uFF5E\u3000]/.test(pwd)) hints.push('密码里含全角字符');
  return hints.length ? { ok: true, hint: hints.join('，') } : { ok: true };
}

function makeConnConfig(cfg) {
  const auth = buildAuthHandler(cfg);
  const keyId = hostKeyId(cfg);
  pendingHostKeys.delete(keyId);   // 每次连接重新判定，避免旧结果污染
  const c = {
    host: cfg.host,
    port: Number(cfg.sshPort) || 22,
    username: cfg.sshUser || 'root',
    readyTimeout: 20000,
    keepaliveInterval: 10000,
    tryKeyboard: true,
    authHandler: auth.handler,
    __authDetail: auth.detail,
    // 用 SHA256 指纹做主机校验：未记录 → 交给用户确认；已记录 → 必须完全一致
    hostHash: 'sha256',
    hostVerifier: (hash, cb) => {
      const rec = knownHosts[keyId];
      if (!rec) {
        pendingHostKeys.set(keyId, { hash, reason: 'unknown' });
        cb(false);
        return;
      }
      if (rec.hash !== hash) {
        pendingHostKeys.set(keyId, { hash, reason: 'mismatch', knownHash: rec.hash });
        cb(false);
        return;
      }
      cb(true);
    },
  };
  if (cfg.privateKey) {
    c.privateKey = cfg.privateKey;
    if (cfg.passphrase) c.passphrase = cfg.passphrase;
  } else {
    c.password = cfg.password;
  }
  return c;
}

function friendlySSHError(e, detail) {
  const msg = (e && e.message) || String(e);
  const level = (e && e.level) || '';
  const d = detail || {};
  const offered = Array.isArray(d.offered) && d.offered.length ? d.offered : null;
  const tried = Array.isArray(d.tried) ? d.tried : [];

  const isAuthFailure = level === 'client-authentication'
    || /All configured authentication methods failed|Permission denied|Authentication failed|Too many authentication failures/i.test(msg);

  if (isAuthFailure) {
    if (/Too many authentication failures/i.test(msg)) {
      return '认证尝试次数过多：服务器限制了失败次数。请等待几分钟后重试，或改用密钥登录。';
    }
    if (d.partial) {
      return '服务器要求多因素认证：除密码外还需要其它验证方式，本工具暂不支持。请改用密钥登录。';
    }
    if (offered && offered.indexOf('publickey') === -1 && tried.indexOf('publickey') !== -1) {
      return '服务器不接受密钥登录（只允许：' + offered.join(' / ') + '）。请把认证方式切换为「密码」后重试。';
    }
    if (offered && offered.indexOf('password') === -1 && offered.indexOf('keyboard-interactive') === -1) {
      return '服务器不接受密码登录（只允许：' + offered.join(' / ') + '）。请把认证方式切换为「私钥」并填写私钥。';
    }
    let text = 'SSH 认证失败：请检查用户名/密码（或密钥）是否正确。部分服务商需先在控制台开启 root 密码登录。';
    if (offered) text += '（服务器允许的认证方式：' + offered.join(' / ') + '）';
    if (d.inputHint) text += '（检测到' + d.inputHint + '，请核对后重试）';
    return text;
  }

  if (/Cannot parse privateKey|Unsupported key format|bad passphrase|integrity check failed/i.test(msg)) {
    return '私钥无法读取：请确认粘贴的是完整私钥（含 BEGIN / END 行），有口令的私钥也要填写口令。';
  }
  if (/no matching (key exchange|host key algorithm|cipher|mac)|Key exchange failed|Unable to negotiate/i.test(msg)) {
    return '算法协商失败：服务器的 SSH 服务过旧或禁用了通用算法，无法握手。';
  }
  if (/ECONNRESET|EPIPE|Connection lost before handshake/i.test(msg)) {
    return '连接被中断：服务器在握手阶段主动断开了连接，常见于并发连接限制、防爆破策略或网络抖动。请稍后重试。';
  }
  if (/timed out|ETIMEDOUT/i.test(msg)) return '连接超时：请检查 IP 是否正确、SSH 端口是否对公网开放。';
  if (/ECONNREFUSED/i.test(msg)) return '连接被拒绝：该端口未开放 SSH 服务，若改过 SSH 端口请填写正确端口。';
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return '无法解析主机：请确认填写的是正确的服务器 IP。';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) return '网络不可达：请检查本机网络、服务器防火墙或云安全组。';
  return 'SSH 连接错误：' + msg;
}

/** 执行命令并逐行回调输出 */
function runCommand(conn, command, opts) {
  const raw = [];
  let buffer = '';
  const maxWait = opts.longRunning ? 40 * 60 * 1000 : 5 * 60 * 1000;
  const stallWarnMs = opts.stallWarnMs || 150 * 1000;   // 多久无输出判定为疑似卡住
  const startedAt = Date.now();
  let finished = false;
  let lastData = Date.now();
  let stallNotified = false;

  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    try { if (feeder) feeder.flush(); } catch (_) {}
    opts.onExit && opts.onExit(code, raw.join(''));
  };

  // 输出分帧：回车符视为原地刷新，避免 wget 进度条把终端刷成数千行
  const feeder = createLineFeeder(
    (line) => opts.onOutput && opts.onOutput(line),
    (text) => opts.onProgress && opts.onProgress(text)
  );

  const timer = setInterval(() => {
    const idle = Date.now() - lastData;
    const elapsed = Date.now() - startedAt;
    opts.onTick && opts.onTick({ elapsedMs: elapsed, idleMs: idle });
    if (!stallNotified && idle > stallWarnMs) {
      stallNotified = true;
      opts.onStall && opts.onStall({ idleMs: idle, elapsedMs: elapsed });
    }
    if (idle > maxWait) {
      try { stream.close(); } catch (_) {}
      finish(-1);
    }
  }, 5000);
  let stream = null;

  conn.exec(command, { pty: { mode: 'echo' }, env: { TERM: 'xterm' } }, (err, s) => {
    if (err) { clearInterval(timer); finish(-1); return; }
    stream = s;
    s.on('close', (code) => finish(code))
      .on('data', (data) => {
        lastData = Date.now();
        const text = data.toString('utf8');
        raw.push(text);
        feeder.feed(text);
      });
    s.stderr.on('data', (data) => {
      lastData = Date.now();
      const text = data.toString('utf8');
      raw.push(text);
      feeder.feed(text);
    });
    if (opts.feedStdin) {
      try { s.write(opts.feedStdin); } catch (_) {}
    }
  });
}

/** 执行一条命令并收集完整输出 */
function execCapture(conn, command, cb) {
  let raw = '';
  conn.exec(command, (err, stream) => {
    if (err) { cb(err, ''); return; }
    stream.on('close', () => cb(null, raw))
      .on('data', (d) => { raw += d.toString('utf8'); })
      .stderr.on('data', (d) => { raw += d.toString('utf8'); });
  });
}

/* ------------------------------------------------------------------ */
/*  Socket 流程                                                         */
/* ------------------------------------------------------------------ */

const activeConn = new Map(); // socketId -> ssh Client

io.on('connection', (socket) => {
  socket.on('disconnect', () => {
    const conn = activeConn.get(socket.id);
    if (conn) { try { conn.end(); } catch (_) {} activeConn.delete(socket.id); }
  });

  /** 测试 SSH 连通性 */
  socket.on('ssh:test', (cfg, ack) => {
    const conn = new Client();
    const connCfg = makeConnConfig(cfg);
    let settled = false;
    const done = (ok, msg, extra) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      if (typeof ack === 'function') ack(Object.assign({ ok, msg }, extra || {}));
    };

    const pre = inspectCreds(cfg);
    if (!pre.ok) { done(false, pre.msg); return; }
    if (pre.hint) connCfg.__authDetail.inputHint = pre.hint;

    conn.on('ready', () => done(true, '连接成功'))
      .on('error', (e) => {
        const hk = hostKeyFailure(cfg);
        if (hk) { done(false, hk.msg, hk); return; }
        done(false, friendlySSHError(e, connCfg.__authDetail));
      })
      .on('close', () => {
        if (settled) return;
        const hk = hostKeyFailure(cfg);
        if (hk) { done(false, hk.msg, hk); return; }
        done(false, '连接被中断：服务器在握手或认证阶段主动断开了连接。请稍后重试。');
      })
      .on('timeout', () => { if (!settled) done(false, '连接超时：服务器在 20 秒内没有响应握手。'); });

    try { conn.connect(connCfg); } catch (e) { done(false, friendlySSHError(e, connCfg.__authDetail)); }
  });

  /** 探测系统类型与版本，返回推荐脚本 */
  socket.on('system:detect', (cfg, ack) => {
    const conn = new Client();
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      if (typeof ack === 'function') ack(payload);
    };

    const cmd = [
      'echo "ID=$(. /etc/os-release 2>/dev/null && echo $ID)"',
      'echo "VERSION_ID=$(. /etc/os-release 2>/dev/null && echo $VERSION_ID)"',
      'echo "PRETTY=$(. /etc/os-release 2>/dev/null && echo \\"$PRETTY_NAME\\")"',
      'echo "ARCH=$(uname -m)"',
      'echo "BIT=$(getconf LONG_BIT)"',
      'echo "KERNEL=$(uname -r)"',
      'echo "MEM=$(free -m | awk \'/Mem:/{print $2}\')"',
      'echo "DISK=$(df -m / | awk \'NR==2{print $4}\')"',
      'echo "ROOT=$( [ "$(id -u)" = "0" ] && echo yes || echo no )"',
      'echo "HOSTNAME=$(cat /etc/hostname 2>/dev/null)"',
      'echo "BT_INSTALLED=$( [ -f /www/server/panel/BT-Panel ] && echo yes || echo no )"',
      'echo "BT_PORT=$(cat /www/server/panel/data/port.pl 2>/dev/null)"',
      'echo "WEB_SVC=$(ps -ef | grep -E "nginx|httpd|apache|mysqld|php-fpm" | grep -v grep | head -3 | tr "\\n" ";")"',
    ].join('; ');

    conn.on('ready', () => {
      execCapture(conn, cmd, (err, raw) => {
        if (err) { done({ ok: false, msg: '读取系统信息失败：' + err.message }); return; }
        const get = (k) => {
          const m = raw.match(new RegExp('^' + k + '=(.*)$', 'm'));
          return m ? m[1].trim().replace(/^"|"$/g, '') : '';
        };
        const info = {
          ok: true,
          id: get('ID'),
          versionId: get('VERSION_ID'),
          pretty: get('PRETTY'),
          arch: get('ARCH'),
          bit: get('BIT'),
          kernel: get('KERNEL'),
          memMb: parseInt(get('MEM'), 10) || 0,
          diskFreeMb: parseInt(get('DISK'), 10) || 0,
          isRoot: get('ROOT') === 'yes',
          hostname: get('HOSTNAME'),
          btInstalled: get('BT_INSTALLED') === 'yes',
          btPort: get('BT_PORT'),
          webServices: get('WEB_SVC'),
        };
        info.judgement = judgeSystem(info);
        info.raw = raw;
        done(info);
      });
    })
      .on('error', (e) => {
        const hk = hostKeyFailure(cfg);
        done(hk ? Object.assign({ ok: false }, hk) : { ok: false, msg: friendlySSHError(e) });
      })
      .on('close', () => {
        if (settled) return;
        const hk = hostKeyFailure(cfg);
        done(hk ? Object.assign({ ok: false }, hk) : { ok: false, msg: '连接在探测系统时被中断，请重试。' });
      });

    try { conn.connect(makeConnConfig(cfg)); } catch (e) { done({ ok: false, msg: friendlySSHError(e) }); }
  });

  /** 开始安装 */
  socket.on('install:start', (cfg) => {
    const emit = (event, data) => socket.emit(event, data);
    const pre = inspectCreds(cfg);
    if (!pre.ok) { emit('install:failed', { error: pre.msg }); return; }

    const conn = new Client();
    activeConn.set(socket.id, conn);

    conn.on('ready', () => {
      emit('log', { level: 'success', text: '✓ SSH 连接成功' });
      emit('stage', { stage: 1, text: '正在识别服务器系统类型与版本' });

      const probe = [
        'echo "ID=$(. /etc/os-release 2>/dev/null && echo $ID)"',
        'echo "VERSION_ID=$(. /etc/os-release 2>/dev/null && echo $VERSION_ID)"',
        'echo "PRETTY=$(. /etc/os-release 2>/dev/null && echo \\"$PRETTY_NAME\\")"',
        'echo "ARCH=$(uname -m)"',
        'echo "ROOT=$( [ "$(id -u)" = "0" ] && echo yes || echo no )"',
        'echo "BT_INSTALLED=$( [ -f /www/server/panel/BT-Panel ] && echo yes || echo no )"',
      ].join('; ');

      execCapture(conn, probe, (err, raw) => {
        if (err) { emit('install:failed', { error: '读取系统信息失败：' + err.message }); return; }
        const get = (k) => {
          const m = raw.match(new RegExp('^' + k + '=(.*)$', 'm'));
          return m ? m[1].trim().replace(/^"|"$/g, '') : '';
        };
        const info = { id: get('ID'), versionId: get('VERSION_ID'), pretty: get('PRETTY'), arch: get('ARCH'), isRoot: get('ROOT') === 'yes' };
        const judge = judgeSystem(info);

        emit('system', { info, judgement: judge });
        emit('log', { level: 'info', text: '系统：' + (info.pretty || info.id || '未知') + '（' + (info.arch || '?') + '）→ ' + judge.reason });

        if (!judge.supported) {
          emit('install:failed', { error: '系统不受支持：' + judge.reason });
          try { conn.end(); } catch (_) {}
          activeConn.delete(socket.id);
          return;
        }
        if (!info.isRoot) {
          emit('install:failed', { error: '当前 SSH 用户不是 root。宝塔官方脚本必须以 root 身份执行，请改用 root 登录（或先配置 sudo 免密）。' });
          try { conn.end(); } catch (_) {}
          activeConn.delete(socket.id);
          return;
        }
        if (get('BT_INSTALLED') === 'yes') {
          emit('log', { level: 'warn', text: '⚠️ 检测到该服务器已安装宝塔面板，官方脚本将执行覆盖安装（面板数据会保留备份）。' });
        }

        // 选脚本：龙芯走专用脚本，其余走所选版本的通用脚本
        const scriptPath = judge.script || (BT_VERSIONS[cfg.btVersion] || BT_VERSIONS.stable12).script;
        const effCfg = Object.assign({}, cfg, { scriptPath });
        const cmd = buildInstallCommand(effCfg);

        emit('stage', { stage: 2, text: '正在下载并执行官方安装脚本（约 2–5 分钟，请勿关闭窗口）' });
        emit('cmd', { text: cmd.full });
        emit('log', { level: 'info', text: '下载地址：' + cmd.url });

        runCommand(conn, cmd.full, {
          longRunning: true,
          feedStdin: 'y\nyes\n',
          onTick: (t) => emit('tick', t),
          onStall: (t) => emit('install:stall', {
            idleSec: Math.round(t.idleMs / 1000),
            elapsedSec: Math.round(t.elapsedMs / 1000),
          }),
          // 进度条单独通道：前端只更新一行，不追加 DOM
          onProgress: (line) => emit('progress', line),
          onOutput: (line) => {
            if (line.trim()) emit('term', line + '\n');
          },
          onExit: (code, raw) => {
            if (/===BT_DOWNLOAD_FAILED===/.test(raw)) {
              emit('install:failed', { error: '安装脚本下载失败：服务器无法访问宝塔下载节点。请换一个下载线路（如 CDN / 香港 / 欧美线路）后重试。' });
              activeConn.delete(socket.id);
              return;
            }
            const parsed = parsePanelInfo(raw);
            if (code !== 0 && !parsed.port) {
              emit('install:failed', { error: '宝塔安装失败（脚本退出码 ' + code + '）。请查看上方日志最后几十行定位失败步骤。常见原因：① 系统版本不受支持 ② 磁盘或内存不足 ③ 服务器无法访问下载节点 ④ 已存在 Web/MySQL 环境导致脚本要求确认。' });
              activeConn.delete(socket.id);
              return;
            }
            emit('stage', { stage: 3, text: '安装完成，正在核对面板信息' });
            finishInstall(conn, cfg, parsed, emit);
          },
        });
      });
    })
      .on('error', (e) => {
        const hk = hostKeyFailure(cfg);
        if (hk) {
          emit('install:failed', Object.assign({ error: hk.msg }, hk));
          activeConn.delete(socket.id);
          return;
        }
        emit('install:failed', { error: friendlySSHError(e) });
      })
      .on('close', () => { activeConn.delete(socket.id); });

    try { conn.connect(makeConnConfig(cfg)); } catch (e) { emit('install:failed', { error: friendlySSHError(e) }); }
  });

  socket.on('install:abort', () => {
    const conn = activeConn.get(socket.id);
    if (conn) {
      try { conn.end(); } catch (_) {}
      activeConn.delete(socket.id);
    }
    socket.emit('install:failed', { error: '已手动中止安装。' });
  });

  /** 从安装输出里解析面板信息 */
  function parsePanelInfo(raw) {
    const clean = String(raw || '').replace(/\x1b\[[0-9;]*m/g, '');
    const out = {};
    const portBlock = clean.match(/PORT=(\d+)/);
    const pathBlock = clean.match(/ADMIN_PATH=(\S*)/);
    const passBlock = clean.match(/DEFAULT_PASS=(\S*)/);
    const svcBlock = clean.match(/SERVICE=(\S*)/);
    const httpBlock = clean.match(/LOCAL_HTTP=(\d*)/);

    if (portBlock) out.port = portBlock[1];
    if (pathBlock) out.safePath = pathBlock[1].replace(/^\/+/, '');
    if (passBlock) out.password = passBlock[1];
    if (svcBlock) out.service = svcBlock[1];
    if (httpBlock) out.localHttp = httpBlock[1];

    // 官方脚本最后的登录信息块
    const ext = clean.match(/外网面板地址:\s*(https?:\/\/[^\s]+)/);
    if (ext && !out.port) {
      const m = ext[1].match(/:(\d+)/);
      if (m) out.port = m[1];
    }
    const user = clean.match(/username:\s*(\S+)/);
    if (user) out.username = user[1];
    const pass = clean.match(/password:\s*(\S+)/);
    if (pass) out.password = pass[1] || out.password;
    return out;
  }

  /** 安装后补齐面板信息（端口 / 安全入口 / 账号 / 密码 / 服务状态） */
  function finishInstall(conn, cfg, parsed, emit) {
    const script = [
      'PORT=$(cat /www/server/panel/data/port.pl 2>/dev/null)',
'ADMIN_PATH=$(cat /www/server/panel/data/admin_path.pl 2>/dev/null)',
      // 双斜杠会让宝塔把登录路由注册成 //xxx，Werkzeug 合并斜杠后登录页必然 404 → 自动纠正并重启一次
      'case "$ADMIN_PATH" in //*) ADMIN_PATH=$(printf "%s" "$ADMIN_PATH" | sed "s#^//*#/#"); printf "%s" "$ADMIN_PATH" > /www/server/panel/data/admin_path.pl; /etc/init.d/bt restart >/dev/null 2>&1; sleep 3; ADMIN_PATH=$(cat /www/server/panel/data/admin_path.pl 2>/dev/null);; esac',
      'DEFAULT_PASS=$(cat /www/server/panel/default.pl 2>/dev/null)',
      'SVC=$( (pgrep -f BT-Panel >/dev/null 2>&1 && echo running) || echo stopped )',
      'UA="' + PANEL_UA + '"',
      'LOCAL_HTTP=$(curl -s -k -A "$UA" -o /dev/null -w "%{http_code}" --max-time 6 "http://127.0.0.1:${PORT}${ADMIN_PATH}" 2>/dev/null)',
      'SSLPORT_CHECK=$(curl -s -k -A "$UA" -o /dev/null -w "%{http_code}" --max-time 6 "https://127.0.0.1:${PORT}${ADMIN_PATH}" 2>/dev/null)',
      'SSL_FLAG=$(cat /www/server/panel/data/ssl.pl 2>/dev/null)',
      'USER_NAME=$(/www/server/panel/pyenv/bin/python /www/server/panel/tools.py username 2>/dev/null | tail -1)',
      'echo "PORT=${PORT}"',
      'echo "ADMIN_PATH=${ADMIN_PATH}"',
      'echo "DEFAULT_PASS=${DEFAULT_PASS}"',
      'echo "SVC=${SVC}"',
      'echo "LOCAL_HTTP=${LOCAL_HTTP}"',
      'echo "SSL_HTTP=${SSLPORT_CHECK}"',
      'echo "USER_NAME=${USER_NAME}"',
    ].join('; ');

    execCapture(conn, script, (err, raw) => {
      if (err) { emit('install:failed', { error: '读取面板信息失败：' + err.message }); return; }
      const get = (k) => {
        const m = raw.match(new RegExp('^' + k + '=(.*)$', 'm'));
        return m ? m[1].trim() : '';
      };
      const port = get('PORT') || parsed.port || cfg.panelPort || '';
      // admin_path.pl 里已是 /xxx 或 //xxx，统一剥成裸路径再拼，避免出现 //
      const safePath = (get('ADMIN_PATH') || parsed.safePath || '').replace(/^\/+/, '').replace(/\/+$/, '');
      const password = get('DEFAULT_PASS') || parsed.password || '';
      const rawUser = get('USER_NAME') || parsed.username || '';
      const username = String(rawUser).replace(/^\s*username\s*:\s*/i, '').trim() || cfg.panelUser || 'admin';
      const service = get('SVC') || parsed.service || '';
      const httpCode = get('LOCAL_HTTP') || parsed.localHttp || '';
const sslCode = get('SSL_HTTP') || '';
      const sslFlag = /true/i.test(get('SSL_FLAG') || '');
      // 只有真正拿到 200/302 才算这条协议通；000=不通，404=被反爬或路径不对
      const reachable = (c) => !!c && c !== '000' && c !== '404';
      // 宝塔默认开启面板 SSL：有 SSL 标记或 HTTPS 真的可达就用 https
      const scheme = sslFlag || reachable(sslCode) || (!reachable(httpCode) && !reachable(sslCode)) ? 'https' : 'http';
      const liveCode = scheme === 'https' ? sslCode : httpCode;

      const urlPath = safePath ? '/' + safePath : '';
      const panelUrl = port ? scheme + '://' + cfg.host + ':' + port + urlPath : '';

      try { conn.end(); } catch (_) {}
      activeConn.delete(conn.__socketId || '');

      emit('install:done', {
        url: panelUrl,
        port,
        safePath: urlPath,
        username,
        password,
        service,
localHttp: liveCode,
        httpsAvailable: scheme === 'https',
        note: reachable(liveCode)
          ? ''
          : '本地面板探活返回 HTTP ' + (liveCode || '无响应') + '，请在浏览器里确认面板能否打开',
      });
    });
  }

  /** 面板急救箱 */
  socket.on('rescue:run', (data, ack) => {
    const { server: srv, action, newPassword } = data || {};
    if (!srv || !srv.host) { ack && ack({ ok: false, output: '请先填写服务器信息' }); return; }
    const conn = new Client();

    conn.on('ready', () => {
      const cmds = [];
      if (action === 'info') {
        cmds.push(
          'echo "PORT=$(cat /www/server/panel/data/port.pl 2>/dev/null)"',
          'echo "ADMIN_PATH=$(cat /www/server/panel/data/admin_path.pl 2>/dev/null)"',
          'echo "DEFAULT_PASS=$(cat /www/server/panel/default.pl 2>/dev/null)"',
          'echo "USER_NAME=$(/www/server/panel/pyenv/bin/python /www/server/panel/tools.py username 2>/dev/null | tail -1)"',
          'echo "SVC=$( (pgrep -f BT-Panel >/dev/null 2>&1 && echo running) || echo stopped )"',
          'echo "VERSION=$(cat /www/server/panel/class/common.py 2>/dev/null | grep -m1 "version" | head -1)"',
          'echo "---BT_DEFAULT---"',
          'bt default 2>&1 | head -20',
        );
      } else if (action === 'restart') {
        cmds.push('bt restart 2>&1', 'echo "---STATUS---"', 'systemctl is-active bt 2>/dev/null || /etc/init.d/bt status 2>/dev/null | head -3');
      } else if (action === 'resetpwd') {
        const pwd = String(newPassword || '').trim();
        if (!pwd) { ack && ack({ ok: false, output: '请输入新密码' }); try { conn.end(); } catch (_) {} return; }
        if (pwd.length < 8) { ack && ack({ ok: false, output: '密码至少 8 位' }); try { conn.end(); } catch (_) {} return; }
        cmds.push(
          'python_bin=/www/server/panel/pyenv/bin/python',
          'test -x $python_bin || python_bin=/usr/bin/btpython',
          '$python_bin /www/server/panel/tools.py panel ' + shQuote(pwd) + ' 2>&1 | tail -5',
          'echo "---RESET_DONE---"',
          'echo "PANEL_USER=$($python_bin /www/server/panel/tools.py username 2>/dev/null | tail -1)"',
        );
      } else if (action === 'portinfo') {
        cmds.push(
          'echo "PORT=$(cat /www/server/panel/data/port.pl 2>/dev/null)"',
          'echo "LISTEN=$(ss -lntp 2>/dev/null | grep -E "BT-Panel|btpython" | head -3)"',
          'echo "FIREWALL=$( (ufw status 2>/dev/null || firewall-cmd --list-ports 2>/dev/null) | head -5)"',
        );
      }

      execCapture(conn, cmds.join('; '), (err, raw) => {
        try { conn.end(); } catch (_) {}
        ack && ack({ ok: !err && !/Traceback|error:/i.test(raw), output: err ? (err.message || String(err)) : raw });
      });
    })
      .on('error', (e) => {
        const hk = hostKeyFailure(srv);
        ack && ack(hk ? Object.assign({ ok: false, output: hk.msg }, hk) : { ok: false, output: friendlySSHError(e) });
      })
      .on('close', () => {});

    try { conn.connect(makeConnConfig(srv)); } catch (e) { ack && ack({ ok: false, output: friendlySSHError(e) }); }
  });

  /** 域名解析检查 */
  socket.on('domain:check', (data, ack) => {
    const { domain, expectedIp } = data || {};
    if (!domain) { ack && ack({ ok: false, msg: '请填写域名' }); return; }
    const servers = ['1.1.1.1', '8.8.8.8'];
    Promise.allSettled(servers.map((s) => dns.resolve4(domain.replace(/^https?:\/\//, '').replace(/\/.*$/, ''), { server: s })))
      .then((results) => {
        const ips = [...new Set(results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value))];
        if (!ips.length) { ack && ack({ ok: false, msg: '域名解析失败：未查询到 A 记录，请先在 DNS 服务商添加指向服务器 IP 的记录' }); return; }
        const hit = expectedIp ? ips.includes(expectedIp) : false;
        ack && ack({
          ok: true,
          ips,
          matched: hit,
          msg: hit
            ? '域名已解析到本服务器（' + ips.join(', ') + '）'
            : '域名解析到 ' + ips.join(', ') + '，与服务器 IP 不一致；若使用 Cloudflare 代理属正常，否则请检查 DNS',
        });
      })
      .catch((e) => ack && ack({ ok: false, msg: '解析异常：' + e.message }));
  });

  /** 面板 HTTPS 状态 */
  socket.on('ssl:status', (data, ack) => {
    const { server: srv } = data || {};
    if (!srv || !srv.host) { ack && ack({ ok: false, output: '请先填写服务器信息' }); return; }
    const conn = new Client();
    conn.on('ready', () => {
      const script = [
        'PORT=$(cat /www/server/panel/data/port.pl 2>/dev/null)',
        'echo "PORT=${PORT}"',
        'echo "HTTP=$(curl -s -k -o /dev/null -w "%{http_code}" --max-time 6 "http://127.0.0.1:${PORT}/login" 2>/dev/null)"',
        'echo "HTTPS=$(curl -s -k -o /dev/null -w "%{http_code}" --max-time 6 "https://127.0.0.1:${PORT}/login" 2>/dev/null)"',
        'echo "SSL_FILE=$( [ -f /www/server/panel/data/ssl.pl ] && echo yes || echo no )"',
        'echo "DOMAIN=$(cat /www/server/panel/data/domain.conf 2>/dev/null)"',
      ].join('; ');
      execCapture(conn, script, (err, raw) => {
        try { conn.end(); } catch (_) {}
        ack && ack({ ok: !err, output: err ? err.message : raw });
      });
    })
      .on('error', (e) => {
        const hk = hostKeyFailure(srv);
        ack && ack(hk ? Object.assign({ ok: false, output: hk.msg }, hk) : { ok: false, output: friendlySSHError(e) });
      });
    try { conn.connect(makeConnConfig(srv)); } catch (e) { ack && ack({ ok: false, output: friendlySSHError(e) }); }
  });

  /** 生成手动安装命令 */
  socket.on('cmd:generate', (cfg, ack) => {
    try {
      const judge = cfg.system ? judgeSystem(cfg.system) : { supported: true, script: null };
      const effCfg = Object.assign({}, cfg, { scriptPath: judge.script });
      ack && ack({ ok: true, command: buildManualCommand(effCfg), note: '以 root 身份在服务器上执行；命令含明文密码，请勿分享。' });
    } catch (e) {
      ack && ack({ ok: false, msg: e.message });
    }
  });

  /** 直接执行一条命令 */
  socket.on('cmd:run', (data, ack) => {
    const { server: srv, command } = data || {};
    if (!srv || !command || !String(command).trim()) { ack && ack({ ok: false, output: '请填写服务器信息和要执行的命令' }); return; }
    const conn = new Client();
    conn.on('ready', () => {
      execCapture(conn, String(command).trim(), (err, raw) => {
        try { conn.end(); } catch (_) {}
        ack && ack({ ok: !err, output: err ? (err.message || String(err)) : raw });
      });
    })
      .on('error', (e) => {
        const hk = hostKeyFailure(srv);
        ack && ack(hk ? Object.assign({ ok: false, output: hk.msg }, hk) : { ok: false, output: friendlySSHError(e) });
      });
    try { conn.connect(makeConnConfig(srv)); } catch (e) { ack && ack({ ok: false, output: friendlySSHError(e) }); }
  });

  /** 用户确认后信任本次连接看到的主机指纹 */
  socket.on('hostkey:trust', (data, ack) => {
    const host = String((data && data.host) || '').trim();
    const port = Number(data && data.port) || 22;
    const fp = String((data && data.fingerprint) || '').trim();
    const hash = hashFromFingerprint(fp);
    if (!host || !hash) { ack && ack({ ok: false, msg: '缺少主机或指纹信息' }); return; }
    const id = host.toLowerCase() + ':' + port;
    const pending = pendingHostKeys.get(id);
    if (!pending || !pending.hash || pending.hash !== hash) {
      ack && ack({ ok: false, msg: '没有待确认的指纹，或指纹与本次连接不一致，请重新测试连接' });
      return;
    }
    knownHosts[id] = { hash, addedAt: new Date().toISOString() };
    try { saveKnownHosts(); } catch (e) { ack && ack({ ok: false, msg: '指纹保存失败：' + e.message }); return; }
    pendingHostKeys.delete(id);
    ack && ack({ ok: true, msg: '已信任该主机指纹' });
  });

  /** 版本/线路元数据 */
  socket.on('meta:get', (_, ack) => {
    ack && ack({
      ok: true,
      versions: Object.keys(BT_VERSIONS).map((k) => ({ key: k, label: BT_VERSIONS[k].label, note: BT_VERSIONS[k].note })),
      mirrors: Object.keys(BT_MIRRORS).map((k) => ({ key: k, label: BT_MIRRORS[k].label })),
    });
  });

  /** 生成随机凭据 */
  socket.on('creds:random', (_, ack) => {
    ack && ack({ ok: true, username: 'admin', password: randomToken(12), safePath: randomToken(8), port: String(10000 + Math.floor(Math.random() * 50000)) });
  });
});

/* ------------------------------------------------------------------ */
/*  兜底与启动                                                          */
/* ------------------------------------------------------------------ */

process.on('uncaughtException', (e) => console.error('[guard] 未捕获异常：', (e && e.stack) || e));
process.on('unhandledRejection', (r) => console.error('[guard] 未处理的 Promise 拒绝：', (r && r.stack) || r));

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('[启动失败] 端口 ' + PORT + ' 已被占用，请关闭占用该端口的程序后重新启动。');
  } else {
    console.error('[启动失败] ' + ((e && e.message) || e));
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('  宝塔面板一键安装器 · 桌面版');
  console.log('  本地地址 →  http://' + HOST + ':' + PORT);
});