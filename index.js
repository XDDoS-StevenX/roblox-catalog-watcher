import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

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
    return { known: {} }; // known[itemId] = { name, price, forSale: true }
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
        } else {
          forSale = undefined;
        }

        // assetType numerico (solo presente cuando itemType es "Asset", no
        // en Bundles). Se resuelve a nombre legible ("Hat") y a la parte del
        // avatar donde se coloca ("Head") via ASSET_TYPE_INFO.
        const assetTypeId = typeof it.assetType === "number" ? it.assetType : null;
        const { name: assetTypeName, bodySlot } = getAssetTypeInfo(assetTypeId);

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
async function checkStillForSale(items) {
  if (items.length === 0) return {};
  const chunks = [];
  for (let i = 0; i < items.length; i += 120) {
    chunks.push(items.slice(i, i + 120));
  }

  const result = {};
  for (const chunk of chunks) {
    const res = await fetch(DETAILS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: chunk.map(({ id, itemType }) => ({ itemType: itemType || "Asset", id })),
      }),
    });
    if (!res.ok) {
      console.error(`Details check fallo: ${res.status}`);
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

async function fetchThumbnailUrl(assetId) {
  try {
    const url = `https://thumbnails.roproxy.com/v1/assets?assetIds=${assetId}&size=150x150&format=png&isCircular=false`;
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
  }
}

// ---------- Ciclo principal ----------
async function tick() {
  const state = await loadState();
  let current;
  try {
    current = await fetchCurrentItems();
  } catch (err) {
    console.error("Error consultando catalogo:", err.message);
    return;
  }

  const currentIds = new Set(current.map((i) => String(i.id)));
  const minValue = Number(FEATURED_MIN_PRICE);
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
    const saleLabel = item.forSale === true ? "Yes" : item.forSale === false ? "No" : "Unknown";
    const isNew = item.itemStatus.some((s) => /new/i.test(s));
    const tagsLabel = item.itemStatus.length > 0 ? item.itemStatus.join(", ") : "None";
    // Si el item no esta a la venta, el precio que trae la API puede ser un
    // valor residual sin sentido (ej. "1"). Mostramos "None" en ese caso en
    // vez de un numero enganoso.
    const priceLabel = item.forSale === false ? "None" : item.price != null ? `${item.price} R$` : "N/A";
    const thumbnailUrl = (await fetchThumbnailUrl(item.id)) || robloxThumbnailUrl(item.id);
    const isHighValue = item.forSale !== false && item.price != null && item.price >= minValue;
    // Para accesorios individuales mostramos el tipo especifico (ej. "Hat",
    // "Neck Accessory"); para bundles no hay assetType, asi que cae al
    // itemType general ("Bundle").
    const typeLabel = item.assetTypeName ?? item.itemType;

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
        { name: "📦 Units Available", value: qtyLabel(item.unitsAvailableForConsumption), inline: true },
        { name: "🌟 High Value?", value: isHighValue ? "Yes" : "No", inline: true },
        { name: "💎 Item Tags", value: tagsLabel, inline: false },
      ],
    });

    await notifyRoblox({
      type: "ITEM_ADDED",
      id: item.id,
      name: item.name,
      itemType: item.itemType,
      assetTypeId: item.assetTypeId,
      assetTypeName: item.assetTypeName,
      bodySlot: item.bodySlot,
      price: item.forSale === false ? null : item.price,
      forSale: item.forSale,
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
        const thumbnailUrl = (await fetchThumbnailUrl(id)) || robloxThumbnailUrl(id);
        const typeLabel = item.assetTypeName ?? item.itemType;

      
