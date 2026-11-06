# Talky Needle: UNOFFICIAL mod for Find The Needle (autoload "TalkyNeedle").
# Loaded from override.cfg, it never reads or changes the game's .pck.
#
# Connects to the local bridge (bridge/bridge.js), runs the jobs the bridge sends
# and reports the game's events back to it. Game actions live in tn_actions.gd.
# Protocol: one JSON object per line over TCP, on 127.0.0.1 only.
extends Node

const VERSION := "0.2.1"
const PROTOCOL := 1
const BRIDGE_HOST := "127.0.0.1"
const BRIDGE_PORT := 7422
const FULL_GAME_APP_ID := 5160800  # the licence: a mod must not work without the full game
const RECONNECT_SECONDS := 2.0
const STATE_SECONDS := 5.0
const MAX_LINE_BYTES := 1048576
const MAX_RUNNING_JOBS := 8
const MAX_QUEUED_JOBS := 200
const MAX_WAIT_SECONDS := 600.0
const DEV_AUTOLOAD_FILE := "user://talky_needle_autoload.txt"

# Signals of GameState the mod listens to, with their expected argument count.
const GAME_SIGNALS := {"needle_found": 2, "needle_discovered": 2, "pile_replaced": 0}

var actions: RefCounted = null
var i18n: RefCounted = null
var menu: Node = null

# What the menu (tn_menu.gd) reads.
var catalog: Array = []
var catalog_version := 0
var bridge_paused := false
var bridge_safe_mode := false
var bridge_bits_multiplier := 1.0
var activity: Array = []
var activity_version := 0

var _enabled := false
var _base_dir := ""
var _language := ""
var _game_font: Font = null
var _peer := StreamPeerTCP.new()
var _buffer := PackedByteArray()
var _hello_sent := false
var _reconnect_in := 0.0
var _state_in := 0.0
var _last_scene: Node = null
var _world: Node = null
var _last_seq := 0
var _queue: Array = []
var _running := 0
var _announced := false


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	process_priority = 1000  # after the game's own updates: the camera effects stay on top
	_base_dir = get_script().resource_path.get_base_dir()
	i18n = (load(_base_dir + "/tn_i18n.gd") as Script).new()
	var actions_script: Script = load(_base_dir + "/tn_actions.gd")
	if actions_script == null or not actions_script.can_instantiate():
		push_error("[TalkyNeedle] tn_actions.gd failed to compile")
		return
	actions = actions_script.new()
	actions.setup(self)
	# The game starts Steam during its own autoloads; leave it a moment.
	await get_tree().create_timer(1.0, true).timeout
	if not _is_full_game():
		print("[TalkyNeedle] the full game is required: mod disabled")
		return
	_enabled = true
	_disable_leaderboard()
	_connect_game_signals()
	print("[TalkyNeedle] v%s loaded (unofficial mod)" % VERSION)
	_dev_autoload.call_deferred()


# Development only: with user://talky_needle_autoload.txt present, loads save slot 0 from
# the main menu and turns saving off, to check the interface without touching the save.
func _dev_autoload() -> void:
	if not FileAccess.file_exists(DEV_AUTOLOAD_FILE):
		return
	DirAccess.remove_absolute(ProjectSettings.globalize_path(DEV_AUTOLOAD_FILE))
	var saves := get_node_or_null("/root/SaveManager")
	if saves == null or not saves.has_method("begin_load"):
		print("[TalkyNeedle] dev autoload: SaveManager not found")
		return
	await get_tree().create_timer(5.0, true).timeout
	print("[TalkyNeedle] dev autoload: loading slot 0, saving off")
	saves.call("begin_load", 0)
	while world() == null:
		await get_tree().create_timer(1.0, true).timeout
	saves.set("block_save", true)


func _is_full_game() -> bool:
	if Engine.has_singleton("Steam"):
		var steam: Object = Engine.get_singleton("Steam")
		if steam != null and steam.has_method("getAppID"):
			var id := int(steam.call("getAppID"))
			if id != 0:
				return id == FULL_GAME_APP_ID
	return not OS.get_executable_path().get_base_dir().containsn("demo")


# Same courtesy as the other mods: a modded run stays off the public leaderboard.
func _disable_leaderboard() -> void:
	var lb := get_node_or_null("/root/Leaderboard")
	if lb != null and "enabled" in lb:
		lb.enabled = false


func _input(event: InputEvent) -> void:
	if not _enabled or world() == null:
		return
	if not (event is InputEventKey) or not event.pressed or event.echo:
		return
	match event.keycode:
		KEY_F8:
			if ensure_menu():
				menu.toggle()
				get_viewport().set_input_as_handled()
		KEY_ESCAPE:
			if menu != null and menu.is_open:
				menu.close()
				get_viewport().set_input_as_handled()
		KEY_F9:
			if actions.clear_ducks() > 0:
				get_viewport().set_input_as_handled()


func _exit_tree() -> void:
	if actions != null:
		actions.on_world_left()


# ---------------------------------------------------------------- menu
# Built the first time it opens, once the game's interface exists.
func ensure_menu() -> bool:
	if menu != null and is_instance_valid(menu):
		return true
	return reload_menu()


# Also used to reload a changed tn_menu.gd without restarting the game.
func reload_menu() -> bool:
	var script: Script = ResourceLoader.load(_base_dir + "/tn_menu.gd", "", ResourceLoader.CACHE_MODE_REPLACE)
	if script == null or not script.can_instantiate():
		push_error("[TalkyNeedle] tn_menu.gd failed to compile")
		return false
	if menu != null and is_instance_valid(menu):
		menu.close()
		menu.free()
	menu = script.new()
	add_child(menu)
	menu.setup(self)
	return true


# The font of the game's HUD, read at run time, so the mod's windows match it.
func game_font() -> Font:
	if _game_font != null:
		return _game_font
	var hud: Variant = world_get("hud")
	if hud is Node:
		for label: Node in (hud as Node).find_children("*", "Label", true, false):
			_game_font = (label as Label).get_theme_font("font")
			if _game_font != null:
				break
	return _game_font


func bridge_connected() -> bool:
	return _hello_sent and _peer.get_status() == StreamPeerTCP.STATUS_CONNECTED


func fire_workflow(id: String, user: String) -> bool:
	if not bridge_connected():
		return false
	_send({"t": "fire", "workflow": id, "user": user})
	return true


func send_bridge_settings(paused: bool, safe_mode: bool, bits_multiplier: float) -> void:
	_send({"t": "settings", "paused": paused, "safeMode": safe_mode, "bitsMultiplier": bits_multiplier})


func _label_of(workflow: String) -> String:
	for w: Variant in catalog:
		if str(w.get("id", "")) == workflow:
			return str(w.get("label", workflow))
	return workflow


func _add_activity(job: Dictionary, failures: Array) -> void:
	var codes: Array = []
	for f: Variant in failures:
		codes.append("%s (%s)" % [f.get("action", "?"), f.get("code", "?")])
	activity.append({
		"time": Time.get_time_string_from_system(),
		"label": _label_of(str(job.get("workflow", ""))),
		"user": str(job.get("user", "")),
		"failures": codes,
	})
	if activity.size() > 30:
		activity.pop_front()
	activity_version += 1


# ---------------------------------------------------------------- game access
func game_state() -> Node:
	return get_node_or_null("/root/GameState")


func world() -> Node:
	return _world if _world != null and is_instance_valid(_world) else null


# A member of the world ("hud", "live", "player"...), or null.
func world_get(member: String) -> Variant:
	var w := world()
	if w == null or not (member in w):
		return null
	var v: Variant = w.get(member)
	if typeof(v) == TYPE_OBJECT and not is_instance_valid(v):
		return null  # "is" would raise an error on a freed object
	return v


# Exported scripts may be remapped, so the world is recognised by its members.
func _is_world(n: Node) -> bool:
	return n != null and "_built" in n and "field" in n and "builds" in n


func _track_world() -> void:
	var cs := get_tree().current_scene
	if cs != _last_scene:
		_last_scene = cs
		if _world != null:
			_world = null
			if menu != null and is_instance_valid(menu):
				menu.close()
			actions.on_world_left()
			_send_state()
	if _world == null and _is_world(cs) and bool(cs.get("_built")):
		_world = cs
		_disable_leaderboard()
		_send_compat()
		_send_state()
		if not _announced:
			_announced = true
			actions.run("notify", {"text": i18n.t("active")}, {})


# ---------------------------------------------------------------- game events
func _connect_game_signals() -> void:
	var gs := game_state()
	if gs == null:
		print("[TalkyNeedle] GameState not found: no game events")
		return
	var counts := {}
	for s in gs.get_signal_list():
		counts[str(s["name"])] = (s["args"] as Array).size()
	for sig: String in GAME_SIGNALS:
		if counts.get(sig, -1) != GAME_SIGNALS[sig]:
			print("[TalkyNeedle] signal %s not found or changed: event disabled" % sig)
			continue
		match sig:
			"needle_found":
				gs.connect(sig, _on_needle_found)
			"needle_discovered":
				gs.connect(sig, _on_needle_discovered)
			"pile_replaced":
				gs.connect(sig, _on_pile_replaced)


func _on_needle_found(index: Variant, _pos: Variant) -> void:
	var gs := game_state()
	_send_event("needle_found", {"index": index, "needlesFound": gs.get("needles_found")})


func _on_needle_discovered(type: Variant, _pos: Variant) -> void:
	_send_event("needle_discovered", {"type": type})


func _on_pile_replaced() -> void:
	_send_event("pile_replaced", {})


func _send_event(event: String, data: Dictionary) -> void:
	_send({"t": "event", "event": event, "data": data})


func _send_state() -> void:
	var gs := game_state()
	var state := {"t": "state", "inWorld": world() != null, "language": i18n.language()}
	_follow_game_language()
	if gs != null:
		state["money"] = gs.get("money")
		state["needlesFound"] = gs.get("needles_found")
	_send(state)
	_state_in = STATE_SECONDS


# Which hooks of the game this version offers, for the bridge's window.
# The player changed the game's language: the window follows, and the state tells the bridge.
func _follow_game_language() -> void:
	var current: String = i18n.language()
	if current == _language:
		return
	var first_time := _language == ""
	_language = current
	if not first_time and menu != null and is_instance_valid(menu):
		var was_open: bool = menu.is_open
		reload_menu()
		if was_open:
			menu.open()


func _send_compat() -> void:
	_send({"t": "compat", "hooks": actions.compat()})


# ---------------------------------------------------------------- link
func _process(delta: float) -> void:
	if not _enabled:
		return
	_track_world()
	actions.tick(delta)
	if menu != null and is_instance_valid(menu):
		menu.tick()
	_poll_link(delta)
	_start_jobs()


func _poll_link(delta: float) -> void:
	_peer.poll()
	match _peer.get_status():
		StreamPeerTCP.STATUS_CONNECTED:
			if not _hello_sent:
				_hello_sent = true
				_send({"t": "hello", "protocol": PROTOCOL, "version": VERSION, "language": i18n.language()})
				_send_state()
				if world() != null:
					_send_compat()
			_read_lines()
			_state_in -= delta
			if _state_in <= 0.0:
				_send_state()
		StreamPeerTCP.STATUS_CONNECTING:
			pass
		_:
			_hello_sent = false
			_buffer.clear()
			_reconnect_in -= delta
			if _reconnect_in <= 0.0:
				_reconnect_in = RECONNECT_SECONDS
				_peer.disconnect_from_host()
				_peer.connect_to_host(BRIDGE_HOST, BRIDGE_PORT)


func _read_lines() -> void:
	var available := _peer.get_available_bytes()
	if available > 0:
		var got: Array = _peer.get_partial_data(available)
		if int(got[0]) == OK:
			_buffer.append_array(got[1])
	while true:
		var end := _buffer.find(10)
		if end < 0:
			break
		var line := _buffer.slice(0, end).get_string_from_utf8()
		_buffer = _buffer.slice(end + 1)
		var msg: Variant = JSON.parse_string(line)
		if msg is Dictionary:
			_on_message(msg)
	if _buffer.size() > MAX_LINE_BYTES:
		print("[TalkyNeedle] line too long from the bridge: disconnecting")
		_peer.disconnect_from_host()


func _on_message(msg: Dictionary) -> void:
	var kind := str(msg.get("t", ""))
	if kind == "catalog":
		var workflows: Variant = msg.get("workflows")
		catalog = workflows if workflows is Array else []
		bridge_paused = msg.get("paused") == true
		bridge_safe_mode = msg.get("safeMode") == true
		bridge_bits_multiplier = _num(msg.get("bitsMultiplier"), 1.0)
		catalog_version += 1
		return
	if kind != "job":
		return
	var seq := int(_num(msg.get("seq"), 0.0))
	_send({"t": "ack", "seq": seq})
	if seq <= _last_seq:
		return  # resent after a reconnection: already here
	_last_seq = seq
	if _queue.size() >= MAX_QUEUED_JOBS:
		_send({"t": "done", "seq": seq, "failures": [{"action": "job", "code": "queue_full"}]})
		return
	_queue.append(msg)


func _send(msg: Dictionary) -> void:
	if _peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		_peer.put_data((JSON.stringify(msg) + "\n").to_utf8_buffer())


# ---------------------------------------------------------------- jobs
func _start_jobs() -> void:
	while not _queue.is_empty() and _running < MAX_RUNNING_JOBS and world() != null:
		_run_job(_queue.pop_front())


func _run_job(job: Dictionary) -> void:
	_running += 1
	var failures: Array = []
	var steps: Variant = job.get("steps")
	for step: Variant in (steps if steps is Array else []):
		if world() == null:
			failures.append({"action": "job", "code": "left_world"})
			break
		if not (step is Dictionary):
			failures.append({"action": "step", "code": "invalid"})
			continue
		var action := str(step.get("action", ""))
		if action == "wait":
			var seconds := clampf(_num(step.get("seconds"), 0.0), 0.0, MAX_WAIT_SECONDS)
			# stops counting while the game is paused
			await get_tree().create_timer(seconds, false).timeout
			continue
		var code: String = await actions.run(action, step, job)
		if code != "":
			failures.append({"action": action, "code": code})
	_running -= 1
	_add_activity(job, failures)
	_send({"t": "done", "seq": job.get("seq"), "failures": failures})


# Workflows can send numbers as text: never NaN, never an error.
func _num(v: Variant, fallback: float) -> float:
	if v is int or v is float:
		var f := float(v)
		return f if is_finite(f) else fallback
	if v is String and (v as String).is_valid_float():
		return _num((v as String).to_float(), fallback)
	return fallback
