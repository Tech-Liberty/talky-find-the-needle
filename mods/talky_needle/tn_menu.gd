# Talky Needle: the in-game window (F8). Effects come from the bridge's catalog, so a
# workflow appears here as soon as config.json gives it a "menu" entry. No token or
# address is ever shown: this window can stay on stream.
extends CanvasLayer

const WINDOW_SIZE := Vector2(1080.0, 680.0)
const COL_AMBER := Color(1.0, 0.86, 0.34)
const COL_ORANGE := Color(0.91, 0.56, 0.17)
const COL_TEXT := Color(0.95, 0.96, 0.99)
const COL_DIM := Color(0.66, 0.69, 0.75)
const COL_BG := Color(0.035, 0.04, 0.055, 0.98)
const COL_CARD := Color(0.085, 0.095, 0.125, 1.0)
const COL_CARD_HOVER := Color(0.14, 0.15, 0.19, 1.0)
const COL_FIELD := Color(0.02, 0.025, 0.035, 1.0)
const COL_LINE := Color(1.0, 1.0, 1.0, 0.09)
const COL_OK := Color(0.45, 0.9, 0.5)
const COL_BAD := Color(1.0, 0.42, 0.38)

const TABS := ["effects", "message", "activity", "settings"]
const GROUPS := {
	"hay": Color(0.87, 0.69, 0.3),
	"ducks": Color(1.0, 0.82, 0.1),
	"troll": Color(0.62, 0.86, 0.3),
	"player": Color(1.0, 0.54, 0.4),
	"screen": Color(0.7, 0.53, 1.0),
	"events": Color(0.25, 0.77, 1.0),
}
const MESSAGE_COLORS := ["#ffd11a", "#69f0ae", "#40c4ff", "#ff80ab", "#ff5252"]
const MESSAGE_SECONDS := [4.0, 6.0, 10.0, 15.0]
const BITS_MULTIPLIERS := [1.0, 2.0, 5.0, 10.0, 20.0]

var mod: Node = null
var is_open := false

var _mouse_before := Input.MOUSE_MODE_CAPTURED
var _backdrop: ColorRect = null
var _window: PanelContainer = null
var _pages := {}
var _tab_buttons := {}
var _status: Label = null
var _feedback: Label = null
var _effects_box: VBoxContainer = null
var _user_edit: LineEdit = null
var _author_edit: LineEdit = null
var _text_edit: TextEdit = null
var _color_buttons: Array = []
var _seconds_buttons: Array = []
var _activity_box: VBoxContainer = null
var _ducks_button: Button = null
var _paused_toggle: Button = null
var _safe_toggle: Button = null
var _bits_buttons: Array = []
var _catalog_seen := -1
var _activity_seen := -1
var _frozen_player: Node = null
var _frozen_mode := Node.PROCESS_MODE_INHERIT


func setup(owner_mod: Node) -> void:
	mod = owner_mod
	layer = 90  # under the message panel, so a message shows above the window
	visible = false
	_build()
	get_viewport().gui_focus_changed.connect(_on_focus_changed)
	select_tab("effects")


func _exit_tree() -> void:
	_thaw_player()


# ---------------------------------------------------------------- open / close
func toggle() -> void:
	if is_open:
		close()
	else:
		open()


func open(tab := "") -> void:
	if not is_open:
		is_open = true
		_mouse_before = Input.mouse_mode
		visible = true
	if tab != "":
		select_tab(tab)
	tick()


func close() -> void:
	if not is_open:
		return
	is_open = false
	visible = false
	var focused: Control = get_viewport().gui_get_focus_owner()
	if focused != null:
		focused.release_focus()
	_thaw_player()
	Input.mouse_mode = _mouse_before


# Runs last in the frame: the game cannot take the cursor back while the window is open.
func tick() -> void:
	if not is_open:
		return
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	var screen: Vector2 = get_viewport().get_visible_rect().size
	_backdrop.position = Vector2.ZERO
	_backdrop.size = screen
	_window.position = ((screen - _window.size) * 0.5).round()
	_refresh()


func select_tab(tab: String) -> void:
	for id: String in _pages:
		_pages[id].visible = id == tab
		_tab_buttons[id].set_pressed_no_signal(id == tab)


# While a text field has the focus, the keys must not walk the player around.
func _on_focus_changed(control: Control) -> void:
	if is_open and (control is LineEdit or control is TextEdit):
		_freeze_player()
	else:
		_thaw_player()


func _freeze_player() -> void:
	var player: Variant = mod.world_get("player")
	if player is Node and _frozen_player == null:
		_frozen_player = player
		_frozen_mode = _frozen_player.process_mode
		_frozen_player.process_mode = Node.PROCESS_MODE_DISABLED


func _thaw_player() -> void:
	if _frozen_player != null and is_instance_valid(_frozen_player):
		_frozen_player.process_mode = _frozen_mode
	_frozen_player = null


# ---------------------------------------------------------------- live data
func _refresh() -> void:
	var connected: bool = mod.bridge_connected()
	_status.text = _t("connected") if connected else _t("disconnected")
	_status.add_theme_color_override("font_color", COL_OK if connected else COL_BAD)
	if _catalog_seen != int(mod.catalog_version):
		_catalog_seen = int(mod.catalog_version)
		_rebuild_effects()
		_paused_toggle.set_pressed_no_signal(mod.bridge_paused)
		_safe_toggle.set_pressed_no_signal(mod.bridge_safe_mode)
		_update_toggle_text(_paused_toggle)
		_update_toggle_text(_safe_toggle)
		for i in _bits_buttons.size():
			_bits_buttons[i].set_pressed_no_signal(is_equal_approx(BITS_MULTIPLIERS[i], float(mod.bridge_bits_multiplier)))
	if _activity_seen != int(mod.activity_version):
		_activity_seen = int(mod.activity_version)
		_rebuild_activity()
	var ducks: int = mod.actions.duck_count()
	_ducks_button.text = _t("remove_ducks") % ducks
	_ducks_button.disabled = ducks == 0


func _rebuild_effects() -> void:
	for child in _effects_box.get_children():
		child.queue_free()
	var catalog: Array = mod.catalog
	if catalog.is_empty():
		_effects_box.add_child(_label(_t("start_bridge"), 18, COL_DIM))
		return
	var by_group := {}
	for w: Variant in catalog:
		var group := str(w.get("group", ""))
		if not by_group.has(group):
			by_group[group] = []
		by_group[group].append(w)
	var order: Array = GROUPS.keys()
	for group: String in by_group:
		if not order.has(group):
			order.append(group)
	for group: String in order:
		if by_group.has(group):
			_add_effect_group(group, by_group[group])


func _add_effect_group(group: String, effects: Array) -> void:
	var accent: Color = GROUPS.get(group, COL_AMBER)
	var heading := _label(_t("group_" + group) if GROUPS.has(group) else group.to_upper(), 15, accent)
	_effects_box.add_child(heading)
	var grid := GridContainer.new()
	grid.columns = 4
	grid.add_theme_constant_override("h_separation", 8)
	grid.add_theme_constant_override("v_separation", 8)
	_effects_box.add_child(grid)
	for w: Variant in effects:
		var label := str(w.get("label", w.get("id", "?")))
		var button := Button.new()
		button.text = label
		button.custom_minimum_size = Vector2(192.0, 54.0)
		button.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		_style_card(button, accent)
		button.pressed.connect(_on_effect.bind(str(w.get("id", "")), label))
		grid.add_child(button)
	var gap := Control.new()
	gap.custom_minimum_size.y = 6.0
	_effects_box.add_child(gap)


func _rebuild_activity() -> void:
	for child in _activity_box.get_children():
		child.queue_free()
	var rows: Array = mod.activity.filter(func(row: Dictionary) -> bool: return not str(row["label"]).begins_with("dev_"))
	if rows.is_empty():
		_activity_box.add_child(_label(_t("nothing_yet"), 16, COL_DIM))
		return
	for i in range(rows.size() - 1, -1, -1):
		var row: Dictionary = rows[i]
		var failures: Array = row["failures"]
		var line := HBoxContainer.new()
		line.add_theme_constant_override("separation", 12)
		line.add_child(_label(str(row["time"]), 15, COL_DIM))
		line.add_child(_label(str(row["label"]), 16, COL_TEXT))
		line.add_child(_label(str(row["user"]), 16, COL_AMBER))
		if not failures.is_empty():
			line.add_child(_label(_t("failed") % ", ".join(failures), 15, COL_BAD))
		_activity_box.add_child(line)


# ---------------------------------------------------------------- actions
func _on_effect(id: String, label: String) -> void:
	var user := _user_edit.text.strip_edges()
	if mod.fire_workflow(id, user):
		_say(_t("sent") % label, COL_OK)
	else:
		_say(_t("disconnected"), COL_BAD)


func _on_send_message() -> void:
	var seconds: float = MESSAGE_SECONDS[1]
	for i in _seconds_buttons.size():
		if _seconds_buttons[i].button_pressed:
			seconds = MESSAGE_SECONDS[i]
	var color: String = MESSAGE_COLORS[0]
	for i in _color_buttons.size():
		if _color_buttons[i].button_pressed:
			color = MESSAGE_COLORS[i]
	var code: String = await mod.actions.run("message", {
		"author": _author_edit.text, "text": _text_edit.text, "color": color, "seconds": seconds,
	}, {})
	match code:
		"":
			_text_edit.text = ""
			_say(_t("message_sent"), COL_OK)
		"queue_full":
			_say(_t("too_many"), COL_BAD)
		_:
			_say(_t("write_first"), COL_BAD)


func _on_toggle_changed(_pressed: bool, button: Button) -> void:
	_update_toggle_text(button)
	_send_settings()


func _send_settings() -> void:
	var multiplier := float(mod.bridge_bits_multiplier)
	for i in _bits_buttons.size():
		if _bits_buttons[i].button_pressed:
			multiplier = BITS_MULTIPLIERS[i]
	mod.send_bridge_settings(_paused_toggle.button_pressed, _safe_toggle.button_pressed, multiplier)


func _update_toggle_text(button: Button) -> void:
	button.text = _t("on") if button.button_pressed else _t("off")


func _say(text: String, color: Color) -> void:
	_feedback.text = text
	_feedback.add_theme_color_override("font_color", color)


# ---------------------------------------------------------------- building
func _build() -> void:
	var theme_used := Theme.new()
	var font: Font = mod.game_font()
	if font != null:
		theme_used.default_font = font
	# The game's own translations would rewrite any text they recognise ("Effects", "HAY"...).
	auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_backdrop = ColorRect.new()
	_backdrop.color = Color(0.0, 0.0, 0.0, 0.5)
	add_child(_backdrop)
	_window = PanelContainer.new()
	_window.theme = theme_used
	_window.custom_minimum_size = WINDOW_SIZE
	var frame := _box(COL_BG, 14, 0.0)
	frame.set_border_width_all(1)
	frame.border_color = COL_LINE
	frame.shadow_color = Color(0.0, 0.0, 0.0, 0.55)
	frame.shadow_size = 24
	_window.add_theme_stylebox_override("panel", frame)
	add_child(_window)
	var column := VBoxContainer.new()
	column.add_theme_constant_override("separation", 0)
	_window.add_child(column)
	column.add_child(_build_header())
	column.add_child(_line())
	var body := HBoxContainer.new()
	body.size_flags_vertical = Control.SIZE_EXPAND_FILL
	body.add_theme_constant_override("separation", 0)
	column.add_child(body)
	var content := PanelContainer.new()
	content.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	content.add_theme_stylebox_override("panel", _box(Color(0.0, 0.0, 0.0, 0.0), 0, 20.0))
	_pages["effects"] = _build_effects_page()
	_pages["message"] = _build_message_page()
	_pages["activity"] = _build_activity_page()
	_pages["settings"] = _build_settings_page()
	for id: String in _pages:
		content.add_child(_pages[id])
	body.add_child(_build_sidebar())
	body.add_child(content)
	column.add_child(_line())
	column.add_child(_build_footer())
	_stop_game_translation(self)


func _build_header() -> Control:
	var bar := PanelContainer.new()
	bar.add_theme_stylebox_override("panel", _box(Color(0.0, 0.0, 0.0, 0.0), 0, 18.0))
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 14)
	bar.add_child(row)
	row.add_child(_label("TALKY NEEDLE", 30, COL_AMBER))
	var tag := _label(_t("unofficial"), 13, COL_DIM)
	tag.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	row.add_child(tag)
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(spacer)
	_status = _label("", 16, COL_DIM)
	_status.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	row.add_child(_status)
	var close_button := Button.new()
	close_button.text = _t("close")
	_style_card(close_button, COL_LINE)
	close_button.custom_minimum_size = Vector2(130.0, 40.0)
	close_button.pressed.connect(close)
	row.add_child(close_button)
	return bar


func _build_sidebar() -> Control:
	var side := PanelContainer.new()
	side.custom_minimum_size.x = 170.0
	side.add_theme_stylebox_override("panel", _box(Color(1.0, 1.0, 1.0, 0.025), 0, 12.0))
	var column := VBoxContainer.new()
	column.add_theme_constant_override("separation", 6)
	side.add_child(column)
	var group := ButtonGroup.new()
	for tab: String in TABS:
		var button := Button.new()
		button.text = _t("tab_" + tab)
		button.toggle_mode = true
		button.button_group = group
		button.alignment = HORIZONTAL_ALIGNMENT_LEFT
		button.custom_minimum_size.y = 46.0
		button.focus_mode = Control.FOCUS_NONE
		button.add_theme_font_size_override("font_size", 19)
		button.add_theme_color_override("font_color", COL_DIM)
		button.add_theme_color_override("font_hover_color", COL_TEXT)
		button.add_theme_color_override("font_pressed_color", COL_AMBER)
		button.add_theme_color_override("font_hover_pressed_color", COL_AMBER)
		button.add_theme_stylebox_override("normal", _box(Color(0.0, 0.0, 0.0, 0.0), 8, 12.0))
		button.add_theme_stylebox_override("hover", _box(COL_CARD, 8, 12.0))
		var selected := _box(COL_CARD_HOVER, 8, 12.0)
		selected.border_width_left = 4
		selected.border_color = COL_ORANGE
		button.add_theme_stylebox_override("pressed", selected)
		button.add_theme_stylebox_override("hover_pressed", selected)
		button.pressed.connect(select_tab.bind(tab))
		_tab_buttons[tab] = button
		column.add_child(button)
	return side


func _build_footer() -> Control:
	var bar := PanelContainer.new()
	bar.add_theme_stylebox_override("panel", _box(Color(0.0, 0.0, 0.0, 0.0), 0, 12.0))
	var row := HBoxContainer.new()
	bar.add_child(row)
	row.add_child(_label(_t("footer"), 14, COL_DIM))
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(spacer)
	_feedback = _label("", 15, COL_OK)
	row.add_child(_feedback)
	return bar


func _build_effects_page() -> Control:
	var page := VBoxContainer.new()
	page.add_theme_constant_override("separation", 12)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 10)
	page.add_child(row)
	var caption := _label(_t("name_caption"), 16, COL_DIM)
	row.add_child(caption)
	_user_edit = _field("Viewer", 260.0)
	_user_edit.text = "Viewer"
	row.add_child(_user_edit)
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	page.add_child(scroll)
	_effects_box = VBoxContainer.new()
	_effects_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_effects_box.add_theme_constant_override("separation", 8)
	scroll.add_child(_effects_box)
	return page


func _build_message_page() -> Control:
	var page := VBoxContainer.new()
	page.add_theme_constant_override("separation", 12)
	page.add_child(_label(_t("author"), 16, COL_DIM))
	_author_edit = _field(_t("optional"), 380.0)
	_author_edit.max_length = 40
	page.add_child(_author_edit)
	page.add_child(_label(_t("message_caption"), 16, COL_DIM))
	_text_edit = TextEdit.new()
	_text_edit.custom_minimum_size = Vector2(0.0, 150.0)
	_text_edit.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	_text_edit.add_theme_font_size_override("font_size", 22)
	_text_edit.add_theme_color_override("font_color", COL_TEXT)
	_text_edit.add_theme_color_override("caret_color", COL_AMBER)
	_text_edit.add_theme_stylebox_override("normal", _box(COL_FIELD, 8, 12.0))
	_text_edit.add_theme_stylebox_override("focus", _box(COL_FIELD, 8, 12.0))
	page.add_child(_text_edit)
	page.add_child(_label(_t("color"), 16, COL_DIM))
	var colors := HBoxContainer.new()
	colors.add_theme_constant_override("separation", 8)
	page.add_child(colors)
	var color_group := ButtonGroup.new()
	for hex: String in MESSAGE_COLORS:
		var swatch := _choice_button("", color_group, Color.html(hex))
		swatch.custom_minimum_size = Vector2(54.0, 38.0)
		swatch.set_pressed_no_signal(hex == MESSAGE_COLORS[0])
		colors.add_child(swatch)
		_color_buttons.append(swatch)
	page.add_child(_label(_t("duration"), 16, COL_DIM))
	var durations := HBoxContainer.new()
	durations.add_theme_constant_override("separation", 8)
	page.add_child(durations)
	var seconds_group := ButtonGroup.new()
	for s: float in MESSAGE_SECONDS:
		var choice := _choice_button("%d s" % int(s), seconds_group, COL_CARD_HOVER)
		choice.custom_minimum_size = Vector2(70.0, 38.0)
		choice.set_pressed_no_signal(s == MESSAGE_SECONDS[1])
		durations.add_child(choice)
		_seconds_buttons.append(choice)
	var spacer := Control.new()
	spacer.size_flags_vertical = Control.SIZE_EXPAND_FILL
	page.add_child(spacer)
	var send := Button.new()
	send.text = _t("send")
	send.custom_minimum_size = Vector2(280.0, 52.0)
	send.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	send.focus_mode = Control.FOCUS_NONE
	send.add_theme_font_size_override("font_size", 19)
	send.add_theme_color_override("font_color", Color(0.08, 0.06, 0.02))
	send.add_theme_color_override("font_hover_color", Color(0.08, 0.06, 0.02))
	send.add_theme_color_override("font_pressed_color", Color(0.08, 0.06, 0.02))
	send.add_theme_stylebox_override("normal", _box(COL_ORANGE, 8, 10.0))
	send.add_theme_stylebox_override("hover", _box(COL_AMBER, 8, 10.0))
	send.add_theme_stylebox_override("pressed", _box(COL_AMBER, 8, 10.0))
	send.pressed.connect(_on_send_message)
	page.add_child(send)
	return page


func _build_activity_page() -> Control:
	var page := VBoxContainer.new()
	page.add_theme_constant_override("separation", 12)
	_ducks_button = Button.new()
	_ducks_button.custom_minimum_size = Vector2(300.0, 46.0)
	_ducks_button.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_style_card(_ducks_button, GROUPS["ducks"])
	_ducks_button.pressed.connect(func() -> void: mod.actions.clear_ducks())
	page.add_child(_ducks_button)
	page.add_child(_label(_t("latest"), 15, COL_DIM))
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	page.add_child(scroll)
	_activity_box = VBoxContainer.new()
	_activity_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_activity_box.add_theme_constant_override("separation", 6)
	scroll.add_child(_activity_box)
	return page


func _build_settings_page() -> Control:
	var page := VBoxContainer.new()
	page.add_theme_constant_override("separation", 16)
	_paused_toggle = _setting_row(page, _t("pause_title"), _t("pause_detail"))
	_safe_toggle = _setting_row(page, _t("safe_title"), _t("safe_detail"))
	_build_bits_row(page)
	page.add_child(_label(_t("session_note"), 15, COL_DIM))
	var spacer := Control.new()
	spacer.size_flags_vertical = Control.SIZE_EXPAND_FILL
	page.add_child(spacer)
	page.add_child(_label(_t("about") % mod.VERSION, 14, COL_DIM))
	return page


func _build_bits_row(page: Control) -> void:
	var card := PanelContainer.new()
	card.add_theme_stylebox_override("panel", _box(COL_CARD, 10, 16.0))
	page.add_child(card)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	card.add_child(row)
	var texts := VBoxContainer.new()
	texts.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(texts)
	texts.add_child(_label(_t("bits_title"), 20, COL_TEXT))
	texts.add_child(_label(_t("bits_detail"), 15, COL_DIM))
	var group := ButtonGroup.new()
	for value: float in BITS_MULTIPLIERS:
		var choice := _choice_button("x%d" % int(value), group, COL_FIELD)
		choice.custom_minimum_size = Vector2(56.0, 42.0)
		choice.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		choice.pressed.connect(_send_settings)
		row.add_child(choice)
		_bits_buttons.append(choice)


func _setting_row(page: Control, title: String, detail: String) -> Button:
	var card := PanelContainer.new()
	card.add_theme_stylebox_override("panel", _box(COL_CARD, 10, 16.0))
	page.add_child(card)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 16)
	card.add_child(row)
	var texts := VBoxContainer.new()
	texts.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(texts)
	texts.add_child(_label(title, 20, COL_TEXT))
	texts.add_child(_label(detail, 15, COL_DIM))
	var toggle_button := Button.new()
	toggle_button.toggle_mode = true
	toggle_button.custom_minimum_size = Vector2(130.0, 42.0)
	toggle_button.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	toggle_button.focus_mode = Control.FOCUS_NONE
	toggle_button.add_theme_color_override("font_color", COL_DIM)
	toggle_button.add_theme_color_override("font_hover_color", COL_TEXT)
	toggle_button.add_theme_color_override("font_pressed_color", Color(0.08, 0.06, 0.02))
	toggle_button.add_theme_color_override("font_hover_pressed_color", Color(0.08, 0.06, 0.02))
	toggle_button.add_theme_stylebox_override("normal", _box(COL_FIELD, 8, 8.0))
	toggle_button.add_theme_stylebox_override("hover", _box(COL_CARD_HOVER, 8, 8.0))
	toggle_button.add_theme_stylebox_override("pressed", _box(COL_ORANGE, 8, 8.0))
	toggle_button.add_theme_stylebox_override("hover_pressed", _box(COL_AMBER, 8, 8.0))
	toggle_button.toggled.connect(_on_toggle_changed.bind(toggle_button))
	_update_toggle_text(toggle_button)
	row.add_child(toggle_button)
	return toggle_button


# ---------------------------------------------------------------- small pieces
func _stop_game_translation(node: Node) -> void:
	node.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	for child in node.get_children():
		_stop_game_translation(child)


func _t(key: String) -> String:
	return mod.i18n.t(key)


func _label(text: String, size_px: int, color: Color) -> Label:
	var label := Label.new()
	label.text = text
	label.add_theme_font_size_override("font_size", size_px)
	label.add_theme_color_override("font_color", color)
	return label


func _line() -> ColorRect:
	var line := ColorRect.new()
	line.color = COL_LINE
	line.custom_minimum_size.y = 1.0
	return line


func _box(color: Color, radius: int, margin: float) -> StyleBoxFlat:
	var box := StyleBoxFlat.new()
	box.bg_color = color
	box.set_corner_radius_all(radius)
	box.set_content_margin_all(margin)
	return box


func _field(placeholder: String, width: float) -> LineEdit:
	var edit := LineEdit.new()
	edit.placeholder_text = placeholder
	edit.custom_minimum_size = Vector2(width, 42.0)
	edit.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	edit.add_theme_font_size_override("font_size", 19)
	edit.add_theme_color_override("font_color", COL_TEXT)
	edit.add_theme_color_override("caret_color", COL_AMBER)
	edit.add_theme_stylebox_override("normal", _box(COL_FIELD, 8, 10.0))
	edit.add_theme_stylebox_override("focus", _box(COL_FIELD, 8, 10.0))
	return edit


func _style_card(button: Button, accent: Color) -> void:
	button.focus_mode = Control.FOCUS_NONE
	button.add_theme_font_size_override("font_size", 18)
	button.add_theme_color_override("font_color", COL_TEXT)
	button.add_theme_color_override("font_hover_color", Color.WHITE)
	button.add_theme_color_override("font_pressed_color", accent)
	button.add_theme_color_override("font_disabled_color", COL_DIM)
	var normal := _box(COL_CARD, 8, 8.0)
	normal.border_width_left = 4
	normal.border_color = accent
	var hover := _box(COL_CARD_HOVER, 8, 8.0)
	hover.set_border_width_all(1)
	hover.border_width_left = 4
	hover.border_color = accent
	var pressed_box := _box(COL_FIELD, 8, 8.0)
	pressed_box.set_border_width_all(1)
	pressed_box.border_width_left = 4
	pressed_box.border_color = accent
	button.add_theme_stylebox_override("normal", normal)
	button.add_theme_stylebox_override("hover", hover)
	button.add_theme_stylebox_override("pressed", pressed_box)
	button.add_theme_stylebox_override("disabled", _box(COL_FIELD, 8, 8.0))


func _choice_button(text: String, group: ButtonGroup, color: Color) -> Button:
	var button := Button.new()
	button.text = text
	button.toggle_mode = true
	button.button_group = group
	button.focus_mode = Control.FOCUS_NONE
	button.add_theme_font_size_override("font_size", 17)
	button.add_theme_color_override("font_color", COL_TEXT)
	button.add_theme_color_override("font_pressed_color", COL_AMBER)
	button.add_theme_color_override("font_hover_color", Color.WHITE)
	var normal := _box(color, 8, 6.0)
	var chosen := _box(color, 8, 6.0)
	chosen.set_border_width_all(3)
	chosen.border_color = COL_TEXT
	button.add_theme_stylebox_override("normal", normal)
	button.add_theme_stylebox_override("hover", normal)
	button.add_theme_stylebox_override("pressed", chosen)
	button.add_theme_stylebox_override("hover_pressed", chosen)
	return button
