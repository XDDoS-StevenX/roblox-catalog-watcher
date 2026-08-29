// ─────────────────────────────────────────────────────────────
// Integracion Rolimons -> catalog-watcher (Opcion A: polling)
// Se llama UNA VEZ por ciclo de tick(), junto a las queries de Roblox.
// Reusa el mismo patron que state.known / pendingDiscordEmbeds (Redis).
// ─────────────────────────────────────────────────────────────

const ROLIMONS_CHANNEL_ID = process.env.ROLIMONS_CHANNEL_ID; // TODO: pegar el ID del canal
const DISCORD_BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN;   // TODO: token de bot (no webhook)

// TODO: ajustar este regex una vez que Steven mande un mensaje de ejemplo real.
// Cubre los 2 formatos mas comunes que postean bots de Rolimons:
//   1) URL directa:      https://www.roblox.com/catalog/101578500081215/...
//   2) "Item ID: 101578500081215" en texto plano o en un embed field
const ITEM_ID_PATTERNS = [
	/roblox\.com\/catalog\/(\d+)/i,
	/item[_ ]?id[:\s]+(\d+)/i,
];

function extractItemIds(message) {
	const found = new Set();

	// texto plano del mensaje
	const sources = [message.content || ""];

	// contenido de embeds (titulo, descripcion, campos, url)
	for (const embed of message.embeds || []) {
		if (embed.title) sources.push(embed.title);
		if (embed.description) sources.push(embed.description);
		if (embed.url) sources.push(embed.url);
		for (const field of embed.fields || []) {
			sources.push(`${field.name} ${field.value}`);
		}
	}

	for (const text of sources) {
		for (const pattern of ITEM_ID_PATTERNS) {
			const m = text.match(pattern);
			if (m) found.add(m[1]);
		}
	}

	return [...found];
}

/**
 * Trae mensajes nuevos del canal de Rolimons desde el ultimo ID visto.
 * Guarda el cursor en Redis (misma instancia que state.known) bajo la key "rolimonsLastMessageId".
 */
async function pollRolimonsChannel(redis) {
	if (!ROLIMONS_CHANNEL_ID || !DISCORD_BOT_TOKEN) {
		console.warn("[Rolimons] Faltan ROLIMONS_CHANNEL_ID o DISCORD_BOT_TOKEN, salteando.");
		return [];
	}

	const lastId = await redis.get("rolimonsLastMessageId");
	const url = new URL(`https://discord.com/api/v10/channels/${ROLIMONS_CHANNEL_ID}/messages`);
	url.searchParams.set("limit", "50");
	if (lastId) url.searchParams.set("after", lastId);

	const res = await fetch(url, {
		headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
	});

	if (!res.ok) {
		console.error(`[Rolimons] Discord API fallo: ${res.status} ${await res.text()}`);
		return [];
	}

	const messages = await res.json(); // vienen del mas nuevo al mas viejo
	if (messages.length === 0) return [];

	// Discord snowflakes son ordenables como string por tiempo -> el primero es el mas nuevo
	await redis.set("rolimonsLastMessageId", messages[0].id);

	const allIds = new Set();
	for (const msg of messages) {
		for (const id of extractItemIds(msg)) allIds.add(id);
	}

	console.log(`[Rolimons] ${messages.length} mensaje(s) nuevos, ${allIds.size} item ID(s) extraidos.`);
	return [...allIds];
}

module.exports = { pollRolimonsChannel, extractItemIds };
