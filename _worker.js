const CONTENT_TYPE_MAP = {
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'bmp': 'image/bmp',
  'svg': 'image/svg+xml',
  'mp4': 'video/mp4',
  'avi': 'video/x-msvideo',
  'mov': 'video/quicktime',
  'webm': 'video/webm',
  'pdf': 'application/pdf'
};

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/x-msvideo': 'avi',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf'
};

const CACHE_CONFIG = {
  HTML: 3600,
  IMAGE: 86400,
  API: 300
};

const SESSION_COOKIE = 'telegraph_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const databaseSchemaPromises = new WeakMap();

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function normalizeAdminPath(value) {
  const path = String(value || 'admin').trim().replace(/^\/+|\/+$/g, '');
  return path || 'admin';
}

function parseMaxSize(value) {
  const sizeInMb = Number.parseInt(value, 10);
  return (Number.isFinite(sizeInMb) && sizeInMb > 0 ? sizeInMb : 20) * 1024 * 1024;
}

function isDatabaseBinding(value) {
  return Boolean(value && typeof value.prepare === 'function');
}

function resolveDatabaseBinding(env) {
  if (isDatabaseBinding(env.DATABASE)) {
    return { database: env.DATABASE, bindingName: 'DATABASE' };
  }

  const bindingName = typeof env.DATABASE === 'string' ? env.DATABASE.trim() : '';
  const database = bindingName ? env[bindingName] : undefined;
  return {
    database: isDatabaseBinding(database) ? database : undefined,
    bindingName: bindingName || 'DATABASE'
  };
}

function extractConfig(env) {
  const databaseBinding = resolveDatabaseBinding(env);
  return {
    domain: env.DOMAIN,
    database: databaseBinding.database,
    databaseBindingName: databaseBinding.bindingName,
    username: env.USERNAME,
    password: env.PASSWORD,
    sessionSecret: env.SESSION_SECRET || env.PASSWORD,
    adminPath: normalizeAdminPath(env.ADMIN_PATH),
    enableAuth: env.ENABLE_AUTH === 'true',
    tgBotToken: env.TG_BOT_TOKEN,
    tgChatId: env.TG_CHAT_ID,
    maxSize: parseMaxSize(env.MAX_SIZE_MB)
  };
}

function getDatabase(config) {
  if (!isDatabaseBinding(config.database)) {
    if (config.databaseBindingName !== 'DATABASE') {
      throw new ConfigurationError(
          `DATABASE 指向的变量 ${config.databaseBindingName} 不存在或不是 D1 数据库绑定`
      );
    }
    throw new ConfigurationError('缺少名为 DATABASE 的 D1 数据库绑定');
  }
  return config.database;
}

function validateAdminCredentials(config) {
  if (!config.username || !config.password) {
    throw new ConfigurationError('缺少 USERNAME 或 PASSWORD 环境变量');
  }
}

async function ensureDatabaseSchema(database) {
  let schemaPromise = databaseSchemaPromises.get(database);
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await database.prepare(`
          CREATE TABLE IF NOT EXISTS media (
            url TEXT PRIMARY KEY,
            fileId TEXT NOT NULL,
            messageId INTEGER,
            createdAt INTEGER,
            originalName TEXT
          )
        `).run();
      const columns = await database.prepare(
          `PRAGMA table_info(media)`
      ).all();
      const columnNames = new Set((columns.results || []).map(c => c.name));
      if (!columnNames.has('messageId')) {
        await database.prepare(`ALTER TABLE media ADD COLUMN messageId INTEGER`).run();
      }
      if (!columnNames.has('createdAt')) {
        await database.prepare(`ALTER TABLE media ADD COLUMN createdAt INTEGER`).run();
      }
      if (!columnNames.has('originalName')) {
        await database.prepare(`ALTER TABLE media ADD COLUMN originalName TEXT`).run();
      }
    })();
    databaseSchemaPromises.set(database, schemaPromise);
    schemaPromise.catch(() => databaseSchemaPromises.delete(database));
  }
  await schemaPromise;
}

function createCachedResponse(body, contentType, cacheMaxAge) {
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': `public, max-age=${cacheMaxAge}`,
      'CDN-Cache-Control': `public, max-age=${cacheMaxAge}`
    }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function unauthorizedResponse() {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Admin"' }
  });
}

function internalErrorResponse(error, pathname) {
  const isConfigurationError = error instanceof ConfigurationError;
  const status = isConfigurationError ? 503 : 500;
  const message = isConfigurationError
      ? error.message
      : '服务暂时不可用，请检查 Worker 配置或日志';

  console.error('请求处理失败:', {
    pathname,
    name: error?.name,
    message: error?.message,
    stack: error?.stack
  });

  if (pathname === '/upload' || pathname === '/delete-images' || pathname === '/bing-images' || pathname === '/transfer' || pathname.startsWith('/v1/api/')) {
    return jsonResponse({ error: message }, status);
  }

  return new Response(`<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>服务提示 · Telegraph Hub</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    <script>
      if (localStorage.getItem('telegraphTheme') === 'light' || (!('telegraphTheme' in localStorage) && window.matchMedia('(prefers-color-scheme: light)').matches)) {
        document.documentElement.classList.remove('dark');
      } else {
        document.documentElement.classList.add('dark');
      }
    </script>
  </head>
  <body class="bg-slate-50 dark:bg-[#0b0f17] text-slate-800 dark:text-slate-100 min-h-screen flex items-center justify-center p-4 selection:bg-indigo-500 selection:text-white transition-colors duration-300">
    <div class="max-w-md w-full bg-white dark:bg-slate-900/90 backdrop-blur-2xl border border-slate-200 dark:border-white/10 rounded-2xl p-8 text-center shadow-2xl">
      <div class="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-500 dark:text-rose-400 flex items-center justify-center mx-auto mb-5 text-2xl">
        <i class="fa-solid fa-triangle-exclamation"></i>
      </div>
      <h1 class="text-xl font-bold mb-2">服务提示</h1>
      <p class="text-slate-500 dark:text-slate-400 text-sm leading-relaxed mb-6">${escapeHtml(message)}</p>
      <div class="flex gap-3 justify-center">
        <a href="/" class="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm transition">返回首页</a>
        <button onclick="location.reload()" class="px-5 py-2.5 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-300 font-semibold text-sm transition">刷新重试</button>
      </div>
    </div>
  </body>
  </html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function generateRandomId(length = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let result = '';
  for (let i = 0; i < length; i++) result += chars[bytes[i] % chars.length];
  return result;
}

function formatDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function generatePathRandomPart() {
  const length = 8 + Math.floor(Math.random() * 25);
  return generateRandomId(length);
}

function ensureFileExtension(fileName, fileExtension) {
  if (!fileExtension || getFileExtension(fileName) === fileExtension) return fileName;
  const baseName = String(fileName || '').replace(/\.[^/.]+$/, '');
  return baseName ? `${baseName}.${fileExtension}` : `file.${fileExtension}`;
}

function getFileExtension(url) {
  const clean = String(url || '').split('?')[0].split('#')[0];
  return clean.includes('.') ? clean.split('.').pop().toLowerCase() : '';
}

function getContentType(extension) {
  return CONTENT_TYPE_MAP[extension] || 'application/octet-stream';
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400'
        }
      });
    }
    const { pathname } = new URL(request.url);
    try {
      const config = extractConfig(env);
      const adminPath = `/${config.adminPath}`;
      if (pathname === '/login') {
        return await handleLoginRequest(request, config);
      }
      if (pathname === '/logout') {
        return handleLogoutRequest(request);
      }
      if (pathname === adminPath || pathname === `${adminPath}/`) {
        return await handleAdminRequest(request, config);
      }
      if (pathname.startsWith('/v1/api/')) {
        return await handleApiRequest(request, config, pathname);
      }
      switch (pathname) {
        case '/':
          return await handleRootRequest(request, config);
        case '/docs':
          return renderApiDocsPage(config);
        case '/upload':
          return request.method === 'POST'
              ? await handleUploadRequest(request, config)
              : new Response('Method Not Allowed', { status: 405 });
        case '/bing-images':
          return handleBingImagesRequest();
        case '/delete-images':
          return await handleDeleteImagesRequest(request, config);
        case '/transfer':
          return await handleTransferRequest(request, config);
        default:
          return await handleImageRequest(request, config);
      }
    } catch (error) {
      return internalErrorResponse(error, pathname);
    }
  }
};

function authenticate(request, username, password) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;
  try {
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = atob(base64Credentials);
    const separator = credentials.indexOf(':');
    return separator !== -1
        && credentials.slice(0, separator) === username
        && credentials.slice(separator + 1) === password;
  } catch {
    return false;
  }
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  for (const cookie of cookieHeader.split(';')) {
    const separator = cookie.indexOf('=');
    if (separator !== -1 && cookie.slice(0, separator).trim() === name) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return null;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function getSessionKey(config) {
  validateAdminCredentials(config);
  return crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(config.sessionSecret || config.password),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
  );
}

async function createSessionToken(config) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${config.username}:${expiresAt}`;
  const key = await getSessionKey(config);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${expiresAt}.${bytesToBase64Url(signature)}`;
}

async function hasValidSession(request, config) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return false;
  const [expiresValue, signatureValue, ...extraParts] = token.split('.');
  const expiresAt = Number(expiresValue);
  if (extraParts.length || !signatureValue || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() / 1000) {
    return false;
  }
  try {
    const key = await getSessionKey(config);
    return await crypto.subtle.verify(
        'HMAC',
        key,
        base64UrlToBytes(signatureValue),
        new TextEncoder().encode(`${config.username}:${expiresAt}`)
    );
  } catch {
    return false;
  }
}

async function isAuthenticated(request, config) {
  return authenticate(request, config.username, config.password)
      || await hasValidSession(request, config);
}

function safeNextPath(value, fallback = '/') {
  if (!value) return fallback;
  try {
    const base = 'https://telegraph.invalid';
    const parsed = new URL(value, base);
    return parsed.origin === base ? `${parsed.pathname}${parsed.search}${parsed.hash}` : fallback;
  } catch {
    return fallback;
  }
}

function redirectResponse(location, status = 303, headers = {}) {
  return new Response(null, { status, headers: { Location: location, ...headers } });
}

async function handleLoginRequest(request, config) {
  validateAdminCredentials(config);
  const url = new URL(request.url);
  const fallback = `/${config.adminPath}`;
  const nextPath = safeNextPath(url.searchParams.get('next'), fallback);

  if (request.method === 'GET') {
    if (await hasValidSession(request, config)) return redirectResponse(nextPath, 302);
    return renderLoginPage(config, nextPath);
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  }

  const formData = await request.formData();
  const username = String(formData.get('username') || '');
  const password = String(formData.get('password') || '');
  const submittedNext = safeNextPath(String(formData.get('next') || ''), nextPath);
  if (username !== config.username || password !== config.password) {
    return renderLoginPage(config, submittedNext, '用户名或密码不正确', 401, username);
  }

  const token = await createSessionToken(config);
  return redirectResponse(submittedNext, 303, {
    'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
    'Cache-Control': 'no-store'
  });
}

function handleLogoutRequest(request) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  return redirectResponse('/login', 303, {
    'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    'Cache-Control': 'no-store'
  });
}

function renderLoginPage(config, nextPath, error = '', status = 200, username = '') {
  const errorHtml = error
      ? `<div class="mb-5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-500 dark:text-rose-400 text-sm flex items-center gap-2.5 animate-bounce">
          <i class="fa-solid fa-circle-exclamation text-base flex-shrink-0"></i>
          <span>${escapeHtml(error)}</span>
        </div>`
      : '';

  return new Response(`<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>管理员登录 · Telegraph Hub</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    <script>
      tailwind.config = { darkMode: 'class' };
      if (localStorage.getItem('telegraphTheme') === 'light' || (!('telegraphTheme' in localStorage) && window.matchMedia('(prefers-color-scheme: light)').matches)) {
        document.documentElement.classList.remove('dark');
      } else {
        document.documentElement.classList.add('dark');
      }
    </script>
    <style>
      body { font-family: 'Plus Jakarta Sans', sans-serif; }
      .bg-grid { background-size: 36px 36px; background-image: linear-gradient(to right, rgba(148, 163, 184, 0.07) 1px, transparent 1px), linear-gradient(to bottom, rgba(148, 163, 184, 0.07) 1px, transparent 1px); }
      .dark .bg-grid { background-image: linear-gradient(to right, rgba(255, 255, 255, 0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255, 255, 255, 0.03) 1px, transparent 1px); }
    </style>
  </head>
  <body class="bg-slate-50 dark:bg-[#0b0f17] text-slate-800 dark:text-slate-100 min-h-screen flex items-center justify-center p-4 relative overflow-hidden selection:bg-indigo-500 selection:text-white transition-colors duration-300">
    <!-- 背景氛围光与网络网格 -->
    <div class="fixed inset-0 pointer-events-none z-0">
      <div class="absolute -top-32 -left-32 w-96 h-96 bg-indigo-500/10 dark:bg-indigo-600/20 rounded-full blur-[120px]"></div>
      <div class="absolute -bottom-32 -right-32 w-96 h-96 bg-cyan-500/10 dark:bg-cyan-500/15 rounded-full blur-[120px]"></div>
      <div class="absolute inset-0 bg-grid"></div>
    </div>
  
    <main class="relative z-10 w-full max-w-md bg-white/80 dark:bg-slate-900/80 backdrop-blur-2xl border border-slate-200/80 dark:border-white/10 rounded-3xl p-8 sm:p-10 shadow-2xl shadow-indigo-500/5 dark:shadow-black/80 transition-all duration-300">
      <div class="flex items-center justify-between mb-8 pb-6 border-b border-slate-200/80 dark:border-white/5">
        <div class="flex items-center gap-3">
          <div class="w-11 h-11 rounded-2xl bg-gradient-to-tr from-indigo-500 via-indigo-600 to-cyan-400 flex items-center justify-center text-white text-lg shadow-lg shadow-indigo-500/25">
            <i class="fa-solid fa-cloud-arrow-up"></i>
          </div>
          <div>
            <h1 class="text-lg font-extrabold tracking-tight text-slate-900 dark:text-white">Telegraph Hub</h1>
            <p class="text-xs text-slate-500 dark:text-slate-400">Next-Gen Media Engine</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" id="theme-btn" class="w-8 h-8 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 flex items-center justify-center transition" title="日夜间切换">
            <i class="fa-solid fa-circle-half-stroke text-xs"></i>
          </button>
          <a href="/" class="text-xs text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white transition flex items-center gap-1">
            <span>首页</span>
            <i class="fa-solid fa-angle-right text-[10px]"></i>
          </a>
        </div>
      </div>
  
      ${errorHtml}
  
      <form method="post" action="/login" autocomplete="on" class="space-y-4">
        <input type="hidden" name="next" value="${escapeHtml(nextPath)}">
        <div>
          <label for="username" class="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5 uppercase tracking-wider">账号</label>
          <div class="relative flex items-center">
            <i class="fa-solid fa-user absolute left-4 text-slate-400 dark:text-slate-500 text-sm pointer-events-none"></i>
            <input id="username" name="username" value="${escapeHtml(username)}" autocomplete="username" placeholder="请输入管理员用户名" required autofocus
              class="w-full h-11 pl-11 pr-4 bg-slate-100/80 dark:bg-slate-950/60 border border-slate-200 dark:border-white/10 rounded-xl text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition duration-200">
          </div>
        </div>
  
        <div>
          <label for="password" class="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5 uppercase tracking-wider">密码</label>
          <div class="relative flex items-center">
            <i class="fa-solid fa-lock absolute left-4 text-slate-400 dark:text-slate-500 text-sm pointer-events-none"></i>
            <input id="password" name="password" type="password" autocomplete="current-password" placeholder="请输入管理密码" required
              class="w-full h-11 pl-11 pr-11 bg-slate-100/80 dark:bg-slate-950/60 border border-slate-200 dark:border-white/10 rounded-xl text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition duration-200">
            <button type="button" id="toggle-pwd" class="absolute right-2.5 w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 transition">
              <i class="fa-solid fa-eye text-xs" id="eye-icon"></i>
            </button>
          </div>
        </div>
  
        <button type="submit" id="submit-btn"
          class="w-full h-11 mt-2 rounded-xl bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 text-white font-bold text-sm shadow-lg shadow-indigo-500/25 active:scale-[0.99] transition duration-200 flex items-center justify-center gap-2">
          <span>登 录</span>
          <i class="fa-solid fa-arrow-right text-xs"></i>
        </button>
      </form>
  
      <div class="mt-8 pt-5 border-t border-slate-200/80 dark:border-white/5 text-center flex items-center justify-center gap-2 text-xs text-slate-500">
        <i class="fa-solid fa-shield-halved text-indigo-500 dark:text-indigo-400"></i>
        <span>7 天 HMAC-SHA256 安全会话凭据</span>
      </div>
    </main>
  
    <script>
      (function() {
        const toggle = document.getElementById('toggle-pwd');
        const pwd = document.getElementById('password');
        const eye = document.getElementById('eye-icon');
        toggle.addEventListener('click', () => {
          const isText = pwd.type === 'text';
          pwd.type = isText ? 'password' : 'text';
          eye.className = isText ? 'fa-solid fa-eye text-xs' : 'fa-solid fa-eye-slash text-xs';
        });
  
        const themeBtn = document.getElementById('theme-btn');
        themeBtn.addEventListener('click', () => {
          const isDark = document.documentElement.classList.toggle('dark');
          localStorage.setItem('telegraphTheme', isDark ? 'dark' : 'light');
        });
      })();
    </script>
  </body>
  </html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin'
    }
  });
}

async function handleRootRequest(request, config) {
  if (config.enableAuth) {
    validateAdminCredentials(config);
    if (!await isAuthenticated(request, config)) {
      const url = new URL(request.url);
      return redirectResponse(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    }
  }
  const showLogout = config.enableAuth
      || Boolean(config.username && config.password && await hasValidSession(request, config));

  const adminUrl = `/${config.adminPath}`;
  const maxSizeMb = config.maxSize / (1024 * 1024);

  return new Response(`<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Telegraph Hub · 现代化图床与文件托管分发平台</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.min.css">
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
    <script>if(typeof Swal==='undefined'){document.write('<script src="https://unpkg.com/sweetalert2@11"><\\/script>')}</script>
    <script>
      tailwind.config = { darkMode: 'class' };
      if (localStorage.getItem('telegraphTheme') === 'light' || (!('telegraphTheme' in localStorage) && window.matchMedia('(prefers-color-scheme: light)').matches)) {
        document.documentElement.classList.remove('dark');
      } else {
        document.documentElement.classList.add('dark');
      }
    </script>
    <style>
      body { font-family: 'Plus Jakarta Sans', sans-serif; }
      .font-mono { font-family: 'JetBrains Mono', monospace; }
      .bg-grid { background-size: 32px 32px; background-image: linear-gradient(to right, rgba(148, 163, 184, 0.07) 1px, transparent 1px), linear-gradient(to bottom, rgba(148, 163, 184, 0.07) 1px, transparent 1px); }
      .dark .bg-grid { background-image: linear-gradient(to right, rgba(255, 255, 255, 0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255, 255, 255, 0.03) 1px, transparent 1px); }
      @keyframes pulseGlow { 0%, 100% { opacity: 0.15; transform: scale(1); } 50% { opacity: 0.28; transform: scale(1.05); } }
      .orb-glow { animation: pulseGlow 8s ease-in-out infinite; }
    </style>
  </head>
  <body class="bg-slate-50 dark:bg-[#0b0f17] text-slate-800 dark:text-slate-100 min-h-screen flex flex-col relative overflow-x-hidden selection:bg-indigo-500 selection:text-white transition-colors duration-300">
    <!-- 顶部星云背景 -->
    <div class="fixed inset-0 pointer-events-none z-0">
      <div class="absolute top-0 left-1/3 w-[600px] h-[350px] bg-indigo-500/10 dark:bg-indigo-600/15 rounded-full blur-[140px] orb-glow"></div>
      <div class="absolute top-1/4 right-10 w-[450px] h-[450px] bg-cyan-500/10 dark:bg-cyan-500/10 rounded-full blur-[130px] orb-glow" style="animation-delay:-4s;"></div>
      <div class="absolute inset-0 bg-grid"></div>
    </div>
  
    <!-- 头部全局导航 -->
    <header class="sticky top-0 z-40 h-16 bg-white/80 dark:bg-[#0b0f17]/80 backdrop-blur-xl border-b border-slate-200/80 dark:border-white/10 px-4 sm:px-8 flex items-center justify-between transition-colors duration-300">
      <a href="/" class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-500 via-indigo-600 to-cyan-400 flex items-center justify-center text-white text-base shadow-lg shadow-indigo-500/25">
          <i class="fa-solid fa-cloud-arrow-up"></i>
        </div>
        <div>
          <span class="font-extrabold text-base tracking-tight text-slate-900 dark:text-white">Telegraph Hub</span>
          <span class="hidden sm:inline-block ml-2 px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-[10px] font-semibold text-indigo-500 dark:text-indigo-400">Cloud Storage</span>
        </div>
      </a>
      <div class="flex items-center gap-2">
        <!-- 日夜模式切换按钮 -->
        <button type="button" id="theme-toggle" class="h-9 px-3 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white flex items-center gap-1.5 transition" title="切换日间/夜间模式">
          <i class="fa-solid fa-sun text-amber-500 dark:hidden"></i>
          <i class="fa-solid fa-moon text-indigo-400 hidden dark:inline-block"></i>
          <span class="text-[11px] hidden md:inline">模式</span>
        </button>
        <a href="/docs" class="h-9 px-3.5 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white flex items-center gap-2 transition">
          <i class="fa-solid fa-book text-indigo-500 dark:text-indigo-400"></i>
          <span>文档</span>
        </a>
        <a href="${escapeHtml(adminUrl)}" class="h-9 px-3.5 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white flex items-center gap-2 transition">
          <i class="fa-solid fa-layer-group text-indigo-500 dark:text-indigo-400"></i>
          <span>媒体库</span>
        </a>
        ${showLogout ? `
        <form method="post" action="/logout" class="m-0">
          <button type="submit" class="h-9 w-9 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-rose-500/15 border border-slate-200 dark:border-white/10 hover:border-rose-500/30 text-slate-500 hover:text-rose-500 dark:hover:text-rose-400 flex items-center justify-center transition" title="退出">
            <i class="fa-solid fa-arrow-right-from-bracket text-xs"></i>
          </button>
        </form>` : ''}
      </div>
    </header>
  
    <!-- 主体工作区 -->
    <main class="relative z-10 flex-1 max-w-5xl w-full mx-auto px-4 py-8 sm:py-12 space-y-8">
      <!-- Hero 介绍区 -->
      <div class="text-center max-w-2xl mx-auto space-y-3">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 text-xs text-slate-600 dark:text-slate-300 shadow-sm">
          <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <span>全球边缘 CDN 高速加速</span>
          <span class="text-slate-300 dark:text-slate-600">|</span>
          <span>单文件上限 ${maxSizeMb} MB</span>
        </div>
        <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight">永久免费、极速、无广告图床中转</h1>
        <p class="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">支持各类主流图片与视频托管，开箱即用，粘贴即传，提供多格式直链生成与一键批量导出功能。</p>
      </div>
  
      <!-- 上传投递核心卡片 -->
      <section class="bg-white/90 dark:bg-slate-900/80 backdrop-blur-2xl border border-slate-200/80 dark:border-white/10 rounded-3xl p-6 sm:p-8 shadow-2xl shadow-indigo-500/5 dark:shadow-black/60 space-y-6 transition-all duration-300">
        <div id="drop-zone" tabindex="0" role="button"
          class="min-h-[220px] rounded-2xl border-2 border-dashed border-slate-300 dark:border-white/15 hover:border-indigo-500 dark:hover:border-indigo-400 bg-slate-50/60 dark:bg-slate-950/40 hover:bg-indigo-500/5 transition duration-300 flex flex-col items-center justify-center p-8 text-center cursor-pointer group outline-none">
          <div class="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-600 dark:text-indigo-400 group-hover:scale-110 flex items-center justify-center text-2xl mb-4 transition duration-300 shadow-lg shadow-indigo-500/10">
            <i class="fa-solid fa-cloud-arrow-up"></i>
          </div>
          <div class="text-base font-bold text-slate-800 dark:text-white mb-1.5">拖拽文件到此处，或点击浏览本地文件</div>
          <div class="text-xs text-slate-500 dark:text-slate-400 flex flex-wrap items-center justify-center gap-3">
            <span><i class="fa-regular fa-image text-indigo-500 dark:text-indigo-400 mr-1"></i>JPG, PNG, GIF, WEBP, SVG</span>
            <span><i class="fa-solid fa-video text-indigo-500 dark:text-indigo-400 mr-1"></i>MP4, MOV, WEBM</span>
            <span><i class="fa-regular fa-file-pdf text-rose-500 dark:text-rose-400 mr-1"></i>PDF 文档</span>
            <span><i class="fa-regular fa-clipboard text-indigo-500 dark:text-indigo-400 mr-1"></i>支持直接 Ctrl+V 粘贴截图</span>
          </div>
          <input type="file" id="file-input" multiple class="hidden">
        </div>
  
        <!-- 控制工具栏：轻度压缩、队列计数与一键上传按钮 -->
        <div class="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2 border-t border-slate-200/80 dark:border-white/5 text-xs">
          <div class="flex items-center gap-4">
            <label class="flex items-center gap-2 cursor-pointer select-none text-slate-600 dark:text-slate-300">
              <input type="checkbox" id="compress-toggle" checked class="w-4 h-4 rounded accent-indigo-500 bg-slate-200 dark:bg-slate-800 border-slate-300 dark:border-white/10">
              <span>图片轻度压缩加速</span>
            </label>
            <span class="text-slate-300 dark:text-slate-600">|</span>
            <label class="flex items-center gap-2 cursor-pointer select-none text-slate-600 dark:text-slate-300">
              <input type="checkbox" id="auto-upload-toggle" checked class="w-4 h-4 rounded accent-indigo-500 bg-slate-200 dark:bg-slate-800 border-slate-300 dark:border-white/10">
              <span>选择后自动上传</span>
            </label>
            <span class="text-slate-300 dark:text-slate-600">|</span>
            <span class="text-slate-500 dark:text-slate-400">队列待办: <strong id="queue-counter" class="text-indigo-600 dark:text-indigo-400 font-bold">0</strong> 项</span>
          </div>
          <div class="flex items-center gap-2 w-full sm:w-auto">
            <button type="button" id="btn-clear-queue" class="px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-rose-500/15 hover:text-rose-500 dark:hover:text-rose-400 border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400 text-xs font-semibold transition">清空队列</button>
            <button type="button" id="btn-upload-all" disabled style="display:none"
              class="flex-1 sm:flex-initial px-6 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold shadow-lg shadow-indigo-500/25 transition flex items-center justify-center gap-2">
              <i class="fa-solid fa-arrow-up-from-bracket"></i>
              <span>立即开始上传</span>
            </button>
          </div>
        </div>
  
        <!-- 待上传队列卡片 (缩略图、进度条、平滑动画) -->
        <div id="queue-box" class="space-y-2.5 hidden">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">待上传列表</h3>
          <div id="queue-list" class="space-y-2 max-h-72 overflow-y-auto pr-1"></div>
        </div>
      </section>

      <!-- URL 远程转存工具卡片 -->
      <section class="bg-gradient-to-br from-white/90 to-cyan-50/60 dark:from-slate-900/80 dark:to-slate-900/40 backdrop-blur-2xl border border-slate-200/80 dark:border-cyan-500/10 rounded-3xl p-6 sm:p-7 shadow-2xl shadow-indigo-500/5 dark:shadow-black/60 transition-all duration-300">
        <div class="flex flex-col sm:flex-row sm:items-center gap-3 mb-5 pb-5 border-b border-slate-200/60 dark:border-white/5">
          <div class="w-11 h-11 rounded-2xl bg-gradient-to-tr from-cyan-500 to-indigo-500 text-white flex items-center justify-center text-lg shadow-lg shadow-cyan-500/25 flex-shrink-0">
            <i class="fa-solid fa-arrow-right-to-bracket"></i>
          </div>
          <div class="flex-1 min-w-0">
            <h2 class="text-sm font-bold text-slate-800 dark:text-white flex items-center gap-2">
              URL 远程转存
              <span class="px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-[10px] font-semibold text-cyan-600 dark:text-cyan-400">新增功能</span>
            </h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">粘贴远程地址，自动识别格式并搬运至全球 CDN，支持 JPG/PNG/GIF/WEBP/SVG、MP4/MOV/WEBM 与 PDF</p>
          </div>
        </div>
        <div class="flex flex-col sm:flex-row gap-2.5">
          <div class="relative flex-1">
            <i class="fa-solid fa-globe absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 text-sm pointer-events-none"></i>
            <input type="url" id="transfer-url" placeholder="https://example.com/image.jpg 或 https://example.com/video.mp4" spellcheck="false" autocomplete="off"
              class="w-full h-11 pl-11 pr-4 bg-slate-100/80 dark:bg-slate-950/60 border border-slate-200 dark:border-white/10 rounded-xl text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 transition duration-200">
          </div>
          <button type="button" id="btn-transfer" class="h-11 px-6 rounded-xl bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-600 hover:to-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold shadow-lg shadow-cyan-500/20 active:scale-[0.98] transition flex items-center justify-center gap-2">
            <i class="fa-solid fa-wand-magic-sparkles"></i>
            <span>开始转存</span>
          </button>
        </div>
        <div id="transfer-tip" class="hidden mt-3.5 flex items-center gap-2.5 text-xs p-3 rounded-xl bg-cyan-500/5 border border-cyan-500/20 text-slate-600 dark:text-slate-300">
          <i class="fa-solid fa-circle-notch fa-spin text-cyan-500"></i>
          <span>正在读取远程资源并转存，请稍候...</span>
        </div>
      </section>
  
      <!-- 上传成功与分发链接生成区 -->
      <section id="result-section" class="bg-white/90 dark:bg-slate-900/80 backdrop-blur-2xl border border-slate-200/80 dark:border-white/10 rounded-3xl p-6 sm:p-8 shadow-2xl shadow-indigo-500/5 dark:shadow-black/60 space-y-6 hidden transition-all duration-300">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200/80 dark:border-white/5">
          <div>
            <h2 class="text-base font-bold text-slate-800 dark:text-white flex items-center gap-2">
              <i class="fa-solid fa-circle-check text-emerald-500"></i>
              <span>上传完成 (<span id="results-count">0</span> 个文件)</span>
            </h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">文件已入库并部署至全球 CDN 缓存中，复制下方链接即可使用</p>
          </div>
          <!-- 格式选择卡片 -->
          <div class="flex items-center gap-2">
            <div class="flex p-1 bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-white/10 rounded-xl gap-1 text-xs">
              <button type="button" class="tab-fmt px-3 py-1.5 rounded-lg font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition active bg-indigo-600 text-white" data-fmt="url">直链</button>
              <button type="button" class="tab-fmt px-3 py-1.5 rounded-lg font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition" data-fmt="markdown">Markdown</button>
              <button type="button" class="tab-fmt px-3 py-1.5 rounded-lg font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition" data-fmt="html">HTML</button>
              <button type="button" class="tab-fmt px-3 py-1.5 rounded-lg font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition" data-fmt="bbcode">BBCode</button>
            </div>
            <button type="button" id="btn-copy-bulk" class="h-9 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-500/20 transition flex items-center gap-1.5">
              <i class="fa-regular fa-copy"></i>
              <span>一键复制全部</span>
            </button>
          </div>
        </div>
  
        <!-- 批量直链文本框 -->
        <div>
          <textarea id="bulk-links-area" readonly rows="4" class="w-full bg-slate-100/70 dark:bg-slate-950/60 border border-slate-200 dark:border-white/10 rounded-2xl p-4 text-xs font-mono text-slate-700 dark:text-slate-300 outline-none focus:border-indigo-500 transition resize-none"></textarea>
        </div>
  
      <!-- 单文件卡片瀑布网格 -->
      <div id="results-gallery" class="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2"></div>
      </section>
  
      <!-- 最近历史记录面板 -->
      <section class="bg-white/60 dark:bg-slate-900/50 backdrop-blur-xl border border-slate-200/80 dark:border-white/5 rounded-3xl p-6 transition-colors duration-300">
        <div class="flex items-center justify-between text-xs cursor-pointer select-none" id="history-toggle">
          <div class="flex items-center gap-2 font-bold text-slate-700 dark:text-slate-300">
            <i class="fa-solid fa-chevron-right text-[10px] text-slate-400 transition-transform duration-200" id="history-arrow"></i>
            <i class="fa-solid fa-clock-rotate-left text-slate-400"></i>
            <span>本地最近记录</span>
            <span id="history-count" class="px-2 py-0.5 rounded-full bg-slate-200/60 dark:bg-white/5 text-[11px] font-mono font-normal text-slate-500 dark:text-slate-400">0</span>
          </div>
          <button type="button" id="btn-clear-history" class="text-slate-500 hover:text-rose-500 dark:hover:text-rose-400 transition">清空历史</button>
        </div>
        <div id="history-collapse" class="hidden pt-4 mt-4 border-t border-slate-200/60 dark:border-white/5">
          <div id="history-grid" class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
            <div class="col-span-full py-6 text-center text-xs text-slate-400 dark:text-slate-500">暂无本地历史记录</div>
          </div>
        </div>
      </section>
    </main>
  
    <!-- 底部版权信息 -->
    <footer class="mt-auto border-t border-slate-200/80 dark:border-white/5 py-6 text-center text-xs text-slate-400 dark:text-slate-500 transition-colors duration-300">
      <p>© 2026 Telegraph Hub · High Performance Edge Storage Engine</p>
    </footer>
  
    <script>
      (function() {
        const MAX_SIZE = ${config.maxSize};
        const state = { files: [], results: [], uploading: false, currentFmt: 'url' };
  
        const dropZone = document.getElementById('drop-zone');
        const fileInput = document.getElementById('file-input');
        const queueBox = document.getElementById('queue-box');
        const queueList = document.getElementById('queue-list');
        const queueCounter = document.getElementById('queue-counter');
        const btnUploadAll = document.getElementById('btn-upload-all');
        const btnClearQueue = document.getElementById('btn-clear-queue');
        const compressToggle = document.getElementById('compress-toggle');
        const autoUploadToggle = document.getElementById('auto-upload-toggle');

        function syncAutoUploadUI() {
          btnUploadAll.style.display = autoUploadToggle.checked ? 'none' : 'flex';
        }
        autoUploadToggle.addEventListener('change', syncAutoUploadUI);
        syncAutoUploadUI();
  
        const resultSection = document.getElementById('result-section');
        const resultsCount = document.getElementById('results-count');
        const bulkLinksArea = document.getElementById('bulk-links-area');
        const resultsGallery = document.getElementById('results-gallery');
        const btnCopyBulk = document.getElementById('btn-copy-bulk');
        const tabFmts = Array.from(document.querySelectorAll('.tab-fmt'));
  
        const historyToggle = document.getElementById('history-toggle');
        const historyCollapse = document.getElementById('history-collapse');
        const historyArrow = document.getElementById('history-arrow');
        const historyCount = document.getElementById('history-count');
        const historyGrid = document.getElementById('history-grid');
        const btnClearHistory = document.getElementById('btn-clear-history');
        const themeToggle = document.getElementById('theme-toggle');

        historyToggle?.addEventListener('click', e => {
          if (e.target.closest('#btn-clear-history')) return;
          const isCollapsed = historyCollapse.classList.toggle('hidden');
          historyArrow.classList.toggle('rotate-90', !isCollapsed);
        });
  
        // 主题模式切换处理
        themeToggle.addEventListener('click', () => {
          const isDark = document.documentElement.classList.toggle('dark');
          localStorage.setItem('telegraphTheme', isDark ? 'dark' : 'light');
        });
  
        function formatBytes(b) {
          if (b < 1024) return b + ' B';
          if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
          return (b / 1048576).toFixed(1) + ' MB';
        }
  
        const videoExtensions = new Set(['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm']);
        function isVideo(nameOrUrl) {
          const raw = String(nameOrUrl || '').split('?')[0].split('#')[0];
          const ext = raw.includes('.') ? raw.split('.').pop().toLowerCase() : '';
          return videoExtensions.has(ext);
        }

        function isPdf(nameOrUrl) {
          const raw = String(nameOrUrl || '').split('?')[0].split('#')[0];
          const ext = raw.includes('.') ? raw.split('.').pop().toLowerCase() : '';
          return ext === 'pdf';
        }

        function toast(msg, icon = 'success') {
          const isDark = document.documentElement.classList.contains('dark');
          Swal.fire({
            toast: true,
            position: 'top-end',
            showConfirmButton: false,
            timer: 2200,
            timerProgressBar: true,
            icon,
            title: msg,
            background: isDark ? '#0f172a' : '#ffffff',
            color: isDark ? '#f8fafc' : '#1e293b'
          });
        }

        function viewMedia(url, isVid) {
          const isDark = document.documentElement.classList.contains('dark');
          const videoMode = typeof isVid === 'boolean' ? isVid : isVideo(url);
          const pdfMode = isPdf(url);
          if (videoMode) {
            Swal.fire({
              html: '<video controls autoplay src="' + url + '" class="max-h-[75vh] mx-auto rounded-xl"></video>',
              background: isDark ? '#0f172a' : '#ffffff',
              showConfirmButton: false,
              showCloseButton: true,
              customClass: { popup: 'border border-slate-200 dark:border-white/10 rounded-2xl shadow-2xl' }
            });
          } else if (pdfMode) {
            const previewUrl = url + (url.includes('?') ? '&' : '?') + 'embed=1';
            Swal.fire({
              title: '<div class="flex items-center justify-between px-1 pt-1"><span class="text-sm font-bold text-slate-800 dark:text-white flex items-center gap-2"><i class="fa-solid fa-file-pdf text-rose-500"></i>PDF 在线预览</span><a href="' + url + '" target="_blank" rel="noopener" class="text-xs text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 font-semibold flex items-center gap-1"><i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>新窗口全屏预览</a></div>',
              html: '<iframe src="' + previewUrl + '" class="w-full h-[72vh] rounded-xl border border-slate-200 dark:border-white/10 mt-3" allowfullscreen></iframe>',
              background: isDark ? '#0f172a' : '#ffffff',
              color: isDark ? '#f8fafc' : '#1e293b',
              showConfirmButton: false,
              showCloseButton: true,
              customClass: { popup: 'w-[95vw] max-w-5xl border border-slate-200 dark:border-white/10 rounded-2xl shadow-2xl p-4' }
            });
          } else {
            Swal.fire({
              imageUrl: url,
              imageAlt: '预览大图',
              background: isDark ? '#0f172a' : '#ffffff',
              color: isDark ? '#f8fafc' : '#1e293b',
              showConfirmButton: false,
              showCloseButton: true,
              customClass: { popup: 'border border-slate-200 dark:border-white/10 rounded-2xl shadow-2xl' }
            });
          }
        }
        const viewImage = viewMedia;

        function getRecent() {
          try { return JSON.parse(localStorage.getItem('telegraphRecent') || '[]'); } catch { return []; }
        }
        function saveRecent(items) {
          try { localStorage.setItem('telegraphRecent', JSON.stringify(items.slice(0, 36))); } catch {}
          renderHistory();
        }

        function addFiles(files) {
          Array.from(files).forEach(file => {
            const isDup = state.files.some(f => f.file.name === file.name && f.file.size === file.size && f.file.lastModified === file.lastModified);
            if (isDup) return;
            const isOver = file.size > MAX_SIZE;
            const isVid = file.type.startsWith('video/') || isVideo(file.name);
            const isImg = file.type.startsWith('image/');
            const isPdfFile = file.type === 'application/pdf' || isPdf(file.name);
            state.files.push({
              id: crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random(),
              file,
              status: isOver ? 'error' : 'pending',
              progress: 0,
              msg: isOver ? '超过上限' : '就绪',
              isVideo: isVid,
              isPdf: isPdfFile,
              preview: (isImg || isVid) ? URL.createObjectURL(file) : ''
            });
          });
          renderQueue();
          if (autoUploadToggle.checked && state.files.some(f => f.status === 'pending')) uploadAll();
        }

        function renderQueue() {
          queueCounter.textContent = state.files.length;
          if (!state.files.length) {
            queueBox.classList.add('hidden');
            btnUploadAll.disabled = true;
            return;
          }

          queueBox.classList.remove('hidden');
          queueList.innerHTML = '';
          state.files.forEach(item => {
            const row = document.createElement('div');
            row.className = 'p-3 rounded-xl bg-slate-100/70 dark:bg-slate-950/40 border border-slate-200/80 dark:border-white/5 flex items-center gap-3 transition-all duration-300';
            row.innerHTML = \`
              <div class="queue-thumb w-10 h-10 rounded-lg overflow-hidden bg-slate-200 dark:bg-slate-800 border border-slate-300/60 dark:border-white/10 flex items-center justify-center flex-shrink-0 relative"></div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between text-xs mb-1">
                  <span class="font-medium text-slate-800 dark:text-slate-200 truncate pr-2">\${item.file.name}</span>
                  <span class="text-[11px] \${item.status === 'done' ? 'text-emerald-500 dark:text-emerald-400 font-semibold' : item.status === 'error' ? 'text-rose-500 dark:text-rose-400 font-semibold' : 'text-slate-500 dark:text-slate-400'}">\${item.msg}</span>
                </div>
                <div class="w-full h-1.5 bg-slate-200 dark:bg-white/5 rounded-full overflow-hidden">
                  <div class="h-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-all duration-300" style="width: \${item.progress}%"></div>
                </div>
                <div class="flex items-center justify-between text-[10px] text-slate-400 dark:text-slate-500 mt-1 font-mono">
                  <span>\${formatBytes(item.file.size)}</span>
                  <span>\${item.progress}%</span>
                </div>
              </div>
              <button type="button" class="btn-remove w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-rose-500 dark:hover:text-rose-400 hover:bg-rose-500/10 transition">
                <i class="fa-solid fa-xmark text-xs"></i>
              </button>
            \`;

            const thumbEl = row.querySelector('.queue-thumb');
            if (item.preview) {
              if (item.isVideo) {
                const vid = document.createElement('video');
                vid.src = item.preview;
                vid.muted = true;
                vid.playsInline = true;
                vid.preload = 'metadata';
                vid.className = 'w-full h-full object-cover pointer-events-none';
                thumbEl.appendChild(vid);
              } else {
                const img = document.createElement('img');
                img.src = item.preview;
                img.className = 'w-full h-full object-cover';
                thumbEl.appendChild(img);
              }
            } else if (item.isPdf) {
              thumbEl.innerHTML = '<i class="fa-solid fa-file-pdf text-rose-500 text-lg"></i>';
            } else {
              thumbEl.innerHTML = item.isVideo
                ? '<i class="fa-solid fa-video text-slate-400 dark:text-slate-500 text-sm"></i>'
                : '<i class="fa-solid fa-file text-slate-400 dark:text-slate-500 text-sm"></i>';
            }

            row.querySelector('.btn-remove').addEventListener('click', () => {
              if (item.preview) URL.revokeObjectURL(item.preview);
              state.files = state.files.filter(f => f.id !== item.id);
              renderQueue();
            });
            queueList.appendChild(row);
          });

          btnUploadAll.disabled = state.uploading || !state.files.some(f => f.status === 'pending');
        }

        function formatText(url, name, fmt) {
          const isVid = isVideo(url) || isVideo(name);
          const isPdfFile = isPdf(url) || isPdf(name);
          if (fmt === 'markdown') return (isVid || isPdfFile) ? '[' + name + '](' + url + ')' : '![' + name + '](' + url + ')';
          if (fmt === 'html') {
            if (isVid) return '<video controls src="' + url + '"></video>';
            if (isPdfFile) return '<a href="' + url + '" target="_blank" rel="noopener">' + name + '</a>';
            return '<img src="' + url + '" alt="' + name + '">';
          }
          if (fmt === 'bbcode') return isVid ? '[video]' + url + '[/video]' : (isPdfFile ? '[url=' + url + ']' + name + '[/url]' : '[img]' + url + '[/img]');
          return url;
        }

        function updateResultsView() {
          resultsCount.textContent = state.results.length;
          if (!state.results.length) {
            resultSection.classList.add('hidden');
            return;
          }

          resultSection.classList.remove('hidden');
          const bulkText = state.results.map(r => formatText(r.url, r.name, state.currentFmt)).join('\\n');
          bulkLinksArea.value = bulkText;

          resultsGallery.innerHTML = '';
          state.results.forEach(item => {
            const isVid = isVideo(item.url) || isVideo(item.name);
            const isPdfFile = isPdf(item.url) || isPdf(item.name);
            const card = document.createElement('div');
            card.className = 'w-full min-w-0 p-3 rounded-2xl bg-slate-100/70 dark:bg-slate-950/60 border border-slate-200/80 dark:border-white/5 flex items-center gap-3 group transition-all duration-300';
            const formattedVal = formatText(item.url, item.name, state.currentFmt);
            card.innerHTML = \`
              <div class="thumb-trigger w-12 h-12 rounded-xl overflow-hidden bg-slate-200 dark:bg-slate-800 flex-shrink-0 cursor-pointer border border-slate-300/60 dark:border-white/10 flex items-center justify-center relative"></div>
              <div class="flex-1 min-w-0">
                <div class="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate" title="\${item.name}">\${item.name}</div>
                <div class="mt-1.5 w-full min-w-0">
                  <input type="text" readonly class="input-val block w-full h-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-white/5 rounded-lg px-2.5 text-[11px] font-mono text-slate-600 dark:text-slate-400 outline-none truncate cursor-pointer hover:border-indigo-500 transition" spellcheck="false">
                </div>
              </div>
              <button type="button" class="btn-copy-card w-8 h-8 rounded-xl bg-slate-200/80 dark:bg-white/5 hover:bg-indigo-600 hover:text-white text-slate-500 dark:text-slate-400 text-xs flex items-center justify-center flex-shrink-0 transition" title="复制链接">
                <i class="fa-regular fa-copy"></i>
              </button>
            \`;

            const thumbWrap = card.querySelector('.thumb-trigger');
            if (isVid) {
              const vid = document.createElement('video');
              vid.preload = 'metadata';
              vid.muted = true;
              vid.playsInline = true;
              vid.className = 'w-full h-full object-cover pointer-events-none';
              vid.src = item.url;
              thumbWrap.appendChild(vid);
              const badge = document.createElement('div');
              badge.className = 'absolute inset-0 flex items-center justify-center pointer-events-none';
              badge.innerHTML = '<div class="w-6 h-6 rounded-full bg-slate-900/80 border border-white/20 text-white flex items-center justify-center text-[10px] pl-0.5"><i class="fa-solid fa-play"></i></div>';
              thumbWrap.appendChild(badge);
            } else if (isPdfFile) {
              thumbWrap.innerHTML = '<div class="w-full h-full flex flex-col items-center justify-center bg-rose-500/10 text-rose-500"><i class="fa-solid fa-file-pdf text-xl"></i><span class="text-[9px] font-bold mt-0.5">PDF</span></div>';
            } else {
              const img = document.createElement('img');
              img.src = item.url;
              img.className = 'w-full h-full object-cover';
              img.onerror = () => { thumbWrap.innerHTML = '<i class="fa-regular fa-image text-slate-400"></i>'; };
              thumbWrap.appendChild(img);
            }

            const inputEl = card.querySelector('.input-val');
            inputEl.value = formattedVal;
            inputEl.title = formattedVal;

            thumbWrap?.addEventListener('click', () => viewMedia(item.url, isVid));
            const copyFn = () => {
              navigator.clipboard.writeText(formattedVal).then(() => toast('链接已复制'));
            };
            inputEl.addEventListener('click', copyFn);
            card.querySelector('.btn-copy-card').addEventListener('click', copyFn);
            resultsGallery.appendChild(card);
          });
        }

        function renderHistory() {
          const items = getRecent();
          if (historyCount) historyCount.textContent = items.length;
          if (!items.length) {
            historyGrid.innerHTML = '<div class="col-span-full py-6 text-center text-xs text-slate-400 dark:text-slate-500">暂无本地历史记录</div>';
            return;
          }
          historyGrid.innerHTML = '';
          items.slice(0, 12).forEach(item => {
            const isVid = isVideo(item.url) || isVideo(item.name);
            const isPdfFile = isPdf(item.url) || isPdf(item.name);
            const card = document.createElement('div');
            card.className = 'group relative aspect-square rounded-xl overflow-hidden bg-slate-200 dark:bg-slate-950 border border-slate-200/80 dark:border-white/10 cursor-pointer transition-all duration-300';
            if (isVid) {
              const vid = document.createElement('video');
              vid.preload = 'metadata';
              vid.muted = true;
              vid.playsInline = true;
              vid.className = 'w-full h-full object-cover pointer-events-none';
              vid.src = item.url;
              card.appendChild(vid);
              const badge = document.createElement('div');
              badge.className = 'absolute inset-0 flex items-center justify-center pointer-events-none';
              badge.innerHTML = '<div class="w-8 h-8 rounded-full bg-slate-900/80 border border-white/20 text-white flex items-center justify-center text-xs pl-0.5"><i class="fa-solid fa-play"></i></div>';
              card.appendChild(badge);
            } else if (isPdfFile) {
              const pdfBadge = document.createElement('div');
              pdfBadge.className = 'w-full h-full flex flex-col items-center justify-center bg-rose-500/10 text-rose-500 p-2 group-hover:scale-105 transition duration-300';
              pdfBadge.innerHTML = '<i class="fa-solid fa-file-pdf text-3xl mb-1"></i><span class="text-[10px] font-mono font-bold text-slate-700 dark:text-slate-300 truncate max-w-full">PDF</span>';
              card.appendChild(pdfBadge);
            } else {
              const img = document.createElement('img');
              img.src = item.url;
              img.className = 'w-full h-full object-cover group-hover:scale-105 transition duration-300';
              img.onerror = () => { card.innerHTML = '<div class="flex items-center justify-center h-full text-[10px] text-slate-400">失效</div>'; };
              card.appendChild(img);
            }
            const overlay = document.createElement('div');
            overlay.className = 'absolute inset-0 bg-slate-900/60 dark:bg-slate-950/70 opacity-0 group-hover:opacity-100 transition duration-200 flex items-center justify-center gap-1.5';
            overlay.innerHTML = '<button type="button" class="btn-copy-h w-7 h-7 rounded-lg bg-white/20 dark:bg-white/10 hover:bg-indigo-600 text-white text-xs flex items-center justify-center transition" title="复制直链"><i class="fa-regular fa-copy"></i></button><button type="button" class="btn-del-h w-7 h-7 rounded-lg bg-white/20 dark:bg-white/10 hover:bg-rose-600 text-white text-xs flex items-center justify-center transition" title="从记录移除"><i class="fa-solid fa-xmark"></i></button>';
            card.appendChild(overlay);

            card.addEventListener('click', e => {
              if (e.target.closest('.btn-copy-h') || e.target.closest('.btn-del-h')) return;
              viewMedia(item.url, isVid);
            });
            overlay.querySelector('.btn-copy-h')?.addEventListener('click', () => {
              navigator.clipboard.writeText(item.url).then(() => toast('直链已复制'));
            });
            overlay.querySelector('.btn-del-h')?.addEventListener('click', () => {
              const updated = getRecent().filter(r => r.url !== item.url);
              saveRecent(updated);
              toast('已从记录移除');
            });
            historyGrid.appendChild(card);
          });
        }

        async function compressImage(file) {
          if (!compressToggle.checked || !file.type.startsWith('image/') || /gif|svg/.test(file.type)) return file;
          return new Promise(resolve => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
              try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                URL.revokeObjectURL(url);
                canvas.toBlob(blob => {
                  resolve(blob && blob.size < file.size ? new File([blob], file.name, { type: file.type }) : file);
                }, file.type, 0.84);
              } catch {
                URL.revokeObjectURL(url);
                resolve(file);
              }
            };
            img.onerror = () => {
              URL.revokeObjectURL(url);
              resolve(file);
            };
            img.src = url;
          });
        }
  
        function sendFile(file, onProgress) {
          return new Promise((resolve, reject) => {
            const body = new FormData();
            body.append('file', file);
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/upload');
            xhr.upload.onprogress = e => {
              if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100));
            };
            xhr.onload = () => {
              let res = {};
              try { res = JSON.parse(xhr.responseText); } catch {}
              if (xhr.status === 401) { location.href = '/login?next=' + encodeURIComponent('/'); return; }
              if (xhr.status >= 200 && xhr.status < 300 && res.data) resolve(res.data);
              else reject(new Error(res.error || '上传失败'));
            };
            xhr.onerror = () => reject(new Error('网络请求异常'));
            xhr.send(body);
          });
        }
  
        async function uploadAll() {
          if (state.uploading) return;
          state.uploading = true;
          btnUploadAll.disabled = true;
          btnUploadAll.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>上传处理中...</span>';
          renderQueue();
          const recent = getRecent();
  
          for (const item of state.files) {
            if (item.status !== 'pending') continue;
            try {
              item.status = 'uploading';
              item.msg = '压缩中...';
              renderQueue();
  
              const prepared = await compressImage(item.file);
              item.msg = '上传中...';
              renderQueue();
  
              const url = await sendFile(prepared, pct => {
                item.progress = pct;
                renderQueue();
              });
  
              item.status = 'done';
              item.progress = 100;
              item.msg = '成功';
              state.results.unshift({ name: item.file.name, url });
              recent.unshift({ name: item.file.name, url, time: Date.now() });
              saveRecent(recent);
              updateResultsView();
              renderQueue();
            } catch (e) {
              item.status = 'error';
              item.msg = e.message || '失败';
              renderQueue();
            }
          }
  
          state.uploading = false;
          btnUploadAll.innerHTML = '<i class="fa-solid fa-arrow-up-from-bracket"></i><span>立即开始上传</span>';
          renderQueue();
          toast('队列已上传完毕');
        }
  
        // 事件绑定
        dropZone.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
        fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  
        ['dragenter', 'dragover'].forEach(n => dropZone.addEventListener(n, e => {
          e.preventDefault();
          dropZone.classList.add('border-indigo-500', 'bg-indigo-500/10', 'scale-[1.01]');
        }));
        ['dragleave', 'drop'].forEach(n => dropZone.addEventListener(n, e => {
          e.preventDefault();
          dropZone.classList.remove('border-indigo-500', 'bg-indigo-500/10', 'scale-[1.01]');
        }));
        dropZone.addEventListener('drop', e => { if (e.dataTransfer?.files) addFiles(e.dataTransfer.files); });
  
        window.addEventListener('paste', e => {
          if (e.clipboardData?.files?.length) {
            addFiles(e.clipboardData.files);
            toast('已截获剪贴板图片');
          }
        });

        const transferUrl = document.getElementById('transfer-url');
        const btnTransfer = document.getElementById('btn-transfer');
        const transferTip = document.getElementById('transfer-tip');

        async function handleTransfer() {
          const url = transferUrl.value.trim();
          if (!url) return toast('请输入远程地址', 'info');
          btnTransfer.disabled = true;
          transferTip.classList.remove('hidden');
          try {
            const res = await fetch('/transfer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url })
            });
            if (res.status === 401) {
              location.href = '/login?next=' + encodeURIComponent('/');
              return;
            }
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '转存失败');
            const name = url.split('/').pop().split('?')[0] || 'remote-file';
            state.results.unshift({ name, url: data.data });
            const recent = getRecent();
            recent.unshift({ name, url: data.data, time: Date.now() });
            saveRecent(recent);
            updateResultsView();
            transferUrl.value = '';
            toast('转存成功，已生成直链');
          } catch (e) {
            toast(e.message || '转存失败', 'error');
          } finally {
            btnTransfer.disabled = false;
            transferTip.classList.add('hidden');
          }
        }

        btnTransfer.addEventListener('click', handleTransfer);
        transferUrl.addEventListener('keydown', e => { if (e.key === 'Enter') handleTransfer(); });
  
        btnClearQueue.addEventListener('click', () => {
          if (state.uploading) return;
          state.files.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview); });
          state.files = [];
          renderQueue();
        });
  
        btnUploadAll.addEventListener('click', uploadAll);
  
        tabFmts.forEach(btn => {
          btn.addEventListener('click', () => {
            tabFmts.forEach(b => b.classList.remove('bg-indigo-600', 'text-white'));
            btn.classList.add('bg-indigo-600', 'text-white');
            state.currentFmt = btn.dataset.fmt;
            updateResultsView();
          });
        });
  
        btnCopyBulk.addEventListener('click', () => {
          if (!bulkLinksArea.value) return toast('暂无可复制链接', 'info');
          navigator.clipboard.writeText(bulkLinksArea.value).then(() => toast('已复制全部链接'));
        });
  
        btnClearHistory.addEventListener('click', () => {
          localStorage.removeItem('telegraphRecent');
          renderHistory();
          toast('历史记录已清除');
        });

        window.addEventListener('storage', e => {
          if (e.key === 'telegraphRecent') renderHistory();
        });

        renderHistory();
      })();
    </script>
  </body>
  </html>`, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' }
  });
}

async function handleAdminRequest(request, config) {
  validateAdminCredentials(config);
  if (!await isAuthenticated(request, config)) {
    const url = new URL(request.url);
    return redirectResponse(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  }
  const url = new URL(request.url);
  const requestedPage = Number.parseInt(url.searchParams.get('page') || '1', 10);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const database = getDatabase(config);
  await ensureDatabaseSchema(database);
  return generateAdminPage(database, page, config);
}

function mediaMetadata(rawUrl, createdAt, originalName) {
  const url = String(rawUrl || '');
  const fileName = url.split('/').pop() || '';
  const displayName = (originalName && String(originalName).trim()) || fileName || '未命名文件';
  const extension = displayName.includes('.')
      ? displayName.split('.').pop().toLowerCase()
      : (fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '');
  let uploadTime = '未知时间';
  const ts = createdAt || Number.parseInt(fileName, 10);
  if (Number.isFinite(ts) && ts > 0) {
    const uploadedAt = new Date(ts);
    if (Number.isFinite(uploadedAt.getTime())) {
      uploadTime = uploadedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    }
  }
  let previewUrl = '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') previewUrl = parsed.href;
  } catch {}
  return { url, previewUrl, fileName: fileName || '未命名文件', displayName, extension, uploadTime };
}

async function generateAdminPage(database, page = 1, config) {
  const pageSize = 48;
  const countRow = await database.prepare('SELECT COUNT(*) AS count FROM media').first();
  const itemCount = Number(countRow?.count) || 0;
  const totalPages = Math.max(1, Math.ceil(itemCount / pageSize));
  const currentPage = Math.min(page, totalPages);
  const mediaData = await fetchMediaData(database, pageSize, (currentPage - 1) * pageSize);
  const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'svg']);
  const videoExtensions = new Set(['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm']);

  const itemsHtml = mediaData.map(row => {
    const item = mediaMetadata(row.url, row.createdAt, row.originalName);
    const escapedUrl = escapeHtml(item.url);
    const escapedPreviewUrl = escapeHtml(item.previewUrl);
    const isImage = escapedPreviewUrl && imageExtensions.has(item.extension);
    const isVideo = escapedPreviewUrl && videoExtensions.has(item.extension);
    const isPdf = escapedPreviewUrl && item.extension === 'pdf';
    const category = isImage ? 'image' : isVideo ? 'video' : isPdf ? 'pdf' : 'other';
    const canPreview = isImage || isVideo || isPdf;
    const rawOpenUrl = isPdf ? `${escapedUrl}${escapedUrl.includes('?') ? '&' : '?'}raw=true` : escapedUrl;

    let previewContent;
    if (isImage) {
      previewContent = `<img src="${escapedPreviewUrl}" alt="${escapeHtml(item.displayName)}" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" onerror="this.parentElement.innerHTML='<div class=\\'flex items-center justify-center h-full text-xs text-slate-400\\'>预览失效</div>'">`;
    } else if (isVideo) {
      previewContent = `<video preload="metadata" muted playsinline class="w-full h-full object-cover"><source src="${escapedPreviewUrl}"></video><div class="absolute inset-0 flex items-center justify-center pointer-events-none"><div class="w-10 h-10 rounded-full bg-slate-900/80 border border-white/20 text-white flex items-center justify-center text-sm pl-0.5"><i class="fa-solid fa-play"></i></div></div>`;
    } else if (isPdf) {
      previewContent = `<div class="flex flex-col items-center justify-center h-full bg-rose-500/5 text-rose-500 gap-1.5"><i class="fa-solid fa-file-pdf text-3xl"></i><span class="text-[10px] font-mono font-bold uppercase text-slate-600 dark:text-slate-300">PDF 文档</span></div>`;
    } else {
      previewContent = `<div class="flex flex-col items-center justify-center h-full text-slate-400 gap-1.5"><i class="fa-regular fa-file text-2xl"></i><span class="text-[10px] font-mono font-bold uppercase">${escapeHtml(item.extension || 'FILE')}</span></div>`;
    }

    return `<article class="media-card group relative bg-white/80 dark:bg-slate-900/80 border border-slate-200/80 dark:border-white/10 rounded-2xl overflow-hidden hover:border-slate-300 dark:hover:border-white/25 hover:shadow-xl hover:shadow-indigo-500/5 dark:hover:shadow-black/50 transition duration-300 flex flex-col"
        data-url="${escapedUrl}" data-preview="${escapedPreviewUrl}" data-name="${escapeHtml(item.displayName.toLowerCase())}" data-type="${escapeHtml(item.extension)}" data-category="${category}" data-can-preview="${canPreview}">
        <label class="absolute top-2.5 left-2.5 z-20 cursor-pointer">
          <input type="checkbox" class="media-checkbox w-4 h-4 rounded accent-indigo-500 cursor-pointer">
        </label>
        <div class="thumb-stage aspect-square bg-slate-100 dark:bg-slate-950/60 relative ${canPreview ? 'cursor-pointer' : 'cursor-default'} overflow-hidden">
          ${previewContent}
          <div class="card-overlay absolute inset-0 bg-slate-900/60 dark:bg-slate-950/65 opacity-0 group-hover:opacity-100 transition duration-200 flex items-center justify-center gap-2">
            ${canPreview ? `
            <button type="button" class="btn-preview w-8 h-8 rounded-xl bg-white/20 dark:bg-white/10 hover:bg-indigo-600 text-white text-xs flex items-center justify-center transition" title="在线预览"><i class="fa-solid fa-expand"></i></button>
            ` : ''}
            <button type="button" class="btn-copy-link w-8 h-8 rounded-xl bg-white/20 dark:bg-white/10 hover:bg-indigo-600 text-white text-xs flex items-center justify-center transition" title="复制直链"><i class="fa-regular fa-copy"></i></button>
            <a href="${rawOpenUrl}" target="_blank" rel="noopener" class="btn-open-link w-8 h-8 rounded-xl bg-white/20 dark:bg-white/10 hover:bg-indigo-600 text-white text-xs flex items-center justify-center transition" title="原链新标签打开"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
          </div>
        </div>
        <div class="p-3 bg-white/90 dark:bg-slate-900/90 border-t border-slate-200/80 dark:border-white/5">
          <div class="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate" title="${escapeHtml(item.displayName)}">${escapeHtml(item.displayName)}</div>
          <div class="flex items-center justify-between mt-1.5 text-[11px] text-slate-400 dark:text-slate-400 font-mono">
            <span class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 uppercase text-[10px] text-slate-600 dark:text-slate-300">${escapeHtml(item.extension || 'FILE')}</span>
            <time class="truncate text-slate-400">${escapeHtml(item.uploadTime)}</time>
          </div>
        </div>
      </article>`;
  }).join('');

  const tableRowsHtml = mediaData.map(row => {
    const item = mediaMetadata(row.url, row.createdAt, row.originalName);
    const escapedUrl = escapeHtml(item.url);
    const escapedPreviewUrl = escapeHtml(item.previewUrl);
    const isImage = escapedPreviewUrl && imageExtensions.has(item.extension);
    const isVideo = escapedPreviewUrl && videoExtensions.has(item.extension);
    const isPdf = escapedPreviewUrl && item.extension === 'pdf';
    const category = isImage ? 'image' : isVideo ? 'video' : isPdf ? 'pdf' : 'other';
    const canPreview = isImage || isVideo || isPdf;
    const rawOpenUrl = isPdf ? `${escapedUrl}${escapedUrl.includes('?') ? '&' : '?'}raw=true` : escapedUrl;

    let miniPreview;
    if (isImage) {
      miniPreview = `<img src="${escapedPreviewUrl}" alt="${escapeHtml(item.displayName)}" loading="lazy" class="w-full h-full object-cover rounded-lg" onerror="this.parentElement.innerHTML='<i class=\\'fa-regular fa-image text-slate-400 text-xs\\'></i>'">`;
    } else if (isVideo) {
      miniPreview = `<div class="w-full h-full rounded-lg bg-indigo-500/10 text-indigo-500 flex items-center justify-center text-xs"><i class="fa-solid fa-play"></i></div>`;
    } else if (isPdf) {
      miniPreview = `<div class="w-full h-full rounded-lg bg-rose-500/10 text-rose-500 flex items-center justify-center text-xs"><i class="fa-solid fa-file-pdf"></i></div>`;
    } else {
      miniPreview = `<div class="w-full h-full rounded-lg bg-slate-100 dark:bg-white/5 text-slate-400 flex items-center justify-center text-xs"><i class="fa-regular fa-file"></i></div>`;
    }

    return `<tr class="media-table-row hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition duration-150 group"
        data-url="${escapedUrl}" data-preview="${escapedPreviewUrl}" data-name="${escapeHtml(item.displayName.toLowerCase())}" data-type="${escapeHtml(item.extension)}" data-category="${category}" data-can-preview="${canPreview}">
        <td class="py-3 px-4">
          <input type="checkbox" class="table-row-checkbox w-4 h-4 rounded accent-indigo-500 cursor-pointer">
        </td>
        <td class="py-2.5 px-3">
          <div class="table-thumb w-10 h-10 rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-white/10 flex items-center justify-center flex-shrink-0 ${canPreview ? 'cursor-pointer hover:ring-2 hover:ring-indigo-500/50' : 'cursor-default'}" title="${canPreview ? '点击在线预览' : ''}">
            ${miniPreview}
          </div>
        </td>
        <td class="py-3 px-4 min-w-[180px]">
          <div class="font-semibold text-slate-800 dark:text-slate-200 truncate max-w-xs sm:max-w-md ${canPreview ? 'cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400' : ''} transition title-trigger" title="${escapeHtml(item.displayName)}">${escapeHtml(item.displayName)}</div>
          <div class="text-[11px] font-mono text-slate-400 dark:text-slate-500 truncate max-w-xs" title="${escapedUrl}">${escapeHtml(item.fileName)}</div>
        </td>
        <td class="py-3 px-3 font-mono">
          <span class="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 uppercase text-[10px] text-slate-600 dark:text-slate-300 font-semibold">${escapeHtml(item.extension || 'FILE')}</span>
        </td>
        <td class="py-3 px-4 font-mono text-[11px] text-slate-400 dark:text-slate-400 whitespace-nowrap">
          <time>${escapeHtml(item.uploadTime)}</time>
        </td>
        <td class="py-3 px-4 text-right whitespace-nowrap">
          <div class="inline-flex items-center gap-1.5">
            ${canPreview ? `
            <button type="button" class="btn-row-preview w-8 h-8 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-indigo-600 hover:text-white text-slate-500 dark:text-slate-400 flex items-center justify-center transition text-xs" title="在线预览"><i class="fa-solid fa-expand"></i></button>
            ` : ''}
            <button type="button" class="btn-row-copy w-8 h-8 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-indigo-600 hover:text-white text-slate-500 dark:text-slate-400 flex items-center justify-center transition text-xs" title="复制直链"><i class="fa-regular fa-copy"></i></button>
            <a href="${rawOpenUrl}" target="_blank" rel="noopener" class="btn-row-open w-8 h-8 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-indigo-600 text-white text-xs flex items-center justify-center transition" title="原链新标签打开"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
          </div>
        </td>
      </tr>`;
  }).join('');

  const emptyHtml = `<div class="col-span-full py-20 text-center bg-slate-100/50 dark:bg-slate-900/40 border border-dashed border-slate-200 dark:border-white/10 rounded-3xl">
      <div class="w-14 h-14 rounded-2xl bg-slate-200/60 dark:bg-white/5 text-slate-400 dark:text-slate-500 flex items-center justify-center mx-auto mb-3 text-2xl">
        <i class="fa-regular fa-folder-open"></i>
      </div>
      <h3 class="text-base font-bold text-slate-800 dark:text-white mb-1">媒体库尚无文件</h3>
      <p class="text-xs text-slate-400 mb-5">上传后的文件都会安全存入 D1 数据库中</p>
      <a href="/" class="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs transition">去上传文件</a>
    </div>`;

  const adminPath = `/${config.adminPath}`;
  const previousUrl = `${adminPath}?page=${currentPage - 1}`;
  const nextUrl = `${adminPath}?page=${currentPage + 1}`;

  return new Response(`<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>媒体管理控制台 · Telegraph Hub</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.min.css">
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
    <script>if(typeof Swal==='undefined'){document.write('<script src="https://unpkg.com/sweetalert2@11"><\\/script>')}</script>
    <script>
      tailwind.config = { darkMode: 'class' };
      if (localStorage.getItem('telegraphTheme') === 'light' || (!('telegraphTheme' in localStorage) && window.matchMedia('(prefers-color-scheme: light)').matches)) {
        document.documentElement.classList.remove('dark');
      } else {
        document.documentElement.classList.add('dark');
      }
    </script>
    <style>
      body { font-family: 'Plus Jakarta Sans', sans-serif; }
      .font-mono { font-family: 'JetBrains Mono', monospace; }
      .bg-grid { background-size: 32px 32px; background-image: linear-gradient(to right, rgba(148, 163, 184, 0.07) 1px, transparent 1px), linear-gradient(to bottom, rgba(148, 163, 184, 0.07) 1px, transparent 1px); }
      .dark .bg-grid { background-image: linear-gradient(to right, rgba(255, 255, 255, 0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255, 255, 255, 0.03) 1px, transparent 1px); }
    </style>
  </head>
  <body class="bg-slate-50 dark:bg-[#0b0f17] text-slate-800 dark:text-slate-100 min-h-screen flex flex-col relative overflow-x-hidden selection:bg-indigo-500 selection:text-white transition-colors duration-300">
    <!-- 顶部星云背景 -->
    <div class="fixed inset-0 pointer-events-none z-0">
      <div class="absolute -top-40 right-1/4 w-[600px] h-[400px] bg-indigo-500/10 dark:bg-indigo-600/15 rounded-full blur-[140px]"></div>
      <div class="absolute bottom-10 left-10 w-[500px] h-[500px] bg-cyan-500/10 dark:bg-cyan-500/10 rounded-full blur-[130px]"></div>
      <div class="absolute inset-0 bg-grid"></div>
    </div>
  
    <!-- 顶部导航 -->
    <header class="sticky top-0 z-40 h-16 bg-white/80 dark:bg-[#0b0f17]/80 backdrop-blur-xl border-b border-slate-200/80 dark:border-white/10 px-4 sm:px-8 flex items-center justify-between transition-colors duration-300">
      <a href="/" class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-500 via-indigo-600 to-cyan-400 flex items-center justify-center text-white text-base shadow-lg shadow-indigo-500/25">
          <i class="fa-solid fa-cloud-arrow-up"></i>
        </div>
        <div>
          <span class="font-extrabold text-base tracking-tight text-slate-900 dark:text-white">Telegraph Hub</span>
          <span class="hidden sm:inline-block ml-2 px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-[10px] font-semibold text-indigo-500 dark:text-indigo-400">Media Manager</span>
        </div>
      </a>
      <div class="flex items-center gap-2">
        <!-- 模式切换按钮 -->
        <button type="button" id="theme-toggle" class="h-9 px-3 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white flex items-center gap-1.5 transition" title="日夜间模式切换">
          <i class="fa-solid fa-sun text-amber-500 dark:hidden"></i>
          <i class="fa-solid fa-moon text-indigo-400 hidden dark:inline-block"></i>
          <span class="text-[11px] hidden md:inline">模式</span>
        </button>
        <a href="/" class="h-9 px-3.5 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white flex items-center gap-2 transition">
          <i class="fa-solid fa-upload text-indigo-500 dark:text-indigo-400"></i>
          <span>上传中心</span>
        </a>
        <form method="post" action="/logout" class="m-0">
          <button type="submit" class="h-9 w-9 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-rose-500/15 border border-slate-200 dark:border-white/10 hover:border-rose-500/30 text-slate-500 hover:text-rose-500 dark:hover:text-rose-400 flex items-center justify-center transition" title="退出登录">
            <i class="fa-solid fa-arrow-right-from-bracket text-xs"></i>
          </button>
        </form>
      </div>
    </header>
  
    <!-- 主体控制中心 -->
    <main class="relative z-10 flex-1 max-w-7xl w-full mx-auto px-4 py-8 sm:py-10 space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 class="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight">媒体资产管理中心</h1>
          <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">集中检索、预览直链与批量清理已托管的文件</p>
        </div>
        <div class="px-4 py-2 rounded-2xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-white/10 text-xs text-slate-500 dark:text-slate-400 font-mono flex items-center gap-2 shadow-sm">
          <i class="fa-solid fa-database text-indigo-500 dark:text-indigo-400"></i>
          <span>共 <strong class="text-indigo-600 dark:text-indigo-400 font-bold">${itemCount}</strong> 个文件 · 第 ${currentPage}/${totalPages} 页</span>
        </div>
      </div>
  
      <!-- 浮动控制坞 (Toolbar) -->
      <div class="sticky top-20 z-30 p-3 bg-white/90 dark:bg-slate-900/80 backdrop-blur-2xl border border-slate-200/80 dark:border-white/10 rounded-2xl shadow-xl shadow-indigo-500/5 dark:shadow-black/40 flex flex-wrap items-center gap-3 transition-colors duration-300">
        <!-- 搜索输入框 -->
        <div class="relative flex-1 min-w-[200px]">
          <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 text-xs"></i>
          <input type="search" id="search-input" placeholder="输入文件名或格式筛选..."
            class="w-full h-9 pl-9 pr-8 bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-white/10 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 outline-none focus:border-indigo-500">
          <button type="button" id="btn-search-clear" class="hidden absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-white text-xs">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
  
        <!-- 类型过滤卡 -->
        <div class="flex p-1 bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-white/10 rounded-xl gap-1 text-xs">
          <button type="button" class="tab-filter px-3 py-1 rounded-lg font-medium text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition active" data-type="all">全部</button>
          <button type="button" class="tab-filter px-3 py-1 rounded-lg font-medium text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition" data-type="image">图片</button>
          <button type="button" class="tab-filter px-3 py-1 rounded-lg font-medium text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition" data-type="video">视频</button>
          <button type="button" class="tab-filter px-3 py-1 rounded-lg font-medium text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition" data-type="pdf">PDF</button>
          <button type="button" class="tab-filter px-3 py-1 rounded-lg font-medium text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition" data-type="other">其他</button>
        </div>
  
        <!-- 批量工具 -->
        <div class="flex items-center gap-2 pl-2 sm:border-l border-slate-200 dark:border-white/10 text-xs">
          <button type="button" id="btn-select-all" class="h-9 px-3 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 font-semibold text-slate-700 dark:text-slate-300 transition">全选</button>
          <select id="batch-format" class="h-9 bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-white/10 rounded-xl px-2.5 text-xs text-slate-700 dark:text-slate-300 outline-none">
            <option value="url">直链 (URL)</option>
            <option value="markdown">Markdown</option>
            <option value="html">HTML</option>
            <option value="bbcode">BBCode</option>
          </select>
          <button type="button" id="btn-batch-copy" disabled class="h-9 px-3 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-200 dark:border-white/10 font-semibold text-slate-700 dark:text-slate-300 transition flex items-center gap-1.5">
            <i class="fa-regular fa-copy text-indigo-500 dark:text-indigo-400"></i>
            <span>复制 (<span id="select-count">0</span>)</span>
          </button>
          <button type="button" id="btn-batch-delete" disabled class="h-9 px-3 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-40 disabled:cursor-not-allowed border border-rose-500/30 font-semibold text-rose-500 dark:text-rose-400 transition flex items-center gap-1.5">
            <i class="fa-regular fa-trash-can"></i>
            <span>删除</span>
          </button>
          <button type="button" id="btn-view-toggle" class="h-9 w-9 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white flex items-center justify-center transition flex-shrink-0" title="切换为表格视图">
            <i id="view-toggle-icon" class="fa-solid fa-table-list text-xs"></i>
          </button>
        </div>
      </div>
  
      <!-- 媒体展示网格 (块状视图) -->
      <div id="media-grid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
        ${itemsHtml || emptyHtml}
      </div>

      <!-- 媒体展示表格 (表格视图) -->
      <div id="media-table-wrap" class="hidden overflow-x-auto bg-white/80 dark:bg-slate-900/80 backdrop-blur-2xl border border-slate-200/80 dark:border-white/10 rounded-2xl shadow-xl shadow-indigo-500/5 dark:shadow-black/40 transition-all duration-300">
        <table class="w-full text-left text-xs border-collapse">
          <thead>
            <tr class="border-b border-slate-200/80 dark:border-white/10 text-slate-400 dark:text-slate-500 font-mono text-[11px] uppercase bg-slate-50/50 dark:bg-slate-950/30 select-none">
              <th class="py-3 px-4 w-10">
                <input type="checkbox" id="table-select-all" class="w-4 h-4 rounded accent-indigo-500 cursor-pointer">
              </th>
              <th class="py-3 px-3 w-16">预览</th>
              <th class="py-3 px-4 min-w-[180px]">原始文件名 / 链接</th>
              <th class="py-3 px-3 w-24">格式</th>
              <th class="py-3 px-4 w-44">上传时间</th>
              <th class="py-3 px-4 w-32 text-right">操作</th>
            </tr>
          </thead>
          <tbody id="media-table-body" class="divide-y divide-slate-200/60 dark:divide-white/5">
            ${tableRowsHtml || '<tr><td colspan="6" class="py-16 text-center text-xs text-slate-400">媒体库尚无文件</td></tr>'}
          </tbody>
        </table>
      </div>
  
      <!-- 分页条 -->
      ${itemCount ? `
      <nav class="pt-6 flex items-center justify-center gap-3 text-xs">
        <a href="${escapeHtml(previousUrl)}" class="h-10 px-4 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-white/10 flex items-center gap-2 text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition ${currentPage <= 1 ? 'opacity-40 pointer-events-none' : ''}">
          <i class="fa-solid fa-chevron-left text-[10px]"></i>
          <span>上一页</span>
        </a>
        <span class="px-4 py-2 rounded-xl bg-white/60 dark:bg-slate-900/40 border border-slate-200 dark:border-white/5 font-mono text-slate-500 dark:text-slate-400">第 ${currentPage} / ${totalPages} 页</span>
        <a href="${escapeHtml(nextUrl)}" class="h-10 px-4 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-white/10 flex items-center gap-2 text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition ${currentPage >= totalPages ? 'opacity-40 pointer-events-none' : ''}">
          <span>下一页</span>
          <i class="fa-solid fa-chevron-right text-[10px]"></i>
        </a>
      </nav>` : ''}
    </main>
  
    <script>
      (function() {
        const cards = Array.from(document.querySelectorAll('.media-card'));
        const rows = Array.from(document.querySelectorAll('.media-table-row'));
        const selected = new Set();
        const selectCount = document.getElementById('select-count');
        const btnBatchCopy = document.getElementById('btn-batch-copy');
        const btnBatchDelete = document.getElementById('btn-batch-delete');
        const btnSelectAll = document.getElementById('btn-select-all');
        const tableSelectAll = document.getElementById('table-select-all');
        const searchInput = document.getElementById('search-input');
        const btnSearchClear = document.getElementById('btn-search-clear');
        const batchFormat = document.getElementById('batch-format');
        const tabFilters = Array.from(document.querySelectorAll('.tab-filter'));
        const themeToggle = document.getElementById('theme-toggle');

        const btnViewToggle = document.getElementById('btn-view-toggle');
        const viewToggleIcon = document.getElementById('view-toggle-icon');
        const mediaGrid = document.getElementById('media-grid');
        const mediaTableWrap = document.getElementById('media-table-wrap');
        let currentFilter = 'all';
        let currentView = 'grid';

        function setView(mode) {
          currentView = mode === 'table' ? 'table' : 'grid';
          const isTable = currentView === 'table';
          mediaGrid?.classList.toggle('hidden', isTable);
          mediaTableWrap?.classList.toggle('hidden', !isTable);

          if (btnViewToggle && viewToggleIcon) {
            if (isTable) {
              btnViewToggle.title = '切换为块状视图';
              viewToggleIcon.className = 'fa-solid fa-table-cells-large text-xs text-indigo-500 dark:text-indigo-400';
            } else {
              btnViewToggle.title = '切换为表格视图';
              viewToggleIcon.className = 'fa-solid fa-table-list text-xs';
            }
          }
          try { localStorage.setItem('telegraphAdminView', currentView); } catch (_) {}
        }

        btnViewToggle?.addEventListener('click', () => {
          setView(currentView === 'grid' ? 'table' : 'grid');
        });

        try {
          const savedView = localStorage.getItem('telegraphAdminView') || 'grid';
          setView(savedView);
        } catch (_) {}
  
        themeToggle.addEventListener('click', () => {
          const isDark = document.documentElement.classList.toggle('dark');
          localStorage.setItem('telegraphTheme', isDark ? 'dark' : 'light');
        });
  
        function toast(msg, icon = 'success') {
          const isDark = document.documentElement.classList.contains('dark');
          Swal.fire({
            toast: true,
            position: 'top-end',
            showConfirmButton: false,
            timer: 2200,
            timerProgressBar: true,
            icon,
            title: msg,
            background: isDark ? '#0f172a' : '#ffffff',
            color: isDark ? '#f8fafc' : '#1e293b'
          });
        }
  
        function viewModal(url, category) {
          const isDark = document.documentElement.classList.contains('dark');
          const isPdf = category === 'pdf' || url.split('?')[0].toLowerCase().endsWith('.pdf');
          if (category === 'video') {
            Swal.fire({
              html: '<video controls autoplay src="' + url + '" class="max-h-[75vh] mx-auto rounded-xl"></video>',
              background: isDark ? '#0f172a' : '#ffffff',
              showConfirmButton: false,
              showCloseButton: true,
              customClass: { popup: 'border border-slate-200 dark:border-white/10 rounded-2xl shadow-2xl' }
            });
          } else if (isPdf) {
            const previewUrl = url + (url.includes('?') ? '&' : '?') + 'embed=1';
            Swal.fire({
              title: '<div class="flex items-center justify-between px-1 pt-1"><span class="text-sm font-bold text-slate-800 dark:text-white flex items-center gap-2"><i class="fa-solid fa-file-pdf text-rose-500"></i>PDF 在线预览</span><a href="' + url + '" target="_blank" rel="noopener" class="text-xs text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 font-semibold flex items-center gap-1"><i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>新窗口全屏预览</a></div>',
              html: '<iframe src="' + previewUrl + '" class="w-full h-[72vh] rounded-xl border border-slate-200 dark:border-white/10 mt-3" allowfullscreen></iframe>',
              background: isDark ? '#0f172a' : '#ffffff',
              color: isDark ? '#f8fafc' : '#1e293b',
              showConfirmButton: false,
              showCloseButton: true,
              customClass: { popup: 'w-[95vw] max-w-5xl border border-slate-200 dark:border-white/10 rounded-2xl shadow-2xl p-4' }
            });
          } else {
            Swal.fire({
              imageUrl: url,
              imageAlt: '原图预览',
              background: isDark ? '#0f172a' : '#ffffff',
              color: isDark ? '#f8fafc' : '#1e293b',
              showConfirmButton: false,
              showCloseButton: true,
              customClass: { popup: 'border border-slate-200 dark:border-white/10 rounded-2xl shadow-2xl' }
            });
          }
        }
  
        function updateSelect() {
          selectCount.textContent = selected.size;
          btnBatchCopy.disabled = !selected.size;
          btnBatchDelete.disabled = !selected.size;
          cards.forEach(card => {
            const isSel = selected.has(card.dataset.url);
            card.classList.toggle('border-indigo-500', isSel);
            card.classList.toggle('ring-2', isSel);
            card.classList.toggle('ring-indigo-500/30', isSel);
            const chk = card.querySelector('.media-checkbox');
            if (chk) chk.checked = isSel;
          });
          rows.forEach(row => {
            const isSel = selected.has(row.dataset.url);
            row.classList.toggle('bg-indigo-500/5', isSel);
            const chk = row.querySelector('.table-row-checkbox');
            if (chk) chk.checked = isSel;
          });

          const visibleRows = rows.filter(r => r.style.display !== 'none');
          if (tableSelectAll) {
            tableSelectAll.checked = visibleRows.length > 0 && visibleRows.every(r => selected.has(r.dataset.url));
          }
        }
  
        cards.forEach(card => {
          const chk = card.querySelector('.media-checkbox');
          chk?.addEventListener('change', () => {
            if (chk.checked) selected.add(card.dataset.url);
            else selected.delete(card.dataset.url);
            updateSelect();
          });
  
          const category = card.dataset.category;
          const canPreview = card.dataset.canPreview === 'true';

          card.querySelector('.btn-preview')?.addEventListener('click', e => {
            e.stopPropagation();
            if (canPreview) {
              viewModal(card.dataset.url, category);
            }
          });

          card.querySelector('.btn-copy-link')?.addEventListener('click', e => {
            e.stopPropagation();
            navigator.clipboard.writeText(card.dataset.url).then(() => toast('直链已复制'));
          });

          card.querySelector('.btn-open-link')?.addEventListener('click', e => {
            e.stopPropagation();
          });

          card.querySelector('.thumb-stage')?.addEventListener('click', e => {
            if (e.target.closest('.btn-copy-link') || e.target.closest('.btn-open-link') || e.target.closest('.btn-preview')) return;
            if (canPreview) {
              viewModal(card.dataset.url, category);
            }
          });
        });

        rows.forEach(row => {
          const chk = row.querySelector('.table-row-checkbox');
          chk?.addEventListener('change', () => {
            if (chk.checked) selected.add(row.dataset.url);
            else selected.delete(row.dataset.url);
            updateSelect();
          });

          const category = row.dataset.category;
          const canPreview = row.dataset.canPreview === 'true';

          row.querySelector('.btn-row-preview')?.addEventListener('click', e => {
            e.stopPropagation();
            if (canPreview) viewModal(row.dataset.url, category);
          });

          row.querySelector('.btn-row-copy')?.addEventListener('click', e => {
            e.stopPropagation();
            navigator.clipboard.writeText(row.dataset.url).then(() => toast('直链已复制'));
          });

          row.querySelector('.btn-row-open')?.addEventListener('click', e => {
            e.stopPropagation();
          });

          row.querySelector('.table-thumb')?.addEventListener('click', () => {
            if (canPreview) viewModal(row.dataset.url, category);
          });

          row.querySelector('.title-trigger')?.addEventListener('click', () => {
            if (canPreview) viewModal(row.dataset.url, category);
          });
        });

        tableSelectAll?.addEventListener('change', () => {
          const visibleRows = rows.filter(r => r.style.display !== 'none');
          visibleRows.forEach(r => {
            if (tableSelectAll.checked) selected.add(r.dataset.url);
            else selected.delete(r.dataset.url);
          });
          updateSelect();
        });
  
        btnSelectAll.addEventListener('click', () => {
          const isTable = mediaTableWrap && !mediaTableWrap.classList.contains('hidden');
          const visibleItems = isTable
            ? rows.filter(c => c.style.display !== 'none')
            : cards.filter(c => c.style.display !== 'none');
          if (!visibleItems.length) return;
          const allSel = visibleItems.every(c => selected.has(c.dataset.url));
          visibleItems.forEach(c => {
            if (allSel) selected.delete(c.dataset.url);
            else selected.add(c.dataset.url);
          });
          updateSelect();
        });
  
        function applySearchAndFilter() {
          const q = searchInput.value.trim().toLowerCase();
          btnSearchClear.classList.toggle('hidden', !q);
          cards.forEach(card => {
            const matchQ = !q || card.dataset.name.includes(q) || card.dataset.type.includes(q);
            const matchT = currentFilter === 'all' || card.dataset.category === currentFilter;
            card.style.display = (matchQ && matchT) ? '' : 'none';
          });
          rows.forEach(row => {
            const matchQ = !q || row.dataset.name.includes(q) || row.dataset.type.includes(q);
            const matchT = currentFilter === 'all' || row.dataset.category === currentFilter;
            row.style.display = (matchQ && matchT) ? '' : 'none';
          });
          updateSelect();
        }
  
        searchInput.addEventListener('input', applySearchAndFilter);
        btnSearchClear.addEventListener('click', () => {
          searchInput.value = '';
          applySearchAndFilter();
          searchInput.focus();
        });
  
        tabFilters.forEach(tab => {
          tab.addEventListener('click', () => {
            tabFilters.forEach(t => {
              t.classList.remove('bg-indigo-600', 'text-white');
              t.classList.add('text-slate-500', 'dark:text-slate-400');
            });
            tab.classList.remove('text-slate-500', 'dark:text-slate-400');
            tab.classList.add('bg-indigo-600', 'text-white');
            currentFilter = tab.dataset.type;
            applySearchAndFilter();
          });
        });
        tabFilters[0].classList.add('bg-indigo-600', 'text-white');
  
        function formatText(url, name) {
          const fmt = batchFormat.value;
          const isPdf = url.split('?')[0].toLowerCase().endsWith('.pdf') || name.toLowerCase().endsWith('.pdf');
          if (fmt === 'markdown') return isPdf ? '[' + name + '](' + url + ')' : '![' + name + '](' + url + ')';
          if (fmt === 'html') return isPdf ? '<a href="' + url + '" target="_blank" rel="noopener">' + name + '</a>' : '<img src="' + url + '" alt="' + name + '">';
          if (fmt === 'bbcode') return isPdf ? '[url=' + url + ']' + name + '[/url]' : '[img]' + url + '[/img]';
          return url;
        }
  
        btnBatchCopy.addEventListener('click', () => {
          if (!selected.size) return;
          const text = Array.from(selected).map(url => {
            const c = cards.find(item => item.dataset.url === url) || rows.find(item => item.dataset.url === url);
            return formatText(url, c?.dataset.name || 'file');
          }).join('\\n');
          navigator.clipboard.writeText(text).then(() => toast('已复制选中的 ' + selected.size + ' 个文件链接'));
        });
  
        btnBatchDelete.addEventListener('click', async () => {
          if (!selected.size) return;
          const count = selected.size;
          const isDark = document.documentElement.classList.contains('dark');
          const confirmResult = await Swal.fire({
            title: '确定要彻底删除吗？',
            text: '将删除选中的 ' + count + ' 个媒体文件，不可撤销！',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: '确定删除',
            cancelButtonText: '取消',
            background: isDark ? '#0f172a' : '#ffffff',
            color: isDark ? '#f8fafc' : '#1e293b',
            confirmButtonColor: '#f43f5e',
            cancelButtonColor: isDark ? '#334155' : '#94a3b8',
            customClass: { popup: 'border border-slate-200 dark:border-white/10 rounded-2xl' }
          });
  
          if (!confirmResult.isConfirmed) return;
  
          btnBatchDelete.disabled = true;
          try {
            const res = await fetch('/delete-images', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(Array.from(selected))
            });
  
            if (res.status === 401) {
              location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
              return;
            }
  
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '删除失败');
  
            toast('已删除 ' + count + ' 项文件');
            try {
              const deletedSet = new Set(selected);
              const recent = JSON.parse(localStorage.getItem('telegraphRecent') || '[]');
              const updated = recent.filter(item => !deletedSet.has(item.url));
              localStorage.setItem('telegraphRecent', JSON.stringify(updated));
            } catch {}
            selected.forEach(url => {
              const card = cards.find(c => c.dataset.url === url);
              card?.remove();
              const row = rows.find(r => r.dataset.url === url);
              row?.remove();
            });
            selected.clear();
            updateSelect();
            setTimeout(() => location.reload(), 600);
          } catch (e) {
            toast(e.message || '删除请求失败', 'error');
            btnBatchDelete.disabled = false;
          }
        });
  
        updateSelect();
      })();
    </script>
  </body>
  </html>`, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' }
  });
}

async function fetchMediaData(DATABASE, limit = null, offset = 0) {
  let query = 'SELECT url, fileId, messageId, createdAt, originalName FROM media ORDER BY COALESCE(createdAt, 0) DESC, url DESC';
  if (limit !== null) {
    query += ' LIMIT ? OFFSET ?';
    const result = await DATABASE.prepare(query).bind(limit, offset).all();
    return (result.results || []).map(row => ({
      fileId: row.fileId,
      url: row.url,
      messageId: row.messageId,
      createdAt: row.createdAt,
      originalName: row.originalName
    }));
  }
  const result = await DATABASE.prepare(query).all();
  return (result.results || []).map(row => ({
    fileId: row.fileId,
    url: row.url,
    messageId: row.messageId,
    createdAt: row.createdAt,
    originalName: row.originalName
  }));
}

async function uploadFileToTelegraph(config, file, originalName) {
  const database = getDatabase(config);
  await ensureDatabaseSchema(database);
  const fileExtension = getFileExtension(file.name);
  const fileName = ensureFileExtension(
      String(originalName || file.name || '').trim() || `file.${fileExtension}`,
      fileExtension
  );
  const datePart = formatDateString();
  const randomPart = generatePathRandomPart();
  const filePath = `/${datePart}/${randomPart}/${fileName}`;
  const pathToSend = `/${datePart}/${randomPart}/${encodeURIComponent(fileName)}`;
  const imageURL = `https://${config.domain}${pathToSend}`;

  const uploadFormData = new FormData();
  uploadFormData.append("chat_id", config.tgChatId);
  if (file.type.startsWith('image/gif')) {
    const newFileName = file.name.replace(/\.gif$/, '.jpeg');
    const newFile = new File([file], newFileName, { type: 'image/jpeg' });
    uploadFormData.append("document", newFile);
  } else {
    uploadFormData.append("document", file);
  }
  uploadFormData.append("caption", filePath);
  const telegramResponse = await fetch(
      `https://api.telegram.org/bot${config.tgBotToken}/sendDocument`,
      { method: 'POST', body: uploadFormData }
  );
  if (!telegramResponse.ok) {
    const errorData = await telegramResponse.json();
    throw new Error(errorData.description || '上传到 Telegram 失败');
  }
  const responseData = await telegramResponse.json();
  const fileId = responseData.result.video?.file_id
      || responseData.result.document?.file_id
      || responseData.result.sticker?.file_id;
  if (!fileId) throw new Error('返回的数据中没有文件 ID');
  const messageId = responseData.result.message_id;
  await database.prepare(
      'INSERT INTO media (url, fileId, messageId, createdAt, originalName) VALUES (?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET originalName = excluded.originalName'
  ).bind(imageURL, fileId, messageId || null, Date.now(), fileName).run();
  return imageURL;
}

async function handleUploadRequest(request, config) {
  try {
    if (config.enableAuth) {
      validateAdminCredentials(config);
      if (!await isAuthenticated(request, config)) return unauthorizedResponse();
    }
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) throw new Error('缺少文件');
    if (file.size > config.maxSize) {
      return jsonResponse({ error: `文件大小超过${config.maxSize / (1024 * 1024)}MB限制` }, 413);
    }
    const imageURL = await uploadFileToTelegraph(config, file, String(file.name || '').trim());
    return jsonResponse({ data: imageURL });
  } catch (error) {
    console.error('内部服务器错误:', error);
    const status = error instanceof ConfigurationError ? 503 : 500;
    return jsonResponse({ error: error.message || '上传失败' }, status);
  }
}

async function handleTransferRequest(request, config) {
  try {
    if (request.method !== 'POST' && request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
    }
    if (config.enableAuth) {
      validateAdminCredentials(config);
      if (!await isAuthenticated(request, config)) return unauthorizedResponse();
    }

    let targetUrl = '';
    if (request.method === 'POST') {
      const contentType = request.headers.get('Content-Type') || '';
      if (contentType.includes('application/json')) {
        const body = await request.json().catch(() => ({}));
        targetUrl = body.url || body.address || '';
      } else {
        const formData = await request.formData();
        targetUrl = formData.get('url') || formData.get('address') || '';
      }
    } else {
      const url = new URL(request.url);
      targetUrl = url.searchParams.get('url') || url.searchParams.get('address') || '';
    }
    if (!targetUrl) throw new Error('缺少地址参数');

    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      throw new Error('无效的地址');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('仅支持 http/https 地址');
    }

    const remoteResponse = await fetch(parsedUrl.href, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Telegraph-Hub-Transfer/1.0)' }
    });
    if (!remoteResponse.ok) {
      throw new Error(`远程地址请求失败 (${remoteResponse.status})`);
    }

    const rawMime = (remoteResponse.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    const urlExt = getFileExtension(parsedUrl.href);
    const mimeExt = MIME_TO_EXT[rawMime] || '';
    const ext = CONTENT_TYPE_MAP[urlExt] && (!mimeExt || mimeExt === urlExt) ? urlExt : mimeExt;
    if (!CONTENT_TYPE_MAP[ext]) {
      throw new Error(`不支持的类型: ${ext || rawMime || '未知'}`);
    }

    const maxBytes = config.maxSize;
    const contentLength = Number(remoteResponse.headers.get('Content-Length') || 0);
    if (contentLength > maxBytes) {
      throw new Error(`文件大小超过${maxBytes / (1024 * 1024)}MB限制`);
    }
    const buffer = await remoteResponse.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error(`文件大小超过${maxBytes / (1024 * 1024)}MB限制`);
    }

    let fileName = parsedUrl.pathname.split('/').pop() || '';
    if (getFileExtension(fileName) !== ext) {
      const baseName = fileName.replace(/\.[^/.]+$/, '');
      fileName = baseName ? `${baseName}.${ext}` : `file.${ext}`;
    }

    const mimeType = rawMime || getContentType(ext);
    const file = new File([buffer], fileName, { type: mimeType });
    const imageURL = await uploadFileToTelegraph(config, file, fileName);
    return jsonResponse({ data: imageURL });
  } catch (error) {
    console.error('转存失败:', error);
    const status = error instanceof ConfigurationError ? 503 : 500;
    return jsonResponse({ error: error.message || '转存失败' }, status);
  }
}

function renderApiDocsPage(config) {
  const apiBase = `/v1/api`;
  const maxSizeMb = config.maxSize / (1024 * 1024);
  const allowedTypes = ['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'BMP', 'SVG', 'MP4', 'AVI', 'MOV', 'WEBM', 'PDF'];

  return new Response(`<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RESTful API 文档 · Telegraph Hub</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    <script>
      tailwind.config = { darkMode: 'class' };
      if (localStorage.getItem('telegraphTheme') === 'light' || (!('telegraphTheme' in localStorage) && window.matchMedia('(prefers-color-scheme: light)').matches)) {
        document.documentElement.classList.remove('dark');
      } else {
        document.documentElement.classList.add('dark');
      }
    </script>
    <style>
      body { font-family: 'Plus Jakarta Sans', sans-serif; }
      .font-mono { font-family: 'JetBrains Mono', monospace; }
      .bg-grid { background-size: 32px 32px; background-image: linear-gradient(to right, rgba(148, 163, 184, 0.07) 1px, transparent 1px), linear-gradient(to bottom, rgba(148, 163, 184, 0.07) 1px, transparent 1px); }
      .dark .bg-grid { background-image: linear-gradient(to right, rgba(255, 255, 255, 0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255, 255, 255, 0.03) 1px, transparent 1px); }
      code.inline { @apply bg-slate-100 dark:bg-slate-950/70 border border-slate-200 dark:border-white/10 rounded px-1.5 py-0.5 text-[11px] font-mono text-indigo-600 dark:text-indigo-400; }
    </style>
  </head>
  <body class="bg-slate-50 dark:bg-[#0b0f17] text-slate-800 dark:text-slate-100 min-h-screen flex flex-col relative overflow-x-hidden selection:bg-indigo-500 selection:text-white transition-colors duration-300">
    <div class="fixed inset-0 pointer-events-none z-0">
      <div class="absolute -top-32 -left-24 w-[500px] h-[350px] bg-indigo-500/10 dark:bg-indigo-600/15 rounded-full blur-[140px]"></div>
      <div class="absolute bottom-0 right-0 w-[500px] h-[400px] bg-cyan-500/10 dark:bg-cyan-500/10 rounded-full blur-[130px]"></div>
      <div class="absolute inset-0 bg-grid"></div>
    </div>

    <header class="sticky top-0 z-40 h-16 bg-white/80 dark:bg-[#0b0f17]/80 backdrop-blur-xl border-b border-slate-200/80 dark:border-white/10 px-4 sm:px-8 flex items-center justify-between transition-colors duration-300">
      <a href="/" class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-500 via-indigo-600 to-cyan-400 flex items-center justify-center text-white text-base shadow-lg shadow-indigo-500/25">
          <i class="fa-solid fa-cloud-arrow-up"></i>
        </div>
        <div>
          <span class="font-extrabold text-base tracking-tight text-slate-900 dark:text-white">Telegraph Hub</span>
          <span class="hidden sm:inline-block ml-2 px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-[10px] font-semibold text-indigo-500 dark:text-indigo-400">API Docs</span>
        </div>
      </a>
      <div class="flex items-center gap-2">
        <button type="button" id="theme-toggle" class="h-9 px-3 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white flex items-center gap-1.5 transition" title="日夜间模式切换">
          <i class="fa-solid fa-sun text-amber-500 dark:hidden"></i>
          <i class="fa-solid fa-moon text-indigo-400 hidden dark:inline-block"></i>
          <span class="text-[11px] hidden md:inline">模式</span>
        </button>
        <a href="/" class="h-9 px-3.5 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white flex items-center gap-2 transition">
          <i class="fa-solid fa-upload text-indigo-500 dark:text-indigo-400"></i>
          <span>上传中心</span>
        </a>
      </div>
    </header>

    <main class="relative z-10 flex-1 w-full max-w-4xl mx-auto px-4 py-10 sm:py-14 space-y-8">
      <div class="text-center space-y-3">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-xs text-indigo-600 dark:text-indigo-400 font-semibold">
          <i class="fa-solid fa-terminal text-[11px]"></i>
          <span>RESTful API 接口文档</span>
        </div>
        <h1 class="text-3xl sm:text-4xl font-black text-slate-900 dark:text-white tracking-tight">开放接口快速上手</h1>
        <p class="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">全部接口基于 <code class="inline">${escapeHtml(apiBase)}</code> 前缀，遵循 RESTful 风格，统一要求身份认证。</p>
      </div>

      <section class="bg-white/90 dark:bg-slate-900/80 backdrop-blur-2xl border border-slate-200/80 dark:border-white/10 rounded-3xl p-6 sm:p-8 shadow-2xl shadow-indigo-500/5 dark:shadow-black/60 space-y-5">
        <div class="flex items-center gap-3 pb-4 border-b border-slate-200/80 dark:border-white/5">
          <div class="w-10 h-10 rounded-2xl bg-gradient-to-tr from-amber-500 to-orange-500 text-white flex items-center justify-center text-base shadow-lg shadow-amber-500/25 flex-shrink-0">
            <i class="fa-solid fa-key"></i>
          </div>
          <div>
            <h2 class="text-sm font-bold text-slate-800 dark:text-white">身份认证</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">所有接口必须携带 Basic Auth 凭证</p>
          </div>
        </div>
        <div class="space-y-3">
          <p class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            在请求头中添加 <code class="inline">Authorization</code>，值为 <code class="inline">Basic</code> + 空格 + 使用环境变量 <code class="inline">USERNAME</code> 与 <code class="inline">PASSWORD</code> 拼接后经 Base64 编码的字符串。
          </p>
          <div class="rounded-2xl bg-slate-950 dark:bg-black/60 border border-slate-800 dark:border-white/10 p-4 overflow-x-auto">
            <pre class="text-[12px] leading-relaxed text-slate-200 font-mono"># 生成凭证（示例）
printf '%s:%s' "YOUR_USERNAME" "YOUR_PASSWORD" | base64</pre>
          </div>
          <div class="rounded-2xl bg-slate-950 dark:bg-black/60 border border-slate-800 dark:border-white/10 p-4 overflow-x-auto">
            <pre class="text-[12px] leading-relaxed text-slate-200 font-mono">Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=</pre>
          </div>
          <div class="grid gap-2">
            <div class="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300 p-3 rounded-xl bg-slate-100/70 dark:bg-white/5 border border-slate-200/80 dark:border-white/5">
              <i class="fa-solid fa-circle-check text-emerald-500 mt-0.5"></i>
              <span>凭证错误或缺失时返回 <code class="inline">401 Unauthorized</code>。</span>
            </div>
            <div class="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300 p-3 rounded-xl bg-slate-100/70 dark:bg-white/5 border border-slate-200/80 dark:border-white/5">
              <i class="fa-solid fa-circle-info text-indigo-500 mt-0.5"></i>
              <span>接口不支持匿名访问，<code class="inline">ENABLE_AUTH</code> 配置不适用于开放接口，认证始终开启。</span>
            </div>
          </div>
        </div>
      </section>

      <section class="bg-white/90 dark:bg-slate-900/80 backdrop-blur-2xl border border-slate-200/80 dark:border-white/10 rounded-3xl p-6 sm:p-8 shadow-2xl shadow-indigo-500/5 dark:shadow-black/60 space-y-6">
        <div class="flex items-center gap-3 pb-4 border-b border-slate-200/80 dark:border-white/5">
          <div class="w-10 h-10 rounded-2xl bg-gradient-to-tr from-cyan-500 to-indigo-500 text-white flex items-center justify-center text-base shadow-lg shadow-cyan-500/25 flex-shrink-0">
            <i class="fa-solid fa-cloud-arrow-up"></i>
          </div>
          <div>
            <h2 class="text-sm font-bold text-slate-800 dark:text-white">上传文件</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">将本地文件上传并返回 CDN 直链</p>
          </div>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <span class="px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs font-bold font-mono">POST</span>
          <code class="inline text-sm">${escapeHtml(apiBase)}/files</code>
          <span class="text-xs text-slate-400">multipart/form-data</span>
        </div>

        <div class="space-y-2">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">请求参数</h3>
          <div class="overflow-x-auto rounded-2xl border border-slate-200/80 dark:border-white/10">
            <table class="w-full text-left text-xs">
              <thead>
                <tr class="bg-slate-100/80 dark:bg-slate-950/50 border-b border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 font-mono">
                  <th class="py-2.5 px-4 font-semibold">字段</th>
                  <th class="py-2.5 px-4 font-semibold">类型</th>
                  <th class="py-2.5 px-4 font-semibold">必填</th>
                  <th class="py-2.5 px-4 font-semibold">说明</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-200/60 dark:divide-white/5 text-slate-600 dark:text-slate-300">
                <tr>
                  <td class="py-3 px-4 font-mono text-indigo-600 dark:text-indigo-400">file</td>
                  <td class="py-3 px-4 font-mono">File</td>
                  <td class="py-3 px-4 text-emerald-600 dark:text-emerald-400 font-semibold">是</td>
                  <td class="py-3 px-4">要上传的文件，支持 ${allowedTypes.join(' / ')}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="space-y-2">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">curl 示例</h3>
          <div class="rounded-2xl bg-slate-950 dark:bg-black/60 border border-slate-800 dark:border-white/10 p-4 overflow-x-auto">
            <pre class="text-[12px] leading-relaxed text-slate-200 font-mono">curl -X POST "${escapeHtml(apiBase)}/files" \\
  -H "Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=" \\
  -F "file=@/path/to/image.png"</pre>
          </div>
        </div>

        <div class="space-y-2">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">响应示例</h3>
          <div class="rounded-2xl bg-slate-950 dark:bg-black/60 border border-slate-800 dark:border-white/10 p-4 overflow-x-auto">
            <pre class="text-[12px] leading-relaxed text-slate-200 font-mono">{
  "data": "https://${escapeHtml(config.domain || 'your.domain')}/20261008/Ab3xYz9QkLmNpQrS/example.png"
}</pre>
          </div>
          <div class="grid gap-2">
            <div class="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300 p-3 rounded-xl bg-slate-100/70 dark:bg-white/5 border border-slate-200/80 dark:border-white/5">
              <i class="fa-solid fa-circle-check text-emerald-500 mt-0.5"></i>
              <span><code class="inline">200</code> 上传成功，<code class="inline">data</code> 字段为文件直链。</span>
            </div>
            <div class="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300 p-3 rounded-xl bg-slate-100/70 dark:bg-white/5 border border-slate-200/80 dark:border-white/5">
              <i class="fa-solid fa-circle-info text-indigo-500 mt-0.5"></i>
              <span><code class="inline">413</code> 文件超过 ${maxSizeMb}MB 上限；<code class="inline">401</code> 未认证。</span>
            </div>
          </div>
        </div>
      </section>

      <section class="bg-white/90 dark:bg-slate-900/80 backdrop-blur-2xl border border-slate-200/80 dark:border-white/10 rounded-3xl p-6 sm:p-8 shadow-2xl shadow-indigo-500/5 dark:shadow-black/60 space-y-6">
        <div class="flex items-center gap-3 pb-4 border-b border-slate-200/80 dark:border-white/5">
          <div class="w-10 h-10 rounded-2xl bg-gradient-to-tr from-rose-500 to-orange-500 text-white flex items-center justify-center text-base shadow-lg shadow-rose-500/25 flex-shrink-0">
            <i class="fa-solid fa-trash-can"></i>
          </div>
          <div>
            <h2 class="text-sm font-bold text-slate-800 dark:text-white">删除文件</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">按文件地址删除，文件不存在时直接返回成功</p>
          </div>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <span class="px-3 py-1.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-500 dark:text-rose-400 text-xs font-bold font-mono">DELETE</span>
          <code class="inline text-sm">${escapeHtml(apiBase)}/files?url={fileUrl}</code>
          <span class="text-xs text-slate-400">也支持 JSON body</span>
        </div>

        <div class="space-y-2">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">请求参数</h3>
          <div class="overflow-x-auto rounded-2xl border border-slate-200/80 dark:border-white/10">
            <table class="w-full text-left text-xs">
              <thead>
                <tr class="bg-slate-100/80 dark:bg-slate-950/50 border-b border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 font-mono">
                  <th class="py-2.5 px-4 font-semibold">字段</th>
                  <th class="py-2.5 px-4 font-semibold">位置</th>
                  <th class="py-2.5 px-4 font-semibold">必填</th>
                  <th class="py-2.5 px-4 font-semibold">说明</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-200/60 dark:divide-white/5 text-slate-600 dark:text-slate-300">
                <tr>
                  <td class="py-3 px-4 font-mono text-indigo-600 dark:text-indigo-400">url</td>
                  <td class="py-3 px-4 font-mono">query / JSON</td>
                  <td class="py-3 px-4 text-emerald-600 dark:text-emerald-400 font-semibold">是</td>
                  <td class="py-3 px-4">待删除文件的完整直链（可含任意主域名）</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="space-y-2">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">curl 示例</h3>
          <div class="rounded-2xl bg-slate-950 dark:bg-black/60 border border-slate-800 dark:border-white/10 p-4 overflow-x-auto">
            <pre class="text-[12px] leading-relaxed text-slate-200 font-mono">curl -X DELETE "${escapeHtml(apiBase)}/files?url=https://${escapeHtml(config.domain || 'your.domain')}/20261008/Ab3xYz9QkLmNpQrS/example.png" \\
  -H "Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ="</pre>
          </div>
        </div>

        <div class="space-y-2">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">响应示例</h3>
          <div class="rounded-2xl bg-slate-950 dark:bg-black/60 border border-slate-800 dark:border-white/10 p-4 overflow-x-auto">
            <pre class="text-[12px] leading-relaxed text-slate-200 font-mono">// 删除成功
{ "success": true, "deleted": 1 }
// 文件不存在（同样返回成功）
{ "success": true, "deleted": 0 }</pre>
          </div>
        </div>
      </section>

      <section class="bg-white/90 dark:bg-slate-900/80 backdrop-blur-2xl border border-slate-200/80 dark:border-white/10 rounded-3xl p-6 sm:p-8 shadow-2xl shadow-indigo-500/5 dark:shadow-black/60 space-y-6">
        <div class="flex items-center gap-3 pb-4 border-b border-slate-200/80 dark:border-white/5">
          <div class="w-10 h-10 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-500 text-white flex items-center justify-center text-base shadow-lg shadow-emerald-500/25 flex-shrink-0">
            <i class="fa-solid fa-arrow-right-to-bracket"></i>
          </div>
          <div>
            <h2 class="text-sm font-bold text-slate-800 dark:text-white">URL 远程转存</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">拉取远程资源并托管至本平台 CDN</p>
          </div>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <span class="px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs font-bold font-mono">POST</span>
          <code class="inline text-sm">${escapeHtml(apiBase)}/transfer</code>
          <span class="text-xs text-slate-400">application/json</span>
        </div>

        <div class="space-y-2">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">请求参数</h3>
          <div class="overflow-x-auto rounded-2xl border border-slate-200/80 dark:border-white/10">
            <table class="w-full text-left text-xs">
              <thead>
                <tr class="bg-slate-100/80 dark:bg-slate-950/50 border-b border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 font-mono">
                  <th class="py-2.5 px-4 font-semibold">字段</th>
                  <th class="py-2.5 px-4 font-semibold">类型</th>
                  <th class="py-2.5 px-4 font-semibold">必填</th>
                  <th class="py-2.5 px-4 font-semibold">说明</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-200/60 dark:divide-white/5 text-slate-600 dark:text-slate-300">
                <tr>
                  <td class="py-3 px-4 font-mono text-indigo-600 dark:text-indigo-400">url</td>
                  <td class="py-3 px-4 font-mono">string</td>
                  <td class="py-3 px-4 text-emerald-600 dark:text-emerald-400 font-semibold">是</td>
                  <td class="py-3 px-4">远程 http/https 资源地址，类型需为 ${allowedTypes.join(' / ')}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="space-y-2">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">curl 示例</h3>
          <div class="rounded-2xl bg-slate-950 dark:bg-black/60 border border-slate-800 dark:border-white/10 p-4 overflow-x-auto">
            <pre class="text-[12px] leading-relaxed text-slate-200 font-mono">curl -X POST "${escapeHtml(apiBase)}/transfer" \\
  -H "Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/image.jpg"}'</pre>
          </div>
        </div>

        <div class="space-y-2">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">响应示例</h3>
          <div class="rounded-2xl bg-slate-950 dark:bg-black/60 border border-slate-800 dark:border-white/10 p-4 overflow-x-auto">
            <pre class="text-[12px] leading-relaxed text-slate-200 font-mono">{
  "data": "https://${escapeHtml(config.domain || 'your.domain')}/20261008/QwErTy9UjIkMnBvCx/remote.jpg"
}</pre>
          </div>
          <div class="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300 p-3 rounded-xl bg-slate-100/70 dark:bg-white/5 border border-slate-200/80 dark:border-white/5">
            <i class="fa-solid fa-circle-info text-indigo-500 mt-0.5"></i>
            <span>不支持的类型或超出 ${maxSizeMb}MB 上限时返回 <code class="inline">500</code>，可通过 <code class="inline">error</code> 字段查看原因。</span>
          </div>
        </div>
      </section>

      <section class="bg-white/90 dark:bg-slate-900/80 backdrop-blur-2xl border border-slate-200/80 dark:border-white/10 rounded-3xl p-6 sm:p-8 shadow-2xl shadow-indigo-500/5 dark:shadow-black/60 space-y-4">
        <div class="flex items-center gap-3 pb-4 border-b border-slate-200/80 dark:border-white/5">
          <div class="w-10 h-10 rounded-2xl bg-gradient-to-tr from-slate-600 to-slate-800 text-white flex items-center justify-center text-base shadow-lg shadow-slate-500/25 flex-shrink-0">
            <i class="fa-solid fa-list-check"></i>
          </div>
          <div>
            <h2 class="text-sm font-bold text-slate-800 dark:text-white">接口总览</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">全部接口一览表</p>
          </div>
        </div>
        <div class="overflow-x-auto rounded-2xl border border-slate-200/80 dark:border-white/10">
          <table class="w-full text-left text-xs">
            <thead>
              <tr class="bg-slate-100/80 dark:bg-slate-950/50 border-b border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 font-mono">
                <th class="py-2.5 px-4 font-semibold">方法</th>
                <th class="py-2.5 px-4 font-semibold">路径</th>
                <th class="py-2.5 px-4 font-semibold">说明</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200/60 dark:divide-white/5 text-slate-600 dark:text-slate-300">
              <tr>
                <td class="py-3 px-4"><span class="px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 font-mono font-bold text-[10px]">POST</span></td>
                <td class="py-3 px-4 font-mono text-indigo-600 dark:text-indigo-400">${escapeHtml(apiBase)}/files</td>
                <td class="py-3 px-4">上传文件（multipart）</td>
              </tr>
              <tr>
                <td class="py-3 px-4"><span class="px-2 py-1 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-500 dark:text-rose-400 font-mono font-bold text-[10px]">DELETE</span></td>
                <td class="py-3 px-4 font-mono text-indigo-600 dark:text-indigo-400">${escapeHtml(apiBase)}/files?url=...</td>
                <td class="py-3 px-4">删除文件（幂等，不存在也返回成功）</td>
              </tr>
              <tr>
                <td class="py-3 px-4"><span class="px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 font-mono font-bold text-[10px]">POST</span></td>
                <td class="py-3 px-4 font-mono text-indigo-600 dark:text-indigo-400">${escapeHtml(apiBase)}/transfer</td>
                <td class="py-3 px-4">URL 远程转存（JSON）</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>

    <footer class="mt-auto border-t border-slate-200/80 dark:border-white/5 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
      <p>© 2026 Telegraph Hub · RESTful API 文档</p>
    </footer>

    <script>
      (function() {
        const themeToggle = document.getElementById('theme-toggle');
        themeToggle?.addEventListener('click', () => {
          const isDark = document.documentElement.classList.toggle('dark');
          localStorage.setItem('telegraphTheme', isDark ? 'dark' : 'light');
        });
      })();
    </script>
  </body>
  </html>`, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' }
  });
}

async function handleApiRequest(request, config, pathname) {
  validateAdminCredentials(config);
  if (!await isAuthenticated(request, config)) {
    return unauthorizedResponse();
  }
  if (pathname === '/v1/api/files' && request.method === 'POST') {
    return await apiUploadFile(request, config);
  }
  if (pathname === '/v1/api/files' && request.method === 'DELETE') {
    return await apiDeleteFile(request, config);
  }
  if (pathname === '/v1/api/transfer' && request.method === 'POST') {
    return await apiTransferFile(request, config);
  }
  if (pathname === '/v1/api/files') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, DELETE' } });
  }
  if (pathname === '/v1/api/transfer') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  return jsonResponse({ error: 'Not Found' }, 404);
}

async function apiUploadFile(request, config) {
  return await handleUploadRequest(request, config);
}

async function apiTransferFile(request, config) {
  return await handleTransferRequest(request, config);
}

async function extractDeleteTarget(request) {
  const url = new URL(request.url);
  const queryUrl = url.searchParams.get('url') || url.searchParams.get('address') || '';
  if (queryUrl) return queryUrl;
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => ({}));
    return body.url || body.address || '';
  }
  return '';
}

async function apiDeleteFile(request, config) {
  try {
    const target = await extractDeleteTarget(request);
    if (!target) return jsonResponse({ error: '缺少 url 参数' }, 400);

    const database = getDatabase(config);
    await ensureDatabaseSchema(database);

    let rows;
    try {
      const parsed = new URL(target);
      const cleanTarget = `${parsed.origin}${parsed.pathname}`;
      const result = await database.prepare(
          'SELECT url, messageId FROM media WHERE url = ? OR url = ? OR url LIKE ?'
      ).bind(target, cleanTarget, `%${parsed.pathname}`).all();
      rows = result.results || [];
    } catch {
      const result = await database.prepare(
          'SELECT url, messageId FROM media WHERE url = ?'
      ).bind(target).all();
      rows = result.results || [];
    }

    const urlsToDelete = rows.map(row => row.url);
    if (urlsToDelete.length === 0) {
      return jsonResponse({ success: true, deleted: 0 });
    }

    const messageIds = rows.map(row => row.messageId).filter(id => id != null);
    const placeholders = urlsToDelete.map(() => '?').join(',');
    const cache = caches.default;

    const [dbResult] = await Promise.all([
      database.prepare(`DELETE FROM media WHERE url IN (${placeholders})`).bind(...urlsToDelete).run(),
      Promise.all(urlsToDelete.map(async (itemUrl) => {
        const cacheKey = new Request(itemUrl);
        await cache.delete(cacheKey);
      })),
      ...(config.tgBotToken && config.tgChatId ? [Promise.all(messageIds.map(async (msgId) => {
        try {
          await fetch(
              `https://api.telegram.org/bot${config.tgBotToken}/deleteMessage`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: config.tgChatId, message_id: msgId })
              }
          );
        } catch {}
      }))] : [])
    ]);

    const deletedCount = dbResult.meta?.changes ?? dbResult.changes ?? urlsToDelete.length;
    return jsonResponse({ success: true, deleted: deletedCount });
  } catch (error) {
    console.error('API 删除失败:', error);
    return jsonResponse({ error: error.message || '删除失败' }, 500);
  }
}

function renderPdfViewerPage({ fileName, rawUrl, downloadUrl, isEmbed }) {
  return new Response(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=2.0">
  <title>${escapeHtml(fileName)} · PDF 在线预览</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script>
    if (typeof pdfjsLib === 'undefined') {
      document.write('<script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js"><\\/script>');
    }
  </script>
  <script>
    tailwind.config = { darkMode: 'class' };
    if (localStorage.getItem('telegraphTheme') === 'light' || (!('telegraphTheme' in localStorage) && window.matchMedia('(prefers-color-scheme: light)').matches)) {
      document.documentElement.classList.remove('dark');
    } else {
      document.documentElement.classList.add('dark');
    }
  </script>
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; }
    .font-mono { font-family: 'JetBrains Mono', monospace; }
    #pdf-canvas { max-width: 100%; height: auto; }
    .bg-grid { background-size: 32px 32px; background-image: linear-gradient(to right, rgba(148, 163, 184, 0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(148, 163, 184, 0.05) 1px, transparent 1px); }
    .dark .bg-grid { background-image: linear-gradient(to right, rgba(255, 255, 255, 0.02) 1px, transparent 1px), linear-gradient(to bottom, rgba(255, 255, 255, 0.02) 1px, transparent 1px); }
  </style>
</head>
<body class="bg-slate-100 dark:bg-[#0b0f17] text-slate-800 dark:text-slate-100 min-h-screen flex flex-col selection:bg-indigo-500 selection:text-white transition-colors duration-300">
  <header class="sticky top-0 z-30 bg-white/90 dark:bg-[#0b0f17]/90 backdrop-blur-xl border-b border-slate-200 dark:border-white/10 px-3 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-3 shadow-sm">
    <div class="flex items-center gap-3 min-w-0">
      ${!isEmbed ? `
      <a href="/" class="flex items-center gap-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white text-xs font-semibold transition flex-shrink-0" title="返回首页">
        <i class="fa-solid fa-arrow-left"></i>
        <span class="hidden sm:inline">首页</span>
      </a>
      <span class="text-slate-300 dark:text-slate-700 hidden sm:inline">|</span>
      ` : ''}
      <div class="flex items-center gap-2 min-w-0">
        <div class="w-7 h-7 rounded-lg bg-rose-500/10 text-rose-500 flex items-center justify-center flex-shrink-0 text-sm">
          <i class="fa-solid fa-file-pdf"></i>
        </div>
        <span class="text-xs font-bold text-slate-800 dark:text-white truncate max-w-[150px] sm:max-w-xs md:max-w-md" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</span>
      </div>
    </div>

    <div class="flex items-center gap-1.5 sm:gap-2">
      <div class="flex items-center bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-0.5 text-xs">
        <button type="button" id="btn-prev" class="w-7 h-7 rounded-lg hover:bg-white dark:hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none text-slate-600 dark:text-slate-300 flex items-center justify-center transition" title="上一页 (←)">
          <i class="fa-solid fa-chevron-left text-[11px]"></i>
        </button>
        <div class="px-2 font-mono text-xs text-slate-600 dark:text-slate-400 flex items-center gap-1">
          <input type="number" id="page-num" min="1" value="1" class="w-10 h-6 text-center rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-white/10 text-slate-800 dark:text-white text-xs outline-none">
          <span>/</span>
          <span id="page-total">1</span>
        </div>
        <button type="button" id="btn-next" class="w-7 h-7 rounded-lg hover:bg-white dark:hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none text-slate-600 dark:text-slate-300 flex items-center justify-center transition" title="下一页 (→)">
          <i class="fa-solid fa-chevron-right text-[11px]"></i>
        </button>
      </div>

      <div class="hidden sm:flex items-center bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-0.5 text-xs">
        <button type="button" id="btn-zoom-out" class="w-7 h-7 rounded-lg hover:bg-white dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center transition" title="缩小 (-)">
          <i class="fa-solid fa-minus text-[11px]"></i>
        </button>
        <span id="zoom-text" class="px-2 font-mono text-[11px] text-slate-600 dark:text-slate-400 min-w-[45px] text-center">100%</span>
        <button type="button" id="btn-zoom-in" class="w-7 h-7 rounded-lg hover:bg-white dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center transition" title="放大 (+)">
          <i class="fa-solid fa-plus text-[11px]"></i>
        </button>
        <button type="button" id="btn-zoom-fit" class="h-7 px-2 rounded-lg hover:bg-white dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center gap-1 text-[11px] transition" title="适合宽度">
          <i class="fa-solid fa-arrows-left-right-to-line text-[10px]"></i>
        </button>
      </div>
    </div>

    <div class="flex items-center gap-1.5">
      <button type="button" id="theme-btn" class="w-8 h-8 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 flex items-center justify-center transition text-xs" title="切换模式">
        <i class="fa-solid fa-circle-half-stroke"></i>
      </button>
      <a href="${escapeHtml(rawUrl)}" target="_blank" rel="noopener" class="h-8 px-2.5 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition" title="浏览器原生全屏预览">
        <i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>
        <span class="hidden md:inline">原生</span>
      </a>
      <a href="${escapeHtml(downloadUrl)}" class="h-8 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-sm shadow-indigo-500/20 flex items-center gap-1.5 transition">
        <i class="fa-solid fa-download text-[11px]"></i>
        <span>下载</span>
      </a>
    </div>
  </header>

  <main id="viewer-container" class="flex-1 overflow-auto p-4 sm:p-8 flex flex-col items-center justify-start relative bg-grid">
    <div id="loading-box" class="py-24 flex flex-col items-center justify-center gap-3">
      <div class="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-xl animate-spin">
        <i class="fa-solid fa-circle-notch"></i>
      </div>
      <p class="text-xs font-semibold text-slate-600 dark:text-slate-400">正在解析并渲染 PDF 文档...</p>
    </div>

    <div id="error-box" class="hidden max-w-md w-full py-12 px-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-white/10 rounded-2xl text-center shadow-xl my-auto">
      <div class="w-12 h-12 rounded-2xl bg-rose-500/10 text-rose-500 flex items-center justify-center text-xl mx-auto mb-3">
        <i class="fa-solid fa-triangle-exclamation"></i>
      </div>
      <h3 class="text-sm font-bold text-slate-800 dark:text-white mb-1">PDF 在线预览失败</h3>
      <p id="error-msg" class="text-xs text-slate-500 dark:text-slate-400 mb-4">文档可能已损坏或受到网络环境限制</p>
      <div class="flex gap-2 justify-center">
        <a href="${escapeHtml(downloadUrl)}" class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition flex items-center gap-1.5">
          <i class="fa-solid fa-download"></i>
          <span>下载文件到本地查看</span>
        </a>
      </div>
    </div>

    <canvas id="pdf-canvas" class="hidden shadow-2xl rounded-2xl border border-slate-200 dark:border-white/10 bg-white dark:bg-slate-950 transition-all duration-200"></canvas>
  </main>

  <script>
    (function() {
      const pdfUrl = ${JSON.stringify(rawUrl)};
      const container = document.getElementById('viewer-container');
      const canvas = document.getElementById('pdf-canvas');
      const ctx = canvas.getContext('2d');
      const loadingBox = document.getElementById('loading-box');
      const errorBox = document.getElementById('error-box');
      const errorMsg = document.getElementById('error-msg');
      const pageNumInput = document.getElementById('page-num');
      const pageTotalSpan = document.getElementById('page-total');
      const btnPrev = document.getElementById('btn-prev');
      const btnNext = document.getElementById('btn-next');
      const btnZoomIn = document.getElementById('btn-zoom-in');
      const btnZoomOut = document.getElementById('btn-zoom-out');
      const btnZoomFit = document.getElementById('btn-zoom-fit');
      const zoomText = document.getElementById('zoom-text');
      const themeBtn = document.getElementById('theme-btn');

      let pdfDoc = null;
      let pageNum = 1;
      let pageRendering = false;
      let pageNumPending = null;
      let scale = window.innerWidth < 640 ? 0.9 : 1.35;

      themeBtn?.addEventListener('click', () => {
        const isDark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('telegraphTheme', isDark ? 'dark' : 'light');
      });

      function updateZoomText() {
        if (zoomText) zoomText.textContent = Math.round(scale * 100) + '%';
      }

      function renderPage(num) {
        pageRendering = true;
        btnPrev.disabled = num <= 1;
        btnNext.disabled = pdfDoc && num >= pdfDoc.numPages;

        pdfDoc.getPage(num).then(page => {
          const viewport = page.getViewport({ scale });
          const outputScale = window.devicePixelRatio || 1;
          canvas.width = Math.floor(viewport.width * outputScale);
          canvas.height = Math.floor(viewport.height * outputScale);
          canvas.style.width = Math.floor(viewport.width) + 'px';
          canvas.style.height = Math.floor(viewport.height) + 'px';

          const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
          const renderContext = {
            canvasContext: ctx,
            transform: transform,
            viewport: viewport
          };

          const renderTask = page.render(renderContext);
          renderTask.promise.then(() => {
            pageRendering = false;
            loadingBox.classList.add('hidden');
            canvas.classList.remove('hidden');
            if (pageNumPending !== null) {
              renderPage(pageNumPending);
              pageNumPending = null;
            }
          });
        }).catch(err => {
          pageRendering = false;
          showError(err.message);
        });

        pageNumInput.value = num;
      }

      function queueRenderPage(num) {
        if (pageRendering) pageNumPending = num;
        else renderPage(num);
      }

      function onPrevPage() {
        if (pageNum <= 1) return;
        pageNum--;
        queueRenderPage(pageNum);
      }

      function onNextPage() {
        if (!pdfDoc || pageNum >= pdfDoc.numPages) return;
        pageNum++;
        queueRenderPage(pageNum);
      }

      function fitWidth() {
        if (!pdfDoc) return;
        pdfDoc.getPage(pageNum).then(page => {
          const availWidth = Math.max(300, container.clientWidth - 48);
          const baseViewport = page.getViewport({ scale: 1.0 });
          scale = Math.max(0.4, Math.min(3.0, availWidth / baseViewport.width));
          updateZoomText();
          queueRenderPage(pageNum);
        });
      }

      function showError(msg) {
        loadingBox.classList.add('hidden');
        canvas.classList.add('hidden');
        errorBox.classList.remove('hidden');
        if (errorMsg && msg) errorMsg.textContent = msg;
      }

      btnPrev.addEventListener('click', onPrevPage);
      btnNext.addEventListener('click', onNextPage);
      btnZoomIn?.addEventListener('click', () => {
        scale = Math.min(3.0, scale + 0.2);
        updateZoomText();
        queueRenderPage(pageNum);
      });
      btnZoomOut?.addEventListener('click', () => {
        scale = Math.max(0.4, scale - 0.2);
        updateZoomText();
        queueRenderPage(pageNum);
      });
      btnZoomFit?.addEventListener('click', fitWidth);

      pageNumInput.addEventListener('change', () => {
        const val = parseInt(pageNumInput.value, 10);
        if (Number.isFinite(val) && val >= 1 && pdfDoc && val <= pdfDoc.numPages) {
          pageNum = val;
          queueRenderPage(pageNum);
        } else {
          pageNumInput.value = pageNum;
        }
      });

      document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT') return;
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') onPrevPage();
        else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
          if (e.key === ' ') e.preventDefault();
          onNextPage();
        }
      });

      if (typeof pdfjsLib === 'undefined') {
        showError('无法加载 PDF 解析引擎，请检查网络或直接下载');
        return;
      }

      const pdfjs = window.pdfjsLib;
      pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

      updateZoomText();

      const loadingTask = pdfjs.getDocument({
        url: pdfUrl,
        cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
        cMapPacked: true
      });

      loadingTask.promise.then(doc => {
        pdfDoc = doc;
        pageTotalSpan.textContent = doc.numPages;
        pageNumInput.max = doc.numPages;
        if (window.innerWidth < 640) fitWidth();
        else renderPage(pageNum);
      }).catch(err => {
        showError(err.message || '文档加载失败');
      });
    })();
  </script>
</body>
</html>`, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'CDN-Cache-Control': 'public, max-age=3600'
    }
  });
}

async function handleImageRequest(request, config) {
  const requestedUrl = request.url;
  const cache = caches.default;
  const cacheKey = new Request(requestedUrl);
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;
  const database = getDatabase(config);
  await ensureDatabaseSchema(database);
  const urlObj = new URL(request.url);
  const cleanUrl = `${urlObj.origin}${urlObj.pathname}`;
  const pathname = urlObj.pathname;
  const result = await database.prepare(
      'SELECT fileId FROM media WHERE url = ? OR url = ? OR substr(url, -length(?)) = ?'
  ).bind(cleanUrl, requestedUrl, pathname, pathname).first();
  if (!result) {
    const notFoundResponse = new Response('资源不存在', { status: 404 });
    await cache.put(cacheKey, notFoundResponse.clone());
    return notFoundResponse;
  }

  const fileExtension = getFileExtension(cleanUrl);
  const isPdf = fileExtension === 'pdf';
  const isRaw = urlObj.searchParams.has('raw');
  const isDownload = urlObj.searchParams.has('download');
  const isEmbed = urlObj.searchParams.has('embed');
  const acceptHeader = request.headers.get('Accept') || '';
  const secFetchDest = request.headers.get('sec-fetch-dest') || '';
  const isBrowserNavigation = isEmbed || urlObj.searchParams.has('preview') || ((acceptHeader.includes('text/html') || secFetchDest === 'document') && !isRaw && !isDownload);

  if (isPdf && isBrowserNavigation) {
    const fileName = cleanUrl.split('/').pop() || 'document.pdf';
    const rawUrl = `${pathname}?raw=true`;
    const downloadUrl = `${pathname}?download=1`;
    return renderPdfViewerPage({ fileName, rawUrl, downloadUrl, isEmbed });
  }

  const fileId = result.fileId;
  let filePath;
  const getFileFailures = [];
  for (let attempts = 0; attempts < 3; attempts++) {
    let getFilePath;
    try {
      getFilePath = await fetch(
          `https://api.telegram.org/bot${config.tgBotToken}/getFile?file_id=${fileId}`
      );
    } catch (error) {
      console.error('[图片访问诊断] Telegram getFile 请求异常:', {
        pathname,
        attempt: attempts + 1,
        name: error?.name,
        message: error?.message
      });
      throw error;
    }
    if (!getFilePath.ok) {
      let telegramError = {};
      try {
        const errorData = await getFilePath.clone().json();
        telegramError = {
          telegramErrorCode: errorData?.error_code,
          telegramDescription: errorData?.description
        };
      } catch {
        // Some upstream errors are not returned as JSON. Keep the HTTP status for diagnosis.
      }
      getFileFailures.push({
        attempt: attempts + 1,
        httpStatus: getFilePath.status,
        ...telegramError
      });
      continue;
    }

    let fileData;
    try {
      fileData = await getFilePath.json();
    } catch (error) {
      console.error('[图片访问诊断] Telegram getFile 返回了无法解析的 JSON:', {
        pathname,
        attempt: attempts + 1,
        httpStatus: getFilePath.status,
        name: error?.name,
        message: error?.message
      });
      throw error;
    }

    if (fileData?.ok && fileData.result?.file_path) {
      filePath = fileData.result.file_path;
      break;
    }
    getFileFailures.push({
      attempt: attempts + 1,
      httpStatus: getFilePath.status,
      telegramErrorCode: fileData?.error_code,
      telegramDescription: fileData?.description || '响应中没有 file_path'
    });
  }
  if (!filePath) {
    console.error('[图片访问诊断] Telegram getFile 重试后仍未返回 file_path:', {
      pathname,
      attempts: getFileFailures
    });
    // Do not cache upstream failures: a transient Telegram error should not poison this URL.
    return new Response('未找到FilePath', { status: 502 });
  }
  const getFileResponse = `https://api.telegram.org/file/bot${config.tgBotToken}/${filePath}`;
  const rangeHeader = request.headers.get('range');
  const fetchHeaders = {};
  if (rangeHeader) {
    fetchHeaders['Range'] = rangeHeader;
  }
  let response;
  try {
    response = await fetch(getFileResponse, { headers: fetchHeaders });
  } catch (error) {
    console.error('[图片访问诊断] Telegram 文件下载请求异常:', {
      pathname,
      rangeRequested: Boolean(rangeHeader),
      name: error?.name,
      message: error?.message
    });
    throw error;
  }
  if (!response.ok && response.status !== 206) {
    console.error('[图片访问诊断] Telegram 文件下载返回非成功状态:', {
      pathname,
      httpStatus: response.status,
      rangeRequested: Boolean(rangeHeader)
    });
    return new Response('获取文件内容失败', { status: 500 });
  }
  const contentType = getContentType(fileExtension);
  const headers = new Headers(response.headers);
  headers.set('Content-Type', contentType);
  const fileName = cleanUrl.split('/').pop() || `file.${fileExtension}`;
  headers.set('Content-Disposition', isDownload ? `attachment; filename="${fileName}"` : `inline; filename="${fileName}"`);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  headers.set('Accept-Ranges', 'bytes');
  if (typeof headers.delete === 'function') {
    headers.delete('content-security-policy');
    headers.delete('x-frame-options');
  }
  headers.set('Cache-Control', `public, max-age=${CACHE_CONFIG.IMAGE}`);
  headers.set('CDN-Cache-Control', `public, max-age=${CACHE_CONFIG.IMAGE}`);
  const responseToCache = new Response(response.body, {
    status: response.status,
    headers
  });
  if (response.status === 200 && request.method === 'GET' && !rangeHeader) {
    await cache.put(cacheKey, responseToCache.clone());
  }
  return responseToCache;
}

async function handleBingImagesRequest() {
  const cache = caches.default;
  const cacheKey = new Request('https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=5');
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;
  const res = await fetch(cacheKey);
  if (!res.ok) {
    return new Response('请求 Bing API 失败', { status: res.status });
  }
  const bingData = await res.json();
  const images = bingData.images.map(image => ({
    url: `https://cn.bing.com${image.url}`
  }));
  const returnData = {
    status: true,
    message: "操作成功",
    data: images
  };
  const response = createCachedResponse(
      JSON.stringify(returnData),
      'application/json',
      CACHE_CONFIG.API
  );
  await cache.put(cacheKey, response.clone());
  return response;
}

async function handleDeleteImagesRequest(request, config) {
  validateAdminCredentials(config);
  if (!await isAuthenticated(request, config)) {
    return unauthorizedResponse();
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  try {
    const keysToDelete = await request.json();
    if (!Array.isArray(keysToDelete) || keysToDelete.length === 0) {
      return jsonResponse({ message: '没有要删除的项' }, 400);
    }
    const database = getDatabase(config);
    await ensureDatabaseSchema(database);
    const placeholders = keysToDelete.map(() => '?').join(',');
    const cache = caches.default;

    // Query messageIds before deleting from DB
    const mediaRows = await database.prepare(
        `SELECT url, messageId FROM media WHERE url IN (${placeholders})`
    ).bind(...keysToDelete).all();
    const messageIds = (mediaRows.results || [])
        .map(row => row.messageId)
        .filter(id => id != null);

    const [dbResult] = await Promise.all([
      database.prepare(
          `DELETE FROM media WHERE url IN (${placeholders})`
      ).bind(...keysToDelete).run(),
      Promise.all(keysToDelete.map(async (url) => {
        const cacheKey = new Request(url);
        await cache.delete(cacheKey);
      })),
      // Delete Telegram messages
      ...(config.tgBotToken && config.tgChatId ? [Promise.all(messageIds.map(async (msgId) => {
        try {
          await fetch(
              `https://api.telegram.org/bot${config.tgBotToken}/deleteMessage`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: config.tgChatId, message_id: msgId })
              }
          );
        } catch {}
      }))] : [])
    ]);

    const deletedCount = dbResult.meta?.changes ?? dbResult.changes ?? 0;
    if (deletedCount === 0) {
      return jsonResponse({ message: '未找到要删除的项' }, 404);
    }

    return jsonResponse({ message: '删除成功' });
  } catch (error) {
    return jsonResponse({ error: '删除失败', details: error.message }, 500);
  }
}
