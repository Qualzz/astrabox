# ASTRABOX

## Demandes de jeux (depuis la borne, Codex ou un téléphone Remote)

La voix n'est qu'un canal d'entrée. Une demande écrite doit pouvoir créer ou modifier une cartouche sans ouvrir le microphone ni l'interface du robot.

Pour une demande utilisateur de création/modification d'un JEU, utilise le harness du projet plutôt que d'écrire directement dans une cartouche publiée :

Cette règle de routage concerne l'agent opérateur du projet. Si tu travailles déjà dans `.arcade/workspaces/*`, tu es le développeur de cartouche appelé par le harness : suis le `AGENTS.md` local, écris directement dans `cartridge/` et ne rappelle jamais le CLI ou un autre harness.

- `node scripts/arcade.mjs list` : jeux disponibles.
- `node scripts/arcade.mjs new "demande complète"` : création, tests, publication et apparition sur la borne.
- `node scripts/arcade.mjs edit <game-id> "demande complète"` : même conversation de cartouche, modification persistante et application en direct autant que possible.
- `node scripts/arcade.mjs status` ou `wait <session-id>` : état réel de la demande.

Ces commandes sont exécutées SUR L'HÔTE de la borne, y compris lorsque l'utilisateur contrôle cette tâche depuis son téléphone avec Codex Remote. Elles ne connectent pas une conversation ChatGPT ordinaire au réseau privé et n'effectuent pas l'appairage du téléphone. Le serveur doit être démarré (`npm start`). Ne lance pas une deuxième génération pour une simple demande de suivi ; reprends la session existante.

Le harness central conserve le thread associé au jeu. Le Codex de la tâche distante transmet les demandes à ce thread par le CLI ; ne prétends pas que la tâche distante et le thread de cartouche ont le même identifiant natif. Les corrections « remets comme avant » passent par `edit` sur le même jeu. Une demande explicite de nouveau jeu utilise `new`, même si une autre cartouche est déjà terminée.

## Développement du projet lui-même

Pour modifier le hub, le harness, le runtime, les contrôles ou les tests, travaille normalement dans le code du projet. La règle CLI ci-dessus ne s'applique pas au développement du framework.

ASTRABOX est indépendant du matériel. Le Raspberry Pi est une cible de déploiement optionnelle : garde les étapes système dans `deploy/raspberry-pi/`, sans dépendance obligatoire dans le cœur. Préserve l'installation desktop et le rendu existant. Ne committe pas `.arcade/`, les identifiants Codex, les conversations ou les jeux personnels générés.

- Lis `docs/CARTRIDGE_CONTRACT.md` avant de changer le contrat des jeux.
- Le framework standardise START P1/P2, scores, résultats, replay, entrées et sortie. Les jeux dessinent leurs propres écrans et gardent leurs DA.
- Menus : A valide/lance/rejoue, B revient au niveau précédent. START reste un raccourci compatible. En pleine partie, A/B restent des actions du jeu, jamais une sortie implicite.
- Contrôles arcade/joysticks d'abord. CODEX est une action système remappable distincte de START et des boutons d'action. Sortie : maintenir START P1 ou P2 pendant 3 secondes ; Escape reste disponible au clavier.
- Le menu doit rester une interface de borne : textes courts, phosphore jaune pâle, CRT. Pas de cartes glassmorphism, dashboard, fenêtre de chat, formulaire ou paramètres visibles en mode borne. Les outils opérateur sont réservés à `?debug=1`.
- Une modification simple doit être visible sans perdre la partie quand c'est raisonnable. Les changements structurels peuvent proposer un restart. Toute modification est sauvegardée. Une seule version publiée par jeu ; le dossier de travail est une préparation, pas un historique de versions.
- Vérifie avec `npm test`. `ARCADE_BROWSER_TESTS=1 npm test` inclut les tests Chromium. Ne présente jamais un mock ou un smoke test comme une validation complète d'un vrai appel Codex/vocal ou de la qualité du gameplay.
- Ne prétends pas intégrer une ressource inaccessible. Si l'algorithme, l'asset ou le service demandé n'est pas accessible, explique le blocage et demande ; ne remplace pas silencieusement la demande.
- Serveur localhost seulement. Le code JavaScript généré n'est pas une sandbox de sécurité pour un public hostile. Ne présente pas ce POC comme un déploiement public durci.
