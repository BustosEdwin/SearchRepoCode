import { DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { timer } from 'rxjs';
import { AppConfig, STATUS_LABEL, Search, SearchApi, activeOf, downloadConfig, isActive, isByBranch, parseConfig } from '../search-api';
import { StatusBadge } from './status-badge';

@Component({
  selector: 'app-home',
  imports: [DatePipe, RouterLink, StatusBadge],
  templateUrl: './home.html',
})
export class Home implements OnInit {
  private api = inject(SearchApi);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  term = signal('');
  project = signal('');
  fileName = signal('');
  byBranch = signal(false);
  repo = signal('');
  branch = signal('');
  submitting = signal(false);
  error = signal('');
  notice = signal('');
  touched = signal(false);
  config = signal<AppConfig | null>(null);
  searches = signal<Search[]>([]);
  loaded = signal(false);
  filter = signal('');
  filtered = computed(() => {
    const words = this.filter().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return this.searches();
    return this.searches().filter((s) => {
      const hay = [s.term, s.project ?? this.config()?.project ?? '', s.repo ?? '', s.branch ?? '', s.fileName, STATUS_LABEL[s.status]]
        .join(' ')
        .toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  });
  isActive = isActive;
  activeOf = activeOf;
  isByBranch = isByBranch;
  exportConfig = downloadConfig;

  async importConfig(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.error.set('');
    try {
      const c = parseConfig(await file.text());
      this.term.set(c.term);
      this.project.set(c.project || this.config()?.project || '');
      this.fileName.set(c.fileName);
      this.byBranch.set(c.byBranch);
      this.repo.set(c.repo);
      this.branch.set(c.branch);
      this.touched.set(false);
      this.notice.set(`Configuración importada desde ${file.name}. Revísala y pulsa "Iniciar búsqueda".`);
    } catch (e) {
      this.error.set((e as Error).message);
    }
  }

  ngOnInit() {
    this.api.config().subscribe((c) => {
      this.config.set(c);
      if (!this.project()) this.project.set(c.project);
    });
    timer(0, 3000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refresh());
  }

  refresh() {
    this.api.list().subscribe({
      next: (list) => {
        this.searches.set(list);
        this.loaded.set(true);
      },
      error: () => this.error.set('No se pudo conectar con el servidor.'),
    });
  }

  submit(event: Event) {
    event.preventDefault();
    this.touched.set(true);
    this.error.set('');
    if (!this.term().trim()) {
      document.getElementById('term')?.focus();
      return;
    }
    if (!this.project().trim()) {
      document.getElementById('project')?.focus();
      return;
    }
    if (this.byBranch()) {
      if (!this.repo().trim()) {
        document.getElementById('repo')?.focus();
        return;
      }
      if (!this.branch().trim()) {
        document.getElementById('branch')?.focus();
        return;
      }
    }
    this.submitting.set(true);
    this.api
      .create({
        term: this.term().trim(),
        fileName: this.fileName().trim(),
        project: this.project().trim(),
        byBranch: this.byBranch(),
        repo: this.byBranch() ? this.repo().trim() : '',
        branch: this.byBranch() ? this.branch().trim() : '',
      })
      .subscribe({
        next: (s) => {
          this.submitting.set(false);
          this.router.navigate(['/busquedas', s.id]);
        },
        error: (e) => {
          this.submitting.set(false);
          this.error.set(e.error?.error ?? 'No se pudo iniciar la búsqueda.');
        },
      });
  }

  cancel(s: Search) {
    this.error.set('');
    this.api.cancel(s.id).subscribe({
      next: () => {
        this.notice.set(`Se solicitó cancelar la búsqueda "${s.term}".`);
        this.refresh();
      },
      error: (e) =>
        this.error.set(
          e.status === 502 || e.status === 0
            ? 'No se pudo cancelar: el servidor no responde. Verifica que el backend esté en ejecución e inténtalo de nuevo.'
            : (e.error?.error ?? 'No se pudo cancelar la búsqueda.'),
        ),
    });
  }

  remove(s: Search) {
    if (!confirm(`¿Eliminar la búsqueda "${s.term}" y su archivo de resultados?`)) return;
    this.api.remove(s.id).subscribe({
      next: () => {
        this.notice.set(`Búsqueda "${s.term}" eliminada.`);
        this.refresh();
      },
      error: (e) => this.error.set(e.error?.error ?? 'No se pudo eliminar.'),
    });
  }

  downloadUrl(s: Search) {
    return this.api.downloadUrl(s.id);
  }

  pct(s: Search) {
    return s.progress.total ? Math.round((s.progress.done / s.progress.total) * 100) : 0;
  }
}
