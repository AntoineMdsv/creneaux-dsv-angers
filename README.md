# Créneaux de livraison DSV Angers

Remplace la page « CRENEAUX LIV » du Power BI et le fichier `CRENEAUX LIV 49.xlsx` : la liste des villes livrées par l'agence 49, leur tournée et leurs horaires de livraison, avec une carte.

- **Villes et carte** : recherche par ville ou code postal, filtres par tournée, regroupement de communes et heure (« Livrable à 14h00 »). Un clic sur une ville zoome la carte dessus. Fonds de carte : plan IGN (par défaut), OpenStreetMap ou photos aériennes IGN.
- **Par tournée** : les villes de chaque tournée, rangées par heure d'ouverture.
- **Modifier** (droit Modification) : ville, code postal, regroupement, tournée (et tournée de secours), une ou deux plages horaires ou « Tél. conducteur », remarque, position du point sur la carte. Chaque changement est signé dans l'historique.
- **Données** (administrateurs) : reprise du fichier Excel, export Excel aux colonnes de l'ancien fichier, villes sans position, historique.

On entre par le **portail DSV Angers** (tuile Créneaux). Les droits se donnent dans la page Accès du portail : Pas d'accès, Consultation ou Modification ; les administrateurs du portail voient l'onglet Données. L'appli n'a pas de page de connexion : une adresse ouverte sans passer par le portail y renvoie.

**Aucun code, aucune clé, aucune adresse de base ne doit être écrit dans ce dépôt.** Tout se règle dans Vercel.

## Mise en ligne (Vercel)

1. Vercel > Add New > Project : importer le dépôt `creneaux-dsv-angers`, sans rien changer aux réglages de build.
2. Onglet Storage : créer une base Neon et la relier au projet (`DATABASE_URL` est ajoutée automatiquement).
3. Settings > Environment Variables (voir ci-dessous), puis Deployments > Redeploy.
4. Dans le projet du portail : ajouter `CRENEAUX_URL` (adresse de cette appli), puis Redeploy du portail.
5. Portail > Accès : donner le droit Créneaux aux personnes.
6. Ouvrir l'appli par le portail, onglet Données : reprendre `CRENEAUX LIV 49.xlsx`.

## Réglages Vercel (Settings > Environment Variables)

- `DATABASE_URL` : ajoutée automatiquement quand on relie une base Neon.
- `PORTAIL_URL` : adresse du portail, par exemple `https://portail-dsv-angers.vercel.app`.
- `CLE_PORTAIL` : la même valeur que dans le portail et les autres applis.
- `CODE_ADMIN` (ancien code de secours) : n'ouvre plus l'appli. S'il est déjà réglé, le laisser tel quel (il sert de clé aux sessions : le changer déconnecte tout le monde). `NOM_ADMIN` ne sert plus.

`/api/health` indique si la base est reliée et si le portail est réglé.

## Positions sur la carte

À la reprise de l'Excel et quand on change une ville ou son code postal, la position est cherchée par la page auprès du service d'adresses de l'IGN (`data.geopf.fr/geocodage`, gratuit, sans clé), avec l'ancien service `api-adresse.data.gouv.fr` en secours. Une ancienne commune fusionnée (commune déléguée, par exemple Chalonnes-sous-le-Lude dans Noyant-Villages) n'est plus une commune pour ces services : elle est cherchée parmi les lieux-dits et les adresses qui portent encore son nom. Le bouton « Chercher à nouveau leur position » de l'onglet Données relance la recherche pour toutes les villes sans position. Une ville introuvable reste dans la liste ; on la place à la main avec « Placer sur la carte ». Un point mal placé se corrige avec « Déplacer le point ».

## Essayer en local

Avec une base Postgres locale et le portail lancé en local : `DATABASE_URL=postgres://… PORTAIL_URL=http://localhost:3001 CLE_PORTAIL=…(même clé que le portail) npm run dev`, puis ouvrir l'appli depuis le portail.
