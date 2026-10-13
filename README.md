# API Connectors

Plugin open-bot qui connecte les comptes de l'utilisateur (GitHub, Google, Slack) et expose un client API unifié pour tous les plugins et agents.

- **Page Connexions** (Dashboards → Connexions) : coller chaque clé, tester la connexion, voir le statut. Les clés vont dans le coffre d'open-bot et ne sont jamais affichées.
- **`ob-plugin-api-connectors-call <provider> <METHOD> <path>`** : appel unifié (headers d'auth automatiques, hôtes en liste blanche, timeout, masquage des clés).
- **`ob-plugin-api-connectors-status`** : état des connexions.

OAuth complet (refresh tokens) prévu en v2.
