import { signal } from '@angular/core';
import type { NewMatch, Query, QueryResult, Row } from './match-store';

export type { Facet, NewMatch, Query, QueryResult, Row } from './match-store';

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

/** Puente hacia el Web Worker que guarda, analiza y filtra las coincidencias fuera del hilo de la interfaz. */
export class MatchEngine {
  /** Cambia cuando el contenido crece o se reemplaza; las vistas lo observan para volver a consultar. */
  readonly revision = signal(0);
  /** Avance de lectura de un archivo (0..1) o null si no hay carga en curso. */
  readonly loadProgress = signal<number | null>(null);

  private worker = new Worker(new URL('./match.worker', import.meta.url), { type: 'module' });
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private bumpTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        this.loadProgress.set(data.size ? data.loaded / data.size : 1);
        return;
      }
      const p = this.pending.get(data.reqId);
      if (!p) return;
      this.pending.delete(data.reqId);
      if (data.type === 'error') p.reject(new Error(data.message));
      else p.resolve(data);
    };
  }

  private call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const reqId = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.worker.postMessage({ ...msg, reqId }, transfer);
    });
  }

  reset() {
    this.worker.postMessage({ type: 'reset' });
    this.revision.update((v) => v + 1);
  }

  /** Agrega coincidencias nuevas (modo en vivo). La notificación a las vistas se agrupa cada 400 ms. */
  append(items: NewMatch[]) {
    this.worker.postMessage({ type: 'append', items });
    this.bumpTimer ??= setTimeout(() => {
      this.bumpTimer = null;
      this.revision.update((v) => v + 1);
    }, 400);
  }

  async load(blob: Blob): Promise<{ term: string; total: number }> {
    this.loadProgress.set(0);
    try {
      const r = await this.call<{ term: string; total: number }>({ type: 'load', blob });
      return { term: r.term, total: r.total };
    } finally {
      this.loadProgress.set(null);
      this.revision.update((v) => v + 1);
    }
  }

  async query(query: Query, limit: number): Promise<QueryResult> {
    return (await this.call<{ result: QueryResult }>({ type: 'query', query, limit })).result;
  }

  async rows(from: number, to: number): Promise<Row[]> {
    return (await this.call<{ rows: Row[] }>({ type: 'rows', from, to })).rows;
  }

  async filteredIds(): Promise<Uint32Array> {
    return (await this.call<{ ids: Uint32Array }>({ type: 'ids' })).ids;
  }

  async byIds(ids: number[]): Promise<Row[]> {
    return (await this.call<{ rows: Row[] }>({ type: 'byIds', ids })).rows;
  }

  destroy() {
    if (this.bumpTimer) clearTimeout(this.bumpTimer);
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('cancelado'));
    this.pending.clear();
  }
}
