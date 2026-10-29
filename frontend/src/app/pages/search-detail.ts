import { DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatchEngine } from '../engine/match-engine';
import { Match, Search, SearchApi, activeOf, downloadConfig, isActive, isByBranch } from '../search-api';
import { MatchList } from './match-list';
import { StatusBadge } from './status-badge';

@Component({
  selector: 'app-search-detail',
  imports: [DatePipe, RouterLink, StatusBadge, MatchList],
  templateUrl: './search-detail.html',
})
export class SearchDetail implements OnInit {
  private api = inject(SearchApi);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  id = input.required<string>();
  engine = new MatchEngine();
  search = signal<Search | null>(null);
  logs = signal<{ t: string; line: string }[]>([]);
  received = signal(0);
  error = signal('');
  notice = signal('');
  cancelling = signal(false);
  isActive = isActive;
  activeOf = activeOf;
  isByBranch = isByBranch;
  exportConfig = downloadConfig;
  private source?: EventSource;

  ngOnInit() {
    this.destroyRef.onDestroy(() => {
      this.source?.close();
      this.engine.destroy();
    });
    this.source = new EventSource(this.api.eventsUrl(this.id()));
    this.source.addEventListener('job', (e) => this.search.set(JSON.parse((e as MessageEvent).data)));
    this.source.addEventListener('log', (e) => {
      const entry = JSON.parse((e as MessageEvent).data);
      this.logs.update((l) => [...l.slice(-1999), entry]);
      queueMicrotask(() => {
        const box = document.getElementById('log');
        if (box) box.scrollTop = box.scrollHeight;
      });
    });
    // Las coincidencias llegan en vivo, igual que se escriben en el archivo, y se procesan en un worker.
    this.source.addEventListener('matches', (e) => {
      const items = JSON.parse((e as MessageEvent).data) as Match[];
      this.received.update((n) => n + items.length);
      this.engine.append(items);
    });
    this.source.addEventListener('end', () => {
      this.source?.close();
      // Solo si el servidor se reinició y ya no tiene el detalle en memoria.
      if (!this.received() && this.search()?.resultSize) void this.recoverFromFile();
    });
    this.source.onerror = () => {
      if (!this.search()) this.error.set('No se encontró la búsqueda o el servidor no responde.');
    };
  }

  private async recoverFromFile() {
    try {
      const res = await fetch(this.api.downloadUrl(this.id()));
      if (!res.ok) return;
      await this.engine.load(await res.blob());
      this.notice.set('Detalle recuperado del archivo (el servidor se reinició).');
    } catch {
      this.error.set('No se pudo recuperar el detalle del archivo.');
    }
  }

  cancel() {
    this.cancelling.set(true);
    this.error.set('');
    this.api.cancel(this.id()).subscribe({
      next: () => this.cancelling.set(false),
      error: (e) => {
        this.cancelling.set(false);
        this.error.set(
          e.status === 502 || e.status === 0
            ? 'No se pudo cancelar: el servidor no responde. Verifica que el backend esté en ejecución e inténtalo de nuevo.'
            : (e.error?.error ?? 'No se pudo cancelar la búsqueda.'),
        );
      },
    });
  }

  remove() {
    if (!confirm('¿Eliminar esta búsqueda y su archivo de resultados?')) return;
    this.api.remove(this.id()).subscribe({
      next: () => this.router.navigate(['/']),
      error: (e) => this.error.set(e.error?.error ?? 'No se pudo eliminar.'),
    });
  }

  downloadUrl() {
    return this.api.downloadUrl(this.id());
  }

  pct(s: Search) {
    return s.progress.total ? Math.round((s.progress.done / s.progress.total) * 100) : 0;
  }
}
