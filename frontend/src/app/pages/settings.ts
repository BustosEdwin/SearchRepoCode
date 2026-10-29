import { DatePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { PatStatus, SearchApi } from '../search-api';

@Component({
  selector: 'app-settings',
  imports: [DatePipe],
  template: `
    <section class="container">
      <h1>Token de Azure DevOps</h1>
      <p class="lead">Actualiza el Personal Access Token (PAT) que usa el servidor para consultar y clonar repositorios.</p>

      @if (message()) {
        <p class="alert alert-success" role="status">{{ message() }}</p>
      }
      @if (error()) {
        <p class="alert alert-error" role="alert">{{ error() }}</p>
      }

      <div class="card">
        <h2 style="margin-top:0">Estado actual</h2>
        @if (status(); as s) {
          @if (s.configured) {
            <p>
              Token configurado: <code>{{ s.masked }}</code>
              <span class="help">
                · origen: {{ s.source === 'store' ? 'guardado cifrado' : 'variable de entorno' }}
                @if (s.updatedAt) {
                  · actualizado {{ s.updatedAt | date: 'medium' }}
                }
              </span>
            </p>
          } @else {
            <p class="alert alert-warning">No hay ningún token configurado.</p>
          }
        } @else if (!error()) {
          <p class="help" role="status">Cargando…</p>
        }

        @if (status()?.requiresAdminKey) {
          <div class="field">
            <label for="adminKey">Clave de administración</label>
            <input id="adminKey" type="password" autocomplete="off" [value]="adminKey" (input)="adminKey = $any($event.target).value; refreshIfKey()" />
          </div>
        }

        <form (submit)="save($event)" autocomplete="off">
          <div class="field">
            <label for="pat">Nuevo token</label>
            <div class="input-row">
              <input
                id="pat"
                [type]="visible() ? 'text' : 'password'"
                name="pat-token"
                autocomplete="new-password"
                spellcheck="false"
                autocapitalize="off"
                maxlength="200"
                [value]="token"
                (input)="token = $any($event.target).value"
                [attr.aria-invalid]="invalid() ? 'true' : null"
                aria-describedby="pat-help"
              />
              <button type="button" class="btn btn-secondary" (click)="visible.set(!visible())" [attr.aria-pressed]="visible()">
                {{ visible() ? 'Ocultar' : 'Mostrar' }}
              </button>
            </div>
            <p id="pat-help" class="help">
              Se valida contra Azure DevOps antes de guardarse y se almacena cifrado (AES-256-GCM) en el servidor. Nunca se vuelve a mostrar completo.
            </p>
            @if (invalid()) {
              <p class="field-error" role="alert">Ingresa un token válido (solo letras y números, mínimo 20 caracteres).</p>
            }
          </div>
          <div class="actions">
            <button class="btn btn-primary" type="submit" [disabled]="busy()">{{ busy() ? 'Validando…' : 'Validar y guardar' }}</button>
            @if (status()?.source === 'store') {
              <button class="btn btn-danger-outline" type="button" (click)="remove()" [disabled]="busy()">Eliminar token guardado</button>
            }
          </div>
        </form>
      </div>

      <p class="alert alert-info">
        Genera el PAT en Azure DevOps con permiso <strong>Code (Read)</strong> únicamente. Sin <code>ADMIN_KEY</code> en el servidor, esta sección solo funciona desde la máquina donde corre el backend.
      </p>
    </section>
  `,
})
export class Settings implements OnInit, OnDestroy {
  private api = inject(SearchApi);
  status = signal<PatStatus | null>(null);
  message = signal('');
  error = signal('');
  busy = signal(false);
  visible = signal(false);
  invalid = signal(false);
  token = '';
  adminKey = '';

  ngOnInit() {
    this.refresh();
  }

  ngOnDestroy() {
    this.token = '';
    this.adminKey = '';
  }

  refreshIfKey() {
    if (this.adminKey.length >= 8) this.refresh();
  }

  private refresh() {
    this.api.getPat(this.adminKey).subscribe({
      next: (s) => {
        this.status.set(s);
        this.error.set('');
      },
      error: (e) => this.fail(e, 'No se pudo consultar el estado del token.'),
    });
  }

  private fail(e: any, fallback: string) {
    this.message.set('');
    this.error.set(e.error?.error ?? fallback);
  }

  private clearToken() {
    this.token = '';
    this.visible.set(false);
  }

  save(ev: Event) {
    ev.preventDefault();
    const t = this.token.trim();
    this.invalid.set(!/^[A-Za-z0-9]{20,200}$/.test(t));
    if (this.invalid()) return;
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    this.api.setPat(t, this.adminKey).subscribe({
      next: (s) => {
        this.status.set(s);
        this.clearToken();
        this.busy.set(false);
        this.message.set('Token validado y guardado correctamente.');
      },
      error: (e) => {
        this.busy.set(false);
        this.fail(e, 'No se pudo guardar el token.');
      },
    });
  }

  remove() {
    if (!confirm('¿Eliminar el token guardado? Se usará el de la variable de entorno, si existe.')) return;
    this.busy.set(true);
    this.api.deletePat(this.adminKey).subscribe({
      next: (s) => {
        this.status.set(s);
        this.busy.set(false);
        this.error.set('');
        this.message.set('Token guardado eliminado.');
      },
      error: (e) => {
        this.busy.set(false);
        this.fail(e, 'No se pudo eliminar el token.');
      },
    });
  }
}
