---@brief Requests from the preview's comment UI, answered by the provider set
---in the `comments` config option, which owns the comments themselves.

---@class LivePreviewComment
---@field id any
---@field file string absolute path
---@field start_line integer
---@field end_line integer
---@field text string

---@class LivePreviewCommentProvider
---@field list fun(): LivePreviewComment[]
---@field add fun(file: string, start_line: integer, end_line: integer, text: string): any returns the new id
---@field edit fun(id: any, text: string)
---@field delete fun(id: any)
---@field send fun(ids: any[]|nil, opts: {submit: boolean}) nil sends them all

local M = {}
local websocket = require("livepreview.server.websocket")

-- The provider stores lines, not the exact words selected in the preview,
-- which are needed to highlight them there again.
local quotes = {}

local actions = {
	["comments.list"] = function(provider)
		local lp = require("livepreview")
		return vim.tbl_map(function(c)
			return {
				id = c.id,
				file = c.file,
				path = lp.url_path(c.file),
				start_line = c.start_line,
				end_line = c.end_line,
				text = c.text,
				quote = quotes[c.id],
			}
		end, provider.list())
	end,
	["comment.add"] = function(provider, message)
		local file = require("livepreview").file_for(message.path)
		local id = provider.add(file, message.start_line, message.end_line, message.text)
		quotes[id] = message.quote
		return id
	end,
	["comment.edit"] = function(provider, message)
		provider.edit(message.id, message.text)
	end,
	["comment.delete"] = function(provider, message)
		provider.delete(message.id)
	end,
	["comments.send"] = function(provider, message)
		provider.send(message.ids, { submit = message.submit == true })
	end,
}

---@param client uv_tcp_t
---@param message {type: string, request_id: integer}
function M.handle(client, message)
	local provider = require("livepreview.config").config.comments
	local action = actions[message.type]
	if not provider or not action then
		return
	end
	local ok, result = pcall(action, provider, message)
	websocket.send_json(client, {
		type = "reply",
		request_id = message.request_id,
		result = ok and result or nil,
		error = not ok and tostring(result) or nil,
	})
	if ok and message.type ~= "comments.list" then
		require("livepreview").refresh_comments()
	end
end

return M
