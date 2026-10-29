import { Component, computed, input } from '@angular/core';
import { STATUS_LABEL, Search } from '../search-api';

@Component({
  selector: 'app-status-badge',
  template: `<span [class]="'badge badge-' + status()"><span aria-hidden="true">{{ icon() }}</span> {{ label() }}</span>`,
})
export class StatusBadge {
  status = input.required<Search['status']>();
  label = computed(() => STATUS_LABEL[this.status()]);
  // El icono evita depender solo del color para comunicar el estado.
  icon = computed(
    () => ({ queued: '◷', running: '●', completed: '✓', failed: '✕', cancelled: '–', interrupted: '!' })[this.status()],
  );
}
