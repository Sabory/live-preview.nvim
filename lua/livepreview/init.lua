local M = {}

local cmd = "LivePreview"
local server = require("livepreview.server")
local utils = require("livepreview.utils")
local config = require("livepreview.config")

---@type LivePreviewServer?
M.serverObj = nil

--- The window the preview follows: it was started from there, the browser
--- navigates when that window opens another file, and vice versa.
---@type integer?
M.source_win = nil

--- Stop live-preview server
function M.close()
	if M.serverObj then
		M.serverObj:stop(function()
			print("live-preview.nvim: Server closed")
		end)
		M.serverObj = nil
	end
end

--- Check if there is a live-preview server process
--- Note: this does not check if the server is running healthy
--- @return boolean
function M.is_running()
	return not not (M.serverObj and M.serverObj.server)
end

--- URL path under which the server serves a file, nil outside its webroot
---@param file string
---@return string?
function M.url_path(file)
	if not M.serverObj or not utils.supported_filetype(file) then
		return
	end
	local relative = utils.get_relative_path(file, M.serverObj.webroot)
	return relative and "/" .. relative
end

---@param path string URL path, as sent by the browser
---@return string
function M.file_for(path)
	return vim.fs.normalize(vim.fs.joinpath(M.serverObj.webroot, path))
end

local function source_buf_is(file)
	local win = M.source_win
	if not win or not vim.api.nvim_win_is_valid(win) then
		return false
	end
	return vim.fs.normalize(vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win))) == file
end

--- Open in the source window the file the browser has just shown
---@param file string
function M.show_in_source(file)
	local win = M.source_win
	if not win or not vim.api.nvim_win_is_valid(win) or source_buf_is(file) then
		return
	end
	local ok, err = pcall(vim.api.nvim_win_call, win, function()
		vim.cmd.edit(vim.fn.fnameescape(file))
	end)
	if not ok then
		vim.notify("live-preview.nvim: " .. err, vim.log.levels.WARN)
	end
end

--- Put the source window's cursor on a line of the previewed file
---@param path string URL path of the previewed file
---@param line integer
function M.reveal(path, line)
	if not source_buf_is(M.file_for(path)) then
		return
	end
	local win = M.source_win
	line = math.max(1, math.min(line, vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(win))))
	vim.api.nvim_win_call(win, function()
		vim.api.nvim_win_set_cursor(0, { line, 0 })
		vim.cmd("normal! zz")
	end)
	server.mark_cursor_synced()
end

---@param client uv_tcp_t
---@param message table
local function on_message(client, message)
	if message.type == "open" then
		local file = M.file_for(message.path)
		M.show_in_source(file)
		local bufnr = vim.fn.bufnr(file)
		if bufnr > 0 then
			M.refresh_hunks(bufnr)
		end
	elseif message.type == "reveal" then
		if message.from_scroll and not config.config.sync_scroll then
			return
		end
		M.reveal(message.path, message.line)
	elseif message.type == "files" then
		require("livepreview.server.websocket").send_json(client, {
			type = "reply",
			request_id = message.request_id,
			result = utils.list_markdown_files(M.serverObj.webroot),
		})
	elseif vim.startswith(message.type or "", "comment") then
		require("livepreview.comments").handle(client, message)
	end
end

--- Send a buffer's changed lines, from the `hunks` provider, to the browsers
---@param bufnr integer
function M.refresh_hunks(bufnr)
	local provider = config.config.hunks
	if not provider or not M.is_running() then
		return
	end
	local path = M.url_path(vim.fs.normalize(vim.api.nvim_buf_get_name(bufnr)))
	if path then
		server.broadcast({ type = "hunks", path = path, hunks = provider(bufnr) })
	end
end

--- Make the browsers reload their comment list, e.g. after the comment
--- provider changed it from Neovim
function M.refresh_comments()
	if M.is_running() then
		server.broadcast({ type = "comments" })
	end
end

--- Start live-preview server
---@param filepath string: path to the file
---@param port number: port to run the server on
---@return boolean?
function M.start(filepath, port)
	local processes = utils.processes_listening_on_port(port)
	if #processes > 0 then
		for _, process in ipairs(processes) do
			if process.pid ~= vim.uv.os_getpid() then
				-- local kill_confirm = vim.fn.confirm(
				-- 	("Port %d is being listened by another process `%s` (PID %d). Kill it?"):format(port, process.name, process.pid),
				-- 	"&Yes\n&No", 2)
				-- if kill_confirm ~= 1 then return else utils.kill(process.pid) end
				vim.notify(
					("Port %d is being used by another process `%s` (PID %d). Run `:lua vim.uv.kill(%d)` to kill it or change the port with `:lua LivePreview.config.port = <new_port>`"):format(
						port,
						process.name,
						process.pid,
						process.pid
					),
					vim.log.levels.WARN
				)
			end
		end
	end
	M.close()

	M.source_win = vim.api.nvim_get_current_win()
	M.serverObj = server.Server:new(config.config.dynamic_root and vim.fs.dirname(filepath) or nil)
	local function onTextChanged(client)
		local bufname = vim.api.nvim_buf_get_name(0)
		if not utils.supported_filetype(bufname) or utils.supported_filetype(bufname) == "html" then
			return
		end
		local message = {
			filepath = bufname,
			type = "update",
			content = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\n"),
		}
		server.websocket.send_json(client, message)
	end

	M.serverObj:start(config.config.address, port, {
		on_events = utils.supported_filetype(filepath) == "html" and {
			---@param client uv_tcp_t
			---@param data {filename: string, event: FsEvent}
			LivePreviewDirChanged = function(client, data)
				if not vim.regex([[\.\(html\|css\|js\)$]]):match_str(data.filename) then
					return
				end

				server.websocket.send_json(client, { type = "reload" })
			end,
		} or {
			TextChanged = vim.schedule_wrap(onTextChanged),
			TextChangedI = vim.schedule_wrap(onTextChanged),
		},
		on_message = on_message,
	})

	vim.api.nvim_create_autocmd("BufWinEnter", {
		group = "LivePreview",
		callback = function(args)
			if vim.api.nvim_get_current_win() ~= M.source_win then
				return
			end
			local path = M.url_path(vim.fs.normalize(vim.api.nvim_buf_get_name(args.buf)))
			if path then
				server.broadcast({ type = "navigate", path = path })
			end
		end,
	})

	return true
end

function M.pick()
	local picker = require("livepreview.picker")

	local pick_callback = function(pick_value)
		local filepath = pick_value or nil
		if not filepath then
			vim.notify("No file picked", vim.log.levels.INFO)
			return
		end
		M.start(filepath, config.config.port)
		vim.cmd.edit(filepath)
		utils.open_browser(
			string.format(
				"http://%s:%d/%s",
				config.config.address,
				config.config.port,
				config.config.dynamic_root and vim.fs.basename(filepath) or filepath
			),
			config.config.browser
		)
	end

	local picker_funcs = {}
	for k, v in pairs(config.pickers) do
		picker_funcs[v] = picker[k]
	end

	if config.config.picker and #config.config.picker > 0 then
		if not picker_funcs[config.config.picker] then
			vim.notify("live-preview.nvim: config option 'picker' invalid", vim.log.levels.ERROR)
			return
		end
		local status, err = pcall(picker_funcs[config.config.picker], pick_callback)
		if not status then
			vim.notify("live-preview.nvim : error calling picker " .. config.config.picker, vim.log.levels.ERROR)
			vim.notify(err, vim.log.levels.ERROR)
		end
	else
		picker.pick(pick_callback)
	end
end

function M.help()
	local function print_help(text)
		print(text:format(cmd))
	end
	print("live-preview.nvim commands:")
	print_help(
		[[  :%s start [filepath] - Start live-preview server and open browser. If no filepath is given, preview the current buffer.]]
	)
	print_help([[  :%s close - Stop live-preview server]])
	print_help([[  :%s pick - Select a file to preview (using a picker like telescope.nvim, fzf-lua or mini.pick)]])
	print("  :che[ckhealth] livepreview - Check the health of the plugin")
	print("  :h[elp] livepreview - Open the documentation")
end

--- @deprecated Use `require('livepreview.config').set(opts)` instead
function M.setup(opts)
	config.set(opts)
end

return M
