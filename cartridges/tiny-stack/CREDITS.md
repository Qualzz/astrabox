TINY STACK — jeu solo original, graphismes procéduraux locaux.

Effets : pepSound1.ogg (pose), highUp.ogg (départ), lowDown.ogg (échec).
Collection Digital Audio, Kenney Vleugels (Kenney.nl), licence CC0-1.0.
Source : https://kenney.nl/assets/digital-audio
Licence : https://creativecommons.org/publicdomain/zero/1.0/
Fichiers partagés fournis par la borne : /assets/audio/kenney-digital/.

Règle : A conserve l’intersection exacte avec le bloc supérieur. Une
intersection vide termine la partie. Chaque bloc réussi rapporte un point.
La base ne compte pas. START démarre ou rejoue ; jeu exclusivement solo.

État version 1 : blocs et identifiants, bloc mobile, direction, score,
caméra, morceaux en chute et temporisations. Les vitesses, couleurs et
la hauteur des blocs sont relues depuis config.json ; vitesse et hauteur
s’appliquent aussi aux entités en cours. initialWidth règle la base des
nouvelles parties et ne redimensionne pas une pile existante.
