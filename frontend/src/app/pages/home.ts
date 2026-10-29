import { DatePipe } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { catchError, forkJoin, map, of, timer } from 'rxjs';
import { AppConfig, FavoriteProject, STATUS_LABEL, Search, SearchApi, activeOf, downloadConfig, isActive, isByBranch, parseConfig } from '../search-api';
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
  favorites = signal<FavoriteProject[]>([]);
  favoriteError = signal('');
  /** Proyectos donde se lanzará la búsqueda: favoritos marcados más el proyecto escrito. */
  selectedProjects = computed(() => {
    const names = this.favorites().filter((f) => f.selected).map((f) => f.name);
    const typed = this.project().trim();
    if (typed && !names.some((n) => n.toLowerCase() === typed.toLowerCase())) names.push(typed);
    return names;
  });
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
  stats = computed(() => {
    const list = this.searches();
    const count = (...st: Search['status'][]) => list.filter((s) => st.includes(s.status)).length;
    return {
      total: list.length,
      active: count('queued', 'running'),
      completed: count('completed'),
      problems: count('failed', 'cancelled', 'interrupted'),
    };
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
    forkJoin({ config: this.api.config(), favorites: this.api.favorites().pipe(catchError(() => of([]))) }).subscribe(({ config, favorites }) => {
      this.config.set(config);
      this.favorites.set(favorites);
      // Con favoritos marcados no se agrega el proyecto por defecto, para no buscar donde no se pidió.
      if (!this.project() && !favorites.some((f) => f.selected)) this.project.set(config.project);
    });
    timer(0, 3000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refresh());
  }

  private saveFavorites(next: FavoriteProject[], done?: string) {
    const prev = this.favorites();
    this.favorites.set(next);
    this.favoriteError.set('');
    this.api.saveFavorites(next).subscribe({
      next: (saved) => {
        this.favorites.set(saved);
        if (done) this.notice.set(done);
      },
      error: (e) => {
        this.favorites.set(prev);
        this.favoriteError.set(e.error?.error ?? 'No se pudieron guardar los favoritos.');
      },
    });
  }

  addFavorite() {
    const name = this.project().trim();
    if (!name) {
      this.favoriteError.set('Escribe el nombre del proyecto que quieres agregar a favoritos.');
      document.getElementById('project')?.focus();
      return;
    }
    const exists = this.favorites().some((f) => f.name.toLowerCase() === name.toLowerCase());
    const next = exists
      ? this.favorites().map((f) => (f.name.toLowerCase() === name.toLowerCase() ? { ...f, selected: true } : f))
      : [...this.favorites(), { name, selected: true }];
    this.project.set('');
    this.saveFavorites(next, exists ? `"${name}" ya estaba en favoritos; quedó seleccionado.` : `"${name}" agregado a favoritos.`);
  }

  toggleFavorite(fav: FavoriteProject, selected: boolean) {
    this.saveFavorites(this.favorites().map((f) => (f.name === fav.name ? { ...f, selected } : f)));
  }

  selectAllFavorites(selected: boolean) {
    this.saveFavorites(this.favorites().map((f) => ({ ...f, selected })));
  }

  removeFavorite(fav: FavoriteProject) {
    this.saveFavorites(
      this.favorites().filter((f) => f.name !== fav.name),
      `"${fav.name}" eliminado de favoritos.`,
    );
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
    const projects = this.selectedProjects();
    if (!projects.length) {
      document.getElementById('project')?.focus();
      return;
    }
    if (this.byBranch() && projects.length > 1) {
      this.error.set('Para buscar en una sola rama selecciona un único proyecto (desmarca los demás favoritos o deja vacío el campo de proyecto).');
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
    const fileName = this.fileName().trim();
    // Una sesión por proyecto; cada creación informa su propio error sin cancelar las demás.
    const requests = projects.map((project) =>
      this.api
        .create({
          term: this.term().trim(),
          fileName: fileName && projects.length > 1 ? `${fileName.replace(/\.txt$/i, '')}_${project}` : fileName,
          project,
          byBranch: this.byBranch(),
          repo: this.byBranch() ? this.repo().trim() : '',
          branch: this.byBranch() ? this.branch().trim() : '',
        })
        .pipe(
          map((search) => ({ project, search, error: '' })),
          catchError((e) => of({ project, search: null, error: e.error?.error ?? 'No se pudo iniciar la búsqueda.' })),
        ),
    );
    forkJoin(requests).subscribe((results) => {
      this.submitting.set(false);
      const ok = results.filter((r) => r.search);
      const failed = results.filter((r) => !r.search);
      if (projects.length === 1 && ok.length === 1) {
        this.router.navigate(['/busquedas', ok[0].search!.id]);
        return;
      }
      if (ok.length) this.notice.set(`Se iniciaron ${ok.length} búsquedas en: ${ok.map((r) => r.project).join(', ')}.`);
      if (failed.length) this.error.set(failed.map((r) => (projects.length > 1 ? `${r.project}: ${r.error}` : r.error)).join(' · '));
      this.refresh();
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
