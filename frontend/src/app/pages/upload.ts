import { Component, OnDestroy, signal } from '@angular/core';
import { MatchEngine } from '../engine/match-engine';
import { MatchList } from './match-list';

@Component({
  selector: 'app-upload',
  imports: [MatchList],
  template: `
    <section class="container">
      <h1>Analizar un archivo de resultados</h1>
      <p class="lead">
        Sube un archivo de resultados descargado de esta plataforma. Se procesa en tu navegador (sin enviarlo al servidor), también con archivos muy grandes, y puedes filtrar por texto, repositorio y rama.
      </p>

      <div class="card">
        <div class="field">
          <label for="resfile">Archivo de resultados (.txt)</label>
          <input id="resfile" type="file" accept=".txt,.log,text/plain" (change)="onFile($event)" aria-describedby="resfile-help" />
          <p id="resfile-help" class="help">Formato generado por esta aplicación o por el script original.</p>
        </div>
        @if (engine.loadProgress() !== null) {
          <div class="progress-row" role="status" aria-live="polite">
            <progress [value]="engine.loadProgress()" max="1" aria-label="Progreso de lectura del archivo"></progress>
            <span>Leyendo {{ fileName() }}… {{ ((engine.loadProgress() ?? 0) * 100).toFixed(0) }}%</span>
          </div>
        }
        @if (error()) {
          <p class="alert alert-error" role="alert">{{ error() }}</p>
        }
        @if (loaded()) {
          <p class="current" role="status">
            <strong>{{ fileName() }}</strong>
            @if (term()) {
              · término buscado: <strong>{{ term() }}</strong>
            }
            · {{ total() }} coincidencias
          </p>
        }
      </div>

      @if (loaded()) {
        <h2>Detalle</h2>
        <app-match-list [engine]="engine" emptyText="El archivo no contiene coincidencias reconocibles." />
      }
    </section>
  `,
})
export class Upload implements OnDestroy {
  engine = new MatchEngine();
  fileName = signal('');
  term = signal('');
  total = signal(0);
  loaded = signal(false);
  error = signal('');

  async onFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.error.set('');
    this.loaded.set(false);
    this.fileName.set(file.name);
    try {
      const r = await this.engine.load(file);
      this.term.set(r.term);
      this.total.set(r.total);
      this.loaded.set(true);
    } catch (e) {
      this.error.set('No se pudo leer el archivo: ' + (e as Error).message);
    }
  }

  ngOnDestroy() {
    this.engine.destroy();
  }
}
