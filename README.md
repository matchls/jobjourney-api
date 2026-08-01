# jobjourney-api

## Configuration

Copier `.env.example` vers `.env` et renseigner les valeurs (voir ce fichier pour la liste des variables et leur rôle).

## Authentification

- Email/mot de passe : `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
- Google OAuth : `GET /auth/google` (redirige vers Google), `GET /auth/google/callback` (échange le code, crée/lie l'utilisateur, pose le cookie `token`, puis redirige vers le frontend).
  - Sans `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL`, ces deux routes échouent proprement (redirection avec `oauthError=google_not_configured`) sans affecter l'auth email.
  - En cas d'erreur, redirection vers `${CLIENT_URL}/login?oauthError=<code>` avec un code stable (`google_cancelled`, `invalid_state`, `invalid_google_account`, `account_conflict`, `google_oauth_failed`, `google_not_configured`) — jamais de détail interne dans l'URL.
