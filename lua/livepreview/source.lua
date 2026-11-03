---@brief Edits made in the preview, applied to the source buffer and written to disk.

local M = {}
local server = require("livepreview.server")

---@class LivePreviewSourceReplace
---@field path string URL path of the previewed file
---@field start_line integer 1-indexed; end_line + 1 to insert before start_line
---@field end_line integer 1-indexed, inclusive
---@field expected string[] the lines the browser saw in that range
---@field lines string[] what replaces them

---@param bufnr integer
local function save_and_broadcast(bufnr)
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
	save_and_broadcast(bufnr)
end

--- Undo or redo the last change to the file, from the buffer's own history,
--- so it is the same step `u` takes in Neovim
---@param command "undo"|"redo"
local function step(command)
	---@param message {path: string}
	return function(message)
		local bufnr = vim.fn.bufnr(require("livepreview").file_for(message.path))
		if bufnr < 0 then
			error("the file is not open in Neovim")
		end
		local tick = vim.api.nvim_buf_get_changedtick(bufnr)
		vim.api.nvim_buf_call(bufnr, function()
			vim.cmd("silent " .. command)
		end)
		if vim.api.nvim_buf_get_changedtick(bufnr) == tick then
			error("nothing to " .. command)
		end
		save_and_broadcast(bufnr)
	end
end

local actions = {
	["source.replace"] = replace,
	["source.undo"] = step("undo"),
	["source.redo"] = step("redo"),
}

---@param client uv_tcp_t
---@param message {type: string, request_id: integer}
function M.handle(client, message)
	local action = actions[message.type]
	if not action then
		return
	end
	local ok, err = pcall(action, message)
	server.websocket.send_json(client, {
		type = "reply",
		request_id = message.request_id,
		error = not ok and tostring(err) or nil,
	})
end

return M
