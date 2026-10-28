local websocket = require("livepreview.server.websocket")

print("Test module livepreview.server.websocket")

local function masked_frame(first_byte, payload)
	local mask = { 0x12, 0x34, 0x56, 0x78 }
	local length = #payload
	local header = string.char(first_byte)
	if length <= 125 then
		header = header .. string.char(0x80 + length)
	else
		header = header .. string.char(0x80 + 126, bit.rshift(length, 8), length % 256)
	end
	local bytes = {}
	for i = 1, length do
		bytes[i] = string.char(bit.bxor(payload:byte(i), mask[(i - 1) % 4 + 1]))
	end
	return header .. string.char(unpack(mask)) .. table.concat(bytes)
end

print()
print("decoder()")
local decode = websocket.decoder()
local long = string.rep("x", 300)
local wire = masked_frame(0x81, '{"type":"a"}') .. masked_frame(0x81, long)
local first = decode(wire:sub(1, 20))
assert(#first == 1 and first[1].payload == '{"type":"a"}', "should decode a frame and keep the partial one")
local second = decode(wire:sub(21))
assert(#second == 1 and second[1].payload == long, "should finish a frame split across reads")

local fragments = decode(masked_frame(0x01, "hel") .. masked_frame(0x80, "lo"))
assert(#fragments == 1 and fragments[1].opcode == 1 and fragments[1].payload == "hello", "should join fragments")

local close = decode(masked_frame(0x88, ""))
assert(close[1].opcode == 8, "should report a close frame")
print("ok")
