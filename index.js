--- /tmp/index.orig.js	2026-10-15 02:02:19.406377337 +0000
+++ index.js	2026-10-15 02:02:19.464221901 +0000
@@ -695,24 +695,49 @@
   };
 }
 
+// Devuelve los embeds que NO se pudieron entregar (para reintentarlos en la
+// proxima corrida en vez de perderlos). Antes solo se atrapaban errores de red
+// y un 400/429/5xx de Discord se perdia en silencio.
 async function sendDigest(embeds) {
-  if (embeds.length === 0) return;
+  if (embeds.length === 0) return [];
   const chunks = [];
   for (let i = 0; i < embeds.length; i += 10) chunks.push(embeds.slice(i, i + 10));
 
+  const failed = [];
   for (let i = 0; i < chunks.length; i++) {
     const mention = i === 0 && Boolean(DISCORD_ROLE_ID);
-    await fetch(DISCORD_WEBHOOK_URL, {
-      method: "POST",
-      headers: { "Content-Type": "application/json" },
-      body: JSON.stringify({
-        content: i === 0 ? (mention ? `<@&${DISCORD_ROLE_ID}>` : undefined) : undefined,
-        allowed_mentions: mention ? { roles: [DISCORD_ROLE_ID] } : { parse: [] },
-        embeds: chunks[i],
-      }),
-    }).catch((err) => console.error("Error notificando a Discord:", err));
+    let delivered = false;
+    for (let attempt = 1; attempt <= 3 && !delivered; attempt++) {
+      try {
+        const res = await fetch(DISCORD_WEBHOOK_URL, {
+          method: "POST",
+          headers: { "Content-Type": "application/json" },
+          body: JSON.stringify({
+            content: i === 0 ? (mention ? `<@&${DISCORD_ROLE_ID}>` : undefined) : undefined,
+            allowed_mentions: mention ? { roles: [DISCORD_ROLE_ID] } : { parse: [] },
+            embeds: chunks[i],
+          }),
+        });
+        if (res.ok) {
+          delivered = true;
+        } else if (res.status === 429) {
+          const body = await res.json().catch(() => ({}));
+          const waitMs = Math.min(15000, Math.ceil((body.retry_after ?? 2) * 1000) + 200);
+          console.error(`Discord 429 (rate limit), esperando ${waitMs}ms (intento ${attempt}/3)`);
+          await sleep(waitMs);
+        } else {
+          console.error(`Discord rechazo el digest: ${res.status} ${await res.text().catch(() => "")}`);
+          break; // 4xx/5xx que no es rate limit: no tiene sentido reintentar en el acto
+        }
+      } catch (err) {
+        console.error("Error notificando a Discord:", err);
+        await sleep(1000);
+      }
+    }
+    if (!delivered) failed.push(...chunks[i]);
     if (i < chunks.length - 1) await sleep(1200); // margen para el rate limit de webhooks
   }
+  return failed;
 }
 
 async function notifyRoblox(payload) {
@@ -749,9 +774,27 @@
 }
 
 // ---------- Ciclo principal ----------
+// Estado de la corrida actual, para poder guardarlo si GitHub Actions cancela o
+// corta el job (SIGTERM) antes de llegar al saveState final.
+let currentState = null;
+let shuttingDown = false;
+process.on("SIGTERM", async () => {
+  if (shuttingDown) return;
+  shuttingDown = true;
+  console.error("SIGTERM recibido (cancelacion/timeout del job): guardando estado antes de salir...");
+  try {
+    if (currentState) await saveState(currentState);
+  } catch (err) {
+    console.error("No se pudo guardar el estado en SIGTERM:", err);
+  }
+  process.exit(143);
+});
+
 async function tick() {
   const state = await loadState();
+  currentState = state;
   state.pendingGameSync ??= []; // compatibilidad con state.json de corridas viejas
+  state.pendingDigest ??= []; // avisos de Discord pendientes (ver pushEmbed)
 
   // Reintentar primero los mensajes que no pudieron publicarse en la corrida
   // anterior (ej. por "publish limit exceeded"), antes de generar mensajes
@@ -813,10 +856,15 @@
   // Embeds construidos esta corrida, agrupados por itemType para el digest
   // final ("Item Update"). No se manda nada a Discord hasta el final del
   // tick; el juego (notifyRoblox) si recibe cada evento en tiempo real.
-  const digestGroups = {}; // { Bundle: [embed, ...], Asset: [embed, ...] }
+  // OJO (Octubre 2026): los embeds viven en state.pendingDigest (se guarda con
+  // el resto del estado). Asi un item marcado como "known" y su aviso de Discord
+  // se persisten JUNTOS: si la corrida se corta (timeout / cancelacion de
+  // GitHub Actions) el aviso pendiente se manda en la siguiente corrida, y si
+  // el estado no llega a guardarse el item vuelve a detectarse (nunca quedan
+  // "avisos repetidos" por un estado sin guardar ni avisos perdidos).
+  state.pendingDigest ??= [];
   const pushEmbed = (itemType, embed) => {
-    const key = itemType || "Asset";
-    (digestGroups[key] ??= []).push(embed);
+    state.pendingDigest.push({ t: itemType || "Asset", embed });
   };
 
   // 1) Items nuevos (aparecen ahora, no estaban en el estado).
@@ -834,11 +882,17 @@
   for (const item of allNewItems) {
     const createdAt = item.createdUtc ? new Date(item.createdUtc).getTime() : null;
     const ageMs = createdAt != null && !Number.isNaN(createdAt) ? Date.now() - createdAt : null;
-    const isStale = ageMs != null && ageMs > ITEM_FRESHNESS_THRESHOLD_MS;
+    // Bug reportado (Octubre 2026): Roblox crea muchos items VARIOS DIAS (o semanas)
+    // antes de ponerlos a la venta, asi que itemCreatedUtc solo no sirve para
+    // saber si algo "salio nuevo": un lanzamiento real se descartaba en silencio
+    // como "antiguo". La etiqueta "New" que pone Roblox (itemStatus) si indica
+    // lanzamiento reciente, asi que un item con esa etiqueta NUNCA se descarta.
+    const hasNewTag = (item.itemStatus ?? []).some((s) => /new/i.test(s));
+    const isStale = ageMs != null && ageMs > ITEM_FRESHNESS_THRESHOLD_MS && !hasNewTag;
 
     if (isStale) {
       console.log(
-        `Item antiguo detectado por primera vez (creado ${item.createdUtc}), se agrega como conocido sin notificar: ${item.name} (${item.id})`
+        `Item antiguo detectado por primera vez (creado ${item.createdUtc}, forSale=${item.forSale}, price=${item.price}, status=[${(item.itemStatus ?? []).join(",")}]), se agrega como conocido sin notificar: ${item.name} (${item.id})`
       );
       // Se guarda como conocido "silenciosamente" para que no se re-evalue
       // en cada tick, pero saltando todo el bloque de abajo (pushEmbed,
@@ -859,13 +913,20 @@
         originalUnits: item.unitsAvailableForConsumption ?? null,
         isHighValue: false,
         firstSeenAt: Date.now(),
+        skippedAsOld: true, // visible en DEBUG_CHECK_IDS: lo vio pero lo silencio el filtro de frescura
       };
       continue;
     }
     newItems.push(item);
   }
 
+  let processedNew = 0;
   for (const item of newItems) {
+    // Checkpoint: si hay muchos items nuevos de golpe (cada uno tarda ~1-3 s por la
+    // pausa de MessagingService + miniatura), guardar de a ratos evita que un corte
+    // a mitad de corrida lo repita todo en la siguiente.
+    if (processedNew > 0 && processedNew % 10 === 0) await saveState(state);
+    processedNew += 1;
     console.log(`New item detected: ${item.name} (${item.id})`);
     const saleLabel =
       item.forSale === true
@@ -1057,8 +1118,20 @@
     );
     for (const id of missingIds) {
       const stillForSale = status[id]?.purchasable;
+      if (stillForSale === true) {
+        delete state.known[id].removeStrikes;
+      }
       if (stillForSale === false) {
         const item = state.known[id];
+        // Histeresis (Octubre 2026): una sola respuesta "no comprable" de roproxy puede ser
+        // un falso positivo y generaba ciclos "Removed -> Relisted" repetidos en Discord. Se
+        // exige que se confirme en 2 revalidaciones seguidas antes de avisar.
+        item.removeStrikes = (item.removeStrikes ?? 0) + 1;
+        if (item.removeStrikes < 2) {
+          console.log(`Posible salida de venta (1/2, se confirma en la proxima revalidacion): ${item.name} (${id})`);
+          continue;
+        }
+        delete item.removeStrikes;
         console.log(`Item removed from sale: ${item.name} (${id})`);
         const thumbnailUrl = (await fetchThumbnailUrl(id, item.itemType)) || robloxThumbnailUrl(id);
         const typeLabel = item.assetTypeName ?? item.itemType;
@@ -1104,9 +1177,20 @@
         offSaleIds.map((id) => ({ id: Number(id), itemType: state.known[id].itemType }))
       );
       for (const id of offSaleIds) {
+        if (relistStatus[id]?.purchasable !== true) {
+          delete state.known[id].relistStrikes;
+          continue;
+        }
         if (relistStatus[id]?.purchasable === true && !notifiedRelistedThisProcess.has(id)) {
-          notifiedRelistedThisProcess.add(id);
           const item = state.known[id];
+          // Misma histeresis que en la salida de venta: 2 confirmaciones seguidas.
+          item.relistStrikes = (item.relistStrikes ?? 0) + 1;
+          if (item.relistStrikes < 2) {
+            console.log(`Posible relist (1/2, se confirma en la proxima revalidacion): ${item.name} (${id})`);
+            continue;
+          }
+          delete item.relistStrikes;
+          notifiedRelistedThisProcess.add(id);
           console.log(`Item relisted (vuelve a la venta): ${item.name} (${id})`);
           const thumbnailUrl = (await fetchThumbnailUrl(id, item.itemType)) || robloxThumbnailUrl(id);
           const typeLabel = item.assetTypeName ?? item.itemType;
@@ -1156,6 +1240,16 @@
 
     if (!deadlineChanged && !qtyChanged) continue;
 
+    // Throttle (Octubre 2026): en un Limited con cupo, el stock baja con CADA venta y
+    // se mandaba un aviso (Discord + juego) en cada corrida. Ahora un cambio de solo
+    // cantidad avisa como mucho una vez cada 30 min (salvo agotado o cambio de fecha
+    // limite, que avisan al instante). prev no se actualiza al saltarse, asi el
+    // cambio se reporta apenas se abre la ventana.
+    const LIMIT_UPDATE_MIN_GAP_MS = 30 * 60 * 1000;
+    if (!deadlineChanged && !soldOut && prev.lastLimitNotifyAt && Date.now() - prev.lastLimitNotifyAt < LIMIT_UPDATE_MIN_GAP_MS) {
+      continue;
+    }
+
     const unitsSold =
       item.isLimitedUnique && prev.originalUnits != null && item.unitsAvailableForConsumption != null
         ? Math.max(0, prev.originalUnits - item.unitsAvailableForConsumption)
@@ -1194,10 +1288,20 @@
 
     state.known[item.id].offSaleDeadline = item.offSaleDeadline ?? null;
     state.known[item.id].unitsAvailableForConsumption = item.unitsAvailableForConsumption ?? null;
+    state.known[item.id].lastLimitNotifyAt = Date.now();
   }
 
   // Armar y mandar el digest agrupado: Bundles primero, luego el resto.
+  // Incluye lo que quedo pendiente de corridas anteriores (state.pendingDigest).
+  // Orden: 1) se guarda el estado CON los avisos pendientes, 2) se envian, 3) se
+  // guarda lo que haya fallado. Antes se enviaba primero y se guardaba al final:
+  // si el job se cortaba o Upstash fallaba entre medias, la siguiente corrida
+  // volvia a detectar los mismos items y repetia los avisos de Discord.
+  await saveState(state);
+
   const typeOrder = ["Bundle", "Asset"];
+  const digestGroups = {};
+  for (const { t, embed } of state.pendingDigest) (digestGroups[t] ??= []).push(embed);
   const sortedTypes = Object.keys(digestGroups).sort(
     (a, b) => typeOrder.indexOf(a) - typeOrder.indexOf(b)
   );
@@ -1207,9 +1311,18 @@
     digestEmbeds.push(sectionHeaderEmbed(label, digestGroups[t].length));
     digestEmbeds.push(...digestGroups[t]);
   }
-  await sendDigest(digestEmbeds);
 
-  await saveState(state);
+  if (digestEmbeds.length > 0) {
+    const failed = await sendDigest(digestEmbeds);
+    // Los embeds fallidos se vuelven a guardar como pendientes (sin los encabezados de
+    // seccion, que se regeneran). Tope de 60 para que un Discord caido no infle el estado.
+    const failedSet = new Set(failed);
+    state.pendingDigest = state.pendingDigest.filter((e) => failedSet.has(e.embed)).slice(-60);
+    if (state.pendingDigest.length > 0) {
+      console.error(`${state.pendingDigest.length} aviso(s) de Discord quedan pendientes para la proxima corrida`);
+    }
+    await saveState(state);
+  }
 }
 
 // ---------- Estado del loop (para el endpoint de status/health-check) ----------
@@ -1286,9 +1399,25 @@
       const entry = state.known[id];
       if (entry) {
         console.log(`  ${id}: SI esta en known -> ${JSON.stringify(entry)}`);
+        if (entry.skippedAsOld) console.log(`    ^ OJO: lo vio pero el filtro de frescura lo silencio (sin aviso).`);
       } else {
         console.log(`  ${id}: NO esta en known (el bot nunca lo proceso)`);
       }
+      // Datos en vivo del item, para ver por que se habria saltado (creador, fecha, estado)
+      try {
+        const live = await fetchItemFullDetails([id]);
+        if (live.length === 0) {
+          console.log(`    en vivo: la API de detalles no devolvio datos para ${id}`);
+        } else {
+          const it = live[0];
+          const ageDays = it.createdUtc ? ((Date.now() - new Date(it.createdUtc).getTime()) / 86400000).toFixed(1) : "?";
+          console.log(
+            `    en vivo: name="${it.name}" type=${it.itemType} forSale=${it.forSale} price=${it.price} creado=${it.createdUtc} (${ageDays} dias) status=[${it.itemStatus.join(",")}] limited=${it.isLimited}`
+          );
+        }
+      } catch (err) {
+        console.log(`    en vivo: error consultando detalles: ${err.message}`);
+      }
     }
     console.log("--- fin DEBUG_CHECK_IDS, no se modifico ningun estado ---");
     return;
