// Dentro de tick(), ademas de las queries normales de Roblox (accessories, v2-broad, etc.):

const { pollRolimonsChannel } = require("./rolimons-watch");
const { pollRolimonsLimitedChannel } = require("./rolimons-limited-watch");

async function tick() {
	// ... queries existentes a catalog.roproxy.com (sin tocar) ...

	// NUEVO: candidatos que Rolimons ya vio pero nuestra busqueda por categoria
	// todavia no alcanzo (por el cache del indice de Roblox, ~2-32min de latencia).
	const rolimonsIds = await pollRolimonsChannel(redisClient);

	for (const itemId of rolimonsIds) {
		if (state.known[itemId]) continue; // ya lo tenemos, no duplicar

		// Igual que con los items de las queries normales: se valida con
		// GetProductInfo antes de confiar en el ID (Rolimons puede listar
		// cosas que no son un asset de catalogo valido).
		const info = await getProductInfoWithRetry(itemId);
		if (!info) continue;

		// Pasa por el MISMO filtro de frescura y el MISMO camino de notificacion
		// que ya existe -- no se bypassea nada, solo se agrega como fuente extra.
		await processCandidateItem(info); // la funcion que ya procesa items nuevos en tick()
	}

	// NUEVO: canal separado de "se volvio Limited". Distinto tratamiento
	// segun si el item ya lo conociamos (bug pendiente: ITEM_RELISTED no
	// trae isLimited desde el bot, el cliente lo adivina con un fallback
	// conservador) o si es la primera vez que lo vemos.
	const nowLimitedIds = await pollRolimonsLimitedChannel(redisClient);

	for (const itemId of nowLimitedIds) {
		const known = state.known[itemId];

		if (known) {
			// Ya lo teniamos como item de compra directa -> avisar YA que
			// paso a ser Limited, con el flag explicito (no hace falta que
			// el cliente lo adivine con el fallback conservador).
			known.isLimited = true;
			await notifyRobloxWithRetry({
				type: "ITEM_RELISTED",
				itemId,
				isLimited: true, // <- explicito, antes este campo no se mandaba
			});
			console.log(`[Rolimons-Limited] ${itemId} marcado Limited (ya conocido).`);
		} else {
			// Nunca lo vimos como item nuevo -> se procesa como candidato
			// nuevo, pero ya nace marcado Limited desde el arranque.
			const info = await getProductInfoWithRetry(itemId);
			if (!info) continue;
			await processCandidateItem(info, { isLimited: true });
		}
	}

	// ... resto de tick() sin cambios ...
}
