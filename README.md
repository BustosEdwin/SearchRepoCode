# Buscador de código en repositorios

- `backend/`: API Node (Express) que ejecuta las búsquedas (equivalente a `buscar_dependencia.sh`, sin depender de `az` ni de bash).
- `frontend/`: interfaz Angular.

## Requisitos
Node 20+ y `git` en el PATH.

## Configuración
```
cd backend
copy .env.example .env   # complete AZDO_PAT con un token NUEVO (permiso Code: Read)
npm install
npm start                # http://localhost:3000
```

## Desarrollo del frontend
```
cd frontend
npm install
npm start                # http://localhost:4200 (proxy a /api -> :3000)
```
Producción: `npm run build` en `frontend` y el backend sirve `frontend/dist` en `http://localhost:3000`.

## Comportamiento
- Cada búsqueda es una sesión independiente (ID propio, carpeta `backend/data/jobs/<id>/`, clones propios). Se ejecutan en paralelo hasta `MAX_CONCURRENT`; el resto queda en cola.
- Archivo de resultados: nombre indicado por el usuario o automático `busqueda_<término>_<fecha-hora>.txt`; nunca se repite.
- Se puede ver progreso/registro en vivo, cancelar, previsualizar, descargar y eliminar. El historial persiste tras reiniciar el servidor.
- Rama única: con el check "Buscar en una sola rama" solo se clona y recorre ese repositorio y rama.
- Rendimiento: clones superficiales (`--depth 1`), `REPO_CONCURRENCY` repositorios en paralelo por búsqueda y una sola búsqueda por árbol idéntico entre ramas. Con repositorios en paralelo el archivo repite el encabezado de repositorio/rama cuando cambia.
- Detalle y "Analizar archivo": el filtrado corre en un Web Worker con almacenamiento columnar, de modo que escribir en el filtro no bloquea la interfaz (probado con 1 millón de filas).
