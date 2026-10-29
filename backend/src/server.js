import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSearch } from './searcher.js';
import { createPatStore, maskToken } from './secrets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = {
  org: process.env.AZDO_ORG ?? 'https://dev.azure.com/interrapidisimo',
  project: process.env.AZDO_PROJECT ?? 'SitiosWeb',
  pat: process.env.AZDO_PAT ?? '',
};
const PORT = Number(process.env.PORT ?? 3000);
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT ?? 3));
const REPO_CONCURRENCY = Math.max(1, Number(process.env.REPO_CONCURRENCY ?? 3));
const jobsDir = path.resolve(root, process.env.DATA_DIR ?? 'data', 'jobs');
await mkdir(jobsDir, { recursive: true });

const patStore = createPatStore(path.resolve(root, process.env.DATA_DIR ?? 'data', 'secrets'));
const envPat = config.pat;
let patUpdatedAt = null;
let patSource = envPat ? 'env' : 'none';
const stored = await patStore.load();
if (stored) {
  config.pat = stored.token;
  patUpdatedAt = stored.updatedAt;
  patSource = 'store';
}

// Un error inesperado en una búsqueda no debe tumbar el servidor (el proxy respondería 502 a todo).
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

/** @type {Map<string, any>} */
const jobs = new Map();
const runtime = new Map(); // id -> { controller, listeners:Set, logs:[] }

const ACTIVE = ['queued', 'running'];
const MAX_RESULTS_MEMORY = 100000;
const metaPath = (job) => path.join(jobsDir, job.id, 'meta.json');
const resultPath = (job) => path.join(jobsDir, job.id, job.fileName);
const persist = (job) => writeFile(metaPath(job), JSON.stringify(job, null, 2)).catch(() => {});

// Recupera sesiones previas; las que estaban activas quedan como interrumpidas.
for (const id of await readdir(jobsDir)) {
  try {
    const job = JSON.parse(await readFile(path.join(jobsDir, id, 'meta.json'), 'utf8'));
    if (ACTIVE.includes(job.status)) {
      job.status = 'interrupted';
      job.finishedAt = new Date().toISOString();
      job.error = 'El servidor se reinició durante la ejecución.';
      await persist(job);
    }
    jobs.set(job.id, job);
  } catch {
    /* carpeta ajena */
  }
}

const slug = (s) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'busqueda';

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function buildFileName(requested, term, project) {
  let base = requested?.trim()
    ? requested.trim().replace(/\.txt$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80)
    : `busqueda_${slug(project)}_${slug(term)}_${stamp()}`;
  const taken = new Set([...jobs.values()].map((j) => j.fileName.toLowerCase()));
  let name = `${base}.txt`;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}_${i}.txt`;
  return name;
}

const publicJob = (j) => j;
const emit = (id, event, data) => {
  for (const res of runtime.get(id)?.listeners ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

function pump() {
  const running = [...jobs.values()].filter((j) => j.status === 'running').length;
  let slots = MAX_CONCURRENT - running;
  for (const job of [...jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (slots-- <= 0) break;
    start(job);
  }
}

async function start(job) {
  const rt = runtime.get(job.id);
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  await persist(job);
  emit(job.id, 'job', publicJob(job));

  const log = (line) => {
    const entry = { t: new Date().toISOString(), line };
    rt.logs.push(entry);
    if (rt.logs.length > 2000) rt.logs.shift();
    emit(job.id, 'log', entry);
  };

  // El progreso cambia muy seguido; se envía como máximo ~4 veces por segundo.
  let progressTimer = null;
  const flushProgress = () => {
    progressTimer = null;
    emit(job.id, 'job', publicJob(job));
  };
  try {
    await runSearch({
      term: job.term,
      config: { ...config, project: job.project },
      target: job.branch ? { repo: job.repo, branch: job.branch } : null,
      concurrency: REPO_CONCURRENCY,
      workDir: path.join(jobsDir, job.id),
      resultFile: resultPath(job),
      log,
      signal: rt.controller.signal,
      onProgress: (p) => {
        job.progress = p;
        progressTimer ??= setTimeout(flushProgress, 250);
      },
      onMatches: (items) => {
        if (rt.results.length < MAX_RESULTS_MEMORY) rt.results.push(...items);
        emit(job.id, 'matches', items);
      },
    });
    job.status = 'completed';
  } catch (e) {
    if (rt.controller.signal.aborted) {
      job.status = 'cancelled';
      log('⛔ Búsqueda cancelada por el usuario.');
    } else {
      job.status = 'failed';
      job.error = e.message;
      log(`❌ ${e.message}`);
    }
  } finally {
    clearTimeout(progressTimer);
    await rm(path.join(jobsDir, job.id, 'clones'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    job.progress = { ...job.progress, repo: '', branch: '', active: [] };
    job.finishedAt = new Date().toISOString();
    job.resultSize = existsSync(resultPath(job)) ? (await stat(resultPath(job))).size : 0;
    await persist(job);
    emit(job.id, 'job', publicJob(job));
    emit(job.id, 'end', {});
    for (const l of rt.listeners) l.end();
    rt.listeners.clear();
    pump();
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  next();
});

// El token solo se administra desde la propia máquina, o con ADMIN_KEY si se define.
const failures = new Map();
function adminOnly(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const ip = req.socket.remoteAddress ?? '';
  const now = Date.now();
  const f = failures.get(ip);
  if (f && f.until > now) return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera unos minutos.' });
  const adminKey = process.env.ADMIN_KEY;
  let ok;
  if (adminKey) {
    const given = Buffer.from(String(req.get('x-admin-key') ?? ''));
    const want = Buffer.from(adminKey);
    ok = given.length === want.length && timingSafeEqual(given, want);
  } else {
    ok = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
  }
  if (!ok) {
    const n = (f?.n ?? 0) + 1;
    failures.set(ip, { n, until: n >= 5 ? now + 5 * 60_000 : 0 });
    return res.status(403).json({ error: adminKey ? 'Clave de administración inválida.' : 'Solo se permite administrar el token desde el servidor local.' });
  }
  failures.delete(ip);
  next();
}

const patStatus = () => ({
  configured: !!config.pat,
  masked: maskToken(config.pat),
  source: patSource,
  updatedAt: patUpdatedAt,
  requiresAdminKey: !!process.env.ADMIN_KEY,
});

app.get('/api/settings/pat', adminOnly, (_req, res) => res.json(patStatus()));

app.put('/api/settings/pat', adminOnly, async (req, res) => {
  const token = String(req.body?.token ?? '').trim();
  if (token.length < 20 || token.length > 200 || !/^[A-Za-z0-9]+$/.test(token)) {
    return res.status(400).json({ error: 'El token no tiene un formato válido (solo letras y números, entre 20 y 200 caracteres).' });
  }
  try {
    const url = `${config.org.replace(/\/$/, '')}/_apis/projects?$top=1&api-version=7.1`;
    const r = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401 || r.status === 403 || r.status >= 300) {
      return res.status(422).json({ error: 'Azure DevOps rechazó el token (inválido, expirado o sin permisos). No se guardó.' });
    }
  } catch {
    return res.status(502).json({ error: 'No se pudo validar el token contra Azure DevOps. Intenta de nuevo.' });
  }
  patUpdatedAt = await patStore.save(token);
  config.pat = token;
  patSource = 'store';
  res.json(patStatus());
});

app.delete('/api/settings/pat', adminOnly, async (_req, res) => {
  await patStore.clear();
  config.pat = envPat;
  patSource = envPat ? 'env' : 'none';
  patUpdatedAt = null;
  res.json(patStatus());
});

app.get('/api/config', (_req, res) => res.json({ org: config.org, project: config.project, patConfigured: !!config.pat, maxConcurrent: MAX_CONCURRENT }));

app.get('/api/searches', (_req, res) =>
  res.json([...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicJob)),
);

app.post('/api/searches', async (req, res) => {
  const term = String(req.body?.term ?? '').trim();
  if (!term) return res.status(400).json({ error: 'Debes ingresar un término de búsqueda.' });
  if (term.length > 200) return res.status(400).json({ error: 'El término es demasiado largo (máximo 200 caracteres).' });
  if (!config.pat) return res.status(503).json({ error: 'El servidor no tiene configurado AZDO_PAT.' });
  const project = String(req.body?.project ?? '').trim() || config.project;
  if (project.length > 64 || /[\u0000-\u001f/\\?#%]/.test(project)) {
    return res.status(400).json({ error: 'El nombre del proyecto no es válido.' });
  }

  let repo;
  let branch;
  if (req.body?.byBranch) {
    repo = String(req.body?.repo ?? '').trim();
    branch = String(req.body?.branch ?? '').trim().replace(/^refs\/heads\//, '');
    if (!repo || repo.length > 128 || /[\u0000-\u001f/\\?#%]/.test(repo)) {
      return res.status(400).json({ error: 'Debes indicar un nombre de repositorio válido para buscar por rama.' });
    }
    if (!branch || branch.length > 200 || branch.startsWith('-') || branch.includes('..') || /[\u0000-\u0020~^:?*[\\]/.test(branch)) {
      return res.status(400).json({ error: 'Debes indicar un nombre de rama válido para buscar por rama.' });
    }
  }

  const id = randomUUID();
  const job = {
    id,
    term,
    project,
    ...(branch ? { byBranch: true, repo, branch } : { byBranch: false }),
    fileName: buildFileName(req.body?.fileName, term, project),
    status: 'queued',
    createdAt: new Date().toISOString(),
    progress: { total: 0, done: 0, matches: 0, repo: '', branch: '', active: [] },
  };
  await mkdir(path.join(jobsDir, id), { recursive: true });
  jobs.set(id, job);
  runtime.set(id, { controller: new AbortController(), listeners: new Set(), logs: [], results: [] });
  await persist(job);
  pump();
  res.status(201).json(publicJob(job));
});

const find = (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) res.status(404).json({ error: 'Búsqueda no encontrada.' });
  return job;
};

app.get('/api/searches/:id', (req, res) => {
  const job = find(req, res);
  if (job) res.json(publicJob(job));
});

app.post('/api/searches/:id/cancel', (req, res) => {
  const job = find(req, res);
  if (!job) return;
  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    persist(job);
    emit(job.id, 'job', publicJob(job));
  } else if (job.status === 'running') {
    runtime.get(job.id)?.controller.abort();
  }
  res.json(publicJob(job));
});

app.delete('/api/searches/:id', async (req, res) => {
  const job = find(req, res);
  if (!job) return;
  if (ACTIVE.includes(job.status)) return res.status(409).json({ error: 'Cancela la búsqueda antes de eliminarla.' });
  jobs.delete(job.id);
  runtime.delete(job.id);
  await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
  res.status(204).end();
});

app.get('/api/searches/:id/events', (req, res) => {
  const job = find(req, res);
  if (!job) return;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  req.socket.setNoDelay(true);
  res.flushHeaders();
  const rt = runtime.get(job.id);
  res.write(`event: job\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
  for (const entry of rt?.logs ?? []) res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  if (rt?.results.length) res.write(`event: matches\ndata: ${JSON.stringify(rt.results)}\n\n`);
  if (!rt || !ACTIVE.includes(job.status)) {
    res.write('event: end\ndata: {}\n\n');
    return res.end();
  }
  rt.listeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    rt.listeners.delete(res);
  });
});

app.get('/api/searches/:id/result', async (req, res) => {
  const job = find(req, res);
  if (!job) return;
  if (!existsSync(resultPath(job))) return res.status(404).json({ error: 'Aún no hay archivo de resultados.' });
  const LIMIT = 200 * 1024;
  const { size } = await stat(resultPath(job));
  const chunks = [];
  for await (const c of createReadStream(resultPath(job), { end: LIMIT - 1 })) chunks.push(c);
  res.json({ content: Buffer.concat(chunks).toString('utf8'), truncated: size > LIMIT, size });
});

app.get('/api/searches/:id/download', (req, res) => {
  const job = find(req, res);
  if (!job) return;
  if (!existsSync(resultPath(job))) return res.status(404).json({ error: 'Aún no hay archivo de resultados.' });
  res.download(resultPath(job), job.fileName);
});

const dist = path.resolve(root, '..', 'frontend', 'dist', 'frontend', 'browser');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => console.log(`API lista en http://localhost:${PORT}`));
