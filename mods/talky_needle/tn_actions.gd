# Talky Needle: the actions a workflow can run in the game.
#
# A handler takes (params, job) and returns "" when it worked, or a short code that
# the bridge shows ("no_hook", "invalid"...). Another mod can add its own:
#   get_node("/root/TalkyNeedle").actions.register("my_action", func(p, job): return "")
#
# Nothing here moves a needle: losing one out of the map would end the run.
extends RefCounted

const MAX_TEXT := 200
const MAX_NOTIFY_SECONDS := 60.0
const MAX_MESSAGE_QUEUE := 20
const MAX_HAY_PER_STEP := 100000
const MAX_HAY_VISIBLE := 300  # loose straws cost physics time: the rest goes straight into the pile
const PATCH_RADIUS := 8  # grid points around the center of a raised patch of the pile
const PATCH_MAX_RISE := 1.5  # metres at its center
const HAY_PER_FRAME := 15
const MAX_RADIUS := 40.0
const MAX_GUST := 40.0
const MAX_FX_SECONDS := 30.0
const MAX_BODIES_PER_FRAME := 400
const MAX_DUCKS := 40
const DUCK_GROUP := "talky_needle_duck"
const MAX_DUCK_SIZE := 8.0
const MAX_DUCKS_PER_STEP := 30
const MAX_BLACKOUT_SECONDS := 10.0
const MAX_YEET := 30.0
const STRAND_REACH := 22.0  # the game removes loose straws far from the player
const PILE_MIN_HEIGHT := 0.3
const PILE_SAMPLES := 4000
const AUDIO_RATE := 22050
const HAY_COLOR := Color(0.86, 0.74, 0.4)
const DUCK_COLOR := Color(1.0, 0.82, 0.1)
const BEAK_COLOR := Color(1.0, 0.45, 0.05)

var mod: Node = null

var _handlers := {}
var _banner: Label = null
var _banner_tween: Tween = null
var _messages: Array = []
var _message_until := 0
var _message_panel: PanelContainer = null
var _message_style: StyleBoxFlat = null
var _message_author: Label = null
var _message_text: Label = null
var _hay_motion := {}
var _camera := {}
var _spin := {}
var _blackout: CanvasLayer = null
var _blackout_until := 0
var _ducks: Array = []  # [{body, until}], oldest first
var _duck_button: Button = null
var _sounds := {}


func setup(owner_mod: Node) -> void:
	mod = owner_mod
	register("notify", _notify)
	register("message", _message)
	register("hay_rain", _hay_rain)
	register("gust", _gust)
	register("magnet", func(p: Dictionary, _j: Dictionary) -> String: return _start_hay_motion("magnet", p, 10.0))
	register("levitate", func(p: Dictionary, _j: Dictionary) -> String: return _start_hay_motion("levitate", p, 4.0))
	register("duck", _duck)
	register("clear_ducks", func(_p: Dictionary, _j: Dictionary) -> String:
		clear_ducks()
		return "")
	register("yeet", _yeet)
	register("spin", _start_spin)
	register("drunk", func(p: Dictionary, _j: Dictionary) -> String: return _start_camera("drunk", p))
	register("upside_down", func(p: Dictionary, _j: Dictionary) -> String: return _start_camera("upside_down", p))
	register("quake_pro", func(p: Dictionary, _j: Dictionary) -> String: return _start_camera("quake_pro", p))
	register("blackout", _start_blackout)
	register("sound", _sound)
	register("menu", _menu)
	register("reload_menu", func(_p: Dictionary, _j: Dictionary) -> String: return "" if mod.reload_menu() else "failed")
	register("screenshot", _screenshot)


func register(action: String, handler: Callable) -> void:
	_handlers[action] = handler


func run(action: String, p: Dictionary, job: Dictionary) -> String:
	if not _handlers.has(action):
		return "unknown_action"
	var result: Variant = await _handlers[action].call(p, job)
	return result if result is String else ""


# What this version of the game offers. Sent to the bridge when a world loads: the
# hooks come from a mod written for an older build, so they may have moved.
func compat() -> Dictionary:
	var hud: Variant = mod.world_get("hud")
	var live: Variant = mod.world_get("live")
	var player: Variant = mod.world_get("player")
	var field: Variant = mod.world_get("field")
	var points := _pile_points()
	var out := {
		"world.player": player != null,
		"player.velocity": player != null and "velocity" in player,
		"player.set_look": player != null and player.has_method("set_look"),
		"camera": mod.get_viewport().get_camera_3d() != null,
		"hud.show_toast": hud != null and hud.has_method("show_toast"),
		"live.spawn": live != null and live.has_method("spawn"),
		"live._active": live != null and live.get("_active") is Array,
		"field.heights": field != null and field.get("heights") is PackedFloat32Array,
		"field._dirty_vertex_cells": field != null and field.has_method("_dirty_vertex_cells"),
		"GameState.hay_total": mod.game_state() != null and "hay_total" in mod.game_state(),
		"Cfg.CELL": float(_cfg("CELL", 0.0)) > 0.0,
		"pile found": not points.is_empty(),
	}
	if field != null:
		print("[TalkyNeedle] pile: nv=%s cell=%s extent=%s points=%d player=%s" % [
			field.get("_nv"), _cfg("CELL", "?"), _cfg("FIELD_EXTENT", "?"), points.size(),
			player.global_position if player is Node3D else "?"])
	if not points.is_empty():
		print("[TalkyNeedle] pile samples: %s" % [points.slice(0, 3)])
	return out


# ---------------------------------------------------------------- menu and checks
# open: true or false; tab: effects, message, activity or settings; language: forces en or fr.
func _menu(p: Dictionary, _job: Dictionary) -> String:
	if p.has("language"):
		mod.i18n.language_override = str(p["language"])
		mod.reload_menu()
	if not mod.ensure_menu():
		return "failed"
	if p.get("open", true) == false:
		mod.menu.close()
	else:
		mod.menu.open(str(p.get("tab", "")))
	return ""


# Saves what the game shows to user://talky_needle_shot.png, to check the interface.
func _screenshot(_p: Dictionary, _job: Dictionary) -> String:
	await RenderingServer.frame_post_draw
	var image: Image = mod.get_viewport().get_texture().get_image()
	if image == null:
		return "failed"
	return "" if image.save_png("user://talky_needle_shot.png") == OK else "failed"


func duck_count() -> int:
	return _ducks.size()


# Called every frame, last, so the camera effects win over the game's own updates.
func tick(delta: float) -> void:
	var now := Time.get_ticks_msec()
	_tick_messages(now)
	_layout_overlays()
	_tick_hay_motion(now)
	_tick_camera(now)
	_tick_spin(now, delta)
	_tick_blackout(now)
	_tick_ducks(now)


func on_world_left() -> void:
	_messages.clear()
	if _message_until != 0:
		_message_until = 0
		_message_panel.visible = false
	_hay_motion.clear()
	_spin.clear()
	_restore_camera()
	_end_blackout()
	_ducks.clear()  # the ducks belong to the world and are freed with it


# Places the overlays by hand, every frame: it follows any resolution or window size.
func _layout_overlays() -> void:
	var screen: Vector2 = mod.get_viewport().get_visible_rect().size
	if _message_panel != null and is_instance_valid(_message_panel) and _message_panel.visible:
		_message_panel.position = Vector2(round((screen.x - _message_panel.size.x) * 0.5), 110.0)
	if _banner != null and is_instance_valid(_banner):
		_banner.position = Vector2(round((screen.x - _banner.size.x) * 0.5), 60.0)
	if _duck_button != null and is_instance_valid(_duck_button) and _duck_button.visible:
		_duck_button.position = Vector2(screen.x - _duck_button.size.x - 16.0, 16.0)


# ---------------------------------------------------------------- game data
# A constant of the game's Cfg, wherever this build keeps it. Hardcoding the name in
# the script would stop the whole mod from compiling if the game renamed it.
func _cfg(key: String, fallback: Variant) -> Variant:
	var script: Script = null
	var node: Node = mod.get_node_or_null("/root/Cfg")
	if node != null:
		script = node.get_script()
	else:
		for c: Dictionary in ProjectSettings.get_global_class_list():
			if str(c["class"]) == "Cfg":
				script = load(str(c["path"])) as Script
				break
	if script == null:
		return fallback
	var constants: Dictionary = script.get_script_constant_map()
	return constants.get(key, fallback)


# Points on top of the pile, in world space, within reach of the player if possible.
func _pile_points() -> Array:
	var field: Variant = mod.world_get("field")
	if field == null:
		return []
	var heights: Variant = field.get("heights")
	var nv := int(mod._num(field.get("_nv"), 0.0))
	var cell := float(mod._num(_cfg("CELL", 0.0), 0.0))
	if not (heights is PackedFloat32Array) or nv < 2 or cell <= 0.0:
		return []
	var grid: PackedFloat32Array = heights
	if grid.size() != nv * nv:
		return []
	var half := float(mod._num(_cfg("FIELD_EXTENT", 0.0), 0.0))
	if half <= 0.0:
		half = float(nv - 1) * cell * 0.5
	var base := Vector3.ZERO
	if field is Node3D:
		base = (field as Node3D).global_position
	var stride := maxi(1, int(sqrt(float(grid.size()) / float(PILE_SAMPLES))))
	var points: Array = []
	for z in range(0, nv, stride):
		for x in range(0, nv, stride):
			var h: float = grid[x + z * nv]
			if h >= PILE_MIN_HEIGHT:
				points.append(base + Vector3(float(x) * cell - half, h, float(z) * cell - half))
	var player: Variant = mod.world_get("player")
	if points.is_empty() or not (player is Node3D):
		return points
	var from: Vector3 = player.global_position
	var near := points.filter(func(q: Vector3) -> bool: return Vector2(q.x - from.x, q.z - from.z).length() <= STRAND_REACH)
	if not near.is_empty():
		return near
	# Too far from all of it: the closest part of the pile, or the straws would vanish.
	points.sort_custom(func(a: Vector3, b: Vector3) -> bool: return a.distance_squared_to(from) < b.distance_squared_to(from))
	return points.slice(0, 200)


func _around_player(radius: float) -> Variant:
	var player: Variant = mod.world_get("player")
	if not (player is Node3D):
		return null
	var angle := randf() * TAU
	return player.global_position + Vector3(cos(angle), 0.0, sin(angle)) * radius * sqrt(randf())


# on: "pile" (default) or "player". Falls back on the player when no pile is known.
func _drop_point(on: String, points: Array, radius: float, height: float) -> Variant:
	if on != "player" and not points.is_empty():
		var top: Vector3 = points.pick_random()
		return top + Vector3(randf_range(-1.0, 1.0), randf_range(height, height + 3.0), randf_range(-1.0, 1.0))
	var at: Variant = _around_player(radius)
	return null if at == null else at + Vector3.UP * randf_range(height, height + 3.0)


func _is_loose_straw(b: Variant) -> bool:
	if b == null or not is_instance_valid(b) or not (b is RigidBody3D) or b.has_meta("needle_index"):
		return false
	return not (b as RigidBody3D).freeze


# ---------------------------------------------------------------- notify
func _notify(p: Dictionary, _job: Dictionary) -> String:
	var text := str(p.get("text", "")).left(MAX_TEXT)
	if text.strip_edges() == "":
		return "invalid"
	var seconds := clampf(mod._num(p.get("seconds"), 4.0), 1.0, MAX_NOTIFY_SECONDS)
	var color := str(p.get("color", ""))
	var hud: Variant = mod.world_get("hud")
	if color == "" and hud != null and hud.has_method("show_toast"):
		# Viewer names reach this text: no markup in case the toast renders it.
		hud.show_toast(text.replace("[", "("), seconds)
	else:
		_show_banner(text, color, seconds)
	return ""


func _show_banner(text: String, color: String, seconds: float) -> void:
	if _banner == null or not is_instance_valid(_banner):
		var layer := CanvasLayer.new()
		layer.layer = 100
		mod.add_child(layer)
		_banner = Label.new()
		_banner.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED  # a viewer's text stays as it is
		_banner.add_theme_font_size_override("font_size", 28)
		var banner_font: Font = mod.game_font()
		if banner_font != null:
			_banner.add_theme_font_override("font", banner_font)
		_banner.add_theme_constant_override("outline_size", 8)
		_banner.add_theme_color_override("font_outline_color", Color.BLACK)
		layer.add_child(_banner)
	_banner.text = text
	_banner.reset_size()  # it would keep the width of a longer previous text
	var tint := Color.html(color) if Color.html_is_valid(color) else Color.WHITE
	_banner.add_theme_color_override("font_color", tint)
	_banner.modulate.a = 1.0
	if _banner_tween != null:
		_banner_tween.kill()  # its fade would erase this new text
	_banner_tween = _banner.create_tween()
	_banner_tween.set_pause_mode(Tween.TWEEN_PAUSE_PROCESS)
	_banner_tween.tween_interval(seconds)
	_banner_tween.tween_property(_banner, "modulate:a", 0.0, 0.4)


# ---------------------------------------------------------------- messages
# A panel with an author and a text. Messages wait for their turn instead of replacing
# each other. Plain labels: a viewer's text cannot carry markup.
func _message(p: Dictionary, _job: Dictionary) -> String:
	var text := str(p.get("text", "")).strip_edges().left(MAX_TEXT)
	if text == "":
		return "invalid"
	if _messages.size() >= MAX_MESSAGE_QUEUE:
		return "queue_full"
	_messages.append({
		"author": str(p.get("author", "")).strip_edges().left(40),
		"text": text,
		"color": str(p.get("color", "")),
		"seconds": clampf(mod._num(p.get("seconds"), 6.0), 1.0, MAX_NOTIFY_SECONDS),
	})
	return ""


func _tick_messages(now: int) -> void:
	if _message_until != 0 and now >= _message_until:
		_message_until = 0
		_message_panel.visible = false
	if _message_until == 0 and not _messages.is_empty():
		_show_message(_messages.pop_front(), now)


func _show_message(m: Dictionary, now: int) -> void:
	if _message_panel == null or not is_instance_valid(_message_panel):
		_build_message_panel()
	var accent := Color.html(str(m["color"])) if Color.html_is_valid(str(m["color"])) else Color(1.0, 0.82, 0.1)
	_message_style.border_color = accent
	_message_author.add_theme_color_override("font_color", accent)
	_message_author.text = str(m["author"])
	_message_author.visible = _message_author.text != ""
	_message_text.text = str(m["text"])
	_message_panel.visible = true
	_message_panel.reset_size()
	_message_until = now + int(float(m["seconds"]) * 1000.0)


func _build_message_panel() -> void:
	var layer := CanvasLayer.new()
	layer.layer = 100
	mod.add_child(layer)
	_message_style = StyleBoxFlat.new()
	_message_style.bg_color = Color(0.05, 0.05, 0.07, 0.88)
	_message_style.set_border_width_all(3)
	_message_style.set_corner_radius_all(10)
	_message_style.set_content_margin_all(16.0)
	_message_panel = PanelContainer.new()
	_message_panel.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED  # a viewer's text stays as it is
	_message_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_message_panel.add_theme_stylebox_override("panel", _message_style)
	var font: Font = mod.game_font()
	if font != null:
		var panel_theme := Theme.new()
		panel_theme.default_font = font
		_message_panel.theme = panel_theme
	layer.add_child(_message_panel)
	var column := VBoxContainer.new()
	column.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_message_panel.add_child(column)
	_message_author = Label.new()
	_message_author.add_theme_font_size_override("font_size", 20)
	column.add_child(_message_author)
	_message_text = Label.new()
	_message_text.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_message_text.custom_minimum_size = Vector2(760.0, 0.0)
	_message_text.add_theme_font_size_override("font_size", 30)
	column.add_child(_message_text)


# ---------------------------------------------------------------- hay
# Loose straws fall on the pile, a few per frame to avoid a hitch. Above MAX_HAY_VISIBLE,
# the rest is added to the pile and to the counter directly.
func _hay_rain(p: Dictionary, _job: Dictionary) -> String:
	var live: Variant = mod.world_get("live")
	if live == null or not live.has_method("spawn"):
		return "no_hook"
	var count := clampi(int(mod._num(p.get("count"), 30.0)), 1, MAX_HAY_PER_STEP)
	var radius := clampf(mod._num(p.get("radius"), 4.0), 0.5, MAX_RADIUS)
	var height := clampf(mod._num(p.get("height"), 6.0), 1.0, 30.0)
	var on := str(p.get("on", "pile"))
	var points := _pile_points() if on != "player" else []
	var spawned := 0
	var visible_straws := mini(count, MAX_HAY_VISIBLE)
	var grown := true
	if on != "player" and count > visible_straws:
		grown = _grow_pile(count - visible_straws)
	for i in visible_straws:
		if mod.world() == null or not is_instance_valid(live):
			return "left_world"
		var at: Variant = _drop_point(on, points, radius, height)
		if at == null:
			return "no_hook"
		var basis := Basis(Vector3.UP, randf() * TAU) * Basis(Vector3.RIGHT, randf() * TAU)
		var velocity := Vector3(randf_range(-0.5, 0.5), -2.0, randf_range(-0.5, 0.5))
		if live.spawn(at, basis, velocity, HAY_COLOR, false) != null:
			spawned += 1
		if (i + 1) % HAY_PER_FRAME == 0:
			await mod.get_tree().process_frame
	if not grown:
		return "pile_not_grown"
	return "" if spawned > 0 else "refused"


# Adds strands to the pile and to the game's counter by raising one rounded patch of the height
# grid. A small patch on purpose: the game rebuilds its collision by zones, and raising the whole
# pile froze it about five times for half a second. Returns false when this build has no way to do it.
func _grow_pile(strands: int) -> bool:
	var field: Variant = mod.world_get("field")
	var gs: Node = mod.game_state()
	if field == null or gs == null or not ("hay_total" in gs):
		return false
	var heights: Variant = field.get("heights")
	var nv := int(mod._num(field.get("_nv"), 0.0))
	if not (heights is PackedFloat32Array) or nv < 2 or not field.has_method("_dirty_vertex_cells"):
		return false
	var grid: PackedFloat32Array = heights
	var sum := 0.0
	var top := 0.0
	for h: float in grid:
		sum += h
		top = maxf(top, h)
	var total := float(gs.get("hay_total"))
	if sum <= 0.0 or top < PILE_MIN_HEIGHT or total <= 0.0:
		return false
	# Somewhere on the upper part of the pile, a different place each time.
	var candidates := PackedInt32Array()
	for i in grid.size():
		if grid[i] >= top * 0.6:
			candidates.append(i)
	var center: int = candidates[randi() % candidates.size()]
	var cx := center % nv
	var cz := center / nv
	# The pile tells how many strands one metre of height is worth.
	var wanted := float(strands) * sum / total
	var radius := PATCH_RADIUS
	while true:
		var weights := _patch_weights(nv, cx, cz, radius)
		var peak := wanted / weights
		if peak <= PATCH_MAX_RISE or radius >= nv:
			_raise_patch(field, grid, nv, cx, cz, radius, peak)
			break
		radius *= 2  # a very large gift: wider rather than a spike
	gs.set("hay_total", total + float(strands))
	gs.set("_hay_dirty", true)
	if gs.has_signal("hay_changed"):
		gs.emit_signal("hay_changed", gs.get("hay_total"), gs.get("hay_dug"))
	return true


func _patch_weights(nv: int, cx: int, cz: int, radius: int) -> float:
	var weights := 0.0
	for z in range(maxi(cz - radius, 0), mini(cz + radius + 1, nv)):
		for x in range(maxi(cx - radius, 0), mini(cx + radius + 1, nv)):
			weights += _patch_weight(x - cx, z - cz, radius)
	return weights


func _raise_patch(field: Variant, grid: PackedFloat32Array, nv: int, cx: int, cz: int, radius: int, peak: float) -> void:
	var touched := PackedInt32Array()
	for z in range(maxi(cz - radius, 0), mini(cz + radius + 1, nv)):
		for x in range(maxi(cx - radius, 0), mini(cx + radius + 1, nv)):
			var w := _patch_weight(x - cx, z - cz, radius)
			if w > 0.0:
				grid[x + z * nv] += peak * w
				touched.append(x + z * nv)
	field.set("heights", grid)
	for i in touched:
		field.call("_dirty_vertex_cells", i % nv, i / nv)


# 1 at the center, 0 at the edge, without a step.
func _patch_weight(dx: int, dz: int, radius: int) -> float:
	var d := sqrt(float(dx * dx + dz * dz)) / float(radius)
	if d >= 1.0:
		return 0.0
	var k := 1.0 - d * d
	return k * k


func _gust(p: Dictionary, _job: Dictionary) -> String:
	var live: Variant = mod.world_get("live")
	var player: Variant = mod.world_get("player")
	if live == null or not (player is Node3D):
		return "no_hook"
	var active: Variant = live.get("_active")
	if not (active is Array):
		return "no_hook"
	var radius := clampf(mod._num(p.get("radius"), 12.0), 1.0, MAX_RADIUS)
	var strength := clampf(mod._num(p.get("strength"), 8.0), 0.5, MAX_GUST)
	var angle := randf() * TAU
	var wind := Vector3(cos(angle), 0.45, sin(angle)).normalized()
	var center: Vector3 = player.global_position
	var moved := 0
	for b: Variant in active:
		if not _is_loose_straw(b):
			continue
		var body := b as RigidBody3D
		if body.global_position.distance_to(center) > radius:
			continue
		body.sleeping = false
		body.linear_velocity += wind * strength * randf_range(0.7, 1.3)
		moved += 1
	return "" if moved > 0 else "nothing_nearby"


func _start_hay_motion(mode: String, p: Dictionary, default_speed: float) -> String:
	var live: Variant = mod.world_get("live")
	if live == null or not (live.get("_active") is Array) or not (mod.world_get("player") is Node3D):
		return "no_hook"
	var seconds := clampf(mod._num(p.get("seconds"), 8.0), 1.0, MAX_FX_SECONDS)
	_hay_motion = {
		"mode": mode,
		"until": Time.get_ticks_msec() + int(seconds * 1000.0),
		"radius": clampf(mod._num(p.get("radius"), 18.0), 2.0, MAX_RADIUS),
		"speed": clampf(mod._num(p.get("speed"), default_speed), 1.0, MAX_GUST),
	}
	return ""


func _tick_hay_motion(now: int) -> void:
	if _hay_motion.is_empty():
		return
	var live: Variant = mod.world_get("live")
	var player: Variant = mod.world_get("player")
	if now >= int(_hay_motion["until"]) or live == null or not (player is Node3D):
		_hay_motion.clear()
		return
	var active: Variant = live.get("_active")
	if not (active is Array):
		_hay_motion.clear()
		return
	var mode := str(_hay_motion["mode"])
	var radius: float = _hay_motion["radius"]
	var speed: float = _hay_motion["speed"]
	var center: Vector3 = player.global_position
	var done := 0
	for b: Variant in active:
		if done >= MAX_BODIES_PER_FRAME:
			break
		if not _is_loose_straw(b):
			continue
		var body := b as RigidBody3D
		var offset: Vector3 = body.global_position - center
		if offset.length() > radius:
			continue
		var target := Vector3.ZERO
		if mode == "magnet":
			target = (Vector3.UP * 1.2 - offset).normalized() * speed
		else:
			target = Vector3(sin(float(now) * 0.001 + offset.x), speed, cos(float(now) * 0.001 + offset.z))
		body.sleeping = false
		body.linear_velocity = body.linear_velocity.lerp(target, 0.12)
		done += 1


# ---------------------------------------------------------------- ducks
# Rubber ducks with a viewer's name, drawn from primitives: no asset of the game or of
# anyone else. Layer 0: tools and machines ignore them, so they cannot break a factory.
func _duck(p: Dictionary, _job: Dictionary) -> String:
	var world: Node = mod.world()
	if world == null:
		return "no_hook"
	var size := clampf(mod._num(p.get("size"), 1.0), 0.2, MAX_DUCK_SIZE)
	var count := clampi(int(mod._num(p.get("count"), 1.0)), 1, MAX_DUCKS_PER_STEP)
	var seconds := clampf(mod._num(p.get("seconds"), 180.0), 5.0, 1800.0)
	var text := str(p.get("name", "")).left(30)
	var on := str(p.get("on", "pile"))
	var points := _pile_points() if on != "player" else []
	for i in count:
		if mod.world() == null:
			return "left_world"
		var at: Variant = _drop_point(on, points, 5.0, 4.0 + size)
		if at == null:
			return "no_hook"
		_spawn_duck(mod.world(), at, size, text, seconds)
		if count > 1:
			await mod.get_tree().create_timer(0.12, false).timeout
	_sound({"name": "quack", "pitch": clampf(1.3 - size * 0.12, 0.45, 1.5)}, {})
	return ""


func _spawn_duck(world: Node, at: Vector3, size: float, text: String, seconds: float) -> void:
	while _ducks.size() >= MAX_DUCKS:
		_free_duck(_ducks.pop_front())
	var body := RigidBody3D.new()
	body.add_to_group(DUCK_GROUP)
	body.collision_layer = 0
	body.collision_mask = 0xFFFFFFFF
	body.mass = maxf(0.5, size * size)
	body.axis_lock_angular_x = true  # stays on its bottom, like a real duck
	body.axis_lock_angular_z = true
	var shape := CollisionShape3D.new()
	var sphere := SphereShape3D.new()
	sphere.radius = 0.5 * size
	shape.shape = sphere
	body.add_child(shape)
	var yellow := _duck_material(DUCK_COLOR)
	_duck_part(body, 0.5, Vector3(0.0, 0.0, 0.0), Vector3(1.0, 0.8, 1.25), size, yellow)
	_duck_part(body, 0.3, Vector3(0.0, 0.5, -0.38), Vector3.ONE, size, yellow)
	_duck_part(body, 0.16, Vector3(0.0, 0.25, 0.58), Vector3(0.8, 1.0, 1.3), size, yellow)
	_duck_part(body, 0.12, Vector3(0.0, 0.46, -0.72), Vector3(1.3, 0.45, 1.5), size, _duck_material(BEAK_COLOR))
	var black := _duck_material(Color.BLACK)
	_duck_part(body, 0.05, Vector3(0.14, 0.6, -0.61), Vector3.ONE, size, black)
	_duck_part(body, 0.05, Vector3(-0.14, 0.6, -0.61), Vector3.ONE, size, black)
	if text.strip_edges() != "":
		var label := Label3D.new()
		label.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
		label.text = text
		label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
		label.no_depth_test = true
		label.font_size = 64
		label.outline_size = 14
		label.pixel_size = 0.006 * maxf(size, 1.0)
		label.position = Vector3.UP * (size + 0.3)
		body.add_child(label)
	world.add_child(body)
	body.global_position = at
	body.rotation.y = randf() * TAU
	body.angular_velocity = Vector3.UP * randf_range(-3.0, 3.0)
	_ducks.append({"body": body, "until": Time.get_ticks_msec() + int(seconds * 1000.0)})


func _duck_part(parent: Node3D, radius: float, at: Vector3, stretch: Vector3, size: float, material: Material) -> void:
	var sphere := SphereMesh.new()
	sphere.radius = radius * size
	sphere.height = radius * size * 2.0
	sphere.radial_segments = 24
	sphere.rings = 12
	var part := MeshInstance3D.new()
	part.mesh = sphere
	part.material_override = material
	part.position = at * size
	part.scale = stretch
	parent.add_child(part)


func _duck_material(color: Color) -> StandardMaterial3D:
	var material := StandardMaterial3D.new()
	material.albedo_color = color
	material.roughness = 0.3
	return material


# Removes every duck. Returns how many were there.
func clear_ducks() -> int:
	var ducks: Array = mod.get_tree().get_nodes_in_group(DUCK_GROUP)
	for body: Node in ducks:
		body.queue_free()
	_ducks.clear()
	if not ducks.is_empty():
		_notify({"text": mod.i18n.t("ducks_removed") % ducks.size()}, {})
	return ducks.size()


# Only shown when the game frees the cursor (pause menu...): nothing on screen while playing.
func _tick_duck_button() -> void:
	var count := _ducks.size()
	var menu_open: bool = mod.menu != null and is_instance_valid(mod.menu) and mod.menu.is_open
	var show := count > 0 and mod.world() != null and not menu_open and Input.mouse_mode != Input.MOUSE_MODE_CAPTURED
	if not show:
		if _duck_button != null and is_instance_valid(_duck_button):
			_duck_button.visible = false
		return
	if _duck_button == null or not is_instance_valid(_duck_button):
		var layer := CanvasLayer.new()
		layer.layer = 101
		mod.add_child(layer)
		_duck_button = Button.new()
		_duck_button.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
		_duck_button.focus_mode = Control.FOCUS_NONE
		_duck_button.add_theme_font_size_override("font_size", 20)
		_duck_button.pressed.connect(clear_ducks)
		layer.add_child(_duck_button)
	_duck_button.text = mod.i18n.t("duck_button") % count
	_duck_button.visible = true


func _tick_ducks(now: int) -> void:
	_tick_duck_button()
	if _ducks.is_empty():
		return
	for i in range(_ducks.size() - 1, -1, -1):
		var entry: Dictionary = _ducks[i]
		var body: Variant = entry["body"]
		if not is_instance_valid(body):
			_ducks.remove_at(i)
		elif now >= int(entry["until"]) or body.global_position.y < -60.0:
			_free_duck(entry)
			_ducks.remove_at(i)


func _free_duck(entry: Dictionary) -> void:
	var body: Variant = entry["body"]
	if is_instance_valid(body):
		body.queue_free()


# ---------------------------------------------------------------- player
func _yeet(p: Dictionary, _job: Dictionary) -> String:
	var player: Variant = mod.world_get("player")
	if player == null or not ("velocity" in player):
		return "no_hook"
	var force := clampf(mod._num(p.get("force"), 14.0), 3.0, MAX_YEET)
	var side := force * 0.25
	player.velocity = Vector3(randf_range(-side, side), force, randf_range(-side, side))
	return ""


func _start_spin(p: Dictionary, _job: Dictionary) -> String:
	var player: Variant = mod.world_get("player")
	if player == null or not player.has_method("set_look"):
		return "no_hook"
	var seconds := clampf(mod._num(p.get("seconds"), 2.0), 0.2, MAX_FX_SECONDS)
	var turns := clampf(mod._num(p.get("turns"), 3.0), 0.5, 30.0)
	_spin = {
		"until": Time.get_ticks_msec() + int(seconds * 1000.0),
		"speed": turns * TAU / seconds,
		"yaw": player.rotation.y,
	}
	return ""


func _tick_spin(now: int, delta: float) -> void:
	if _spin.is_empty():
		return
	var player: Variant = mod.world_get("player")
	if now >= int(_spin["until"]) or player == null:
		_spin.clear()
		return
	var yaw: float = float(_spin["yaw"]) + float(_spin["speed"]) * delta
	_spin["yaw"] = yaw
	player.set_look(yaw, mod._num(player.get("_pitch"), 0.0))


# ---------------------------------------------------------------- camera
func _start_camera(mode: String, p: Dictionary) -> String:
	_restore_camera()
	var camera: Camera3D = mod.get_viewport().get_camera_3d()
	if camera == null:
		return "no_hook"
	var seconds := clampf(mod._num(p.get("seconds"), 10.0), 1.0, MAX_FX_SECONDS)
	var now := Time.get_ticks_msec()
	_camera = {
		"mode": mode, "camera": camera, "start": now, "until": now + int(seconds * 1000.0),
		"fov": camera.fov, "roll": camera.rotation.z,
	}
	return ""


func _tick_camera(now: int) -> void:
	if _camera.is_empty():
		return
	var camera: Variant = _camera["camera"]
	if not is_instance_valid(camera):
		_camera.clear()
		return
	if now >= int(_camera["until"]):
		_restore_camera()
		return
	var t := float(now - int(_camera["start"])) / 1000.0
	var roll: float = _camera["roll"]
	var fov: float = _camera["fov"]
	var ramp := minf(t / 0.6, 1.0)
	match str(_camera["mode"]):
		"drunk":
			camera.rotation.z = roll + sin(t * 1.7) * 0.28 + sin(t * 0.6) * 0.14
			camera.fov = clampf(fov + sin(t * 1.1) * 14.0, 10.0, 150.0)
		"upside_down":
			camera.rotation.z = roll + PI * ramp
		"quake_pro":
			camera.fov = lerpf(fov, 150.0, ramp)


func _restore_camera() -> void:
	if _camera.is_empty():
		return
	var camera: Variant = _camera["camera"]
	if is_instance_valid(camera):
		camera.rotation.z = _camera["roll"]
		camera.fov = _camera["fov"]
	_camera.clear()


# ---------------------------------------------------------------- blackout
func _start_blackout(p: Dictionary, _job: Dictionary) -> String:
	_end_blackout()
	var seconds := clampf(mod._num(p.get("seconds"), 4.0), 0.5, MAX_BLACKOUT_SECONDS)
	_blackout = CanvasLayer.new()
	_blackout.layer = 99
	var black := ColorRect.new()
	black.color = Color.BLACK
	black.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_blackout.add_child(black)
	black.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var label := Label.new()
	label.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	label.text = str(p.get("text", "")).left(MAX_TEXT)
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.add_theme_font_size_override("font_size", 36)
	_blackout.add_child(label)
	label.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mod.add_child(_blackout)
	_blackout_until = Time.get_ticks_msec() + int(seconds * 1000.0)
	return ""


func _tick_blackout(now: int) -> void:
	if _blackout != null and now >= _blackout_until:
		_end_blackout()


func _end_blackout() -> void:
	if _blackout != null and is_instance_valid(_blackout):
		_blackout.queue_free()
	_blackout = null


# ---------------------------------------------------------------- sounds
# Synthesised here: the mod ships no audio file.
func _sound(p: Dictionary, _job: Dictionary) -> String:
	var key := str(p.get("name", ""))
	if not _sounds.has(key):
		var stream: AudioStreamWAV = _synth(key)
		if stream == null:
			return "invalid"
		_sounds[key] = stream
	var player := AudioStreamPlayer.new()
	player.stream = _sounds[key]
	player.volume_db = clampf(mod._num(p.get("volume"), 0.0), -30.0, 6.0)
	player.pitch_scale = clampf(mod._num(p.get("pitch"), randf_range(0.92, 1.08)), 0.25, 3.0)
	player.finished.connect(player.queue_free)
	mod.add_child(player)
	player.play()
	return ""


func _synth(key: String) -> AudioStreamWAV:
	var seconds := 0.0
	match key:
		"beep":
			seconds = 0.09
		"quack":
			seconds = 0.34
		"fart":
			seconds = 1.1
		_:
			return null
	var n := int(seconds * float(AUDIO_RATE))
	var data := PackedByteArray()
	data.resize(n * 2)
	var phase := 0.0
	for i in n:
		var t := float(i) / float(AUDIO_RATE)
		var k := t / seconds
		var s := 0.0
		match key:
			"beep":
				s = sin(TAU * 1500.0 * t) * (1.0 - k) * 0.7
			"quack":
				# two nasal bursts falling in pitch
				var burst := fposmod(k * 2.0, 1.0)
				phase += lerpf(620.0, 360.0, burst) / float(AUDIO_RATE)
				var saw := fposmod(phase, 1.0) * 2.0 - 1.0
				s = (saw + sin(TAU * phase * 3.0) * 0.5) * sin(PI * burst) * 0.55
			"fart":
				var pitch := 62.0 + 26.0 * sin(t * 11.0) + 14.0 * sin(t * 37.0) - 20.0 * k
				phase += pitch / float(AUDIO_RATE)
				var buzz := fposmod(phase, 1.0) * 2.0 - 1.0
				var flutter := 0.65 + 0.35 * sin(t * 83.0)
				s = (buzz + randf_range(-0.25, 0.25)) * flutter * minf(k * 12.0, 1.0) * (1.0 - k * k) * 0.8
		data.encode_s16(i * 2, int(clampf(s, -1.0, 1.0) * 32767.0))
	var wav := AudioStreamWAV.new()
	wav.format = AudioStreamWAV.FORMAT_16_BITS
	wav.mix_rate = AUDIO_RATE
	wav.stereo = false
	wav.data = data
	return wav
