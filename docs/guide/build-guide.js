#!/usr/bin/env node
// Builds find-the-needle-talky.json, in the format of LibertyTalk's guide seeders
// (api/database/seeders/guides). Text lives here as [fr, en] pairs to keep both languages side by side.
//   node docs/guide/build-guide.js [downloadUrl]

'use strict';

const fs = require('fs');
const path = require('path');

const DOWNLOAD_URL = process.argv[2] || '';
const L = (fr, en) => ({ fr, en });
const part = (id, fr, en, sfr, sen) => ({ id, type: 'part', title: L(fr, en), summary: L(sfr, sen) });
const h2 = (id, fr, en) => ({ id, type: 'heading', level: 2, text: L(fr, en) });
const p = (id, fr, en) => ({ id, type: 'paragraph', text: L(fr, en) });
const code = (id, language, text, cfr, cen) => ({
  id, type: 'code', language, code: text, ...(cfr ? { caption: L(cfr, cen) } : {}),
});
const callout = (id, kind, tfr, ten, fr, en) => ({ id, type: 'callout', kind, title: L(tfr, ten), text: L(fr, en) });
const capture = (id, fr, en) => callout(id, 'info', 'Capture à ajouter', 'Screenshot to add', fr, en);
const steps = (id, items) => ({ id, type: 'steps', items: items.map(([tf, te, f, e]) => ({ title: L(tf, te), text: L(f, e) })) });
const list = (id, items) => ({ id, type: 'list', ordered: false, items: items.map(([f, e]) => L(f, e)) });
const table = (id, head, rows) => ({
  id, type: 'table',
  head: head.map(([f, e]) => L(f, e)),
  rows: rows.map((r) => r.map((c) => (Array.isArray(c) ? L(c[0], c[1]) : L(c, c)))),
});

const blocks = [
  p('intro-what',
    "Talky Needle relie vos événements Twitch et YouTube à votre partie de Find The Needle. Quand Bob suit votre chaîne, un canard en plastique portant le nom « Bob » tombe sur votre tas de foin. Un raid déclenche une avalanche de foin et vous envoie en l'air. Une récompense de points de chaîne peut faire biper votre détecteur jusqu'à « AIGUILLE TROUVÉE ! », avant de révéler que c'était faux.",
    'Talky Needle connects your Twitch and YouTube events to your Find The Needle game. When Bob follows your channel, a rubber duck named "Bob" falls on your hay pile. A raid triggers a hay avalanche and throws you into the air. A channel points reward can make your detector beep up to "NEEDLE FOUND!" before revealing it was a fake.'),
  {
    id: 'intro-flow', type: 'flow',
    steps: [
      { kind: 'trigger', label: L('Follow sur Twitch', 'Twitch follow'), detail: L('Bob suit votre chaîne.', 'Bob follows your channel.') },
      { kind: 'action', label: L('Widget LibertyTalk', 'LibertyTalk widget'), detail: L('Envoie `{"user_name":"Bob"}` au pont, à travers le tunnel.', 'Sends `{"user_name":"Bob"}` to the bridge, through the tunnel.') },
      { kind: 'external', label: L('Pont sur votre PC', 'Bridge on your PC'), detail: L('Lance le workflow `new_follower`.', 'Runs the `new_follower` workflow.') },
      { kind: 'external', label: L('Mod dans le jeu', 'Mod in the game'), detail: L('Fait tomber le canard « Bob ».', 'Drops the "Bob" duck.') },
    ],
  },
  callout('intro-unofficial', 'warning', 'Mod non officiel', 'Unofficial mod',
    "Talky Needle est un mod non officiel, sans lien avec le développeur de Find The Needle, et vous l'utilisez à vos risques. Il demande le jeu complet. Le jeu détecte les mods au lancement et sort la partie des classements en ligne. Cette exclusion peut durer après la désinstallation. Le mod ne lit ni ne modifie le fichier `.pck` du jeu.",
    'Talky Needle is an unofficial mod, not affiliated with the developer of Find The Needle, and you use it at your own risk. It requires the full game. The game detects mods at startup and takes the run off the online leaderboards. This exclusion may last after you uninstall. The mod neither reads nor changes the game\'s `.pck` file.'),
  callout('intro-tested', 'info', 'Version testée', 'Tested version',
    "Talky Needle 0.2.0 a été lancé sur Find The Needle EA V12, en solo et sur Windows 11. Une mise à jour du jeu peut déplacer ce que le mod utilise : le pont écrit alors `warning: hooks missing` au chargement d'une partie.",
    'Talky Needle 0.2.0 was run on Find The Needle EA V12, in single player, on Windows 11. A game update can move what the mod relies on: the bridge then prints `warning: hooks missing` when a game loads.'),

  part('part-1-enable', 'Activer Talky Needle dans le jeu', 'Turn on Talky Needle in the game',
    'Installer le mod et le pont, tester depuis le menu F8, ouvrir le tunnel, puis relier LibertyTalk.',
    'Install the mod and the bridge, test from the F8 menu, open the tunnel, then connect LibertyTalk.'),

  h2('p1-need', "Ce qu'il vous faut", 'What you need'),
  list('p1-need-list', [
    ['Windows 10 ou 11.', 'Windows 10 or 11.'],
    ['Find The Needle, le jeu complet sur Steam. La démo ne fonctionne pas : le mod se désactive.', 'Find The Needle, the full game on Steam. The demo does not work: the mod turns itself off.'],
    ['Node.js 18 ou plus récent, pour le pont.', 'Node.js 18 or later, for the bridge.'],
    ['cloudflared, pour donner une adresse publique au pont.', 'cloudflared, to give the bridge a public address.'],
    ['Un compte LibertyTalk avec Twitch ou YouTube connecté.', 'A LibertyTalk account with Twitch or YouTube connected.'],
  ]),
  code('p1-need-code', 'powershell', 'winget install OpenJS.NodeJS.LTS\nwinget install --id Cloudflare.cloudflared',
    'Fermez puis rouvrez le terminal après ces installations pour que `node` et `cloudflared` soient reconnus.',
    'Close and reopen the terminal after installing, so that `node` and `cloudflared` are recognised.'),

  h2('p1-get', 'Récupérer Talky Needle', 'Get Talky Needle'),
  {
    id: 'p1-get-links', type: 'links',
    items: [
      { label: L('Télécharger Talky Needle', 'Download Talky Needle'), url: DOWNLOAD_URL, kind: 'github', description: L('Le fichier `TalkyNeedle-0.2.0.zip`, avec le mod, le pont et les scripts.', 'The `TalkyNeedle-0.2.0.zip` file, with the mod, the bridge and the scripts.') },
      { label: L('Node.js', 'Node.js'), url: 'https://nodejs.org', kind: 'external' },
      { label: L('cloudflared', 'cloudflared'), url: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/', kind: 'external' },
    ],
  },

  h2('p1-install', 'Installer', 'Install'),
  steps('p1-install-steps', [
    ['Extrayez le zip dans un dossier que vous gardez', 'Extract the zip to a folder you keep',
      "Par exemple `Documents\\TalkyNeedle`. Le pont et sa configuration restent dans ce dossier, pas dans celui du jeu.",
      'For example `Documents\\TalkyNeedle`. The bridge and its settings stay in this folder, not in the game folder.'],
    ['Fermez le jeu et sauvegardez vos parties', 'Close the game and back up your saves',
      'Vos parties se trouvent dans `%APPDATA%\\Godot\\app_userdata\\FindTheNeedle\\saves`. Copiez ce dossier ailleurs avant de continuer.',
      'Your saves are in `%APPDATA%\\Godot\\app_userdata\\FindTheNeedle\\saves`. Copy this folder elsewhere before you continue.'],
    ['Lancez le script d\'installation', 'Run the install script',
      'Ouvrez un terminal PowerShell dans le dossier `TalkyNeedle` et lancez la commande ci-dessous. Le script copie `mods\\talky_needle` à côté de `FindTheNeedle.exe` et ajoute une ligne `TalkyNeedle` dans `override.cfg`. Il garde une copie de ce fichier sous le nom `override.cfg.talky-needle.bak`.',
      'Open a PowerShell terminal in the `TalkyNeedle` folder and run the command below. The script copies `mods\\talky_needle` next to `FindTheNeedle.exe` and adds a `TalkyNeedle` line to `override.cfg`. It keeps a copy of this file as `override.cfg.talky-needle.bak`.'],
  ]),
  code('p1-install-code', 'powershell', 'powershell -ExecutionPolicy Bypass -File tools\\install.ps1',
    'Le script cherche le jeu dans le dossier Steam par défaut, `steamapps\\common\\Needle in a Haystack`. Si votre bibliothèque est ailleurs, ajoutez `-GameDir "D:\\SteamLibrary\\steamapps\\common\\Needle in a Haystack"`.',
    'The script looks for the game in the default Steam folder, `steamapps\\common\\Needle in a Haystack`. If your library is elsewhere, add `-GameDir "D:\\SteamLibrary\\steamapps\\common\\Needle in a Haystack"`.'),
  callout('p1-install-update', 'warning', 'Après une mise à jour du jeu', 'After a game update',
    "Une mise à jour peut remplacer `override.cfg`. Si le mod ne se charge plus, relancez la même commande.",
    'An update can replace `override.cfg`. If the mod no longer loads, run the same command again.'),

  h2('p1-bridge', 'Lancer le pont', 'Start the bridge'),
  p('p1-bridge-text',
    "Double-cliquez sur `start-bridge.cmd` et laissez la fenêtre ouverte pendant que vous jouez. Le pont ne reçoit des appels que sur votre PC, à l'adresse `http://127.0.0.1:7421`. Au premier lancement, il crée `bridge\\config.json` avec un jeton aléatoire et copie ce jeton dans le presse-papiers sans jamais l'afficher, pour qu'il reste hors du stream.",
    'Double-click `start-bridge.cmd` and leave the window open while you play. The bridge only receives calls on your PC, at `http://127.0.0.1:7421`. On first start, it creates `bridge\\config.json` with a random token and copies the token to the clipboard without ever showing it, so it stays off your stream.'),
  code('p1-bridge-code', 'text', 'created config.json with a random token, copied to your clipboard; never shown here\nTalky Needle bridge 0.2.0 (unofficial): webhooks on http://127.0.0.1:7421, game link on port 7422\n10 webhook(s), 24 workflow(s), waiting for the game...',
    'Ce que le pont affiche au premier lancement, précédé de l\'heure.',
    'What the bridge prints on first start, after the time.'),

  h2('p1-menu', 'Ouvrir le menu F8 et tester', 'Open the F8 menu and test'),
  steps('p1-menu-steps', [
    ['Chargez une partie à part', 'Load a separate game',
      "Le foin ajouté par le mod peut rester dans la sauvegarde : gardez votre partie principale de côté pour ce test. Un bandeau « Talky Needle : mod non officiel actif » s'affiche, et le pont écrit `game connected`.",
      'Hay added by the mod can stay in the save: keep your main game aside for this test. A "Talky Needle: unofficial mod active" banner appears, and the bridge prints `game connected`.'],
    ['Appuyez sur F8', 'Press F8',
      "La fenêtre Talky Needle s'ouvre, avec `Bridge connecté` en haut à droite. `F8` ou `Échap` la referme.",
      'The Talky Needle window opens, with `Bridge connected` at the top right. `F8` or `Esc` closes it.'],
    ['Cliquez sur « Canard » dans la page Effets', 'Click "Duck" on the Effects page',
      "Le champ « Pseudo affiché » contient `Viewer` : fermez la fenêtre, et un canard à ce nom tombe sur le tas.",
      'The "Displayed name" field contains `Viewer`: close the window, and a duck with this name falls on the pile.'],
  ]),
  capture('p1-menu-shot', 'La fenêtre F8 sur la page Effets, avec les groupes de boutons.', 'The F8 window on the Effects page, with the groups of buttons.'),
  p('p1-menu-cli',
    'Vous pouvez aussi lancer un workflow depuis un terminal ouvert dans le dossier `bridge`, par exemple pour le relier à un Stream Deck :',
    'You can also run a workflow from a terminal opened in the `bridge` folder, for example to connect it to a Stream Deck:'),
  code('p1-menu-cli-code', 'powershell', 'node bridge.js fire new_follower user=Bob'),

  h2('p1-tunnel', 'Ouvrir le tunnel', 'Open the tunnel'),
  p('p1-tunnel-text',
    "LibertyTalk refuse les adresses locales : le pont a besoin d'une adresse publique pour recevoir vos événements. Dans une seconde fenêtre, lancez la commande ci-dessous, puis notez l'adresse `https://des-mots-au-hasard.trycloudflare.com` qu'elle affiche.",
    'LibertyTalk refuses local addresses: the bridge needs a public address to receive your events. In a second window, run the command below, then note the `https://random-words.trycloudflare.com` address it prints.'),
  code('p1-tunnel-code', 'powershell', 'cloudflared tunnel --url http://127.0.0.1:7421'),
  callout('p1-tunnel-change', 'warning', "Cette adresse change à chaque lancement", 'This address changes on every start',
    "Un tunnel rapide ne demande aucun compte, mais son adresse change à chaque lancement et Cloudflare le réserve aux tests. Mettez-la à jour dans LibertyTalk avant chaque live, ou créez un tunnel nommé sur votre domaine pour la garder d'un stream à l'autre. ngrok peut remplacer cloudflared si vous l'utilisez déjà.",
    'A quick tunnel needs no account, but its address changes on every start and Cloudflare reserves it for testing. Update it in LibertyTalk before each stream, or create a named tunnel on your domain to keep it from one stream to the next. ngrok can replace cloudflared if you already use it.'),

  h2('p1-widget', 'Relier LibertyTalk', 'Connect LibertyTalk'),
  p('p1-widget-text',
    "Le widget officiel « Find The Needle · Talky Needle » envoie les événements de votre live au pont, à travers le tunnel. Il est gratuit, et chaque événement a sa case dans sa configuration.",
    'The official "Find The Needle · Talky Needle" widget sends your live events to the bridge, through the tunnel. It is free, and each event has its own checkbox in its settings.'),
  { id: 'p1-widget-card', type: 'widget', listing_slug: 'find-the-needle-talky' },
  steps('p1-widget-steps', [
    ['Installez le widget', 'Install the widget',
      "Sélectionnez votre communauté dans la barre latérale. Sur la fiche du widget dans la [Marketplace](dashboard:/market), cliquez sur **Installer**, puis ouvrez-le dans [Widgets](dashboard:/widgets) et gardez la portée **Global**.",
      "Select your community in the sidebar. On the widget's page in the [Marketplace](dashboard:/market), click **Install**, then open it in [Widgets](dashboard:/widgets) and keep the **Global** scope."],
    ['Remplissez sa configuration', 'Fill in its settings',
      "Saisissez les trois champs du tableau ci-dessous, puis cliquez sur **Enregistrer**.",
      'Enter the three fields in the table below, then click **Save**.'],
    ['Activez-le', 'Enable it',
      'Dans le bloc **Activation**, cliquez sur **Activer**.',
      'In the **Activation** block, click **Enable**.'],
  ]),
  table('p1-widget-fields', [['Champ', 'Field'], ['Valeur', 'Value']], [
    [['Adresse publique du pont', 'Bridge public URL'], ["L'adresse du tunnel, sans `/` à la fin", 'The tunnel address, with no trailing `/`']],
    [['Jeton du pont', 'Bridge token'], ['La valeur `token` de `bridge\\config.json`, celle que le pont a mise dans le presse-papiers', 'The `token` value of `bridge\\config.json`, the one the bridge put in the clipboard']],
    [['Commande de chat (sans « ! »)', 'Chat command (without "!")'], ['`foin` par défaut : vos viewers tapent `!foin`', '`foin` by default, `hay` for example: your viewers then type `!hay`']],
  ]),

  h2('p1-check', 'Vérifier de bout en bout', 'Check end to end'),
  p('p1-check-text',
    "Partie chargée, pont et tunnel ouverts, demandez à un ami de suivre votre chaîne, ou utilisez le test de déclencheur `channelFollow` de LibertyTalk. Le pont écrit le nom du workflow reçu, et la page **Activité** du menu F8 affiche l'événement avec le pseudo du viewer.",
    'With a game loaded and the bridge and tunnel open, ask a friend to follow your channel, or use the LibertyTalk `channelFollow` trigger test. The **Activity** page of the F8 menu shows the event with the viewer\'s name.'),

  h2('p1-trouble', 'Dépannage', 'Troubleshooting'),
  {
    id: 'p1-trouble-faq', type: 'faq',
    items: [
      { q: L('Rien ne se passe au lancement du jeu', 'Nothing happens when the game starts'), a: L("Vérifiez que `override.cfg` se trouve à côté de `FindTheNeedle.exe` et contient la ligne `TalkyNeedle`. Lancez à nouveau `tools\\install.ps1` si besoin. Le journal du jeu, `%APPDATA%\\Godot\\app_userdata\\FindTheNeedle\\logs\\godot.log`, doit contenir `[TalkyNeedle] v0.2.0 loaded`.", 'Check that `override.cfg` is next to `FindTheNeedle.exe` and contains the `TalkyNeedle` line. Run `tools\\install.ps1` again if needed. The game log, `%APPDATA%\\Godot\\app_userdata\\FindTheNeedle\\logs\\godot.log`, must contain `[TalkyNeedle] v0.2.0 loaded`.') },
      { q: L('Le menu affiche « Bridge non connecté »', 'The menu shows "Bridge not connected"'), a: L('Lancez `start-bridge.cmd` et laissez sa fenêtre ouverte. Le mod se reconnecte seul toutes les deux secondes.', 'Run `start-bridge.cmd` and leave its window open. The mod reconnects by itself every two seconds.') },
      { q: L('Le pont écrit `warning: hooks missing`', 'The bridge prints `warning: hooks missing`'), a: L("Une mise à jour du jeu a déplacé ce que le mod utilise. Les effets concernés ne font plus rien jusqu'à une nouvelle version du mod : les autres continuent de fonctionner.", 'A game update moved what the mod relies on. The affected effects do nothing until a new version of the mod comes out: the others keep working.') },
      { q: L('Le pont écrit `gust failed: nothing_nearby`', 'The bridge prints `gust failed: nothing_nearby`'), a: L("Le vent n'a trouvé aucun foin libre autour de vous, donc rien n'a bougé. Dans vos workflows, placez un `hay_rain` avec `\"on\": \"player\"` juste avant le `gust`.", 'The wind found no loose hay around you, so nothing moved. In your workflows, place a `hay_rain` with `"on": "player"` right before the `gust`.') },
      { q: L('LibertyTalk appelle le pont, mais il ne se passe rien en jeu', 'LibertyTalk calls the bridge, but nothing happens in the game'), a: L("Le pont garde les événements jusqu'à ce qu'une partie soit chargée, pendant 15 minutes au plus. Vérifiez aussi que **Mettre les viewers en pause** est désactivé dans la page Réglages du menu F8.", 'The bridge keeps events until a game is loaded, for 15 minutes at most. Also check that **Pause viewers** is off on the Settings page of the F8 menu.') },
      { q: L('Comment désinstaller ?', 'How do I uninstall?'), a: L('Fermez le jeu, puis lancez `tools\\install.ps1 -Uninstall`. Le script retire la ligne de `override.cfg` et le dossier `mods\\talky_needle`.', 'Close the game, then run `tools\\install.ps1 -Uninstall`. The script removes the line from `override.cfg` and the `mods\\talky_needle` folder.') },
    ],
  },

  part('part-2-workflows', 'Choisir ce qui se passe en jeu', 'Choose what happens in the game',
    'Les effets disponibles, les récompenses de points, les messages à l\'écran et les workflows du pont.',
    'The available effects, channel points rewards, on-screen messages and the bridge workflows.'),

  h2('p2-events', 'Ce que font vos événements par défaut', 'What your events do by default'),
  table('p2-events-table', [['Événement', 'Event'], ['Webhook', 'Webhook'], ['Effet en jeu', 'In-game effect']], [
    [['Follow', 'Follow'], '`/hooks/follow`', ['Un petit canard au nom du viewer', 'A small duck named after the viewer']],
    [['Abonnement', 'Subscription'], '`/hooks/sub`', ["Un canard géant, plus grand selon le tier, qui reste 15 minutes", 'A giant duck, larger with the tier, that stays 15 minutes']],
    [['Abonnements offerts', 'Gifted subscriptions'], '`/hooks/gift`', ['Une pluie de canards, un par abonnement, 30 au plus', 'A rain of ducks, one per subscription, 30 at most']],
    [['Bits', 'Bits'], '`/hooks/bits`', ['Du foin sur le tas : à ×10, 500 bits ajoutent 5000 brins. À partir de 1000 bits, un canard géant en plus', 'Hay on the pile: at x10, 500 bits add 5000 straws. From 1000 bits, a giant duck as well']],
    [['Raid', 'Raid'], '`/hooks/raid`', ['Une avalanche de foin, des canards, et vous êtes éjecté', 'A hay avalanche, ducks, and you get thrown']],
    [['Don ou Super Chat', 'Donation or Super Chat'], '`/hooks/donation`, `/hooks/superchat`', ['Un canard géant au nom du donateur', "A giant duck named after the donor"]],
    [['Commande de chat', 'Chat command'], '`/hooks/command`', ['Un peu de foin, une fois toutes les 30 secondes', 'A little hay, once every 30 seconds']],
  ]),
  callout('p2-events-chat', 'info', 'Pseudo des commandes de chat', 'Name on chat commands',
    "Le widget n'envoie que le nom de la commande : ni le pseudo du viewer, ni le texte tapé après elle. La plateforme interdit de redistribuer les messages du chat depuis un widget de la marketplace.",
    "The widget only sends the name of the command: neither the viewer's name nor the text typed after it. The platform forbids redistributing chat messages from a marketplace widget."),

  h2('p2-bits', 'Régler le multiplicateur de bits', 'Set the bits multiplier'),
  p('p2-bits-text',
    "Chaque bit ajoute des brins de foin selon le multiplicateur : 10 par défaut, donc 500 bits ajoutent 5000 brins. Changez-le dans la page **Réglages** du menu F8 (x1, x2, x5, x10 ou x20) pour la session, ou avec `bitsMultiplier` dans `settings` de `bridge\config.json` pour le garder. 300 brins tombent à l'écran au plus : le reste s'ajoute directement au tas et au compteur, pour que votre partie ne gèle pas. Le workflow `bits` plafonne chaque événement à 5000 brins.",
    'Each bit adds hay straws based on the multiplier: 10 by default, so 500 bits add 5000 straws. Change it on the **Settings** page of the F8 menu (x1, x2, x5, x10 or x20) for the session, or with `bitsMultiplier` in `settings` of `bridge\config.json` to keep it. At most 300 straws fall on screen: the rest goes directly to the pile and the counter, so your game does not freeze. The `bits` workflow caps each event at 5000 straws.'),

  h2('p2-points', 'Créer des récompenses de points', 'Create channel points rewards'),
  p('p2-points-text',
    'Le webhook `points` choisit le workflow selon le titre de la récompense. Les mots dépendent de la langue de Windows au premier lancement du pont, français ici. Créez une récompense Twitch dont le titre contient un des mots ci-dessous : « Coup de vent sur le tas » lance `points_gust`. La casse ne compte pas, et le premier mot trouvé dans la liste de `bridge\\config.json` l\'emporte.',
    'The `points` webhook picks the workflow from the title of the reward. The words depend on the Windows language when the bridge first starts, English here. Create a Twitch reward whose title contains one of the words below: "Wind on the pile" runs `points_gust`. Case does not matter, and the first word found in the list in `bridge\\config.json` wins.'),
  table('p2-points-table', [['Mot dans le titre', 'Word in the title'], ['Effet', 'Effect'], ['Délai', 'Cooldown']], [
    [['`foin`', '`hay`'], ['Livraison de foin sur le tas', 'Hay delivery on the pile'], '30 s'],
    [['`canard`', '`duck`'], ['Un canard au nom du viewer, de taille aléatoire', "A duck named after the viewer, in a random size"], '20 s'],
    [['`prout`', '`fart`'], ['Un prout synthétisé qui souffle le foin autour de vous', 'A synthesised fart that blows the hay around you'], '30 s'],
    [['`aiguille`', '`needle`'], ['Fausse alerte : le détecteur bipe, « AIGUILLE TROUVÉE ! », puis « ... non. »', 'False alarm: the detector beeps, "NEEDLE FOUND!", then "... nope."'], '180 s'],
    [['`éjecte`', '`launch`'], ['Vous envoie en l\'air', 'Throws you into the air'], '60 s'],
    [['`aimant`', '`magnet`'], ['Le foin libre vous fonce dessus', 'Loose hay rushes at you'], '120 s'],
    [['`lévitation`', '`levitat`'], ['Le foin libre s\'envole doucement', 'Loose hay gently floats up'], '120 s'],
    [['`bourré`', '`drunk`'], ['La caméra tangue', 'The camera sways'], '180 s'],
    [['`envers`', '`upside`'], ['L\'écran se retourne', 'The screen turns upside down'], '180 s'],
    ['`zoom`', ['Champ de vision extrême', 'Extreme field of view'], '120 s'],
    [['`toupie`', '`spin`'], ['Votre vue tourne sur elle-même', 'Your view spins around'], '90 s'],
    [['`panne`', '`blackout`'], ['Écran noir, avec le nom du viewer', "Black screen, with the viewer's name"], '180 s'],
    [['`vent`', '`wind`'], ['Coup de vent sur le foin', 'A gust of wind on the hay'], '60 s'],
  ]),
  callout('p2-points-needles', 'tip', 'Vos aiguilles ne bougent jamais', 'Your needles never move',
    "Aucun effet ne déplace une aiguille : perdre une aiguille hors de la carte mettrait fin à la partie. Le foin ajouté par le mod peut en revanche la recouvrir.",
    'No effect moves a needle: losing one outside the map would end the game. Hay added by the mod can still cover it.'),

  h2('p2-menu', 'Piloter depuis le menu F8', 'Control it from the F8 menu'),
  table('p2-menu-table', [['Page', 'Page'], ['Ce que vous y faites', 'What you do there']], [
    [['**Effets**', '**Effects**'], ['Déclencher chaque effet à la souris, avec le pseudo de votre choix', 'Trigger each effect with the mouse, with the name of your choice']],
    [['**Message**', '**Message**'], ['Écrire un message à l\'écran et choisir sa couleur et sa durée', 'Write an on-screen message and choose its colour and duration']],
    [['**Activité**', '**Activity**'], ['Voir les derniers événements et supprimer les canards', 'See the latest events and remove the ducks']],
    [['**Réglages**', '**Settings**'], ['Mettre les viewers en pause, ou activer le mode safe', 'Pause viewers, or turn on safe mode']],
  ]),
  p('p2-menu-ducks',
    "`F9` supprime tous les canards à tout moment. Sinon, un canard disparaît après 3 minutes, ou 15 minutes pour ceux des abonnements et des dons. Les réglages de la page **Réglages** durent jusqu'au redémarrage du pont. Pour les garder, modifiez `settings` dans `bridge\\config.json`.",
    '`F9` removes all ducks at any time. Otherwise, a duck disappears after 3 minutes, or 15 minutes for those from subscriptions and donations. The settings on the **Settings** page last until the bridge restarts. To keep them, edit `settings` in `bridge\\config.json`.'),

  h2('p2-message', 'Afficher un message envoyé par LibertyTalk', 'Show a message sent by LibertyTalk'),
  p('p2-message-text',
    "Le widget n'envoie pas de message. Pour en afficher un depuis LibertyTalk, créez un workflow dans [Workflows](dashboard:/workflows) avec l'action **Appel webhook / API** vers `<adresse du tunnel>/hooks/message`, en méthode `POST`, avec l'en-tête `X-Bridge-Token` et le corps ci-dessous. Les messages passent l'un après l'autre, 6 secondes chacun, et 20 au plus attendent leur tour.",
    'The widget sends no message. To show one from LibertyTalk, create a workflow in [Workflows](dashboard:/workflows) with the **Webhook / API call** action to `<tunnel address>/hooks/message`, using the `POST` method, the `X-Bridge-Token` header and the body below. Messages show one after the other, 6 seconds each, and at most 20 wait for their turn.'),
  code('p2-message-code', 'json', '{ "user_name": "{user_name}", "text": "Merci pour le follow !" }'),
  callout('p2-message-warning', 'warning', 'Ce texte passe sur votre stream', 'This text goes on your stream',
    "Le pont affiche le texte tel quel. Écrivez-le vous-même dans le workflow, ou faites-le modérer avant de l'envoyer. N'y branchez pas le texte libre d'une récompense de points sans filtre.",
    'The bridge displays the text as is. Write it yourself in the workflow, or have it moderated before sending. Do not connect the free text of a channel points reward without a filter.'),

  h2('p2-workflows', 'Modifier les workflows du pont', 'Edit the bridge workflows'),
  p('p2-workflows-text',
    "Les workflows se trouvent dans `bridge\\config.json`, avec la même syntaxe que Talky pour Project Zomboid. Relancez le pont après une modification. L'exemple ci-dessous envoie du foin selon les bits multipliés, avec un maximum de 2000 brins, et 5 canards à partir de 1000 bits.",
    'Workflows are in `bridge\\config.json`, with the same syntax as Talky for Project Zomboid. Restart the bridge after a change. The example below sends hay based on multiplied bits, with a maximum of 2000 straws, and 5 ducks from 1000 bits.'),
  code('p2-workflows-code', 'json', `"bits": {
  "steps": [
    { "action": "hay_rain", "count": "{{bitsMultiplied | clamp:10:2000}}" },
    { "if": { "bits": { "gte": 1000 } },
      "then": [ { "action": "duck", "name": "{{user}}", "count": 5, "size": 2 } ] }
  ]
}`, 'Le champ `menu` d\'un workflow ajoute un bouton dans la page Effets : `"menu": { "label": "Mon effet", "group": "hay" }`.', 'A workflow\'s `menu` field adds a button on the Effects page: `"menu": { "label": "My effect", "group": "hay" }`.'),
  table('p2-actions-table', [['Action', 'Action'], ['Paramètres', 'Parameters'], ['Effet', 'Effect']], [
    ['`notify`', '`text`, `seconds`, `color`', ['Bandeau à l\'écran', 'On-screen banner']],
    ['`message`', '`text`, `author`, `seconds`, `color`', ['Panneau de message, en file d\'attente', 'Message panel, queued']],
    ['`wait`', '`seconds`', ['Pause dans le workflow', 'Pause in the workflow']],
    ['`hay_rain`', '`count` (100 000 max), `on` (`pile`, `player`), `radius`, `height`', ['Du foin sur le tas ou autour du joueur', 'Hay on the pile or around the player']],
    ['`gust`', '`strength`, `radius`', ['Pousse le foin libre proche', 'Pushes nearby loose hay']],
    ['`magnet`, `levitate`', '`seconds` (30 max), `radius`, `speed`', ['Le foin libre fonce sur le joueur, ou s\'envole', 'Loose hay rushes at the player, or floats up']],
    ['`duck`', '`name`, `size` (8 max), `count` (30 max), `seconds`, `on`', ['Canard en plastique, 40 en même temps au plus', 'Rubber duck, 40 at the same time at most']],
    ['`clear_ducks`', '', ['Supprime tous les canards', 'Removes all ducks']],
    ['`yeet`', '`force` (30 max)', ['Envoie le joueur en l\'air', 'Throws the player into the air']],
    ['`spin`', '`turns`, `seconds`', ['Fait tourner la vue', 'Spins the view']],
    ['`drunk`, `upside_down`, `quake_pro`', '`seconds` (30 max)', ['Effets de caméra', 'Camera effects']],
    ['`blackout`', '`seconds` (10 max), `text`', ['Écran noir avec un texte', 'Black screen with a text']],
    ['`sound`', '`name` (`fart`, `quack`, `beep`), `pitch`, `volume`', ['Son synthétisé par le mod', 'Sound synthesised by the mod']],
  ]),

  h2('p2-limits', 'Limiter les abus', 'Limit abuse'),
  p('p2-limits-text',
    "Dans `settings` de `bridge\\config.json`, `maxJobsPerMinute` plafonne les événements viewers (30 par défaut), `blockedActions` désactive des actions et `safeMode` coupe `safeModeBlocks`, les effets sur le joueur et la caméra par défaut. Chaque workflow accepte aussi `cooldownSeconds` et `userCooldownSeconds`. Le menu F8 et la commande `fire` ignorent ces délais et ce plafond pour que vous puissiez tester.",
    'In `settings` of `bridge\\config.json`, `maxJobsPerMinute` caps viewer events (30 by default), `blockedActions` turns actions off and `safeMode` cuts `safeModeBlocks`, the effects on the player and the camera by default. Each workflow also accepts `cooldownSeconds` and `userCooldownSeconds`. The F8 menu and the `fire` command ignore these cooldowns and this cap so that you can test.'),

  h2('p2-back', 'Prévenir LibertyTalk quand une aiguille est trouvée', 'Tell LibertyTalk when a needle is found'),
  steps('p2-back-steps', [
    ['Créez un webhook entrant', 'Create an incoming webhook',
      'Dans LibertyTalk, créez un workflow avec le déclencheur **Webhook entrant**. Il fournit une URL et un secret.',
      'In LibertyTalk, create a workflow with the **Incoming webhook** trigger. It gives you a URL and a secret.'],
    ['Remplissez la cible du pont', 'Fill in the bridge target',
      'Dans `bridge\\config.json`, remplacez les valeurs `PASTE_...` de `httpTargets.lt_report`. Le pont refuse d\'appeler une cible qui contient encore ces valeurs.',
      'In `bridge\\config.json`, replace the `PASTE_...` values of `httpTargets.lt_report`. The bridge refuses to call a target that still contains these values.'],
    ['Activez le workflow', 'Enable the workflow',
      'Passez `enabled` à `true` dans `report_to_libertytalk`, puis relancez le pont. À chaque aiguille trouvée, LibertyTalk reçoit `event` et `needlesFound`, que votre workflow peut par exemple écrire dans le chat.',
      'Set `enabled` to `true` in `report_to_libertytalk`, then restart the bridge. For each needle found, LibertyTalk receives `event` and `needlesFound`, which your workflow can for example write in chat.'],
  ]),
  p('p2-back-events',
    'Le jeu envoie aussi `needle_discovered` et `pile_replaced`. Reliez-les à vos workflows dans `gameEvents`.',
    'The game also sends `needle_discovered` and `pile_replaced`. Link them to your workflows in `gameEvents`.'),
  { id: 'p2-more', type: 'guide_link', slug: 'workflows-deep', text: L('Pour construire vos workflows côté LibertyTalk.', 'To build your workflows on the LibertyTalk side.') },
];

const guide = {
  slug: 'find-the-needle-talky',
  status: 'draft',
  visibility: 'public',
  required_feature: null,
  category: 'game-integrations',
  tags: ['find-the-needle', 'twitch', 'youtube', 'webhook', 'mod'],
  level: 'intermediate',
  template: 'game_integration',
  icon: 'ph:game-controller',
  cover_url: null,
  default_locale: 'fr',
  locales: ['fr', 'en'],
  title: L('Find The Needle × LibertyTalk : Talky Needle', 'Find The Needle × LibertyTalk: Talky Needle'),
  summary: L(
    "Un follow fait tomber un canard à son nom sur votre tas de foin, un raid déclenche une avalanche, une récompense de points lance une fausse alerte du détecteur. Partie 1 : installer le mod non officiel et son pont. Partie 2 : choisir ce qui se passe en jeu.",
    'A follow drops a duck named after the viewer on your hay pile, a raid triggers an avalanche, a channel points reward sets off a fake detector alert. Part 1: install the unofficial mod and its bridge. Part 2: choose what happens in the game.'),
  blocks,
};

// The rules of the guides: both languages, no em dash, unique ids of 8 to 36 characters.
for (const b of blocks) if (b.id.length < 8) b.id = `${b.id}-section`;
const text = JSON.stringify(guide, null, 2);
if (text.includes('—')) throw new Error('em dash found');
const ids = blocks.map((b) => b.id);
if (new Set(ids).size !== ids.length) throw new Error('duplicate block id');
for (const id of ids) if (!/^[A-Za-z0-9_-]{8,36}$/.test(id)) throw new Error(`bad block id ${id}`);
fs.writeFileSync(path.join(__dirname, 'find-the-needle-talky.json'), `${text}\n`);
console.log(`${blocks.length} blocks, ${text.length} bytes, download url ${DOWNLOAD_URL ? 'set' : 'EMPTY (draft only)'}`);
