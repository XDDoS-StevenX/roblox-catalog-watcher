// ─────────────────────────────────────────────────────────────
// Integracion Rolimons "New Limited!" -> catalog-watcher
// Canal separado del de items nuevos. Mismo bot/token, distinto ID.
// ─────────────────────────────────────────────────────────────

const { extractItemIds } = require("./rolimons-watch"); // reusa el mismo regex de /catalog/(\d+)

const ROLIMONS_LIMITED_CHANNEL_ID = process.env.ROLIMONS_LIMITED_CHANNEL_ID; // TODO: 1542971893328384140
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN; // mismo token que ya configuramos

async function pollRolimonsLimitedChannel(redis) {
	if (!ROLIMONS_LIMITED_CHANNEL_ID || !DISCORD_BOT_TOKEN) {
		console.warn("[Rolimons-Limited] Falta ROLIMONS_LIMITED_CHANNEL_ID o DISCORD_BOT_TOKEN, salteando.");
		return [];
	}

	// Cursor separado del canal de items nuevos -- misma Redis, distinta key
	const lastId = await redis.get("rolimonsLimitedLastMessageId");
	const url = new URL(`https://discord.com/api/v10/channels/${ROLIMONS_LIMITED_CHANNEL_ID}/messages`);
	url.searchParams.set("limit", "50");
	if (lastId) url.searchParams.set("after", lastId);

	const res = await fetch(url, {
		headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
	});

	if (!res.ok) {
		console.error(`[Rolimons-Limited] Discord API fallo: ${res.status} ${await res.text()}`);
		return [];
	}

	const messages = await res.json();
	if (messages.length === 0) return [];

	await redis.set("rolimonsLimitedLastMessageId", messages[0].id);

	const allIds = new Set();
	for (const msg of messages) {
		for (const id of extractItemIds(msg)) allIds.add(id);
	}

	console.log(`[Rolimons-Limited] ${messages.length} mensaje(s) nuevos, ${allIds.size} item ID(s) marcados Limited.`);
	return [...allIds];
}

module.exports = { pollRolimonsLimitedChannel };
