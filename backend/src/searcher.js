import { spawn } from 'node:child_process';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_OUTPUT = 64 * 1024 * 1024;
const FLUSH_MS = 300;
const FLUSH_LINES = 200;

/** Ejecuta un comando entregando cada línea de stdout apenas llega. Devuelve { code, err }. */
function runLines(cmd, args, { cwd, signal, onLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, signal, windowsHide: true });
    let rest = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      rest += d;
      const lines = rest.split('\n');
      rest = lines.pop();
      for (const l of lines) onLine(l.replace(/\r$/, ''));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (rest) onLine(rest.replace(/\r$/, ''));
      resolve({ code, err: err.trim() });
    });
  });
}

async function runText(cmd, args, opts) {
  let out = '';
  let size = 0;
  const { code, err } = await runLines(cmd, args, {
    ...opts,
    onLine: (l) => {
      size += l.length;
      if (size <= MAX_OUTPUT) out += `${l}\n`;
    },
  });
  return { code, err, out };
}

const authHeader = (pat) => `AUTHORIZATION: Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
const basic = (pat) => `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
const rmDir = (dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});

async function azGet(url, pat, signal, what) {
  const res = await fetch(url, { headers: { Authorization: basic(pat) }, signal, redirect: 'manual' });
  if (res.status === 404) throw new Error(`${what} no existe o no tienes acceso (HTTP 404).`);
  if (!res.ok) throw new Error(`No se pudo consultar ${what} (HTTP ${res.status}). Verifique los nombres y que el token sea correcto y no haya expirado.`);
  return res.json();
}

async function listRepos({ org, project, pat }, signal) {
  const base = `${org.replace(/\/$/, '')}/${encodeURIComponent(project)}/_apis/git/repositories`;
  const data = await azGet(`${base}?api-version=7.1`, pat, signal, `el proyecto "${project}"`);
  return (data.value ?? []).filter((r) => !r.isDisabled).map((r) => ({ name: r.name, url: r.remoteUrl }));
}

async function getRepo({ org, project, pat }, name, signal) {
  const base = `${org.replace(/\/$/, '')}/${encodeURIComponent(project)}/_apis/git/repositories`;
  const r = await azGet(`${base}/${encodeURIComponent(name)}?api-version=7.1`, pat, signal, `el repositorio "${name}" del proyecto "${project}"`);
  return { name: r.name, url: r.remoteUrl };
}

/** Escritor compartido: serializa las escrituras y mantiene el archivo legible aunque varios repos escriban a la vez. */
function createWriter(resultFile, onMatches, onError) {
  let chain = Promise.resolve();
  let lastRepo = null;
  let lastKey = null;
  const reposWithMatches = new Set();
  const write = (items) => {
    if (!items.length) return chain;
    chain = chain
      .then(async () => {
        let text = '';
        for (const it of items) {
          if (it.repo !== lastRepo) {
            lastRepo = it.repo;
            lastKey = null;
            reposWithMatches.add(it.repo);
            text += `\n${'='.repeat(40)}\n🔥 REPOSITORIO: ${it.repo}\n${'='.repeat(40)}`;
          }
          const key = `${it.type}|${it.branch}`;
          if (key !== lastKey) {
            lastKey = key;
            if (it.type === 'CONTENIDO') text += `\n[CONTENIDO] Rama ${it.branch}:`;
          }
          text += it.type === 'ARCHIVO' ? `\n[ARCHIVO] Rama ${it.branch}: ${it.text}` : `\n${it.branch}:${it.text}`;
        }
        await appendFile(resultFile, `${text}\n`);
        onMatches(items);
      })
      .catch(onError);
    return chain;
  };
  return { write, idle: () => chain, matchedRepos: () => reposWithMatches.size };
}

/**
 * Ejecuta la búsqueda. Cada ejecución usa su propio directorio de trabajo, por lo que
 * varias pueden correr en paralelo sin interferir.
 *
 * Optimizaciones: clones superficiales (solo la punta de cada rama, que es lo único que se
 * busca), varios repositorios en paralelo, una sola búsqueda por árbol idéntico (las ramas
 * que apuntan al mismo contenido comparten resultados) y salida en streaming.
 *
 * target: null → todos los repos y ramas del proyecto; { repo, branch } → solo esa rama.
 */
export async function runSearch({ term, config, target, workDir, resultFile, log, signal, onProgress, onMatches, concurrency = 3 }) {
  const bar = '='.repeat(49);
  await writeFile(resultFile, `${bar}\nRESULTADOS DE BÚSQUEDA PARA: ${term}\n${bar}\n`);

  let repos;
  if (target) {
    log(`Consultando el repositorio ${target.repo} del proyecto ${config.project}...`);
    repos = [await getRepo(config, target.repo, signal)];
    log(`Se buscará solo en la rama ${target.branch}.`);
  } else {
    log(`Obteniendo lista de repositorios del proyecto ${config.project}...`);
    repos = await listRepos(config, signal);
    if (repos.length === 0) throw new Error('El proyecto no tiene repositorios accesibles.');
    log(`Se revisarán ${repos.length} repositorios (hasta ${concurrency} en paralelo).`);
  }

  const cloneDir = path.join(workDir, 'clones');
  await mkdir(cloneDir, { recursive: true });
  const lowerTerm = term.toLowerCase();
  const writer = createWriter(resultFile, onMatches, (e) => log(`❌ Error al escribir resultados: ${e.message}`));
  const active = new Map();
  let done = 0;
  let current = { repo: '', branch: '' };
  const progress = () =>
    onProgress({
      total: repos.length,
      done,
      matches: writer.matchedRepos(),
      repo: current.repo,
      branch: current.branch,
      active: [...active].map(([repo, branch]) => ({ repo, branch })),
    });
  progress();

  async function searchRepo(repo) {
    const dir = path.join(cloneDir, repo.name.replace(/[^\w.-]/g, '_'));
    const gd = ['--git-dir', dir];
    let pending = [];
    let count = 0;
    let announced = false;
    const flush = () => {
      if (!pending.length) return;
      const items = pending;
      pending = [];
      if (!announced) {
        announced = true;
        log(`🔥 ¡ENCONTRADO EN: ${repo.name}!`);
      }
      writer.write(items);
    };
    const push = (item) => {
      count++;
      pending.push(item);
      if (pending.length >= FLUSH_LINES) flush();
    };
    const timer = setInterval(flush, FLUSH_MS);
    const setBranch = (b) => {
      active.set(repo.name, b);
      current = { repo: repo.name, branch: b };
      progress();
    };

    try {
      setBranch('');
      log(`Revisando repositorio: ${repo.name} (clonando...)`);
      const cloneArgs = target
        ? ['clone', '--bare', '-q', '--depth', '1', '--single-branch', '--branch', target.branch]
        : ['clone', '--bare', '-q', '--depth', '1', '--no-single-branch'];
      const clone = await runLines('git', ['-c', `http.extraheader=${authHeader(config.pat)}`, ...cloneArgs, '--', repo.url, dir], { signal, onLine: () => {} });
      if (clone.code !== 0) {
        const detail = clone.err.split(config.pat).join('***').split('\n').filter((l) => !l.startsWith('warning:')).join(' ').trim();
        const msg = target ? `No se pudo descargar la rama "${target.branch}" de ${repo.name}: ${detail}` : `Falló la descarga del repositorio ${repo.name}. ${detail}`;
        if (target) throw new Error(msg);
        log(`❌ ${msg}`);
        return;
      }

      // Rama + árbol: las ramas con el mismo árbol tienen exactamente los mismos resultados.
      const refs = await runText('git', [...gd, 'for-each-ref', '--format=%(refname:short) %(tree)', 'refs/heads/', 'refs/remotes/'], { signal });
      if (refs.code !== 0) log(`❌ No se pudieron listar las ramas de ${repo.name}: ${refs.err}`);
      const groups = new Map();
      for (const line of refs.out.split('\n')) {
        const [name, tree] = line.trim().split(' ');
        if (!name || !tree) continue;
        if (target && name !== target.branch) continue;
        (groups.get(tree) ?? groups.set(tree, []).get(tree)).push(name);
      }
      const branchCount = [...groups.values()].reduce((n, g) => n + g.length, 0);
      if (target && !branchCount) throw new Error(`La rama "${target.branch}" no existe en ${repo.name}.`);
      log(`   ${repo.name}: ${branchCount} rama(s), ${groups.size} contenido(s) distinto(s) por revisar.`);

      for (const names of groups.values()) {
        signal.throwIfAborted();
        const rep = names[0];
        setBranch(rep);
        log(`   → ${repo.name} · rama ${names.length > 1 ? `${rep} (+${names.length - 1} con el mismo contenido)` : rep}`);
        const prefix = `${rep}:`;
        const found = [];
        const before = count;

        const grep = await runLines('git', [...gd, '--no-pager', 'grep', '--no-color', '-i', '-I', '-n', '-F', '-e', term, rep], {
          signal,
          onLine: (l) => {
            if (!l) return;
            const text = l.startsWith(prefix) ? l.slice(prefix.length) : l;
            found.push({ type: 'CONTENIDO', text });
            push({ repo: repo.name, branch: rep, type: 'CONTENIDO', text });
          },
        });
        if (grep.code > 1) log(`     ⚠ git grep falló en ${rep}: ${grep.err}`);
        flush();

        await runLines('git', [...gd, 'ls-tree', '-r', '--name-only', rep], {
          signal,
          onLine: (l) => {
            if (l && l.toLowerCase().includes(lowerTerm)) {
              found.push({ type: 'ARCHIVO', text: l });
              push({ repo: repo.name, branch: rep, type: 'ARCHIVO', text: l });
            }
          },
        });
        flush();

        // Las demás ramas con el mismo contenido reciben los mismos resultados sin volver a buscar.
        for (const other of names.slice(1)) {
          for (const f of found) push({ repo: repo.name, branch: other, type: f.type, text: f.text });
          flush();
        }
        if (count > before) log(`     ${count - before} coincidencia(s) en ${repo.name}`);
      }
      if (!count) log(`   Sin coincidencias en ${repo.name}.`);
    } finally {
      clearInterval(timer);
      flush();
      active.delete(repo.name);
      await rmDir(dir);
      done++;
      if (active.size === 0) current = { repo: '', branch: '' };
      progress();
    }
  }

  const queue = [...repos];
  let fatal = null;
  const worker = async () => {
    while (!fatal && !signal.aborted) {
      const repo = queue.shift();
      if (!repo) return;
      try {
        await searchRepo(repo);
      } catch (e) {
        if (signal.aborted) return;
        if (target) {
          fatal = e;
          return;
        }
        log(`❌ ${repo.name}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, repos.length) }, worker));
  await writer.idle();
  await rmDir(cloneDir);
  signal.throwIfAborted();
  if (fatal) throw fatal;
  log(`✅ Búsqueda finalizada. Coincidencias en ${writer.matchedRepos()} repositorio(s).`);
}
