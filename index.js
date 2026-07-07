import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";

const {
  ROBLOX_API_KEY,
  UNIVERSE_ID,
  MESSAGING_TOPIC = "ItemCatalogUpdate",
  DISCORD_WEBHOOK_URL,
  // Opcional. ID del rol de Discord a mencionar en cada notificacion (clic
  // derecho en el rol con "Modo desarrollador" activado -> Copiar ID). Si
  // no se define, los mensajes salen sin mencion, igual que antes.
  DISCORD_ROLE_ID,
  // Legacy: query unico (accesorios). Se sigue soportando si no defines los
  // nuevos CATALOG_QUERY_ACCESSORIES / CATALOG_QUERY_BUNDLES, para no romper
  // el secret que ya tenias guardado.
  CATALOG_QUERY,
  // Nuevos: queries separados por categoria. Se fusionan en cada tick sin
  // duplicar items (por id). Si CATALOG_QUERY_ACCESSORIES no esta definido,
  // se usa CATALOG_QUERY como fallback para esa categoria.
  CATALOG_QUERY_ACCESSORIES,
  CATALOG_QUERY_BUNDLES,
  POLL_INTERVAL_MS = "45000",
  MAX_PAGES = "3",
  // Precio (R$) desde el cual un item se marca como "alto valor" para el
  // panel de items destacados en el juego. Se manda al game via el campo
  // "isHighValue" en cada payload de MessagingService.
  FEATURED_MIN_PRICE = "1000",
} = process.env;

// Lista de queries a correr esta corrida, cada uno con una etiqueta para
// los logs. Se descartan los que no tengan valor (ej. si no configuraste
// CATALOG_QUERY_BUNDLES todavia, simplemente no se corre esa categoria).
const CATALOG_QUERIES = [
  { label: "accessories", query: CATALOG_QUERY_ACCESSORIES || CATALOG_QUERY },
  { label: "bundles", query: CATALOG_QUERY_BUNDLES },
].filter((q) => q.query);

for (const [key, val] of Object.entries({
  ROBLOX_API_KEY,
  UNIVERSE_ID,
  DISCORD_WEBHOOK_URL,
})) {
  if (!val) {
    console.error(`Falta la variable de entorno ${key}. Revisa tu .env`);
    process.exit(1);
  }
}

if (CATALOG_QUERIES.length === 0) {
  console.error(
    "Falta definir al menos un query de catalogo: CATALOG_QUERY_ACCESSORIES, CATALOG_QUERY_BUNDLES, o el legacy CATALOG_QUERY."
  );
  process.exit(1);
}

const STATE_FILE = path.resolve("./state.json");
// Se usa roproxy.com en vez de catalog.roblox.com porque Roblox bloquea
// las IPs compartidas de GitHub Actions. roproxy es un espejo comunitario
// muy usado por desarrolladores de Roblox para este mismo problema.
const SEARCH_URL = "https://catalog.roproxy.com/v1/search/items/details";
const DETAILS_URL = "https://catalog.roproxy.com/v1/catalog/items/details";
// Roblox exige un token CSRF (header x-csrf-token) incluso para este
// endpoint de solo lectura. El primer POST sin token (o con uno vencido)
// responde 403 "XSRF token invalid" pero trae el token valido en el header
// de la MISMA respuesta 403 — hay que reintentar una vez con ese token.
// Se cachea en memoria porque el token es valido por un buen rato (no hay
// que pedirlo en cada corrida).
let cachedCsrfToken = null;
const MESSAGING_URL = (universeId, topic) =>
  `https://apis.roblox.com/messaging-service/v1/universes/${universeId}/topics/${topic}`;

// Mapa de assetType (numerico, campo "assetType" que trae la API de
// catalogo) a nombre legible + parte del avatar donde se coloca. Cubre los
// tipos de accesorio mas comunes en el catalogo oficial de Roblox. Si un
// item trae un assetType que no esta en esta lista, se usa un fallback
// generico (ver getAssetTypeInfo) en vez de romper.
const ASSET_TYPE_INFO = {
  8: { name: "Hat", bodySlot: "Head" },
  17: { name: "Head", bodySlot: "Head (body part)" },
  18: { name: "Face", bodySlot: "Head (body part)" },
  19: { name: "Gear", bodySlot: "Held / Tool" },
  41: { name: "Hair Accessory", bodySlot: "Head" },
  42: { name: "Face Accessory", bodySlot: "Face" },
  43: { name: "Neck Accessory", bodySlot: "Neck" },
  44: { name: "Shoulder Accessory", bodySlot: "Shoulders" },
  45: { name: "Front Accessory", bodySlot: "Front Torso" },
  46: { name: "Back Accessory", bodySlot: "Back" },
  47: { name: "Waist Accessory", bodySlot: "Waist" },
  57: { name: "Ear Accessory", bodySlot: "Head (ears)" },
  58: { name: "Eye Accessory", bodySlot: "Face (eyes)" },
  64: { name: "T-Shirt Accessory", bodySlot: "Torso" },
  65: { name: "Shirt Accessory", bodySlot: "Torso" },
  66: { name: "Pants Accessory", bodySlot: "Legs" },
  67: { name: "Jacket Accessory", bodySlot: "Torso" },
  68: { name: "Sweater Accessory", bodySlot: "Torso" },
  69: { name: "Shorts Accessory", bodySlot: "Legs" },
  70: { name: "Left Shoe Accessory", bodySlot: "Feet (left)" },
  71: { name: "Right Shoe Accessory", bodySlot: "Feet (right)" },
  72: { name: "Dress/Skirt Accessory", bodySlot: "Legs" },
  76: { name: "Eyebrow Accessory", bodySlot: "Face" },
};

function getAssetTypeInfo(assetTypeId) {
  if (assetTypeId == null) return { name: null, bodySlot: null };
  return ASSET_TYPE_INFO[assetTypeId] ?? { name: `Type ${assetTypeId}`, bodySlot: "Unknown" };
}

// ---------- Persistencia ----------
// NOTA: en Render, un Background Worker sin "persistent disk" tiene
// filesystem efimero: si el proceso se reinicia (deploy, crash, etc.)
// este archivo se pierde y el bot "redescubrira" todo como nuevo una vez.
// Para produccion seria, agrega un Render Disk montado en /data y usa
// STATE_FILE = "/data/state.json", o migra esto a una key-value store
// externa (ej. Upstash Redis, gratis).
async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { known: {}, pendingGameSync: [] }; // known[itemId] = { name, price, forSale: true }
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- Roblox: descubrir items de la categoria ----------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCatalogPage(query, cursor, attempt = 1) {
  const url = new URL(SEARCH_URL);
  for (const [k, v] of new URLSearchParams(query)) {
    url.searchParams.set(k, v);
  }
  if (cursor) url.searchParams.set("cursor", cursor);

  const res = await fetch(url, {
    headers: {
      // User-Agent tipo navegador normal: algunas APIs bloquean con mas
      // severidad patrones que se identifican claramente como bot/script.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });

  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number(res.headers.get("retry-after")) || attempt * 5;
    console.log(`429 recibido, reintentando en ${retryAfter}s (intento ${attempt}/3)...`);
    await sleep(retryAfter * 1000);
    return fetchCatalogPage(query, cursor, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`Catalog search fallo: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function fetchCurrentItems() {
  // Map en vez de array para poder deduplicar por id: si el mismo item
  // apareciera en mas de un query (no deberia pasar entre accesorios y
  // bundles, pero por seguridad), el primero que lo encuentra gana y los
  // siguientes se ignoran.
  const itemsById = new Map();
  const maxPages = Number(MAX_PAGES);

  for (const { label, query } of CATALOG_QUERIES) {
    let cursor = undefined;
    let fetched = 0;

    for (let page = 0; page < maxPages; page++) {
      const data = await fetchCatalogPage(query, cursor);
      for (const it of data.data ?? []) {
        if (itemsById.has(it.id)) continue;

        // Filtro de seguridad: solo items creados por la cuenta oficial de
        // Roblox (creatorTargetId "1" — la cuenta oficial es tecnicamente un
        // "User" con ese ID, no existe un CreatorType "Roblox" en la API).
        const isOfficialRoblox = String(it.creatorTargetId) === "1";
        if (!isOfficialRoblox) continue;

        // El campo real que devuelve este endpoint es "priceStatus" (ej.
        // "Free", "Off Sale", o vacio/undefined cuando tiene precio normal).
        // Se revisan tambien nombres alternativos por si la API cambia.
        let forSale;
        if (typeof it.priceStatus === "string") {
          forSale = !/off\s*sale/i.test(it.priceStatus);
        } else if (typeof it.isForSale === "boolean") {
          forSale = it.isForSale;
        } else if (typeof it.purchasable === "boolean") {
          forSale = it.purchasable;
        } else if (typeof it.isPurchasable === "boolean") {
          forSale = it.isPurchasable;
        } else if (typeof it.price === "number") {
          // Los Bundles (via este query especifico) no traen NINGUNO de los
          // campos de arriba. Como mejor senal disponible, se infiere que
          // esta a la venta si trae un precio numerico. Es una inferencia,
          // no una confirmacion directa de la API — se marca como
          // "inferred" (no "true") para que el embed lo muestre distinto
          // ("Likely Yes") en vez de afirmarlo con la misma certeza que un
          // campo explicito.
          forSale = "inferred";
        } else {
          forSale = undefined;
        }

        // assetType numerico (solo presente cuando itemType es "Asset", no
        // en Bundles). Se resuelve a nombre legible ("Hat") y a la parte del
        // avatar donde se coloca ("Head") via ASSET_TYPE_INFO.
        const assetTypeId = typeof it.assetType === "number" ? it.assetType : null;
        const { name: assetTypeName, bodySlot } = getAssetTypeInfo(assetTypeId);

        // Taxonomia (ej. "Animation Bundle"): solo presente en Bundles via
        // este query. Es informacion real y util para el campo "Item Tags"
        // del embed, a diferencia de itemStatus que casi siempre viene
        // vacio para Bundles.
        const taxonomyTags = Array.isArray(it.taxonomy)
          ? it.taxonomy.map((t) => t.taxonomyName).filter(Boolean)
          : [];

        itemsById.set(it.id, {
          id: it.id,
          name: it.name,
          description: it.description ?? "",
          price: it.price ?? null,
          itemType: it.itemType ?? "Asset",
          assetTypeId,
          assetTypeName,
          bodySlot,
          forSale,
          taxonomyTags,
          createdUtc: it.itemCreatedUtc ?? null,
          isLimited: Array.isArray(it.itemRestrictions)
            ? it.itemRestrictions.some((r) => /limited/i.test(r))
            : false,
          // "Limited" = solo tiempo/cupo dinamico. "LimitedUnique" = cupo fijo
          // desde el inicio (coleccionable numerado). Guardamos cual es porque
          // cambia como se interpreta unitsAvailableForConsumption.
          isLimitedUnique: Array.isArray(it.itemRestrictions)
            ? it.itemRestrictions.some((r) => /limitedunique/i.test(r))
            : false,
          itemStatus: Array.isArray(it.itemStatus) ? it.itemStatus : [],
          favoriteCount: typeof it.favoriteCount === "number" ? it.favoriteCount : null,
          // Fecha limite de venta (null si no tiene). Campo real de la API:
          // "offSaleDeadline".
          offSaleDeadline: it.offSaleDeadline ?? null,
          // Cupo restante para items Limited/LimitedUnique. null = sin cupo
          // fijo o el campo no vino en esta respuesta.
          unitsAvailableForConsumption:
            typeof it.unitsAvailableForConsumption === "number"
              ? it.unitsAvailableForConsumption
              : null,
        });
        fetched++;
      }
      cursor = data.nextPageCursor;
      if (!cursor) break;
    }
    console.log(`Query "${label}": ${fetched} item(s) nuevo(s) en esta corrida`);
  }
  return [...itemsById.values()];
}

// ---------- Roblox: revisar si items ya conocidos siguen a la venta ----------
// items: [{ id, itemType }]. Antes esto forzaba itemType "Asset" para todo,
// lo cual da resultados invalidos para bundles (itemType "Bundle").
function detailsHeaders(csrfToken) {
  return {
    "Content-Type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json",
    Referer: "https://www.roblox.com/catalog",
    Origin: "https://www.roblox.com",
    ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
  };
}

async function postDetailsChunk(chunk, csrfToken) {
  return fetch(DETAILS_URL, {
    method: "POST",
    headers: detailsHeaders(csrfToken),
    body: JSON.stringify({
      items: chunk.map(({ id, itemType }) => ({ itemType: itemType || "Asset", id })),
    }),
  });
}

async function checkStillForSale(items) {
  if (items.length === 0) return {};
  const chunks = [];
  for (let i = 0; i < items.length; i += 120) {
    chunks.push(items.slice(i, i + 120));
  }

  const result = {};
  for (const chunk of chunks) {
    let res = await postDetailsChunk(chunk, cachedCsrfToken);

    // Token ausente o vencido: Roblox lo entrega en el header de esta misma
    // respuesta 403. Se cachea y se reintenta UNA vez con el token nuevo.
    if (res.status === 403) {
      const freshToken = res.headers.get("x-csrf-token");
      if (freshToken && freshToken !== cachedCsrfToken) {
        cachedCsrfToken = freshToken;
        res = await postDetailsChunk(chunk, cachedCsrfToken);
      }
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "(no se pudo leer el cuerpo)");
      console.error(
        `Details check fallo: ${res.status} ${res.statusText} — body: ${bodyText.slice(0, 300)}`
      );
      continue;
    }
    const data = await res.json();
    for (const it of data.data ?? []) {
      result[it.id] = {
        purchasable: Boolean(it.purchasable ?? it.isPurchasable ?? false),
        offSaleDeadline: it.offSaleDeadline ?? null,
        unitsAvailableForConsumption:
          typeof it.unitsAvailableForConsumption === "number"
            ? it.unitsAvailableForConsumption
            : null,
      };
    }
  }
  return result;
}

// ---------- Notificaciones ----------
function robloxThumbnailUrl(assetId) {
  return `https://www.roblox.com/asset-thumbnail/image?assetId=${assetId}&width=150&height=150&format=png`;
}

function robloxItemUrl(assetId) {
  return `https://www.roblox.com/catalog/${assetId}`;
}

async function fetchThumbnailUrl(id, itemType) {
  try {
    // Los bundles NO son assets — tienen su propio namespace de IDs y su
    // propio endpoint de thumbnails. Usar el endpoint de assets con un ID de
    // bundle devuelve una imagen equivocada (o la misma para todos), que es
    // justo el bug reportado.
    const url =
      itemType === "Bundle"
        ? `https://thumbnails.roproxy.com/v1/bundles/thumbnail?bundleIds=${id}&size=150x150&format=png&isCircular=false`
        : `https://thumbnails.roproxy.com/v1/assets?assetIds=${id}&size=150x150&format=png&isCircular=false`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.imageUrl ?? null;
  } catch {
    return null;
  }
}

// Envia UN mensaje "Item Update" con todos los embeds de esta corrida,
// agrupados por categoria (Bundles primero, luego Accesorios/Assets). Cada
// grupo lleva un embed "divisor" a modo de encabezado de seccion. Discord
// permite max 10 embeds por mensaje, asi que si hay mas se manda en varios
// mensajes seguidos (solo el primero menciona el rol, para no spamear ping).
function sectionHeaderEmbed(label, count) {
  return {
    title: label,
    description: `${count} update${count === 1 ? "" : "s"} detected this run`,
    color: 0x2f3136,
  };
}

async function sendDigest(embeds) {
  if (embeds.length === 0) return;
  const chunks = [];
  for (let i = 0; i < embeds.length; i += 10) chunks.push(embeds.slice(i, i + 10));

  for (let i = 0; i < chunks.length; i++) {
    const mention = i === 0 && Boolean(DISCORD_ROLE_ID);
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: i === 0 ? (mention ? `<@&${DISCORD_ROLE_ID}> **Item Update**` : "**Item Update**") : undefined,
        allowed_mentions: mention ? { roles: [DISCORD_ROLE_ID] } : { parse: [] },
        embeds: chunks[i],
      }),
    }).catch((err) => console.error("Error notificando a Discord:", err));
    if (i < chunks.length - 1) await sleep(1200); // margen para el rate limit de webhooks
  }
}

async function notifyRoblox(payload) {
  const res = await fetch(MESSAGING_URL(UNIVERSE_ID, MESSAGING_TOPIC), {
    method: "POST",
    headers: {
      "x-api-key": ROBLOX_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: JSON.stringify(payload) }),
  });
  if (!res.ok) {
    console.error(`MessagingService fallo: ${res.status} ${await res.text()}`);
    return false;
  }
  return true;
}

// Version que, si notifyRoblox falla (ej. "publish limit exceeded" cuando se
// detectan muchos items de golpe), guarda el payload en state.pendingGameSync
// para reintentarlo en la proxima corrida en vez de perderlo silenciosamente.
// El item SI se sigue marcando como "known" (para no repetir el aviso de
// Discord cada 5 min), pero el juego recibira el dato en cuanto se reintente
// con exito.
async function notifyRobloxWithRetry(state, payload) {
  const ok = await notifyRoblox(payload);
  if (!ok) {
    state.pendingGameSync.push(payload);
  }
  // Pequena pausa entre publicaciones sucesivas para no ráfaguear el limite
  // de MessagingService cuando se detectan muchos items en una sola corrida
  // (ej. la primera vez que corre un query nuevo).
  await sleep(350);
}

// ---------- Ciclo principal ----------
async function tick() {
  const state = await loadState();
  state.pendingGameSync ??= []; // compatibilidad con state.json de corridas viejas

  // Reintentar primero los mensajes que no pudieron publicarse en la corrida
  // anterior (ej. por "publish limit exceeded"), antes de generar mensajes
  // nuevos. Los que vuelvan a fallar se quedan en la cola para la siguiente.
  if (state.pendingGameSync.length > 0) {
    console.log(`Reintentando ${state.pendingGameSync.length} mensaje(s) pendiente(s) de la corrida anterior...`);
    const stillPending = [];
    for (const payload of state.pendingGameSync) {
      const ok = await notifyRoblox(payload);
      if (!ok) stillPending.push(payload);
      await sleep(350);
    }
    state.pendingGameSync = stillPending;
    console.log(`Pendientes resueltos: ${state.pendingGameSync.length === 0 ? "todos" : `quedan ${stillPending.length}`}`);
  }

  let current;
  try {
    current = await fetchCurrentItems();
  } catch (err) {
    console.error("Error consultando catalogo:", err.message);
    return;
  }

  const currentIds = new Set(current.map((i) => String(i.id)));
  // Number("") es 0, no NaN — si el secret FEATURED_MIN_PRICE no existe,
  // GitHub Actions manda un string vacio (no "undefined"), lo que rompia el
  // default del destructuring de arriba y dejaba minValue en 0 (por eso
  // CUALQUIER item con precio se marcaba "High Value"). Este fallback cubre
  // ese caso sin depender de que el secret exista.
  const minValue = Number(FEATURED_MIN_PRICE) || 1000;
  const dateLabel = (ts) =>
    ts
      ? new Date(ts).toLocaleString("en-US", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "None";
  const qtyLabel = (n) => (n != null ? n.toLocaleString("en-US") : "Unlimited");

  // Embeds construidos esta corrida, agrupados por itemType para el digest
  // final ("Item Update"). No se manda nada a Discord hasta el final del
  // tick; el juego (notifyRoblox) si recibe cada evento en tiempo real.
  const digestGroups = {}; // { Bundle: [embed, ...], Asset: [embed, ...] }
  const pushEmbed = (itemType, embed) => {
    const key = itemType || "Asset";
    (digestGroups[key] ??= []).push(embed);
  };

  // 1) Items nuevos (aparecen ahora, no estaban en el estado)
  const newItems = current.filter((i) => !state.known[i.id]);

  for (const item of newItems) {
    console.log(`New item detected: ${item.name} (${item.id})`);
    const saleLabel =
      item.forSale === true
        ? "Yes"
        : item.forSale === "inferred"
        ? "Likely (inferred from price)"
        : item.forSale === false
        ? "No"
        : "Unknown";
    const isNew = item.itemStatus.some((s) => /new/i.test(s));
    const allTags = [...item.itemStatus, ...(item.taxonomyTags ?? [])];
    const tagsLabel = allTags.length > 0 ? allTags.join(", ") : "None";
    // Si el item no esta a la venta, el precio que trae la API puede ser un
    // valor residual sin sentido (ej. "1"). Mostramos "None" en ese caso en
    // vez de un numero enganoso.
    const priceLabel = item.forSale === false ? "None" : item.price != null ? `${item.price} R$` : "N/A";
    const thumbnailUrl = (await fetchThumbnailUrl(item.id, item.itemType)) || robloxThumbnailUrl(item.id);
    const isHighValue = item.forSale !== false && item.price != null && item.price >= minValue;
    // Para accesorios individuales mostramos el tipo especifico (ej. "Hat",
    // "Neck Accessory"); para bundles no hay assetType, asi que cae al
    // itemType general ("Bundle").
    const typeLabel = item.assetTypeName ?? item.itemType;
    // "Units Available" solo tiene sentido para items Limited/LimitedUnique
    // con cupo real. Para items normales este campo puede venir en 0 sin
    // significar "agotado" — simplemente no aplica, y mostrar "0" ahi
    // confundia (por eso el bug reportado).
    const unitsLabel = item.isLimited || item.isLimitedUnique ? qtyLabel(item.unitsAvailableForConsumption) : "N/A (not limited)";

    pushEmbed(item.itemType, {
      title: `✨ New Item - ${item.name}`,
      description: item.description || undefined,
      url: robloxItemUrl(item.id),
      color: item.forSale === false ? 0xf1c40f : isHighValue ? 0xe67e22 : 0x2ecc71,
      thumbnail: { url: thumbnailUrl },
      timestamp: new Date().toISOString(),
      fields: [
        { name: "🆔 ID", value: String(item.id), inline: true },
        { name: "📦 Type", value: typeLabel, inline: true },
        { name: "🧍 Body Slot", value: item.bodySlot ?? "N/A", inline: true },
        { name: "💵 Price", value: priceLabel, inline: true },
        { name: "🔒 Limited?", value: item.isLimitedUnique ? "Yes (fixed qty)" : item.isLimited ? "Yes" : "No", inline: true },
        { name: "💸 On Sale?", value: saleLabel, inline: true },
        { name: "🆕 New Tag?", value: isNew ? "Yes" : "No", inline: true },
        { name: "⏰ Sale Deadline", value: dateLabel(item.offSaleDeadline), inline: true },
        { name: "📦 Units Available", value: unitsLabel, inline: true },
        { name: "🌟 High Value?", value: isHighValue ? "Yes" : "No", inline: true },
        { name: "💎 Item Tags", value: tagsLabel, inline: false },
      ],
    });

    await notifyRobloxWithRetry(state, {
      type: "ITEM_ADDED",
      id: item.id,
      name: item.name,
      itemType: item.itemType,
      assetTypeId: item.assetTypeId,
      assetTypeName: item.assetTypeName,
      bodySlot: item.bodySlot,
      price: item.forSale === false ? null : item.price,
      // Se manda un booleano limpio al juego (Lua no deberia tener que
      // lidiar con el estado interno "inferred" que usamos solo para el
      // texto del embed de Discord). Un valor no confirmado por la API se
      // trata como "probablemente si" salvo que se demuestre lo contrario.
      forSale: item.forSale !== false,
      // Aparte, se informa si ese "true" es un dato confirmado por la API o
      // una inferencia nuestra (ej. Bundles que no traen priceStatus). El
      // juego puede usar esto para, por ejemplo, mostrar un badge "?" en
      // vez de tratarlo con la misma certeza que un item confirmado.
      forSaleConfirmed: item.forSale === true || item.forSale === false,
      isLimited: item.isLimited,
      isLimitedUnique: item.isLimitedUnique,
      offSaleDeadline: item.offSaleDeadline,
      unitsAvailableForConsumption: item.unitsAvailableForConsumption,
      unitsSold: 0,
      isHighValue,
      favoriteCount: item.favoriteCount,
    });
    state.known[item.id] = {
      name: item.name,
      price: item.price,
      forSale: item.forSale !== false,
      itemType: item.itemType,
      assetTypeId: item.assetTypeId,
      assetTypeName: item.assetTypeName,
      bodySlot: item.bodySlot,
      taxonomyTags: item.taxonomyTags ?? [],
      isLimited: item.isLimited,
      isLimitedUnique: item.isLimitedUnique,
      offSaleDeadline: item.offSaleDeadline ?? null,
      unitsAvailableForConsumption: item.unitsAvailableForConsumption ?? null,
      // Cupo original visto la primera vez que detectamos el item. Sirve de
      // base para calcular "unidades vendidas" en LimitedUnique. OJO: si el
      // bot arranca despues de que ya se vendieron algunas, esto no sera el
      // total real desde el lanzamiento, solo desde que el bot lo detecto.
      originalUnits: item.unitsAvailableForConsumption ?? null,
      isHighValue,
    };
  }

  // 2) Items que ya conociamos pero ya no aparecen en la busqueda actual:
  // pueden estar fuera de la primera(s) pagina(s) simplemente por orden,
  // asi que los re-confirmamos contra el endpoint de detalles antes de
  // avisar que salieron de venta (evita falsos positivos).
  const missingIds = Object.keys(state.known).filter(
    (id) => state.known[id].forSale && !currentIds.has(id)
  );

  if (missingIds.length > 0) {
    const status = await checkStillForSale(
      missingIds.map((id) => ({ id: Number(id), itemType: state.known[id].itemType }))
    );
    for (const id of missingIds) {
      const stillForSale = status[id]?.purchasable;
      if (stillForSale === false) {
        const item = state.known[id];
        console.log(`Item removed from sale: ${item.name} (${id})`);
        const thumbnailUrl = (await fetchThumbnailUrl(id, item.itemType)) || robloxThumbnailUrl(id);
        const typeLabel = item.assetTypeName ?? item.itemType;

        pushEmbed(item.itemType, {
          title: `📉 Item Removed From Sale - ${item.name}`,
          url: robloxItemUrl(id),
          color: 0xe74c3c,
          thumbnail: { url: thumbnailUrl },
          timestamp: new Date().toISOString(),
          fields: [
            { name: "🆔 ID", value: String(id), inline: true },
            { name: "📦 Type", value: typeLabel, inline: true },
            { name: "🧍 Body Slot", value: item.bodySlot ?? "N/A", inline: true },
            { name: "💵 Last Price", value: item.price != null ? `${item.price} R$` : "N/A", inline: true },
          ],
        });
        await notifyRobloxWithRetry(state, {
          type: "ITEM_REMOVED",
          id: Number(id),
          name: item.name,
          itemType: item.itemType,
          assetTypeId: item.assetTypeId,
          assetTypeName: item.assetTypeName,
          bodySlot: item.bodySlot,
        });
        state.known[id].forSale = false;
      }
      // si stillForSale es true o undefined (fallo de red), no hacemos nada:
      // seguimos considerandolo a la venta y lo reintentamos el proximo ciclo
    }
  }

  // 3) Items ya conocidos que siguen a la venta: revisamos si cambio su
  // fecha limite o su cupo restante (relevante para Limited/LimitedUnique
  // con tiempo o cantidad fija de venta, ej. bundles de temporada). Tambien
  // calculamos cuantas unidades se vendieron desde que el bot lo detecto.
  const stillOnSaleItems = current.filter(
    (i) => state.known[i.id] && state.known[i.id].forSale !== false
  );

  for (const item of stillOnSaleItems) {
    const prev = state.known[item.id];
    const deadlineChanged = (item.offSaleDeadline ?? null) !== (prev.offSaleDeadline ?? null);
    const qtyChanged =
      item.unitsAvailableForConsumption != null &&
      item.unitsAvailableForConsumption !== prev.unitsAvailableForConsumption;
    const soldOut = item.isLimitedUnique && item.unitsAvailableForConsumption === 0;

    if (!deadlineChanged && !qtyChanged) continue;

    const unitsSold =
      item.isLimitedUnique && prev.originalUnits != null && item.unitsAvailableForConsumption != null
        ? Math.max(0, prev.originalUnits - item.unitsAvailableForConsumption)
        : null;

    console.log(`Limit info updated: ${item.name} (${item.id})${soldOut ? " [SOLD OUT]" : ""}`);
    const thumbnailUrl = (await fetchThumbnailUrl(item.id, item.itemType)) || robloxThumbnailUrl(item.id);
    const typeLabel = item.assetTypeName ?? item.itemType;

    pushEmbed(item.itemType, {
      title: soldOut ? `🚨 SOLD OUT - ${item.name}` : `⏳ Sale Limit Updated - ${item.name}`,
      url: robloxItemUrl(item.id),
      color: soldOut ? 0x992d22 : 0x9b59b6,
      thumbnail: { url: thumbnailUrl },
      timestamp: new Date().toISOString(),
      fields: [
        { name: "🆔 ID", value: String(item.id), inline: true },
        { name: "📦 Type", value: typeLabel, inline: true },
        { name: "⏰ Sale Deadline", value: dateLabel(item.offSaleDeadline), inline: true },
        { name: "📦 Units Remaining", value: item.isLimited || item.isLimitedUnique ? qtyLabel(item.unitsAvailableForConsumption) : "N/A (not limited)", inline: true },
        ...(unitsSold != null ? [{ name: "🛒 Units Sold (since tracked)", value: unitsSold.toLocaleString("en-US"), inline: true }] : []),
      ],
    });
    await notifyRobloxWithRetry(state, {
      type: soldOut ? "ITEM_SOLD_OUT" : "ITEM_LIMIT_UPDATE",
      id: item.id,
      name: item.name,
      itemType: item.itemType,
      assetTypeId: item.assetTypeId,
      assetTypeName: item.assetTypeName,
      bodySlot: item.bodySlot,
      offSaleDeadline: item.offSaleDeadline,
      unitsAvailableForConsumption: item.unitsAvailableForConsumption,
      unitsSold,
    });

    state.known[item.id].offSaleDeadline = item.offSaleDeadline ?? null;
    state.known[item.id].unitsAvailableForConsumption = item.unitsAvailableForConsumption ?? null;
  }

  // Armar y mandar el digest agrupado: Bundles primero, luego el resto.
  const typeOrder = ["Bundle", "Asset"];
  const sortedTypes = Object.keys(digestGroups).sort(
    (a, b) => typeOrder.indexOf(a) - typeOrder.indexOf(b)
  );
  const digestEmbeds = [];
  for (const t of sortedTypes) {
    const label = t === "Bundle" ? "📦 BUNDLES" : "🎩 ACCESSORIES / ITEMS";
    digestEmbeds.push(sectionHeaderEmbed(label, digestGroups[t].length));
    digestEmbeds.push(...digestGroups[t]);
  }
  await sendDigest(digestEmbeds);

  await saveState(state);
}

// ---------- Estado del loop (para el endpoint de status/health-check) ----------
// Se usa para: 1) que Render tenga algo a lo que responder en el puerto
// asignado (requisito de los Web Services), y 2) que cron-job.org (o quien
// sea) pueda hacer ping a este mismo endpoint para evitar que el free tier
// se duerma tras ~15 min sin trafico HTTP. Mientras no se duerma, el proceso
// nunca se reinicia y state.json en memoria/disco local sobrevive entre
// ciclos (evita el problema de "todo se ve como nuevo" tras un restart).
const tickStats = {
  startedAt: new Date().toISOString(),
  tickCount: 0,
  lastTickAt: null,
  lastTickMs: null,
  lastError: null,
  intervalMs: Number(POLL_INTERVAL_MS),
};

function startStatusServer() {
  const port = Number(process.env.PORT) || 3000;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...tickStats }, null, 2));
  });
  server.listen(port, () => {
    console.log(`Status server escuchando en el puerto ${port} (para health-check y anti-sleep ping)`);
  });
}

async function runTickTracked() {
  const start = Date.now();
  try {
    await tick();
    tickStats.lastError = null;
  } catch (err) {
    console.error("Error en tick:", err);
    tickStats.lastError = String(err?.message ?? err);
  } finally {
    tickStats.tickCount += 1;
    tickStats.lastTickAt = new Date().toISOString();
    tickStats.lastTickMs = Date.now() - start;
  }
}

async function main() {
  console.log("roblox-catalog-watcher iniciado");

  // RUN_ONCE=true: corre un solo ciclo y termina (modo para GitHub Actions
  // cron u otro scheduler externo, en vez de mantener un proceso 24/7).
  if (process.env.RUN_ONCE === "true") {
    await tick();
    console.log("Ciclo unico completado, saliendo.");
    return;
  }

  // Modo persistente (Render Web Service): levanta un servidor HTTP minimo
  // (requisito de Render para no matar el servicio por no bindear $PORT, y
  // ademas es el endpoint al que cron-job.org le hace ping para anti-sleep)
  // y corre el ciclo en un setInterval propio, sin depender de ningun
  // scheduler externo. Esto es lo que elimina el retraso de la cola de
  // GitHub Actions cron.
  startStatusServer();

  const interval = Number(POLL_INTERVAL_MS);
  await runTickTracked();
  setInterval(runTickTracked, interval);
}

main();
    
