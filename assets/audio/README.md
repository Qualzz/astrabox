# Banque sonore pour les cartouches

Le catalogue local est disponible à `/assets/audio/catalog.json`. Il fournit 24 effets courts de Kenney Digital Audio sous CC0, sans dépendance réseau pendant le jeu. Provenance et vérifications : [SOURCES.md](SOURCES.md).

## Utilisation par Codex

1. Lire le catalogue et choisir quelques sons cohérents avec la DA du jeu. Cette banque est une ressource, pas une identité sonore imposée à toutes les cartouches.
2. Utiliser les `id` stables et résoudre leur `file` depuis le catalogue. Les tags décrivent les familles de noms du pack ; écouter avant de décider d'un rôle précis dans le gameplay.
3. Charger uniquement les sons utilisés avec le service audio du SDK. Ne pas précharger toute la banque et ne pas déclencher une nouvelle instance à chaque frame.
4. Laisser le runtime gérer le déverrouillage audio sur une action utilisateur, le volume global et l'atténuation pendant la voix. Ne pas démarrer de lecture autonome hors du service partagé.
5. Pour exporter une cartouche autonome, copier seulement les fichiers retenus avec leur notice et mettre à jour leurs chemins dans le manifeste de cette cartouche.

### Structure du catalogue

```js
const { sounds } = await fetch('/assets/audio/catalog.json').then(r => r.json());
const effect = sounds.find(sound => sound.id === 'power-up-7');
// effect.file : URL locale à fournir au chargeur audio du SDK.
// effect.duration : secondes ; effect.license : "CC0-1.0".
```

`source` référence un élément du tableau `sources`. Les SHA-256 et tailles concernent les fichiers originaux ; si un nouvel effet dérivé est enregistré, lui donner une entrée distincte avec ses propres métadonnées. Pas d'historique automatique des anciennes versions.

Validation des fichiers et du catalogue :

```sh
node --test tests/audio-bank.test.js
```
