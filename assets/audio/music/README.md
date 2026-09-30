# Petite orbite

Composition originale pour le menu ASTRABOX : 16 mesures, 92 BPM, environ
42 secondes. Boîte à musique, basse ronde et accords brisés ; pas de sample
ni de mélodie empruntée. Les sons CC0 du catalogue restent une banque d'effets
distincte, leur licence n'est pas attribuée à cette composition.

Source éditable : `scripts/compose-menu.mjs` ; régénérer avec
`node scripts/compose-menu.mjs`. `petite-orbite.mid` est un vrai Standard MIDI
File (format 0), ouvrable dans un séquenceur. Le menu le synthétise localement
via Web Audio, sans réseau ni périphérique MIDI. Les instruments sont une
interprétation rétro légère, pas une banque General MIDI réaliste.

Le menu baisse sa musique pendant la voix, l'arrête à l'entrée d'une
cartouche et la reprend au retour. Aucun nouveau bouton ou panneau ajouté.
Hors borne configurée pour l'autoplay, un premier clic/appui clavier peut
être nécessaire pour autoriser le son.
