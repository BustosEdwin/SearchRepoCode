import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type Status = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface Search {
  id: string;
  term: string;
  fileName: string;
  status: Status;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  resultSize?: number;
  progress: { total: number; done: number; matches: number; repo?: string; branch?: string; active?: { repo: string; branch: string }[] };
  project?: string;
  byBranch?: boolean;
  repo?: string;
  branch?: string;
}

export interface CreateSearch {
  term: string;
  fileName: string;
  project: string;
  byBranch: boolean;
  repo: string;
  branch: string;
}

export interface Match {
  repo: string;
  branch: string;
  type: 'CONTENIDO' | 'ARCHIVO';
  text: string;
}

export interface AppConfig {
  org: string;
  project: string;
  patConfigured: boolean;
  maxConcurrent: number;
}

export interface FavoriteProject {
  name: string;
  selected: boolean;
}

export interface PatStatus {
  configured: boolean;
  masked: string;
  source: 'store' | 'env' | 'none';
  updatedAt: string | null;
  requiresAdminKey: boolean;
}

export const STATUS_LABEL: Record<Status, string> = {
  queued: 'En cola',
  running: 'En ejecución',
  completed: 'Completada',
  failed: 'Con error',
  cancelled: 'Cancelada',
  interrupted: 'Interrumpida',
};

export const isActive = (s: Status) => s === 'queued' || s === 'running';

/** Las búsquedas anteriores no guardaban byBranch; se deduce de la rama. */
export const isByBranch = (s: Search) => s.byBranch ?? !!s.branch;

export interface SearchConfigFile {
  type: 'search-config';
  version: 1;
  term: string;
  project: string;
  byBranch: boolean;
  repo: string;
  branch: string;
  fileName: string;
}

export const toConfigFile = (s: Search): SearchConfigFile => ({
  type: 'search-config',
  version: 1,
  term: s.term,
  project: s.project ?? '',
  byBranch: isByBranch(s),
  repo: s.repo ?? '',
  branch: s.branch ?? '',
  fileName: s.fileName,
});

export function downloadConfig(s: Search) {
  const blob = new Blob([JSON.stringify(toConfigFile(s), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `config_${s.fileName.replace(/\.[^.]+$/, '')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Valida el JSON importado; lanza Error con un mensaje legible si no es una configuración válida. */
export function parseConfig(text: string): SearchConfigFile {
  let d: any;
  try {
    d = JSON.parse(text);
  } catch {
    throw new Error('El archivo no es un JSON válido.');
  }
  if (!d || typeof d !== 'object' || typeof d.term !== 'string' || !d.term.trim()) {
    throw new Error('El JSON no contiene una configuración de búsqueda válida (falta "term").');
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const byBranch = d.byBranch === true;
  if (byBranch && (!str(d.repo) || !str(d.branch))) {
    throw new Error('La configuración indica búsqueda por rama pero falta "repo" o "branch".');
  }
  return {
    type: 'search-config',
    version: 1,
    term: d.term.trim(),
    project: str(d.project),
    byBranch,
    repo: byBranch ? str(d.repo) : '',
    branch: byBranch ? str(d.branch) : '',
    fileName: str(d.fileName),
  };
}

export const activeOf = (s: Search): { repo: string; branch: string }[] =>
  s.progress.active?.length ? s.progress.active : s.progress.repo ? [{ repo: s.progress.repo, branch: s.progress.branch ?? '' }] : [];

@Injectable({ providedIn: 'root' })
export class SearchApi {
  private http = inject(HttpClient);

  config() {
    return this.http.get<AppConfig>('/api/config');
  }
  private adminHeaders(key: string) {
    return key ? { headers: { 'X-Admin-Key': key } } : {};
  }
  getPat(key = '') {
    return this.http.get<PatStatus>('/api/settings/pat', this.adminHeaders(key));
  }
  setPat(token: string, key = '') {
    return this.http.put<PatStatus>('/api/settings/pat', { token }, this.adminHeaders(key));
  }
  deletePat(key = '') {
    return this.http.delete<PatStatus>('/api/settings/pat', this.adminHeaders(key));
  }
  favorites() {
    return this.http.get<FavoriteProject[]>('/api/favorites');
  }
  saveFavorites(projects: FavoriteProject[]) {
    return this.http.put<FavoriteProject[]>('/api/favorites', { projects });
  }
  list() {
    return this.http.get<Search[]>('/api/searches');
  }
  get(id: string) {
    return this.http.get<Search>(`/api/searches/${id}`);
  }
  create(body: CreateSearch): Observable<Search> {
    return this.http.post<Search>('/api/searches', body);
  }
  cancel(id: string) {
    return this.http.post<Search>(`/api/searches/${id}/cancel`, {});
  }
  remove(id: string) {
    return this.http.delete<void>(`/api/searches/${id}`);
  }
  result(id: string) {
    return this.http.get<{ content: string; truncated: boolean; size: number }>(`/api/searches/${id}/result`);
  }
  downloadUrl(id: string) {
    return `/api/searches/${id}/download`;
  }
  eventsUrl(id: string) {
    return `/api/searches/${id}/events`;
  }
}
