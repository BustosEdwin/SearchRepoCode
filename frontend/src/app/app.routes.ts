import { Routes } from '@angular/router';
import { Home } from './pages/home';
import { SearchDetail } from './pages/search-detail';
import { Upload } from './pages/upload';
import { Settings } from './pages/settings';

export const routes: Routes = [
  { path: '', component: Home, title: 'Búsquedas · Buscador de código' },
  { path: 'busquedas/:id', component: SearchDetail, title: 'Detalle de búsqueda · Buscador de código' },
  { path: 'archivo', component: Upload, title: 'Analizar archivo · Buscador de código' },
  { path: 'configuracion', component: Settings, title: 'Token de Azure DevOps · Buscador de código' },
  { path: '**', redirectTo: '' },
];
