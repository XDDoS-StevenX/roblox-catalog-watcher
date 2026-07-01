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
const SEARCH_URL = "https://catalog.roblox.com/v1/search/items/details";
const DETAILS_URL = "https://catalog.roblox.com/v1/catalog/items/details";
const MESSAGING_URL = (universeId, topic) =>
  `https://apis.roblox.com/messaging-service/v1/universes/${universeId}/topics/${topic}`;

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { known: {} };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchCatalogPage(cursor) {
  const url = new URL(SEARCH_URL);
  for (const [k, v] of new URLSearchParams(CATALOG_QUERY)) {
    url.searchParams.set(k, v);
  }
  if (cursor) url.searchParams.set("cursor", cursor);

  const res = await fetch(url, {
    headers: { "User-Agent": "roblox-catalog-watcher/1.0" },
  });
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
      const isOfficialRoblox = String(it.creatorTargetId) === "1";
      if (!isOfficialRoblox) continue;

      let forSale;
      if (typeof it.isForSale === "boolean") forSale = it.isForSale;
      else if (typeof it.purchasable === "boolean") forSale = it.purchasable;
      else if (typeof it.isPurchasable === "boolean") forSale = it.isPurchasable;
      else forSale = undefined;

      items.push({
        id: it.id,
        name: it.name,
        price: it.price ?? null,
        itemType: it.itemType ?? "Asset",
        forSale,
      });
    }
    cursor = data.nextPageCursor;
    if (!cursor) break;
  }
  return items;
}

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

async function notifyDiscord({ title, description, color }) {
  await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{ title, description, color, timestamp: new Date().toISOString() }],
    }),
  }).catch((err) => console.error("Error notificando a Discord:", err));
}

async function notifyRoblox(payload) {
  const res = await fetch(MESSAGING_URL(UNIVERSE_ID, MESSAGING_TOPIC), {
    method: "POST",
    headers: { "x-api-key": ROBLOX_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ message: JSON.stringify(payload) }),
  });
  if (!res.ok) {
    console.error(`MessagingService fallo: ${res.status} ${await res.text()}`);
  }
}

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

  const newItems = current.filter((i) => !state.known[i.id]);

  for (const item of newItems) {
    console.log(`Nuevo item detectado: ${item.name} (${item.id})`);
    const saleLabel =
      item.forSale === true
        ? "Si, a la venta"
        : item.forSale === false
        ? "No, fuera de venta / oculto"
        : "Desconocido";
    await notifyDiscord({
      title: "Nuevo objeto detectado",
      description: `**${item.name}**\nPrecio: ${item.price ?? "N/A"}\nA la venta: ${saleLabel}\nID: ${item.id}`,
      color: item.forSale === false ? 0xf1c40f : 0x2ecc71,
    });
    await notifyRoblox({
      type: "ITEM_ADDED",
      id: item.id,
      name: item.name,
      price: item.price,
      forSale: item.forSale,
    });
    state.known[item.id] = { name: item.name, price: item.price, forSale: item.forSale !== false };
  }

  const missingIds = Object.keys(state.known).filter(
    (id) => state.known[id].forSale && !currentIds.has(id)
  );

  if (missingIds.length > 0) {
    const status = await checkStillForSale(missingIds.map(Number));
    for (const id of missingIds) {
      const stillForSale = status[id];
      if (stillForSale === false) {
        const item = state.known[id];
        console.log(`Item retirado de venta: ${item.name} (${id})`);
        await notifyDiscord({
          title: "Objeto retirado de venta",
          description: `**${item.name}**\nID: ${id}`,
          color: 0xe74c3c,
        });
        await notifyRoblox({ type: "ITEM_REMOVED", id: Number(id), name: item.name });
        state.known[id].forSale = false;
      }
    }
  }

  await saveState(state);
}

async function main() {
  console.log("roblox-catalog-watcher iniciado");

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
