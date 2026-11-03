---@brief Edits made in the preview, applied to the source buffer and written to disk.

local M = {}
local server = require("livepreview.server")

---@class LivePreviewSourceReplace
---@field path string URL path of the previewed file
---@field start_line integer 1-indexed; end_line + 1 to insert before start_line
---@field end_line integer 1-indexed, inclusive
---@field expected string[] the lines the browser saw in that range
---@field lines string[] what replaces them

---@param message LivePreviewSourceReplace
local function replace(message)
	local file = require("livepreview").file_for(message.path)
	local bufnr = vim.fn.bufadd(file)
	vim.fn.bufload(bufnr)
	local first, last = message.start_line - 1, message.end_line
	if not vim.deep_equal(vim.api.nvim_buf_get_lines(bufnr, first, last, true), message.expected) then
		error("the file changed since the preview rendered it")
	end
	vim.api.nvim_buf_set_lines(bufnr, first, last, true, message.lines)
	vim.api.nvim_buf_call(bufnr, function()
		vim.cmd("silent write")
	end)
	-- WHY: TextChanged only fires for the current buffer, and the edited file may be hidden.
	server.broadcast({
		type = "update",
		filepath = vim.api.nvim_buf_get_name(bufnr),
		content = table.concat(vim.api.nvim_buf_get_lines(bufnr, 0, -1, false), "\n"),
	})
end

---@param client uv_tcp_t
---@param message LivePreviewSourceReplace|{request_id: integer}
function M.handle(client, message)
	local ok, err = pcall(replace, message)
	server.websocket.send_json(client, {
		type = "reply",
		request_id = message.request_id,
		error = not ok and tostring(err) or nil,
	})
end

return M
