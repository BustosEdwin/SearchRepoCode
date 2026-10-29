// Motor de coincidencias: lógica pura (sin DOM) que corre dentro de un Web Worker.
//
// Diseño para rendimiento:
//  - Almacenamiento columnar (typed arrays) en vez de un objeto por fila.
//  - Repositorios y ramas internados: cada nombre se guarda una vez y las filas guardan su índice.
//  - Un único texto en minúsculas ("pajar") con los textos de todas las filas; el filtro usa
//    String.indexOf nativo sobre ese bloque (muy rápido) y avanza por línea de forma lineal,
//    en lugar de llamar a includes() fila por fila.
//  - Una sola pasada calcula resultados y conteos de repositorios/ramas.
//  - El análisis del archivo es en streaming, sin cargarlo completo como un único string.

export type MatchType = 'CONTENIDO' | 'ARCHIVO';

export interface NewMatch {
  repo: string;
  branch: string;
  type: MatchType;
  text: string;
}

export interface Row extends NewMatch {
  id: number;
}

export interface Facet {
  name: string;
  count: number;
}

export interface Query {
  q: string;
  repos: string[];
  branches: string[];
}

export interface QueryResult {
  total: number;
  matched: number;
  repoFacets: Facet[];
  branchFacets: Facet[];
  rows: Row[];
}

const MAX_TOKENS = 8;
const MAX_FACETS = 1000;

export class MatchStore {
  repos: string[] = [];
  branches: string[] = [];
  count = 0;

  private repoIds = new Map<string, number>();
  private branchIds = new Map<string, number>();
  private cap = 4096;
  private rowRepo = new Uint32Array(4096);
  private rowBranch = new Uint32Array(4096);
  private rowType = new Uint8Array(4096);
  private offsets = new Uint32Array(4097);
  private texts: string[] = [];
  private hay = '';
  private parts: string[] = [];
  private hayLen = 0;
  private filtered = new Uint32Array(0);
  private filteredCount = 0;

  reset() {
    this.repos = [];
    this.branches = [];
    this.count = 0;
    this.repoIds.clear();
    this.branchIds.clear();
    this.texts = [];
    this.hay = '';
    this.parts = [];
    this.hayLen = 0;
    this.filteredCount = 0;
  }

  add(repo: string, branch: string, type: MatchType, text: string) {
    if (this.count === this.cap) this.grow();
    const i = this.count;
    this.rowRepo[i] = this.intern(this.repoIds, this.repos, repo);
    this.rowBranch[i] = this.intern(this.branchIds, this.branches, branch);
    this.rowType[i] = type === 'ARCHIVO' ? 1 : 0;
    const lower = text.toLowerCase();
    this.offsets[i] = this.hayLen;
    this.parts.push(lower + '\n');
    this.hayLen += lower.length + 1;
    this.offsets[i + 1] = this.hayLen;
    this.texts.push(text);
    this.count++;
  }

  addMany(items: NewMatch[]) {
    for (const m of items) this.add(m.repo, m.branch, m.type, m.text);
  }

  private intern(map: Map<string, number>, list: string[], name: string) {
    let id = map.get(name);
    if (id === undefined) {
      id = list.length;
      list.push(name);
      map.set(name, id);
    }
    return id;
  }

  private grow() {
    this.cap *= 2;
    const r = new Uint32Array(this.cap);
    r.set(this.rowRepo);
    this.rowRepo = r;
    const b = new Uint32Array(this.cap);
    b.set(this.rowBranch);
    this.rowBranch = b;
    const t = new Uint8Array(this.cap);
    t.set(this.rowType);
    this.rowType = t;
    const o = new Uint32Array(this.cap + 1);
    o.set(this.offsets);
    this.offsets = o;
  }

  private flushHay() {
    if (this.parts.length) {
      this.hay += this.parts.join('');
      this.parts = [];
    }
  }

  query(q: Query, limit: number): QueryResult {
    const n = this.count;
    this.flushHay();
    const hay = this.hay;
    const offsets = this.offsets;
    const tokens = q.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);
    const nt = tokens.length;

    // Por cada término: en qué líneas aparece en el texto, y qué repos/ramas lo contienen en su nombre.
    const textHit: Uint8Array[] = [];
    const repoOk: Uint8Array[] = [];
    const branchOk: Uint8Array[] = [];
    const repoLower = this.repos.map((r) => r.toLowerCase());
    const branchLower = this.branches.map((b) => b.toLowerCase());
    for (const tok of tokens) {
      const hit = new Uint8Array(n);
      let line = 0;
      let pos = hay.indexOf(tok);
      while (pos !== -1) {
        while (offsets[line + 1] <= pos) line++;
        hit[line] = 1;
        pos = hay.indexOf(tok, offsets[line + 1]);
      }
      textHit.push(hit);
      repoOk.push(Uint8Array.from(repoLower, (r) => (r.includes(tok) ? 1 : 0)));
      branchOk.push(Uint8Array.from(branchLower, (b) => (b.includes(tok) ? 1 : 0)));
    }

    const rOn = q.repos.length > 0;
    const bOn = q.branches.length > 0;
    const rSel = new Uint8Array(this.repos.length);
    const bSel = new Uint8Array(this.branches.length);
    for (const r of q.repos) {
      const id = this.repoIds.get(r);
      if (id !== undefined) rSel[id] = 1;
    }
    for (const b of q.branches) {
      const id = this.branchIds.get(b);
      if (id !== undefined) bSel[id] = 1;
    }

    const repoCounts = new Uint32Array(this.repos.length);
    const branchCounts = new Uint32Array(this.branches.length);
    if (this.filtered.length < n) this.filtered = new Uint32Array(Math.max(n, 1024));
    const out = this.filtered;
    let m = 0;
    const rowRepo = this.rowRepo;
    const rowBranch = this.rowBranch;
    for (let i = 0; i < n; i++) {
      const r = rowRepo[i];
      const b = rowBranch[i];
      let ok = true;
      for (let t = 0; t < nt; t++) {
        if (!(textHit[t][i] || repoOk[t][r] || branchOk[t][b])) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const okB = !bOn || bSel[b] === 1;
      const okR = !rOn || rSel[r] === 1;
      if (okB) repoCounts[r]++;
      if (okR) branchCounts[b]++;
      if (okB && okR) out[m++] = i;
    }
    this.filteredCount = m;

    return {
      total: n,
      matched: m,
      repoFacets: this.facets(this.repos, repoCounts, rSel),
      branchFacets: this.facets(this.branches, branchCounts, bSel),
      rows: this.rows(0, limit),
    };
  }

  private facets(names: string[], counts: Uint32Array, selected: Uint8Array): Facet[] {
    const list: Facet[] = [];
    for (let i = 0; i < names.length; i++) {
      if (counts[i] > 0 || selected[i]) list.push({ name: names[i], count: counts[i] });
    }
    list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return list.slice(0, MAX_FACETS);
  }

  private row(i: number): Row {
    return {
      id: i,
      repo: this.repos[this.rowRepo[i]],
      branch: this.branches[this.rowBranch[i]],
      type: this.rowType[i] === 1 ? 'ARCHIVO' : 'CONTENIDO',
      text: this.texts[i],
    };
  }

  /** Filas [from, to) del último resultado filtrado. */
  rows(from: number, to: number): Row[] {
    const end = Math.min(to, this.filteredCount);
    const out: Row[] = [];
    for (let k = from; k < end; k++) out.push(this.row(this.filtered[k]));
    return out;
  }

  /** Identificadores de todas las filas del último resultado filtrado. */
  filteredIds(): Uint32Array {
    return this.filtered.slice(0, this.filteredCount);
  }

  byIds(ids: ArrayLike<number>): Row[] {
    const out: Row[] = [];
    for (let k = 0; k < ids.length; k++) if (ids[k] < this.count) out.push(this.row(ids[k]));
    return out;
  }
}

/** Analiza en streaming un archivo de resultados (formato de esta plataforma y de buscar_dependencia.sh). */
export class ResultParser {
  term = '';
  private store: MatchStore;
  private repo = '';
  private branch = '';
  private prefix = '';
  private rest = '';

  constructor(store: MatchStore) {
    this.store = store;
  }

  feed(chunk: string) {
    const data = this.rest + chunk;
    let start = 0;
    let nl: number;
    while ((nl = data.indexOf('\n', start)) !== -1) {
      this.line(data.slice(start, nl));
      start = nl + 1;
    }
    this.rest = data.slice(start);
  }

  finish() {
    if (this.rest) this.line(this.rest);
    this.rest = '';
  }

  private line(raw: string) {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!l) return;
    const c = l.charCodeAt(0);
    if (c === 61) return; // líneas "====="
    if (c === 91) {
      if (l.startsWith('[ARCHIVO] Rama ')) {
        const rest = l.slice(15);
        const sep = rest.indexOf(': ');
        if (sep > 0) this.store.add(this.repo, rest.slice(0, sep), 'ARCHIVO', rest.slice(sep + 2));
        return;
      }
      if (l.startsWith('[CONTENIDO] Rama ') && l.endsWith(':')) {
        this.branch = l.slice(17, -1);
        this.prefix = `${this.branch}:`;
        return;
      }
    } else if (c === 82 && l.startsWith('RESULTADOS DE BÚSQUEDA PARA:')) {
      this.term = l.slice(28).trim();
      return;
    } else if (c === 0xd83d && l.startsWith('🔥 REPOSITORIO:')) {
      this.repo = l.slice(15).trim();
      this.branch = '';
      this.prefix = '';
      return;
    }
    if (!this.branch) return;
    this.store.add(this.repo, this.branch, 'CONTENIDO', l.startsWith(this.prefix) ? l.slice(this.prefix.length) : l);
  }
}
