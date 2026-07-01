# roblox-catalog-watcher

Vigila una categoria del catalogo de Roblox, avisa por Discord cuando aparece
un item nuevo o cuando uno se retira de venta, y empuja el cambio en vivo a
tu juego via Open Cloud MessagingService.

## 1. Consigue el `CATALOG_QUERY`

1. Abre https://www.roblox.com/catalog en tu navegador
2. Filtra por la categoria/subcategoria que quieres vigilar (ej. Sombreros)
3. Abre las DevTools del navegador (F12) -> pestana **Network**
4. Recarga la pagina o cambia el filtro, busca una peticion a
   `catalog.roblox.com/v1/search/items/details?...`
5. Copia todo lo que va despues del `?` en la URL — eso es tu `CATALOG_QUERY`
   (ejemplo: `category=11&subcategory=9&sortType=3&limit=30`)

## 2. Variables de entorno

Copia `.env.example` a `.env` y completa:

- `ROBLOX_API_KEY` — tu Open Cloud API Key (permiso Messaging Service > Publish)
- `UNIVERSE_ID` — el Universe ID de tu experiencia
- `DISCORD_WEBHOOK_URL` — el webhook del canal de Discord
- `CATALOG_QUERY` — lo que sacaste en el paso 1
- `POLL_INTERVAL_MS` — cada cuanto revisa (45000 = 45s es un buen default,
  no lo bajes demasiado para no pegarle muy fuerte a la API publica)

## 3. Correr localmente (para probar)

```bash
npm install
npm start
```

Deberias ver logs de "Nuevo item detectado" o simplemente el ciclo corriendo
sin cambios si nada nuevo aparecio.

## 4. Desplegar en Render

1. Sube esta carpeta a un repo de GitHub (privado esta bien)
2. En Render: **New +** -> **Background Worker** (NO "Web Service" — este
   proceso no escucha peticiones HTTP entrantes, solo hace polling saliente)
3. Conecta el repo
4. Build command: `npm install`
5. Start command: `npm start`
6. En **Environment**, agrega las mismas variables del `.env` (nunca subas
   el `.env` al repo — agrega un `.gitignore` con `.env` y `state.json`)
7. Deploy

### Sobre la persistencia (`state.json`)

Un Background Worker de Render sin disco persistente tiene filesystem
efimero: si Render reinicia el proceso (deploy nuevo, restart, etc.) el
archivo `state.json` se pierde y el bot va a "redescubrir" todos los items
como si fueran nuevos una vez, generando notificaciones duplicadas.

Para evitarlo, cuando quieras pasar esto a produccion en serio:
- Agrega un **Render Disk** (Persistent Disk) montado en `/data`, y cambia
  `STATE_FILE` en `index.js` a `/data/state.json`, o
- Migra el estado a una key-value store externa (ej. Upstash Redis, tiene
  capa gratuita y es sencillo de integrar)

Para una primera version / pruebas, dejarlo como esta (archivo local) es
suficiente.

## 5. Lado Roblox

1. Copia `CatalogUpdateListener.server.lua` a `ServerScriptService`
2. Crea un `RemoteEvent` llamado `CatalogUpdateEvent` dentro de
   `ReplicatedStorage/RemoteEvents` (ya tienes esa carpeta segun tu
   estructura de proyecto)
3. En el cliente, escucha ese evento donde quieras mostrar el toast de
   "Nuevo objeto disponible" — mismo patron visual que ya usas en
   `MilestoneClient` o `RankUpCelebration`
4. El script muta `AccessoryConfig` en memoria; si quieres que el cambio
   sobreviva a un reinicio del servidor de Roblox, agrega tambien un guardado
   a DataStore dentro de `handleItemAdded`/`handleItemRemoved`

## Notas

- La API publica de `catalog.roblox.com` no requiere API key para
  busquedas/lectura, pero no tiene SLA garantizado — puede cambiar sin aviso.
  Si Render te reporta errores 403/429 seguidos, baja la frecuencia
  (`POLL_INTERVAL_MS`) o agrega un `User-Agent` mas especifico.
- La deteccion de "retirado de venta" hace una llamada extra de
  confirmacion antes de avisar, para evitar falsos positivos por paginacion.
- Node 18+ trae `fetch` nativo, no hace falta instalar `node-fetch`.
