---@brief WebSocket server implementation
--- To require this module, do
--- ```lua
--- local websocket = require('livepreview.server.websocket')
--- ```

local sha1 = require("livepreview.utils").sha1
local header = require("livepreview.server.utils.header")

local M = {}

--- Handle a WebSocket handshake request
--- @param client uv_tcp_t: client
--- @param request string: client request
function M.handshake(client, request)
	local key = header.get(request, "Sec-WebSocket-Key")
	if not key then
		vim.print("Invalid WebSocket request from client")
		client:close()
		return nil
	end

	local accept = sha1(key .. "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
	accept = vim.base64.encode(accept)
	accept = vim.trim(accept)

	local response = "HTTP/1.1 101 Switching Protocols\r\n"
		.. "Upgrade: websocket\r\n"
		.. "Connection: Upgrade\r\n"
		.. "Sec-WebSocket-Accept: "
		.. accept
		.. "\r\n\r\n"
	client:write(response)
end

--- Send a message to a WebSocket client
--- @param client uv_tcp_t: client
--- @param message string: message to send
function M.send(client, message)
	local byteMessage = message
	local length = #byteMessage

	local frame = string.char(0x81)

	if length <= 125 then
		frame = frame .. string.char(length) .. byteMessage
	elseif length <= 65535 then
		frame = frame .. string.char(126) .. string.char(bit.rshift(length, 8), length % 256) .. byteMessage
	else
		frame = frame
			.. string.char(127)
			.. string.char(
				-- WHY: LuaJIT's bit ops are 32-bit and take the shift modulo 32, so
				-- shifting by 32 or more would repeat the low bytes here.
				0,
				0,
				0,
				0,
				bit.rshift(length, 24) % 256,
				bit.rshift(length, 16) % 256,
				bit.rshift(length, 8) % 256,
				length % 256
			)
			.. byteMessage
	end

	client:write(frame)
end

--- Send a JSON message to a WebSocket client
--- @param client uv_tcp_t: client
--- @param message table: message to send
function M.send_json(client, message)
	local json = vim.json.encode(message)
	M.send(client, json)
end

--- Incremental decoder for frames sent by a client. Browsers always mask them,
--- and a read can carry part of a frame or several frames at once.
--- @return fun(chunk: string): {opcode: integer, payload: string}[]
function M.decoder()
	local buffer = ""
	local fragmented
	return function(chunk)
		buffer = buffer .. chunk
		local frames = {}
		while #buffer >= 2 do
			local b1, b2 = buffer:byte(1, 2)
			local length = bit.band(b2, 0x7f)
			local offset = 2
			if length == 126 then
				if #buffer < 4 then
					break
				end
				length = buffer:byte(3) * 256 + buffer:byte(4)
				offset = 4
			elseif length == 127 then
				if #buffer < 10 then
					break
				end
				length = 0
				for i = 3, 10 do
					length = length * 256 + buffer:byte(i)
				end
				offset = 10
			end
			local mask_length = bit.band(b2, 0x80) ~= 0 and 4 or 0
			local frame_end = offset + mask_length + length
			if #buffer < frame_end then
				break
			end
			local payload = buffer:sub(offset + mask_length + 1, frame_end)
			if mask_length > 0 then
				local mask = { buffer:byte(offset + 1, offset + 4) }
				local bytes = {}
				for i = 1, length do
					bytes[i] = string.char(bit.bxor(payload:byte(i), mask[(i - 1) % 4 + 1]))
				end
				payload = table.concat(bytes)
			end
			buffer = buffer:sub(frame_end + 1)

			local fin = bit.band(b1, 0x80) ~= 0
			local opcode = bit.band(b1, 0x0f)
			if opcode == 0 and fragmented then
				fragmented.payload = fragmented.payload .. payload
				if fin then
					table.insert(frames, fragmented)
					fragmented = nil
				end
			elseif not fin then
				fragmented = { opcode = opcode, payload = payload }
			else
				table.insert(frames, { opcode = opcode, payload = payload })
			end
		end
		return frames
	end
end

return M
