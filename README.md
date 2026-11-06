# Talky Needle: LibertyTalk live events in Find The Needle

[Version française](README.fr.md)

**Unofficial mod**, not affiliated with the game's developer, used at your own risk. It requires the full game and stays free, as the game's licence asks (`NOTICE.txt`).

**Status: version 0.2, tested in single player on Find The Needle EA V12.** The menu follows the game's language (French or English). Example workflows are in French when Windows is French on the bridge's first start, in English otherwise.

Talky Needle follows the idea of [Talky for Project Zomboid](https://github.com/Tech-Liberty/talky-project-zomboid): a follow, bits or a raid run a workflow in your game, and the game sends its own events back ("needle found").

```
LibertyTalk -HTTPS-> tunnel -> bridge.js (workflows) <-local TCP-> GDScript mod in the game
```

Full guide: [liberty-talk.com/guides/find-the-needle-talky](https://liberty-talk.com/guides/find-the-needle-talky)

## How the mod hooks into the game

The game runs on Godot 4.7. Like the other mods on Nexus, Talky Needle uses no loader: an `[autoload]` line in `override.cfg` loads a script from `mods/`, next to the executable. **The game's `.pck` is left alone: the mod does not read, decrypt or decompile it.**

The hooks (`GameState`, `hud.show_toast`, `live.spawn`...) come from [AleDev11's open source co-op mod](https://github.com/AleDev11/FindTheNeedle-Coop-Mod), written for an older demo. They can change: each time a game loads, the bridge reports the missing ones.

## Install

1. Run `start-bridge.cmd`. On first start, the token goes to the clipboard and is never shown.
2. Back up your saves, close the game, then run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File tools\install.ps1
   ```
3. Load a game. The "unofficial mod active" banner appears and the bridge prints `game connected`.
4. Press **F8**, or test without LibertyTalk:
   ```powershell
   cd bridge
   node bridge.js fire new_follower user=Bob
   ```

To uninstall: `tools\install.ps1 -Uninstall`. A game update can replace `override.cfg`: run the install again.

**Before you install:**

- The game detects mods at startup and takes the run off the leaderboards (`this game is off the boards`). This may last after you uninstall.
- Added hay and effects can change the state of the game. Test on a separate game.

## Connect LibertyTalk

The bridge follows Talky's contract: `POST /hooks/<id>` with the `X-Bridge-Token` header, and the same ids (`follow`, `sub`, `gift`, `bits`, `raid`, `points`, `command`, `donation`, `superchat`, `member`).

1. Expose the bridge: `cloudflared tunnel --url http://127.0.0.1:7421`.
2. In LibertyTalk, install the widget (see the guide), or create **Webhook / API call** workflows to `<tunnel address>/hooks/<id>`.

## The in-game window (F8)

`F8` opens the menu, `F8` or `Esc` closes it, in a loaded game.

- **Effects**: runs the workflows that have a `menu` entry in `bridge\config.json` (`label`, `group` and `payload` for test values). The chosen name replaces the viewer's.
- **Message**: writes a message on screen, with its colour and duration.
- **Activity**: the latest events that ran, and removing the ducks.
- **Settings**: pausing viewer events, safe mode and the bits multiplier, until the bridge restarts.

The window shows no token and no address: it can stay on screen while you stream.

## Show a message

```powershell
node bridge\bridge.js fire message "text=Hello chat" user=Bob
```

From LibertyTalk: `POST /hooks/message` with `user_name` and `text` (or `message`). The text is displayed as is, on your stream: only connect text you control or that is moderated.

## In-game actions

| Action | Parameters | Effect |
|---|---|---|
| `notify` | `text`, `seconds`, `color` | On-screen banner. Without `color`, uses the game's banner |
| `message` | `text` (200 characters), `author`, `seconds`, `color` | Message panel. Messages show one after the other (20 waiting at most) |
| `wait` | `seconds` | Pause in the job (stops while the game is paused) |
| `hay_rain` | `count` (100,000 max), `on` (`pile` or `player`), `radius`, `height` | Hay falls on the pile or around the player. At most 300 straws fall: on the pile, the rest goes straight to the pile and the counter |
| `gust` | `strength`, `radius` | A gust on nearby loose hay |
| `magnet` / `levitate` | `seconds` (30 max), `radius`, `speed` | Loose hay rushes at the player, or floats up |
| `duck` | `name`, `size` (8 max), `count` (30 max), `seconds`, `on` | Rubber duck named after the viewer. 40 at the same time at most |
| `clear_ducks` | | Removes all ducks. Also with `F9`, or the button at the top right when the cursor is free (pause menu) |
| `yeet` | `force` (30 max) | Throws the player into the air |
| `spin` | `turns`, `seconds` | Spins the player's view |
| `drunk` / `upside_down` / `quake_pro` | `seconds` (30 max) | Drunk camera, upside-down screen, extreme field of view |
| `blackout` | `seconds` (10 max), `text` | Black screen with a text |
| `sound` | `name` (`fart`, `quack`, `beep`), `pitch`, `volume` | Sound synthesised by the mod |

Needles never move. Workflows live in `bridge\config.json`, with Talky's syntax (`when`, `if`, `random`, `repeat`, filters such as `{{bits | div:100 | floor}}`). Channel point rewards are routed by their title: `hay`, `duck`, `fart`, `needle` (fake detector alert), `launch`, `magnet`, `levitat`, `drunk`, `upside`, `zoom`, `spin`, `blackout` or `wind`. On a French system, the words are French: see `README.fr.md`.

## Bits multiplier

`bitsMultiplier` in `settings` of `bridge\config.json` (10 by default) multiplies bits: at x10, 500 bits add 5000 straws. The buttons in F8 > Settings change it until the bridge restarts. Workflows read the result in `{{bitsMultiplied}}`, capped at 5000 in the `bits` workflow.

## Limit abuse

In `settings` of `bridge\config.json`:

- `maxJobsPerMinute`: ceiling on viewer events per minute;
- `blockedActions`: actions that are always off;
- `safeMode`: cuts `safeModeBlocks` (the effects on the player and the camera by default), for long sessions.

Each workflow also accepts `cooldownSeconds`, `userCooldownSeconds` and `chance`. A job waiting longer than `jobTtlSeconds` is dropped: a game started late does not receive 40 deliveries at once.

## Game events

`gameEvents` links an event to workflows: `needle_found`, `needle_discovered`, `pile_replaced`. To tell LibertyTalk when a needle is found, fill in the `lt_report` target of `httpTargets` and enable the `report_to_libertytalk` workflow.

## Development

```powershell
cd bridge
node --test test/
```

To adjust the window without restarting the game: copy `tn_menu.gd` into the game folder, then `fire dev_reload`. `fire dev_shot` saves a capture of what the game shows to `talky_needle_shot.png`, in its user data.

## Licence

MIT. `bridge/lib/engine.js`, `bridge/lib/hosts.js` and `bridge/lib/examples.js` come from Talky. No game content is included.
