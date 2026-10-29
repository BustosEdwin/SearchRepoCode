import { Component, ElementRef, OnDestroy, effect, input, signal, untracked, viewChild } from '@angular/core';
import { MatchEngine, QueryResult, Row } from '../engine/match-engine';

const PAGE = 200;
const MODAL_PAGE = 200;
const EMPTY: QueryResult = { total: 0, matched: 0, repoFacets: [], branchFacets: [], rows: [] };

@Component({
  selector: 'app-match-list',
  template: `
    <div class="field filter">
      <label [for]="inputId">Filtrar el detalle (repositorio, rama, archivo o texto)</label>
      <input [id]="inputId" type="text" autocomplete="off" (input)="setFilter($any($event.target).value)" [attr.aria-describedby]="inputId + '-count'" />
      <p class="help">Puedes escribir varias palabras: se muestran las coincidencias que contengan todas.</p>
    </div>

    @if (result().repoFacets.length || repos().size) {
      <fieldset class="facets">
        <legend>Repositorios ({{ result().repoFacets.length }})</legend>
        <div class="chips">
          @for (f of result().repoFacets; track f.name) {
            <button type="button" class="chip" [attr.aria-pressed]="repos().has(f.name)" (click)="toggle(repos, f.name)">
              {{ f.name }} <span class="chip-count">{{ f.count }}</span>
            </button>
          }
        </div>
      </fieldset>
      <fieldset class="facets">
        <legend>Ramas ({{ result().branchFacets.length }})</legend>
        <div class="chips">
          @for (f of result().branchFacets; track f.name) {
            <button type="button" class="chip" [attr.aria-pressed]="branches().has(f.name)" (click)="toggle(branches, f.name)">
              {{ f.name }} <span class="chip-count">{{ f.count }}</span>
            </button>
          }
        </div>
      </fieldset>
    }

    <div class="toolbar">
      <p [id]="inputId + '-count'" class="help" role="status" aria-live="polite" [attr.aria-busy]="busy()">
        {{ result().matched }} de {{ result().total }} coincidencias
        @if (repos().size || branches().size) {
          · {{ repos().size + branches().size }} filtro(s) por etiqueta
        }
        @if (busy()) {
          · filtrando…
        }
      </p>
      <div class="actions">
        @if (repos().size || branches().size || filter()) {
          <button type="button" class="btn btn-secondary" (click)="clearFilters()">Limpiar filtros</button>
        }
        <button type="button" class="btn btn-secondary" (click)="selectAllFiltered()" [disabled]="!result().matched">Seleccionar los {{ result().matched }} resultados</button>
        @if (selected().size) {
          <button type="button" class="btn btn-secondary" (click)="selected.set(emptySet)">Quitar selección</button>
        }
        <button type="button" class="btn btn-primary" (click)="openSelected()" [disabled]="!selected().size">Ver seleccionados ({{ selected().size }})</button>
      </div>
    </div>

    <ul class="matches" tabindex="0" aria-label="Detalle de coincidencias">
      @for (m of rows(); track m.id) {
        <li>
          <input type="checkbox" class="pick" [checked]="selected().has(m.id)" (change)="pick(m.id)" [attr.aria-label]="'Seleccionar coincidencia en ' + m.repo + ' rama ' + m.branch" />
          <span class="tag">{{ m.repo }}</span>
          <span class="tag">{{ m.branch }}</span>
          <span class="tag tag-type">{{ m.type === 'ARCHIVO' ? 'Archivo' : 'Contenido' }}</span>
          <button type="button" class="link-btn" (click)="openOne(m)">Ver<span class="sr-only"> coincidencia en {{ m.repo }}</span></button>
          <code class="match-text">{{ m.text }}</code>
        </li>
      } @empty {
        <li class="empty">{{ result().total ? 'Ninguna coincidencia cumple los filtros.' : emptyText() }}</li>
      }
    </ul>
    @if (result().matched > rows().length) {
      <button type="button" class="btn btn-secondary" (click)="more()">Mostrar más ({{ result().matched - rows().length }} restantes)</button>
    }

    <dialog #dlg class="modal" aria-labelledby="modal-title" (close)="onClose()">
      <div class="modal-head">
        <h2 id="modal-title">{{ modalIds().length === 1 ? 'Coincidencia' : modalIds().length + ' coincidencias seleccionadas' }}</h2>
        <button type="button" class="btn btn-primary" (click)="dlg.close()">Cerrar</button>
      </div>
      <div class="modal-body" tabindex="0">
        @for (m of modalRows(); track m.id) {
          <article class="modal-item">
            <p class="meta">
              Repositorio <strong>{{ m.repo }}</strong> · rama <strong>{{ m.branch }}</strong> · {{ m.type === 'ARCHIVO' ? 'nombre de archivo' : 'contenido de archivo' }}
            </p>
            <pre class="preview">{{ m.text }}</pre>
          </article>
        }
        @if (modalRows().length < modalIds().length) {
          <button type="button" class="btn btn-secondary" (click)="modalMore()">Mostrar más ({{ modalIds().length - modalRows().length }} restantes)</button>
        }
      </div>
    </dialog>
  `,
})
export class MatchList implements OnDestroy {
  engine = input.required<MatchEngine>();
  emptyText = input('No hay coincidencias.');
  inputId = `filter-${Math.random().toString(36).slice(2, 8)}`;
  emptySet = new Set<number>();
  private dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  private opener: HTMLElement | null = null;

  filter = signal('');
  repos = signal(new Set<string>());
  branches = signal(new Set<string>());
  selected = signal(new Set<number>());
  result = signal<QueryResult>(EMPTY);
  rows = signal<Row[]>([]);
  busy = signal(false);
  modalIds = signal<number[]>([]);
  modalRows = signal<Row[]>([]);

  private running = false;
  private dirty = false;
  private gen = 0;
  private debounce?: ReturnType<typeof setTimeout>;

  constructor() {
    // Cualquier cambio de filtro o de contenido dispara una consulta al worker (la UI nunca se bloquea).
    effect(() => {
      this.engine().revision();
      this.filter();
      this.repos();
      this.branches();
      untracked(() => void this.run());
    });
  }

  private async run() {
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    this.busy.set(true);
    try {
      do {
        this.dirty = false;
        const gen = ++this.gen;
        const res = await this.engine().query(
          { q: this.filter(), repos: [...this.repos()], branches: [...this.branches()] },
          Math.max(PAGE, this.rows().length),
        );
        if (gen === this.gen) {
          this.result.set(res);
          this.rows.set(res.rows);
        }
      } while (this.dirty);
    } catch {
      /* el worker se cerró (se salió de la página) */
    } finally {
      this.running = false;
      this.busy.set(false);
    }
  }

  setFilter(v: string) {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.rows.set([]);
      this.filter.set(v);
    }, 200);
  }

  toggle(sig: typeof this.repos, name: string) {
    this.rows.set([]);
    sig.update((s) => {
      const n = new Set(s);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  }

  clearFilters() {
    clearTimeout(this.debounce);
    const el = document.getElementById(this.inputId) as HTMLInputElement | null;
    if (el) el.value = '';
    this.rows.set([]);
    this.filter.set('');
    this.repos.set(new Set());
    this.branches.set(new Set());
  }

  pick(id: number) {
    this.selected.update((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async selectAllFiltered() {
    this.selected.set(new Set(await this.engine().filteredIds()));
  }

  async more() {
    const gen = this.gen;
    const from = this.rows().length;
    const next = await this.engine().rows(from, from + PAGE);
    if (gen === this.gen) this.rows.update((r) => r.concat(next));
  }

  openOne(m: Row) {
    this.modalIds.set([m.id]);
    this.modalRows.set([m]);
    this.show();
  }

  async openSelected() {
    const ids = [...this.selected()].sort((a, b) => a - b);
    this.modalIds.set(ids);
    this.modalRows.set(await this.engine().byIds(ids.slice(0, MODAL_PAGE)));
    this.show();
  }

  async modalMore() {
    const from = this.modalRows().length;
    const next = await this.engine().byIds(this.modalIds().slice(from, from + MODAL_PAGE));
    this.modalRows.update((r) => r.concat(next));
  }

  private show() {
    this.opener = document.activeElement as HTMLElement;
    this.dlg().nativeElement.showModal();
  }

  onClose() {
    this.opener?.focus();
  }

  ngOnDestroy() {
    clearTimeout(this.debounce);
  }
}
