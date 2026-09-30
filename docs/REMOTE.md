# Piloter l'arcade par texte depuis Codex Remote

Le téléphone peut servir de télécommande **texte**, sans démarrer le vocal. Codex Remote rejoint l'hôte qui possède ce projet ; c'est sur cet hôte que Codex exécute le petit client du harness.

Le CLI ne crée pas un deuxième générateur : il transmet les demandes au même harness que le robot. Le serveur retrouve la conversation de chaque cartouche pour les éditions suivantes. La conversation Remote sert de point d'entrée ; ce n'est **pas** une affirmation que le thread interne App Server apparaît automatiquement comme cette même tâche dans l'interface Codex.

## Préparation sur l'hôte

- Le projet et ses dépendances sont présents, et `npm start` sert l'arcade sur le port 8080.
- Le Codex utilisé par le harness est authentifié sur cet hôte.
- Le navigateur de la borne reste ouvert si l'on veut voir les publications arriver ou fournir des captures du jeu.
- Le téléphone se connecte à l'hôte via Codex Remote. Il n'a pas besoin d'accéder directement à `localhost:8080` : sur le téléphone, ce nom désignerait le téléphone lui-même.

Il n'y a pas de microphone dans ce chemin. Le CLI n'appelle aucun endpoint voix et n'expose pas le serveur sur le réseau public.

## Commandes

Depuis le dossier du projet sur l'hôte :

```sh
node scripts/arcade.mjs list
node scripts/arcade.mjs new "Crée un jeu solo où une grenouille livre des colis sur des nénuphars."
node scripts/arcade.mjs edit line-pong "Agrandis les raquettes et rends la balle légèrement plus lente."
node scripts/arcade.mjs edit line-pong "Non, remets la vitesse comme avant."
node scripts/arcade.mjs status
node scripts/arcade.mjs wait <session-id>
```

`new` demande toujours une nouvelle cartouche, sans reprendre l'identifiant de session du hub. `edit` cible l'identifiant exact renvoyé par `list` et reprend la conversation du jeu côté serveur. Les nouvelles instructions passent donc par le contexte du harness, ses règles arcade, la validation et la publication durable — pas par des modifications directes du dossier depuis une deuxième conversation.

Le harness utilise **GPT-6 Astra, raisonnement high, mode Fast** par défaut, pour le hub et les créations/modifications de cartouches, y compris les demandes déléguées par le vocal. Le tier natif est `priority`, nommé Fast dans le catalogue Codex. Le modèle audio natif reste inchangé. Aucun réglage global du compte Codex n'est modifié.

Pour tester un réglage explicite : `node scripts/arcade.mjs edit line-pong "Mets le fond en vert canard." --model gpt-6-astra --effort low`. Ces options sont transmises au vrai tour Codex ; la demande suivante sans options revient aux défauts du harness. Elles ne peuvent pas changer un tour déjà en cours. Le mode Fast consomme davantage de quota : voir la [documentation officielle](https://learn.chatgpt.com/docs/agent-configuration/speed#fast-mode).

`new` et `edit` attendent les événements de la demande par défaut, pendant **10 minutes au maximum**. On peut réduire cette attente ou simplement transmettre :

```sh
node scripts/arcade.mjs edit line-pong "Change le terrain en bleu nuit." --timeout 90
node scripts/arcade.mjs new "Un casse-briques coopératif à deux joueurs." --no-wait
```

Le client affiche les `sessionId`, `threadId` et `gameId` retournés par le serveur, puis les vrais états et messages reçus. `PUBLISHED` confirme la publication d'une révision. `READY` peut signifier qu'il n'y avait rien à modifier ; `IDLE` que Codex attend une précision. Ni l'un ni l'autre n'est présenté comme une nouvelle publication.

Un timeout renvoie le code de sortie 2 et **n'annule pas** le travail en cours. Reprendre le suivi avec `wait`, ou lire `status`. Une erreur renvoie 1 ; succès/attente de précision renvoie 0. Le CLI ne réessaie pas automatiquement un POST incertain afin de ne pas dupliquer une demande.

## Contexte du jeu et modifications à chaud

Le téléphone n'a pas à transporter lui-même des images : le harness peut demander au navigateur de la borne une capture fraîche du jeu actif. Si aucun navigateur n'affiche ce jeu, il ne faut pas inventer une capture ; Codex peut encore travailler sur son code et ses ressources, mais doit annoncer l'absence de contexte visuel frais.

Une publication est reçue par le navigateur ouvert. Le runtime garde la partie quand la modification est compatible ; un changement structurel peut proposer un redémarrage. Le message `PUBLISHED` confirme le disque et l'événement serveur, **pas** que chaque écran distant l'a déjà affiché.

`PUBLISHED` n'attend plus le smoke test navigateur : les contrôles statiques restent préalables, puis la vérification et la vignette arrivent en arrière-plan. Une erreur ultérieure est signalée par le harness ; elle ne rétablit pas automatiquement un ancien jeu. La vignette ne déclenche pas un second rechargement de la partie.

## Adresse du harness

Par défaut, le CLI parle à `http://127.0.0.1:8080`. Pour un autre port local :

```sh
ARCADE_URL=http://localhost:8090 node scripts/arcade.mjs status
```

Seules les origines HTTP `localhost` et `127.0.0.1` sont acceptées, sans identifiants, chemin, paramètres ou fragment. Les redirections sont refusées. Ne pas utiliser ce réglage pour exposer le harness, contourner l'accès Remote ou transmettre des identifiants à un serveur externe.

## Vérification

`node --test tests/remote-cli.test.js` lance uniquement des serveurs HTTP locaux factices et des sous-processus du CLI. Aucun test de ce fichier n'envoie de demande à Codex ni ne démarre de génération réelle.
