# Cartouche arcade — contrat v1

Le hub lunaire, la conversation Codex et les contrôles système appartiennent à la borne. Une cartouche est un jeu indépendant, pas une modification du hub. Les règles de session sont communes, **le rendu des écrans ne l'est pas**.

## Fichiers et publication

Une seule copie publiée par jeu :

```text
cartridges/<id>/
  game.json       # manifeste
  config.json     # paramètres durables, jamais des variables seulement en mémoire
  game.js         # export default function createGame()
  ...assets locaux éventuels
```

Manifeste minimal : `{ "id": "my-game", "title": "My Game", "description": "...", "maxPlayers": 2, "accent": "#abc123", "screenshot": "cover.png", "entry": "game.js", "stateVersion": 1 }`. Les chemins d'assets de la cartouche sont relatifs pour rester portables pendant la préparation et la publication.

Le catalogue publié est `GET /api/games` → `{games:[manifest + revision]}`. Une configuration se lit via `GET /api/games/:id/config`. `revision` est un identifiant d'invalidation du cache, **pas un historique de versions**. Le serveur annonce la publication par SSE `game-updated` avec `{gameId,revision,requiresRestart?}`. Le runtime utilise `/cartridges/:id/@:revision/game.js` pour renouveler aussi le graphe des imports relatifs. Ces URL pointent vers les fichiers actuels ; précharger les assets nécessaires, ne pas supposer une ancienne URL conservée comme archive.

Codex ne modifie que le dossier temporaire fourni par le harness. Imports autorisés : `pixi.js` et modules internes à la cartouche. Ne pas importer le runtime, le hub ou une autre cartouche. Aucun accès réseau, écouteur clavier global ou accès au stockage des autres jeux. Les services sont fournis par l'API.

La publication attend uniquement les contrôles statiques (fichiers, manifeste, configuration, imports et compilation). Le smoke test navigateur vient **après** l'enregistrement et l'événement `game-updated`, sans bloquer l'affichage. Un échec ultérieur est signalé, pas masqué par un retour automatique à une ancienne copie. Un résultat devenu obsolète pendant une nouvelle modification est ignoré. La vignette générée est un cache séparé dans `.arcade/thumbnails/` (une seule entrée par jeu) : `game-thumbnail-updated` rafraîchit le catalogue, jamais la partie. Ce cache ne change pas la révision du code et n'est pas un historique de jeux.

## Factory et API

```js
export default function createGame() {
  return {
    stateVersion: 1,
    configure(config, arcade) {},
    mount(arcade) { /* retourne un Pixi.Container neuf */ },
    start(arcade) { /* nouvelle partie seulement */ },
    update(dt, arcade) {},
    captureState() { /* retourne un objet JSON détaché, sans Pixi */ },
    restoreState(snapshot, arcade) { /* synch, sans start(); retourne true ou throw */ },
    renderAttract(arcade, {game, controls}) { /* retourne un Container */ },
    renderGameOver(arcade, {result, playerCount, controls}) { /* idem */ },
    onPlayerJoinRequested(player, arcade) { /* pour un jeu 2P */ },
    // Optionnels : updateAttract(dt, arcade), updateGameOver(dt, arcade), destroy()
    // migrateState(snapshot, previousStateVersion, arcade) -> nouvel état synchrone
  };
}
```

`arcade` fournit :

- `width`, `height` (actuellement 960 × 540).
- `hudSafeArea` : rectangle immuable `{left, top, right, bottom, width, height}` en coordonnées logiques. À 960 × 540 : `{left:80, top:54, right:880, bottom:486, width:800, height:432}`.
- `input.down(player, action)` et `input.pressed(player, action)` ; actions `left`, `right`, `up`, `down`, `a` à `h` (libellés A, B, X, Y, L1, R1, L2, R2), `start`. Les identifiants historiques restent inchangés. Les boutons absents peuvent être non mappés. Pas d’action COIN ni de crédits : le bouton physique marqué COIN est mappé sur START. START P2 demande l’arrivée du deuxième joueur selon la règle de la cartouche.
- `playerCount` (getter), `acceptPlayer(2, notice?)` et `endGame({score,label,detail})`.
- `assets` (Pixi Assets), `audio.add(alias, source)`, `audio.play(alias, options)`, `audio.stopAll()`.

`mount`, `configure`, `restoreState` et `migrateState` sont synchrones. Aucun appel à `start` pendant une restauration. Aucun effet externe pendant la préparation d'un montage de remplacement. Les assets asynchrones doivent être préparés séparément et leur absence ne doit pas casser la simulation. `destroy` éventuel doit libérer les ressources propres à l'instance, sans détruire les assets partagés ; le runtime détruit ses Containers Pixi.

## Bande-son MIDI

Chaque nouveau jeu compose sa propre petite bande-son originale en **vrai fichier `.mid`**, enregistrée dans la cartouche. Une boucle musicale avec mélodie, basse et accompagnement, pas une succession aléatoire de bips. Son tempo, ses timbres et son motif suivent la DA du jeu ; ne copie pas la musique du menu ou d'un autre jeu. Garde de l'espace pour les bruitages et la voix. Une modification sans rapport avec la musique conserve la bande-son existante.

- `audio.music(url, {volume: 0.22, loop: true})` charge et joue un MIDI. Retourne une Promise de booléen (chargement accepté/échec, pas une preuve que l'autoplay est autorisé). Un nouvel URL remplace la musique ; répéter le même URL ne superpose pas les boucles. `audio.stopMusic()` arrête uniquement la musique, `audio.stopAll()` arrête aussi les effets.
- Utilise `new URL('./soundtrack.mid', import.meta.url).href`, jamais un chemin vers le hub ou une autre cartouche. Démarre la musique dans `start` ou au premier `update` actif ; pour supporter une restauration en direct, le premier `update` d'une nouvelle instance peut démarrer la musique avec un drapeau **non sérialisé**. Pas d'audio dans `configure`, `mount`, `restoreState`, `migrateState` ou les fonctions de construction des écrans. Pour une musique d'attract/résultats, utilise leur callback `update…`.
- Le runtime suspend la musique d'une cartouche préchargée mais pas encore affichée, l'arrête à la sortie et baisse son volume pendant le vocal. Il gère l'autorisation audio du navigateur et les onglets cachés ; ne crée pas tes propres AudioContext, timers musicaux ou écouteurs globaux. Un fichier absent ne doit pas empêcher de jouer.
- Lecteur léger : Standard MIDI File format 0/1, PPQ, tempo, note-on/off, vélocité, programme et volume de canal (CC7). **Pas une banque General MIDI complète** : programmes 0–7 = triangle doux, 8–15 = cloche, 32–39 = basse, 80–87 = lead carré, 88–103 = nappe sinus ; autres programmes = triangle. Canal 10 (index 9) = percussion tonale simple, pas un kit de batterie réaliste. Sustain, pitch-bend et autres contrôleurs ne sont pas interprétés. Maximum 12 notes simultanées : vise 3–6 voix, 8–16 mesures bouclables, fichier compact.

Pour composer sans installer de dépendance, `reference/midi.mjs` fournit `encodeMidi`. Utilise-le **dans un script de génération Node**, pas comme import du jeu. Exemple de format (compose tes propres notes, ce fragment n'est pas une bande-son) :

```js
import { writeFileSync } from 'node:fs';
import { encodeMidi } from './reference/midi.mjs';
writeFileSync('cartridge/soundtrack.mid', encodeMidi({
  bpm: 100, beats: 32, // durée exacte de la boucle, silences finaux compris
  tracks: [{ channel: 0, program: 10, notes: [
    // [position en noires, hauteur MIDI (60 = do central), durée en noires, vélocité 1–127]
    [0, 72, .5, 70], [1, 76, .75, 60],
  ] }],
}));
```

Garde la partition/script de composition dans le workspace pour les retouches ; publie le `.mid` dans `cartridge/`. Pas de service externe, de SoundFont à télécharger ou de permission Web MIDI nécessaire.

## Standardisation arcade, identité indépendante

Le runtime maintient `attract → playing → gameover → replay/attract`, reçoit START, les demandes P2, gère scores et sortie. Maintenir START P1 **ou** P2 pendant 3 secondes quitte la cartouche et revient au hub (ou à l’attract dans le runtime autonome). L’appui court reste immédiat pour démarrer, rejouer ou rejoindre : il n’attend ni relâchement ni délai. Le maintien est réservé au runtime, pas aux cartouches ; il est annulé par le relâchement, la perte de focus ou l’ouverture de l’atelier. Les durées P1/P2 ne s’additionnent pas. Le jeu fournit ses propres compositions pour le titre/attract, HUD et résultats/highscores. Aucun thème lunaire ou palette commune imposée. `controls` contient les libellés du mapping effectif `{p1Start,p2Start,exit,codex}` (`exit` vaut `START 3 SEC`). `result` contient `{score,label,detail,leaderboard:[{name,score}]}`.

Une cartouche 2P définit explicitement la réaction au START P2 : rejoindre immédiatement, interrompre un solo pour un duel, ou attendre une frontière pertinente de manche. Elle appelle `acceptPlayer` seulement lorsque le joueur rejoint réellement. Pas de lobby universel. Les trois cartouches de référence : Meteor = arrivée immédiate ; Pong = nouveau match versus ; Breakout = solo.

Dans les menus, **A valide/lance/rejoue et B revient en arrière**. Le runtime applique ces commandes aux écrans titre et résultats ; le hub les applique à la sélection et au robot. A depuis le panneau P2 fonctionne également pour un jeu solo (lancement 1P) ; pour une cartouche 2P, il lance à deux. START garde ses raccourcis historiques. `controls.confirm` et `controls.back` valent `A` et `B` pour les indications dessinées par la cartouche. En pleine partie, aucun détournement de A/B : START P2 est toujours nécessaire pour demander à rejoindre, et B ne quitte jamais le jeu. Un menu bloqué par l’atelier ne reçoit pas ces confirmations.

Les records sont enregistrés côté borne sous `arcade:<id>:<playerCount>p`. Le rendu du tableau appartient au jeu. Les records ne sont pas l'état de la partie, et une modification en direct ne sauvegarde pas automatiquement une progression pour le lendemain.

## Marges de sécurité CRT

Tous les éléments informatifs (scores, vies, icônes, titre, instructions, résultats et records) doivent tenir **entièrement** dans `arcade.hudSafeArea`, pas seulement leur point d'ancrage. Marges minimales : 8,33 % de la largeur à gauche/droite et 10 % de la hauteur en haut/bas (80 px et 54 px à 960 × 540). Mesure les bornes réelles après mise à jour du texte, y compris les scores longs et le HUD 2P ; ajuste l'alignement, le retour à la ligne ou la taille si nécessaire. Le cadre de borne et la déformation CRT masquent les coins et la périphérie.

Le décor et le terrain restent plein écran : ne réduis pas toute la scène, ne déplace pas les collisions pour ajouter cette marge. Chaque jeu conserve sa DA. Le runtime dessine lui-même la jauge de sortie START (barre jaune pâle sur noir, centrée en bas, qui se vide en 3 secondes) ; ne la duplique pas dans les jeux.

## Modifications en direct et persistance

Concevoir l'état vivant séparément des références au rendu : positions, vélocités, vies, score, timers, entités, progression. `configure` consomme les paramètres enregistrés dans `config.json`. Les dimensions doivent servir à la fois au rendu et aux collisions.

Après publication d'une modification, le runtime importe une nouvelle instance puis, **entre deux ticks**, capture l'état CURRENT de l'ancienne et le restaure dans la nouvelle. Ce n'est jamais la capture envoyée à Codex au début de la demande. La partie continue pendant le chargement. Le snapshot est cloné avant migration pour qu'une tentative rejetée ne mutile pas la partie active.

- Même `stateVersion` : `restoreState` valide et restaure.
- Version différente : fournir `migrateState`, sinon proposition de redémarrage.
- `requiresRestart`, incompatibilité de joueurs ou échec de restauration : garder l'ancienne instance vivante et proposer START pour redémarrer ou ESC pour plus tard. Ne pas relancer silencieusement. Une erreur de configuration ou de rendu est signalée sans proposer un redémarrage qui reproduirait la même erreur.
- La version publiée existe déjà durablement sur disque. Garder l'ancienne partie en mémoire après refus de restart ne restaure pas l'ancienne copie sur disque.
- Simple changement de configuration : supporté par le même chemin avec conservation des entités. Une instance peut aussi exposer `applyConfig` pour tests/outils, mais toute modification utilisateur doit d'abord être persistée par le harness.

Le temps réel est une priorité raisonnable, pas une promesse de rendre tout remplaçable. Annoncer les interruptions nécessaires. La validation ne prouve pas toutes les interactions ou performances : annoncer ce qui a réellement été testé.

## Boutons de borne

Le mapping USB-encodeur/clavier est persistant dans `arcade:input-mapping:v1`. Par défaut : P1 flèches/K/L/Entrée ; P2 WASD/F/G/Espace ; CODEX C ; sortie par START maintenu 3 secondes, avec ESC comme raccourci clavier supplémentaire. **B reste une action de jeu, pas la sortie.** CODEX est réservé au système. `loadInputMapping`, `saveInputMapping`, `getCodexKey` et `setCodexKey` sont exportés par le module input. Les collisions de touches sont refusées.

Un seul `ArcadeInput` possède les écouteurs clavier de chaque page. Il émet `arcade-system` `{action,code}` ou `{action,source:"gamepad"}` (annulable) ; l'atelier appelle `preventDefault` s'il consomme l'action. La saisie texte bloque les contrôles de jeu ; une conversation vocale peut laisser le joystick actif.

Quand le hub ouvre une cartouche intégrée, celle-ci emprunte **la même instance d'entrée que le menu** : mêmes profils J1/J2 et même source USB du navigateur. Seuls les écouteurs clavier/focus changent de fenêtre. Le ticker du jeu remplace alors celui du hub pour lire cette instance ; il n'y a ni nouvelle attribution J1/J2 ni second lecteur concurrent. Sortir rend l'instance au hub, sans la détruire avec le jeu. Le runtime autonome crée sa propre entrée.

Les profils se règlent via l’icône manette en bas à droite de l’accueil (`/controls.html?debug=1`). L’assistant demande les quatre directions, A/B/X/Y/L1/R1/L2/R2, puis START et CODEX : seulement deux boutons supplémentaires. Les actions absentes sont passables ; CODEX peut rester au clavier. Aucun écran COIN ou SORTIE supplémentaire : la sortie utilise le START déjà mappé, maintenu 3 secondes. Échap reste disponible. Les anciens profils restent lisibles ; leur ancienne entrée `coin` est ignorée, sans réaffecter automatiquement START.

Le mapping est enregistré dans `arcade:gamepads:v1` **dans le navigateur de la borne** : `localhost` et `127.0.0.1` sont deux origines distinctes. Les Xbox `standard` utilisent A/B/X/Y/LB/RB/LT/RT pour les huit actions, Menu=START, Guide=CODEX si disponible, clic stick droit=sortie. Un encodeur non standard doit être calibré ; une étiquette navigateur `standard` incorrecte (certains DragonRise) se corrige avec le même assistant. Deux périphériques identiques restent liés à leur index ; pas de promotion silencieuse de P2 après débranchement de P1. Si l’OS réordonne deux encodeurs identiques, refaire l’attribution.

## Vérification locale

`node --test tests/runtime-live.test.js tests/cartridge-state.test.js`

Les tests couvrent la capture au moment d'activation, la migration/clonage, le refus de restart silencieux, le mapping sans double handlers, les états des trois jeux, l'arrivée P2 et la cohérence des tailles/collisions. Ils ne remplacent pas la vérification dans un vrai navigateur avec rendu, capture, son et serveur de publication.
