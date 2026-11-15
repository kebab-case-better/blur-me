# Blur Me — floutage de visages

Floutez les visages de vos photos et vidéos, directement dans votre navigateur.

**[Ouvrir l'outil →](https://kebab-case-better.github.io/blur-me/)**

## Principe

- **100 % local** — les fichiers ne quittent jamais votre appareil. Aucun serveur, aucun traceur, aucune ressource externe : la bibliothèque et le modèle de détection sont servis depuis ce dépôt.
- **Photos** — détection automatique, zones activables/désactivables d'un clic, ajout de zones à la main en traçant un rectangle. Export en JPEG.
- **Vidéos** — traitement image par image à vitesse réelle, son conservé. Export en MP4 ou WebM selon le navigateur.
- **Trois styles** — flou, pixels, cache noir. Le détail d'origine est détruit, pas seulement atténué.
- **Métadonnées retirées** — les fichiers exportés sont recréés à partir des pixels (pas de GPS, d'appareil ni de date d'origine).

## Limites

La détection automatique peut manquer des visages (de profil, masqués, très petits, en mouvement rapide). **Vérifiez toujours le résultat avant de publier.** Pour les vidéos, gardez l'onglet visible pendant le traitement.

## Développement

Aucune étape de build. Servez simplement les fichiers statiques :

```bash
python3 -m http.server 8000
```

## Technique

- JavaScript sans framework, Canvas API, MediaRecorder
- [face-api](https://github.com/vladmandic/face-api) (MIT) avec le modèle SSD MobileNet v1, embarqués dans `lib/` et `models/`

## Licence

MIT
