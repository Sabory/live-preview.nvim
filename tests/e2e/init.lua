-- Neovim side of the end-to-end tests: serves tests/e2e/fixtures with an
-- in-memory comment provider and hunks the tests set through _G.HUNKS.
local root = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, "S").source:sub(2))))
vim.opt.rtp:prepend(root)
-- Tests kill Neovim, which would leave swap files that block the next run.
vim.o.swapfile = false
vim.cmd("runtime plugin/livepreview.lua")

_G.COMMENTS, _G.SENT, _G.HUNKS = {}, {}, {}
local next_id = 1
local comments = {
	list = function()
		return vim.tbl_values(_G.COMMENTS)
	end,
	add = function(file, start_line, end_line, text)
		local id = next_id
		next_id = next_id + 1
		_G.COMMENTS[id] = { id = id, file = file, start_line = start_line, end_line = end_line, text = text }
		return id
	end,
	edit = function(id, text)
		_G.COMMENTS[id].text = text
	end,
	delete = function(id)
		_G.COMMENTS[id] = nil
	end,
	send = function(ids, opts)
		table.insert(_G.SENT, { ids = ids, submit = opts.submit })
	end,
}

require("livepreview.config").set({
	port = tonumber(vim.env.LP_PORT),
	browser = "true",
	comments = vim.env.LP_NO_COMMENTS == nil and comments or false,
	hunks = function()
		return _G.HUNKS
	end,
})
vim.cmd.cd(root .. "/tests/e2e/fixtures")
vim.cmd.edit(vim.env.LP_FILE or "a.md")
vim.cmd("LivePreview start")
