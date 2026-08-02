# jobjourney-api

## Configuration

Copier `.env.example` vers `.env` et renseigner les valeurs (voir ce fichier pour la liste des variables et leur rôle).

## Authentification

- Email/mot de passe : `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
- Google OAuth : `GET /auth/google` (redirige vers Google), `GET /auth/google/callback` (échange le code, crée/lie l'utilisateur, pose le cookie `token`, puis redirige vers le frontend).
  - Sans `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL`, ces deux routes échouent proprement (redirection avec `oauthError=google_not_configured`) sans affecter l'auth email.
  - En cas d'erreur, redirection vers `${CLIENT_URL}/login?oauthError=<code>` avec un code stable (`google_cancelled`, `invalid_state`, `invalid_google_account`, `account_conflict`, `google_oauth_failed`, `google_not_configured`) — jamais de détail interne dans l'URL.

## Import de candidatures par agent (V1.1)

Workflow dédié pour permettre à un agent externe (pas un navigateur, pas un utilisateur) de créer des candidatures sans jamais toucher à SQL, aux cookies utilisateurs, ni à la lecture/modification/suppression de données : `agent → JSON → validation Zod → service applicatif → Prisma`.

### Authentification

- En-tête `Authorization: Bearer <clé>`, format de clé : `jja_<prefix>_<secret>` (`prefix` public sert uniquement à retrouver la clé en base, `secret` n'est jamais stocké — seul son hash HMAC-SHA-256, salé par `AGENT_API_KEY_PEPPER`, est conservé).
- Middleware dédié (`src/middlewares/agent-auth.middleware.ts`), totalement séparé de l'auth cookie classique. Vérifie format, préfixe, hash (comparaison en temps constant), révocation, expiration puis le scope `applications:create`.
- Sans `AGENT_API_KEY_PEPPER` configuré, le serveur démarre normalement mais toute route `/agent/*` répond `503 { "error": { "code": "agent_config_error" } }`.
- Toute clé absente, mal formée, inconnue ou avec un mauvais secret répond `401 { "error": { "code": "unauthorized" } }` — jamais de détail permettant de savoir si un préfixe existe. Clé révoquée/expirée/scope insuffisant → `403` avec un code dédié (`revoked_key`, `expired_key`, `insufficient_scope`).

### Génération d'une clé (script admin, pas d'interface de gestion en V1.1)

```bash
npm run agent-key:create -- --user-email=user@example.com --name="Import principal" --expires-days=90
```

Affiche le secret complet **une seule fois**, sur la sortie standard, jamais écrit dans un fichier ni un log persistant. Ne conserver que ce que l'opérateur copie immédiatement.

**Révocation manuelle** : pas d'endpoint dédié en V1.1. Poser `revokedAt = now()` sur la ligne `AgentApiKey` concernée (Prisma Studio ou une requête `UPDATE` directe), identifiée par son `prefix` (jamais par son secret, qui n'est pas récupérable).

### `POST /agent/applications`

En-têtes requis : `Authorization: Bearer <clé>`, `Content-Type: application/json`, `Idempotency-Key: <chaîne 1-128 caractères>`.

Corps JSON (`.strict()`, propriétés inconnues rejetées) :

```json
{
  "company": "Acme",
  "position": "Backend Engineer",
  "offerUrl": "https://example.com/jobs/42",
  "location": "Paris",
  "contractType": "CDI",
  "salary": "55k€",
  "jobDescription": "...",
  "notes": "...",
  "source": "LinkedIn",
  "stack": ["Node.js", "TypeScript"],
  "agentAnalysis": {
    "summary": "Bon match sur les compétences backend.",
    "score": 82,
    "confidenceByField": { "salary": 0.4, "location": 0.9 },
    "uncertainFields": ["salary"]
  }
}
```

Réponses :

- `201` — création : `{ "status": "created", "applicationId": "...", "duplicate": false, "idempotent": false }`
- `200` — doublon détecté (par `offerUrl` normalisée ou, à défaut, `entreprise+poste+localisation` normalisés) : `{ "status": "duplicate", "applicationId": "...", "duplicate": true, "idempotent": false }`
- `200` — relecture idempotente (même `Idempotency-Key` + même payload qu'un appel précédent) : `duplicate`/`status` reflètent le résultat d'origine, `idempotent: true`
- `409` — même `Idempotency-Key` avec un payload différent : `{ "error": { "code": "idempotency_conflict" } }`
- `400` — payload ou en-tête `Idempotency-Key` invalide : `{ "error": { "code": "validation_error", "fieldErrors": {}, "formErrors": [] } }`
- `401` / `403` — voir Authentification ci-dessus
- `413` — corps au-delà de ~32 Ko (limite propre à cette route, sans impact sur les autres)
- `429` — limite de débit atteinte, en-tête `Retry-After` (secondes) présent, `{ "error": { "code": "rate_limited" } }`

La candidature créée reçoit `creationSource: "AGENT_IMPORT"`, `status: "TARGETED"`, `importReviewStatus: "PENDING"` si `agentAnalysis.uncertainFields` est non vide (sinon `"NOT_REQUIRED"`), et `agentImportMetadata` limité à `stack`/`summary`/`score`/`confidenceByField` (jamais de secret, de token ou de clé d'idempotence).

### Revue utilisateur d'un import

`PATCH /applications/:id` (route existante, auth cookie classique) accepte désormais `confirmImportReview: true` en plus des champs métier habituels. Sur une candidature dont `creationSource === "AGENT_IMPORT"`, cela positionne `importReviewStatus = "REVIEWED"` et `reviewedAt = now()`. Ce n'est jamais transmis tel quel à Prisma, et le frontend ne peut pas modifier directement `creationSource`, `agentImportMetadata`, `importedByApiKeyId` ni `agentDedupKey` via cette route (absents du schéma de validation, donc silencieusement ignorés s'ils sont envoyés).

### Rate limiting

60 requêtes / 10 minutes, indexé par clé API (jamais sur les routes utilisateur classiques). Implémentation en mémoire (`src/middlewares/agent-rate-limit.middleware.ts`) : **limite locale à chaque instance Render**, pas de compteur partagé entre instances. Suffisant pour une seule instance ; prévoir un store partagé (Redis) avant de scaler horizontalement.

### Déploiement

Nouvelle migration `secure_agent_application_import` à appliquer sur Render via `npx prisma migrate deploy` avant le déploiement du code (pas exécutée automatiquement par ce dépôt). Ajouter `AGENT_API_KEY_PEPPER` aux variables d'environnement Render — sans elle, `/agent/*` répond `503` mais le reste de l'API continue de fonctionner normalement.

### Sécurité

L'agent n'a **aucun accès SQL**, aucune route de lecture, de modification ou de suppression — uniquement `POST /agent/applications` avec le scope `applications:create`. Toute autre tentative (scope insuffisant, méthode/route différente) est refusée par le middleware avant d'atteindre Prisma.
