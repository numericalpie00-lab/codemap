#!/usr/bin/env node
// ============================================================
// CodeMap — a live spatial map of a codebase.
//
// Zero npm dependencies. Point it at a repo, open the browser:
//   node server.mjs [repoPath] [--port 7100]
//
// It scans the repo into a topology graph (files = nodes, imports =
// edges, grouped by domain), then watches the filesystem. When your AI
// coding tool edits a file, the matching node lights up and the change
// lands on a session timeline — so you never lose "where am I now."
//
// This is a prototype starting point, deliberately hackable. The two
// obvious next steps are marked with  // NEXT:
// ============================================================

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- args ----------
const args = process.argv.slice(2);
let repoRoot = process.cwd();
let port = 7100;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]) || port;
  else if (!args[i].startsWith('--')) repoRoot = path.resolve(args[i]);
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', '.vercel',
  '.wrangler', 'coverage', '.cache', '.turbo', 'vendor', '__pycache__',
  '.venv', 'target', '.idea', '.vscode',
]);
const CODE_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.go', '.rs', '.java', '.rb', '.php', '.c', '.h', '.cpp',
  '.css', '.scss', '.html', '.json', '.md', '.sql', '.sh', '.toml', '.yaml', '.yml',
]);
const JS_LIKE = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte']);
const MAX_FILE_BYTES = 600 * 1024;

// ---------- graph state ----------
/** @type {Map<string, any>} id(relPath) -> node */
let nodes = new Map();
let edges = [];            // { source, target }
let activity = [];         // { path, kind, ts } newest-first
let generatedAt = 0;

// LLM semantic grouping: id -> { domain(中文业务领域), why }
const semanticDomain = new Map();
let digests = new Map();   // id -> compact digest string (built during scan)
let grouping = 'folder';   // 'folder' until the LLM pass upgrades it to 'llm'

const rel = (abs) => path.relative(repoRoot, abs).split(path.sep).join('/');

/** Folder-based fallback domain. Used until (or unless) the LLM classifies. */
function folderDomain(relPath) {
  const parts = relPath.split('/');
  if (parts.length === 1) return '(root)';
  if (parts[0] === 'src' && parts.length > 2) return `src/${parts[1]}`;
  return parts[0];
}

/** Domain = a coarse grouping used to cluster the map. Prefers the LLM's
 *  Chinese business-domain label; falls back to folder grouping. */
function domainOf(relPath) {
  return semanticDomain.get(relPath)?.domain || folderDomain(relPath);
}

// ============================================================
// LLM semantic grouping
//
// Reads each file's *responsibility* (top comment, exported symbols, path)
// and classifies it into an intuitive Chinese business domain — 用户认证 /
// 画布渲染 / 数据持久化 … — so the map clusters by what code DOES, not by
// which folder it happens to live in.
//
// Providers (auto-detected, in priority order):
//   1. Anthropic  — set ANTHROPIC_API_KEY. Cheap + good: defaults to
//                   claude-haiku-4-5. Override model with CODEMAP_MODEL.
//   2. OpenAI-compatible (incl. local models: Ollama / LM Studio / vLLM) —
//                   set LLM_BASE_URL (e.g. http://localhost:11434/v1) and
//                   CODEMAP_MODEL (e.g. qwen2.5-coder). OPENAI_API_KEY optional.
//   3. none        — falls back to folder grouping (still fully usable).
//
// One batched call per ~50 files. Results cache to .codemap-cache.json keyed
// by a hash of each file's digest, so re-runs are near-free and only changed
// files get re-classified.
// ============================================================
const LLM = {
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  baseURL: (process.env.LLM_BASE_URL || '').replace(/\/$/, ''),
  openaiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '',
  model: process.env.CODEMAP_MODEL || '',
};
function llmProvider() {
  if (LLM.baseURL) return 'openai';        // explicit endpoint wins (local models)
  if (LLM.anthropicKey) return 'anthropic';
  if (LLM.openaiKey) return 'openai';
  return null;
}

const CACHE_PATH = path.join(__dirname, '.codemap-cache.json');
let cacheStore = {};       // { [repoRoot]: { [id]: { h, domain, why } } }
function repoCache() { return (cacheStore[repoRoot] ||= {}); }

async function loadCache() {
  try {
    cacheStore = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8')) || {};
  } catch { cacheStore = {}; }
  // hydrate in-memory domains from cache so a restart shows semantic groups instantly
  const rc = repoCache();
  for (const [id, v] of Object.entries(rc)) semanticDomain.set(id, { domain: v.domain, why: v.why });
  if (semanticDomain.size) grouping = 'llm';
}
let cacheSaveTimer = null;
function saveCacheSoon() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    fsp.writeFile(CACHE_PATH, JSON.stringify(cacheStore)).catch(() => {});
  }, 500);
}

function sha(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12); }

/** Build a compact, signal-rich digest: path + header comment + top symbols. */
function buildDigest(id, content) {
  const ext = path.extname(id).toLowerCase();
  if (!content) return id;
  const lines = content.split('\n');
  // leading header: first non-empty lines (usually a doc comment / module intent)
  const head = [];
  for (const ln of lines.slice(0, 30)) {
    const s = ln.trim();
    if (!s) continue;
    head.push(s.replace(/^[/#*<!;-]+\s?/, ''));
    if (head.join(' ').length > 220) break;
  }
  // top-level / exported symbol names across common languages
  const symRe = /(?:export\s+(?:default\s+)?(?:async\s+)?)?(?:function|class|interface|type|enum|struct|def|func|const|module|component)\s+([A-Za-z_$][\w$]*)/g;
  const syms = new Set();
  let m;
  while ((m = symRe.exec(content)) && syms.size < 14) if (m[1]) syms.add(m[1]);
  const parts = [id];
  if (head.length) parts.push('说明: ' + head.join(' ').slice(0, 220));
  if (syms.size) parts.push('符号: ' + [...syms].join(', '));
  return parts.join('\n').slice(0, 500);
}

async function callAnthropic(system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': LLM.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: LLM.model || 'claude-haiku-4-5',
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.content || []).map((b) => b.text || '').join('');
}

async function callOpenAI(system, user) {
  const base = LLM.baseURL || 'https://api.openai.com/v1';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(LLM.openaiKey ? { authorization: `Bearer ${LLM.openaiKey}` } : {}),
    },
    body: JSON.stringify({
      model: LLM.model || 'gpt-4o-mini',
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const s = body.indexOf('{'), e = body.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('no json object in model reply');
  return JSON.parse(body.slice(s, e + 1));
}

function buildPrompt(batch, knownDomains) {
  const system =
    '你是一位资深软件架构师。下面给出一个代码库里若干文件的摘要（路径 + 头部说明 + 主要符号）。' +
    '请依据每个文件的【核心职责】，把它归类到一个直观的【中文业务领域】名称。规则：\n' +
    '1) 领域名用中文，2~6 个字，描述“做什么”（如：用户认证、画布渲染、数据持久化、路由分发、' +
    '状态管理、样式主题、构建配置、接口定义、测试、文档、工具函数）。\n' +
    '2) 按职责聚类，功能相同的文件必须归到同一个领域；不要按文件夹，也不要一个文件一个领域。\n' +
    '3) 整个代码库的领域总数保持精简（通常 5~12 个）。\n' +
    (knownDomains.length ? `4) 尽量复用这些已存在的领域名：${knownDomains.join('、')}。\n` : '') +
    '只输出一个 JSON 对象，键是文件路径（与输入完全一致），值是中文领域名。不要输出任何解释。';
  const user =
    '文件摘要如下：\n\n' +
    batch.map((d, i) => `【${i + 1}】\n${d.digest}`).join('\n\n') +
    '\n\n请输出 JSON：{"路径": "中文领域", ...}';
  return { system, user };
}

let classifyRunning = false;
async function classifyDomains() {
  const provider = llmProvider();
  if (!provider || classifyRunning) return;
  classifyRunning = true;
  try {
    const rc = repoCache();
    // which files need (re)classification? cache miss or changed digest.
    const todo = [];
    for (const [id, digest] of digests) {
      const h = sha(digest);
      const hit = rc[id];
      if (hit && hit.h === h) {
        semanticDomain.set(id, { domain: hit.domain, why: hit.why });
      } else {
        todo.push({ id, digest, h });
      }
    }
    // drop cache entries for files that no longer exist
    for (const id of Object.keys(rc)) if (!digests.has(id)) { delete rc[id]; semanticDomain.delete(id); }

    if (!todo.length) { applyDomains(); return; }
    console.log(`[codemap] classifying ${todo.length} file(s) via ${provider}…`);

    const BATCH = 50;
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const known = [...new Set([...semanticDomain.values()].map((v) => v.domain))];
      const { system, user } = buildPrompt(batch, known);
      let reply;
      try {
        reply = provider === 'anthropic' ? await callAnthropic(system, user) : await callOpenAI(system, user);
      } catch (e) {
        console.warn('[codemap] LLM call failed, keeping folder grouping:', e.message);
        return;
      }
      let map;
      try { map = extractJson(reply); }
      catch (e) { console.warn('[codemap] could not parse LLM reply:', e.message); continue; }
      for (const { id, h } of batch) {
        const domain = typeof map[id] === 'string' ? map[id].trim() : null;
        if (domain) {
          semanticDomain.set(id, { domain, why: '' });
          rc[id] = { h, domain, why: '' };
        }
      }
      applyDomains();       // upgrade the live map incrementally, batch by batch
      saveCacheSoon();
    }
    grouping = 'llm';
    applyDomains();
    console.log('[codemap] semantic grouping ready ✓');
  } finally {
    classifyRunning = false;
  }
}

/** Push current domain assignments onto the live nodes and bump the version. */
function applyDomains() {
  if (semanticDomain.size) grouping = 'llm';
  for (const [id, n] of nodes) n.domain = domainOf(id);
  generatedAt = Date.now();
}

async function walk(dir, acc) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env.example') {
      if (e.isDirectory() && !IGNORE_DIRS.has(e.name)) { /* allow dotdirs? skip */ }
      // skip dotfiles/dotdirs by default to keep the map clean
      if (e.name !== '.github') continue;
    }
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      await walk(abs, acc);
    } else if (CODE_EXT.has(path.extname(e.name).toLowerCase())) {
      acc.push(abs);
    }
  }
}

/** Resolve a relative import specifier to a node id in `nodeSet`, or null. */
function resolveImport(fromRel, spec, nodeSet) {
  if (!spec.startsWith('.')) return null; // external / bare import
  const baseAbs = path.resolve(repoRoot, path.dirname(fromRel), spec);
  const baseRel = rel(baseAbs);
  const cands = [
    baseRel,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'].map((x) => baseRel + x),
    ...['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'].map((x) => `${baseRel}/${x}`),
  ];
  for (const c of cands) if (nodeSet.has(c)) return c;
  return null;
}

const IMPORT_RE = /(?:import[\s\S]*?from\s*|import\s*|require\s*\(\s*|from\s+)['"]([^'"]+)['"]/g;

async function scan() {
  const files = [];
  await walk(repoRoot, files);
  const nextNodes = new Map();
  const contents = new Map();   // id -> content (JS-like only), for the edge pass
  const nextDigests = new Map(); // id -> digest, for the LLM grouping pass

  // pass 1: build every node so the edge pass can resolve against the full set
  for (const abs of files) {
    const id = rel(abs);
    const ext = path.extname(id).toLowerCase();
    let size = 0, loc = 0, content = '';
    try {
      const st = await fsp.stat(abs);
      size = st.size;
      if (size <= MAX_FILE_BYTES) {
        content = await fsp.readFile(abs, 'utf8');
        loc = content.length ? content.split('\n').length : 0;
      }
    } catch { /* ignore unreadable */ }
    const prev = nodes.get(id);
    nextNodes.set(id, {
      id, label: path.basename(id), domain: domainOf(id), ext, size, loc,
      lastChanged: prev ? prev.lastChanged : 0,
    });
    if (JS_LIKE.has(ext) && content) contents.set(id, content);
    nextDigests.set(id, buildDigest(id, content));
  }

  // pass 2: resolve import edges against the complete node set
  const nextEdges = [];
  for (const [id, content] of contents) {
    IMPORT_RE.lastIndex = 0;
    let m;
    const seen = new Set();
    while ((m = IMPORT_RE.exec(content))) {
      const target = resolveImport(id, m[1], nextNodes);
      if (target && target !== id && !seen.has(target)) {
        seen.add(target);
        nextEdges.push({ source: id, target });
      }
    }
  }

  nodes = nextNodes;
  edges = nextEdges;
  digests = nextDigests;
  generatedAt = Date.now();

  // kick off (or refresh) semantic grouping in the background — the map is
  // already usable with folder grouping; it upgrades in place when the LLM returns.
  scheduleClassify();
}

let classifyTimer = null;
function scheduleClassify() {
  if (!llmProvider()) return;
  clearTimeout(classifyTimer);
  classifyTimer = setTimeout(() => classifyDomains().catch((e) => console.warn('[codemap] classify error:', e.message)), 300);
}

// ---------- filesystem watch ----------
let rescanTimer = null;
function scheduleRescan() {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => scan().catch(() => {}), 400);
}

function markChange(abs, kind) {
  const ext = path.extname(abs).toLowerCase();
  if (!CODE_EXT.has(ext)) return;
  const base = path.basename(abs);
  // skip dotfiles (incl. our own .codemap-cache.json) — the scanner ignores
  // them too, so they're never nodes and shouldn't clutter the timeline.
  if (base.startsWith('.')) return;
  const parts = abs.split(path.sep);
  if (parts.some((p) => IGNORE_DIRS.has(p))) return;
  const id = rel(abs);
  const node = nodes.get(id);
  const ts = Date.now();
  if (node) node.lastChanged = ts;
  // de-dupe rapid repeats of the same file
  if (!(activity[0] && activity[0].path === id && ts - activity[0].ts < 800)) {
    activity.unshift({ path: id, kind, ts });
    activity = activity.slice(0, 60);
  }
  if (kind !== 'change') scheduleRescan(); // add/unlink → refresh structure
}

function startWatch() {
  try {
    fs.watch(repoRoot, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const abs = path.join(repoRoot, filename.toString());
      markChange(abs, event === 'rename' ? 'structure' : 'change');
    });
  } catch (e) {
    console.warn('[codemap] recursive watch unavailable on this platform:', e.message);
  }
}

// ---------- http server ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      repo: path.basename(repoRoot),
      repoRoot,
      generatedAt,
      grouping,                 // 'llm' (semantic) or 'folder' (fallback)
      provider: llmProvider(),  // 'anthropic' | 'openai' | null
      nodes: [...nodes.values()],
      edges,
      activity,
    }));
    return;
  }
  // static files from ./public
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const abs = path.join(__dirname, 'public', file);
  if (!abs.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); res.end(); return; }
  try {
    const data = await fsp.readFile(abs);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'text/plain' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

await loadCache();
await scan();
startWatch();
server.listen(port, () => {
  const provider = llmProvider();
  console.log(`\n  🗺  CodeMap  →  http://localhost:${port}`);
  console.log(`     repo: ${repoRoot}`);
  console.log(`     ${nodes.size} files, ${edges.length} import edges. Watching for changes…`);
  if (provider) console.log(`     语义分组: ${provider}${LLM.model ? ` (${LLM.model})` : ''} — 后台归类中…`);
  else console.log(`     语义分组: 未启用（设 ANTHROPIC_API_KEY 或 LLM_BASE_URL 开启中文业务领域聚类）。现用文件夹分组。`);
  console.log('');
});

// NEXT: git integration — on change, run `git diff --stat` for real lines-changed,
//       and let a node click show the actual diff.
