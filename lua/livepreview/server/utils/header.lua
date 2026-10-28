---@brief HTTP header module
--- To require this module, do
--- ```lua
--- local header = require('livepreview.server.utils.header')
--- ```

local M = {}

--- Value of a header in a raw HTTP request; names are case-insensitive
--- @param request string: raw HTTP request
--- @param name string: header name
--- @return string?
function M.get(request, name)
	name = name:lower()
	for line in request:gmatch("[^\r\n]+") do
		local key, value = line:match("^([^:]+):%s*(.-)%s*$")
		if key and key:lower() == name then
			return value
		end
	end
end

return M
