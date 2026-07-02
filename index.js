import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const {
  ROBLOX_API_KEY,
  UNIVERSE_ID,
  MESSAGING_TOPIC = "ItemCatalogUpdate",
  DISCORD_WEBHOOK_URL,
  CATALOG_QUERY,
  POLL_INTERVAL_MS = "45000",
  MAX_PAGES = "3",
} = process.env;

for (const [key, val] of Object.entries({
  ROBLOX_API_KEY,
  UNIVERSE_ID,
  DISCORD_WEBHOOK_URL,
  CATALOG_QUERY,
})) {
  if (!val) {
    console.error(`Falta la variable de entorno ${key}. Revisa tu .env`);
    process.exit(1);
  }
}

const STATE_FILE = path.resolve("./state.json");
// Se usa roproxy.com en vez de catalog.roblox.com porque Roblox bloquea
// las IPs compartidas de GitHub Actions. roproxy es un espejo comunitario
// muy usado por desarrolladores de Roblox para este mismo problema.
const SEARCH_URL = "https://catalog.roproxy.com/v1/search/items/details";
const DETAILS_URL = "https://catalog.roproxy.com/v1/catalog/items/details";
const MESSAGING_URL = (universeId, topic) =>
  `https://apis.roblox.com/messaging-service/v1/universes/${universeId}/topics/${topic}`;

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

async function fetchCatalogPage(cursor, attempt = 1) {
  const url = new URL(SEARCH_URL);
  for (const [k, v] of new URLSearchParams(CATALOG_QUERY)) {
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
    return fetchCatalogPage(cursor, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`Catalog search fallo: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function fetchCurrentItems() {
  const items = [];
  let cursor = undefined;
  const maxPages = Number(MAX_PAGES);

  for (let page = 0; page < maxPages; page++) {
    const data = await fetchCatalogPage(cursor);
    for (const it of data.data ?? []) {
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

      items.push({
        id: it.id,
        name: it.name,
        description: it.description ?? "",
        price: it.price ?? null,
        itemType: it.itemType ?? "Asset",
        forSale,
        createdUtc: it.itemCreatedUtc ?? null,
        isLimited: Array.isArray(it.itemRestrictions)
          ? it.itemRestrictions.some((r) => /limited/i.test(r))
          : false,
        itemStatus: Array.isArray(it.itemStatus) ? it.itemStatus : [],
        favoriteCount: typeof it.favoriteCount === "number" ? it.favoriteCount : null,
      });
    }
    cursor = data.nextPageCursor;
    if (!cursor) break;
  }
  return items;
}

// ---------- Roblox: revisar si items ya conocidos siguen a la venta ----------
async function checkStillForSale(itemIds) {
  if (itemIds.length === 0) return {};
  const chunks = [];
  for (let i = 0; i < itemIds.length; i += 120) {
    chunks.push(itemIds.slice(i, i + 120));
  }

  const result = {};
  for (const chunk of chunks) {
    const res = await fetch(DETAILS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: chunk.map((id) => ({ itemType: "Asset", id })),
      }),
    });
    if (!res.ok) {
      console.error(`Details check fallo: ${res.status}`);
      continue;
    }
    const data = await res.json();
    for (const it of data.data ?? []) {
      result[it.id] = Boolean(it.purchasable ?? it.isPurchasable ?? false);
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

async function notifyDiscord({ title, description, color, fields, thumbnailUrl, url }) {
  await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title,
          description,
          color,
          url,
          fields,
          thumbnail: thumbnailUrl ? { url: thumbnailUrl } : undefined,
          timestamp: new Date().toISOString(),
          footer: { text: "roblox-catalog-watcher" },
        },
      ],
    }),
  }).catch((err) => console.error("Error notificando a Discord:", err));
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

  // 1) Items nuevos (aparecen ahora, no estaban en el estado)
  const newItems = current.filter((i) => !state.known[i.id]);

  for (const item of newItems) {
    console.log(`New item detected: ${item.name} (${item.id})`);
    const saleLabel = item.forSale === true ? "Yes" : item.forSale === false ? "No" : "Unknown";
    const createdLabel = item.createdUtc
      ? new Date(item.createdUtc).toLocaleString("en-US", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Unknown";

    const isNew = item.itemStatus.some((s) => /new/i.test(s));
    const tagsLabel = item.itemStatus.length > 0 ? item.itemStatus.join(", ") : "None";
    // Si el item no esta a la venta, el precio que trae la API puede ser un
    // valor residual sin sentido (ej. "1"). Mostramos "None" en ese caso en
    // vez de un numero enganoso.
    const priceLabel = item.forSale === false ? "None" : item.price != null ? `${item.price} R$` : "N/A";
    const thumbnailUrl = (await fetchThumbnailUrl(item.id)) || robloxThumbnailUrl(item.id);

    await notifyDiscord({
      title: `✨ New Item Detected - ${item.name}`,
      description: item.description || undefined,
      url: robloxItemUrl(item.id),
      thumbnailUrl,
      color: item.forSale === false ? 0xf1c40f : 0x2ecc71,
      fields: [
        { name: "🆔 ID", value: String(item.id), inline: true },
        { name: "💵 Price", value: priceLabel, inline: true },
        { name: "🔒 Limited?", value: item.isLimited ? "Yes" : "No", inline: true },
        { name: "📅 Created", value: createdLabel, inline: true },
        { name: "💸 On Sale?", value: saleLabel, inline: true },
        { name: "🆕 New Tag?", value: isNew ? "Yes" : "No", inline: true },
        { name: "💎 Item Tags", value: tagsLabel, inline: false },
        {
          name: "⭐ Favorites",
          value: item.favoriteCount != null ? item.favoriteCount.toLocaleString("en-US") : "N/A",
          inline: true,
        },
      ],
    });
    await notifyRoblox({
      type: "ITEM_ADDED",
      id: item.id,
      name: item.name,
      price: item.forSale === false ? null : item.price,
      forSale: item.forSale,
      isLimited: item.isLimited,
      favoriteCount: item.favoriteCount,
    });
    state.known[item.id] = { name: item.name, price: item.price, forSale: item.forSale !== false };
  }

  // 2) Items que ya conociamos pero ya no aparecen en la busqueda actual:
  // pueden estar fuera de la primera(s) pagina(s) simplemente por orden,
  // asi que los re-confirmamos contra el endpoint de detalles antes de
  // avisar que salieron de venta (evita falsos positivos).
  const missingIds = Object.keys(state.known).filter(
    (id) => state.known[id].forSale && !currentIds.has(id)
  );

  if (missingIds.length > 0) {
    const status = await checkStillForSale(missingIds.map(Number));
    for (const id of missingIds) {
      const stillForSale = status[id];
      if (stillForSale === false) {
        const item = state.known[id];
        console.log(`Item removed from sale: ${item.name} (${id})`);
        const thumbnailUrl = (await fetchThumbnailUrl(id)) || robloxThumbnailUrl(id);
        await notifyDiscord({
          title: `📉 Item Removed From Sale - ${item.name}`,
          url: robloxItemUrl(id),
          thumbnailUrl,
          color: 0xe74c3c,
          fields: [
            { name: "🆔 ID", value: String(id), inline: true },
            { name: "💵 Last Price", value: item.price != null ? `${item.price} R$` : "N/A", inline: true },
          ],
        });
        await notifyRoblox({ type: "ITEM_REMOVED", id: Number(id), name: item.name });
        state.known[id].forSale = false;
      }
      // si stillForSale es true o undefined (fallo de red), no hacemos nada:
      // seguimos considerandolo a la venta y lo reintentamos el proximo ciclo
    }
  }

  await saveState(state);
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

  const interval = Number(POLL_INTERVAL_MS);
  await tick().catch((err) => console.error("Error en tick:", err));
  setInterval(() => {
    tick().catch((err) => console.error("Error en tick:", err));
  }, interval);
}

main();
