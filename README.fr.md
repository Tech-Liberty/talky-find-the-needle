# Talky Needle : les événements live de LibertyTalk dans Find The Needle

[English version](README.md)

**Mod non officiel**, sans lien avec le développeur du jeu, utilisé à vos risques. Il nécessite le jeu complet et reste gratuit, comme le demande la licence du jeu (`NOTICE.txt`).

**État : version 0.2, testée en solo sur Find The Needle EA V12.** Le menu suit la langue du jeu (français ou anglais). Les workflows d'exemple sont en français si Windows l'est au premier lancement du bridge.

Talky Needle reprend l'idée de [Talky](../Talky) : un follow, des bits ou un raid lancent un workflow dans la partie, et le jeu renvoie ses événements (« aiguille trouvée »).

```
LibertyTalk ─HTTPS→ tunnel → bridge.js (workflows) ⇄ TCP local ⇄ mod GDScript dans le jeu
```

## Comment le mod s'accroche au jeu

Le jeu tourne sous Godot 4.7. Comme les autres mods Nexus, Talky Needle n'utilise aucun loader : une ligne `[autoload]` dans `override.cfg` charge un script depuis `mods/`, à côté de l'exécutable. **Le `.pck` du jeu reste intact : le mod ne le lit pas, ne le déchiffre pas et ne le décompile pas.**

Les points d'accroche (`GameState`, `hud.show_toast`, `live.spawn`...) viennent du [mod coop open source d'AleDev11](https://github.com/AleDev11/FindTheNeedle-Coop-Mod), écrit pour une ancienne version de la démo. Ils ont pu changer : à chaque chargement d'une partie, le bridge indique ceux qui manquent.

## Installation

1. Lancez `start-bridge.cmd`. Au premier lancement, le jeton est copié dans le presse-papiers sans jamais s'afficher.
2. Sauvegardez vos parties, fermez le jeu, puis lancez :
   ```powershell
   powershell -ExecutionPolicy Bypass -File tools\install.ps1
   ```
3. Chargez une partie. Le bandeau « mod non officiel actif » s'affiche et le bridge écrit `game connected`.
4. Testez sans LibertyTalk :
   ```powershell
   cd bridge
   node bridge.js fire new_follower user=Bob
   ```

Pour désinstaller : `tools\install.ps1 -Uninstall`. Une mise à jour du jeu peut remplacer `override.cfg` : relancez alors l'installation.

**À savoir avant d'installer :**

- Le jeu détecte les mods au lancement et écrit dans son log que la partie sort des classements (`this game is off the boards`). Cette exclusion pourrait durer après la désinstallation.
- Le foin ajouté et les effets peuvent changer l'état de la partie. Testez sur une partie à part.

## Brancher LibertyTalk

Le bridge reprend le contrat de Talky : `POST /hooks/<id>` avec l'en-tête `X-Bridge-Token`, et les mêmes identifiants (`follow`, `sub`, `gift`, `bits`, `raid`, `points`, `command`, `donation`, `superchat`, `member`).

1. Exposez le bridge : `cloudflared tunnel --url http://127.0.0.1:7421`.
2. Dans LibertyTalk, créez des workflows **Appel webhook / API** vers `<adresse du tunnel>/hooks/<id>`. Les champs à envoyer sont dans le README de Talky. Le widget « Project Zomboid · Talky » devrait aussi fonctionner en y collant cette adresse et ce jeton, mais cela reste à vérifier.

## Actions en jeu

| Action | Paramètres | Effet |
|---|---|---|
| `notify` | `text`, `seconds`, `color` | Message à l'écran. Sans `color`, utilise le bandeau du jeu |
| `message` | `text` (200 caractères), `author`, `seconds`, `color` | Panneau de message. Les messages passent l'un après l'autre (20 en attente au plus) |
| `wait` | `seconds` | Pause dans le job (s'arrête quand le jeu est en pause) |
| `hay_rain` | `count` (100 000 max), `on` (`pile` ou `player`), `radius`, `height` | Du foin tombe sur le tas, ou autour du joueur. 300 brins tombent au plus : sur le tas, le reste s'ajoute directement au tas et au compteur |
| `gust` | `strength`, `radius` | Coup de vent sur le foin libre proche |
| `magnet` / `levitate` | `seconds` (30 max), `radius`, `speed` | Le foin libre fonce sur le joueur ou s'envole |
| `duck` | `name`, `size` (8 max), `count` (30 max), `seconds`, `on` | Canard en plastique au nom du viewer. 40 en même temps au plus |
| `clear_ducks` | | Supprime tous les canards. Aussi avec `F9`, ou le bouton affiché en haut à droite quand le curseur est libre (menu pause) |
| `yeet` | `force` (30 max) | Envoie le joueur en l'air |
| `spin` | `turns`, `seconds` | Fait tourner la vue du joueur |
| `drunk` / `upside_down` / `quake_pro` | `seconds` (30 max) | Caméra ivre, écran à l'envers, champ de vision extrême |
| `blackout` | `seconds` (10 max), `text` | Écran noir avec un texte |
| `sound` | `name` (`fart`, `quack`, `beep`), `pitch`, `volume` | Son synthétisé par le mod |

Les aiguilles ne sont jamais déplacées. Les workflows se règlent dans `bridge\config.json`, avec la même syntaxe que Talky (`when`, `if`, `random`, `repeat`, filtres `{{bits | div:100 | floor}}`). Les récompenses de points sont routées d'après leur titre : `foin`, `canard`, `prout`, `aiguille` (fausse alerte du détecteur), `éjecte`, `aimant`, `lévitation`, `bourré`, `envers`, `zoom`, `toupie`, `panne` ou `vent`.

## La fenêtre en jeu (F8)

`F8` ouvre le menu, `F8` ou `Échap` le ferme, dans une partie chargée.

- **Effets** : déclenche les workflows qui ont une entrée `menu` dans `bridgeconfig.json` (`label`, `group`, et `payload` pour les valeurs de test). Le pseudo choisi remplace celui du viewer.
- **Message** : écrit un message à l'écran, avec sa couleur et sa durée.
- **Activité** : les derniers événements exécutés, et la suppression des canards.
- **Réglages** : pause des événements viewers et mode safe, jusqu'au redémarrage du bridge.

La fenêtre n'affiche ni jeton ni adresse : elle peut rester à l'écran pendant un stream.

## Afficher un message

```powershell
node bridgeridge.js fire message "text=Bonjour le chat" user=Bob
```

Depuis LibertyTalk : `POST /hooks/message` avec `user_name` et `text` (ou `message`). Le texte s'affiche tel quel à l'écran, donc sur le stream : ne branchez dessus que du texte que vous contrôlez ou qui est modéré.

## Multiplicateur de bits

`bitsMultiplier` dans `settings` de `bridgeconfig.json` (10 par défaut) multiplie les bits : à ×10, 500 bits ajoutent 5000 brins. Les boutons de F8 > Réglages le changent jusqu'au redémarrage du bridge. Les workflows lisent le résultat dans `{{bitsMultiplied}}`, plafonné à 5000 dans le workflow `bits`.

## Limiter les abus

Dans `settings` de `bridge\config.json` :

- `maxJobsPerMinute` : plafond des événements viewers par minute ;
- `blockedActions` : actions toujours désactivées ;
- `safeMode` : coupe `safeModeBlocks` (les effets sur le joueur et la caméra par défaut), pour les longues sessions.

Chaque workflow accepte aussi `cooldownSeconds`, `userCooldownSeconds` et `chance`. Un job qui attend plus de `jobTtlSeconds` est abandonné : une partie lancée en retard ne reçoit pas 40 livraisons d'un coup.

## Événements du jeu

`gameEvents` associe un événement à des workflows : `needle_found`, `needle_discovered`, `pile_replaced`. Pour prévenir LibertyTalk quand une aiguille est trouvée, remplissez la cible `lt_report` de `httpTargets` et activez le workflow `report_to_libertytalk`.

## Pas encore fait

Vraie aiguille-leurre pour le détecteur, drones au nom des abonnés, vraie panne des machines, votes sur l'arbre techno, paris sur la grille, overlay. Ces idées demandent d'abord de voir comment le jeu complet se comporte.

## Développement

```powershell
cd bridge
node --test test/
```

Pour retoucher la fenêtre sans relancer le jeu : copiez `tn_menu.gd` dans le dossier du jeu, puis `fire dev_reload`. `fire dev_shot` enregistre une capture de ce que montre le jeu dans `talky_needle_shot.png`, dans ses données utilisateur.

## Licence

MIT. `bridge/lib/engine.js` et `bridge/lib/hosts.js` viennent de Talky. Le contenu du jeu n'est pas inclus.
