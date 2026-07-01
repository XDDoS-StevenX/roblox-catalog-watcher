-- ServerScriptService/CatalogUpdateListener
-- Recibe actualizaciones de catalogo publicadas por el watcher externo
-- via Open Cloud MessagingService y las aplica en caliente sin reiniciar
-- el servidor.

local MessagingService = game:GetService("MessagingService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local TOPIC = "ItemCatalogUpdate" -- debe coincidir con MESSAGING_TOPIC del watcher

-- AccessoryConfig es un ModuleScript que devuelve una tabla; la mutamos
-- en memoria para reflejar los cambios inmediatamente. Si quieres que
-- persista tras un reinicio del servidor, guarda tambien en un DataStore.
local AccessoryConfig = require(ReplicatedStorage:WaitForChild("AccessoryConfig"))

-- RemoteEvent para avisar a los clientes conectados ahora mismo
local remotesFolder = ReplicatedStorage:WaitForChild("RemoteEvents", 5)
local CatalogUpdateEvent = remotesFolder and remotesFolder:FindFirstChild("CatalogUpdateEvent")
if not CatalogUpdateEvent then
	warn("[CatalogUpdateListener] Falta crear el RemoteEvent 'CatalogUpdateEvent' en ReplicatedStorage/RemoteEvents")
end

local function handleItemAdded(data)
	-- Evita duplicados si ya existe el id
	for _, entry in ipairs(AccessoryConfig) do
		if entry.id == data.id then
			return
		end
	end

	table.insert(AccessoryConfig, {
		id = data.id,
		name = data.name or "Objeto nuevo",
		price = data.price or 0,
	})

	print(("[CatalogUpdateListener] Item agregado en vivo: %s (%d)"):format(data.name, data.id))

	if CatalogUpdateEvent then
		CatalogUpdateEvent:FireAllClients({
			type = "ITEM_ADDED",
			id = data.id,
			name = data.name,
			price = data.price,
		})
	end
end

local function handleItemRemoved(data)
	for i, entry in ipairs(AccessoryConfig) do
		if entry.id == data.id then
			table.remove(AccessoryConfig, i)
			break
		end
	end

	print(("[CatalogUpdateListener] Item retirado en vivo: %s (%d)"):format(data.name, data.id))

	if CatalogUpdateEvent then
		CatalogUpdateEvent:FireAllClients({
			type = "ITEM_REMOVED",
			id = data.id,
			name = data.name,
		})
	end
end

local ok, err = pcall(function()
	MessagingService:SubscribeAsync(TOPIC, function(message)
		local data = message.Data
		if typeof(data) == "string" then
			local success, decoded = pcall(function()
				return game:GetService("HttpService"):JSONDecode(data)
			end)
			if success then
				data = decoded
			else
				warn("[CatalogUpdateListener] No se pudo decodificar el mensaje:", data)
				return
			end
		end

		if data.type == "ITEM_ADDED" then
			handleItemAdded(data)
		elseif data.type == "ITEM_REMOVED" then
			handleItemRemoved(data)
		end
	end)
end)

if not ok then
	warn("[CatalogUpdateListener] Fallo la suscripcion a MessagingService:", err)
end
