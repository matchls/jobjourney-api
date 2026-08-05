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

### Import local depuis PowerShell (`scripts/import-application.ps1`)

Script versionné permettant d'envoyer un fichier JSON vers `POST /agent/applications` depuis un poste Windows, **sans connecteur MCP et sans stocker le moindre secret dans le dépôt**. Compatible Windows PowerShell 5.1 (aucun module externe requis).

Un exemple de charge utile conforme au schéma est fourni dans `examples/agent-application.example.json`.

#### 1. Préparer la clé pour la session PowerShell courante (saisie masquée)

```powershell
$secure = Read-Host 'Cle API Job Journey' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $env:JOB_JOURNEY_AGENT_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    Remove-Variable secure, bstr -ErrorAction SilentlyContinue
}
```

`Read-Host -AsSecureString` évite que la clé apparaisse à l'écran et dans l'historique de la console.

Le pointeur renvoyé par `SecureStringToBSTR` doit être **conservé puis libéré** avec `ZeroFreeBSTR` : cette mémoire non managée n'est pas récupérée par le ramasse-miettes. L'enchaîner directement (`PtrToStringBSTR([...]::SecureStringToBSTR($secure))`) laisserait la clé en clair dans le processus jusqu'à sa fermeture, sans aucun moyen de la nettoyer.

Ce que cette étape garantit — et ce qu'elle ne garantit pas :

- ✅ la clé n'est pas saisie en clair à l'écran, ni enregistrée dans l'historique de commandes ;
- ✅ elle n'est écrite sur aucun disque, dans aucun fichier du dépôt ;
- ✅ elle disparaît à la fermeture de la fenêtre PowerShell ;
- ⚠️ **une fois posée, la valeur est une variable d'environnement en clair dans ce processus.** Tout programme lancé depuis cette session en hérite et peut la lire. `SecureString` protège la saisie, pas la variable qui en résulte.

#### 2. Exécuter le script

```powershell
.\scripts\import-application.ps1 -InputFile .\examples\agent-application.example.json
```

Sortie (uniquement les champs opérationnels) :

```
status  applicationId                        duplicate idempotent
------  -------------                        --------- ----------
created 3f6c1b2e-5a94-4d0e-9f3a-8b1c2d4e5f60     False      False
```

Paramètres :

| Paramètre | Obligatoire | Défaut | Rôle |
| --- | --- | --- | --- |
| `-InputFile` | oui | — | Chemin du fichier JSON à importer |
| `-ApiBaseUrl` | non | `http://localhost:4000` | URL de base de l'API — HTTPS obligatoire hors machine locale |
| `-IdempotencyKey` | non | GUID généré | Clé d'idempotence envoyée dans l'en-tête `Idempotency-Key` |

Rejouer le même fichier avec la **même** `-IdempotencyKey` renvoie la candidature d'origine (`idempotent: true`) au lieu d'en créer une seconde ; le rejouer avec une clé différente déclenche la détection de doublon (`duplicate: true`). Sans `-IdempotencyKey`, une clé unique est générée à chaque exécution.

#### 3. Cibler une API locale ou de test

La valeur par défaut vise le serveur de développement local (`npm run dev`, port 4000) : **aucune exécution n'atteint la production tant qu'on ne le demande pas explicitement**.

```powershell
# API locale (valeur par défaut, rappelée ici pour mémoire)
.\scripts\import-application.ps1 -InputFile .\ma-candidature.json -ApiBaseUrl http://localhost:4000

# Instance déployée — à ne passer que sciemment
.\scripts\import-application.ps1 -InputFile .\ma-candidature.json -ApiBaseUrl https://jobjourney-api.onrender.com
```

**Transport : HTTPS obligatoire hors machine locale.** La clé voyage en clair dans l'en-tête `Authorization` ; sur `http://`, n'importe quel intermédiaire réseau la lit. Le script n'accepte donc `http://` que vers la loopback (`localhost`, `127.0.0.0/8`, `::1`) et refuse toute autre destination HTTP **avant d'ouvrir le moindre socket** — la clé n'est jamais émise, pas même une fois :

```
.\scripts\import-application.ps1 -InputFile .\c.json -ApiBaseUrl http://api.exemple.com
# HTTPS est obligatoire pour 'http://api.exemple.com' : en HTTP, la clé
# JOB_JOURNEY_AGENT_KEY circulerait en clair sur le réseau. [...]
```

Toutes les vérifications (fichier présent, `JOB_JOURNEY_AGENT_KEY` présente, JSON valide, clé d'idempotence valide, transport autorisé) ont lieu **avant** le moindre appel réseau. Les erreurs HTTP sont remontées avec leur code et le code d'erreur de l'API (`unauthorized`, `validation_error`, `rate_limited`…), jamais avec l'en-tête `Authorization` de la requête.

**Redaction des messages d'erreur.** Le corps d'une réponse HTTP provient d'un serveur qu'on ne contrôle pas : une API mal écrite, une passerelle ou un reverse proxy peut recopier l'en-tête `Authorization` dans son message d'erreur. Le script masque donc la valeur exacte de la clé par `[REDACTED]` dans **tout** message remonté — corps JSON (`formErrors`, `fieldErrors`), corps non JSON, et messages d'exception génériques — tout en conservant les informations utiles :

```
# Corps renvoyé par une passerelle :
#   502 Bad Gateway - upstream rejected request with header Authorization: Bearer jja_...
# Message affiché par le script :
L'API a répondu HTTP 502 (Bad Gateway). 502 Bad Gateway - upstream rejected
request with header Authorization: Bearer [REDACTED]
```

Validation locale du script, sans clé réelle et sans appel réseau sortant (serveur factice sur `127.0.0.1`) :

```powershell
.\scripts\test-import-application.ps1
```

#### 4. Nettoyer après utilisation — étape manuelle et obligatoire

Il faut bien distinguer deux choses :

| Ce qui est effacé automatiquement | Ce qui persiste |
| --- | --- |
| Les **copies locales détenues par le script** en fin d'exécution : la chaîne contenant la clé, l'en-tête `Authorization` construit pour la requête, et le secret utilisé pour la redaction. Effacées dans un bloc `finally`, donc y compris quand l'import échoue. | La **variable de session** `$env:JOB_JOURNEY_AGENT_KEY`. Le script ne la supprime **pas**, volontairement : elle doit rester disponible pour enchaîner plusieurs imports dans la même fenêtre. |

Le script ne nettoie donc **pas** la variable de session à votre place. Tant qu'elle est posée, tout processus lancé depuis cette fenêtre peut la lire. Une fois les imports terminés :

```powershell
Remove-Item Env:JOB_JOURNEY_AGENT_KEY -ErrorAction SilentlyContinue
```

Fermer la fenêtre PowerShell a le même effet, la variable n'existant que dans ce processus. Vérification :

```powershell
Test-Path Env:JOB_JOURNEY_AGENT_KEY   # doit renvoyer False
```

#### 5. Utilisation depuis un agent local

Le workflow fonctionne avec n'importe quel outil exécuté localement (agent de développement en ligne de commande, tâche planifiée, script maison). Poser la variable comme à l'étape 1 **dans le terminal, avant de lancer l'outil** ; celui-ci en hérite et le script y lit la clé au moment de l'appel.

```powershell
# 1. Poser la variable (voir l'etape 1 pour le snippet complet avec ZeroFreeBSTR)
# 2. Lancer l'outil local depuis CETTE session
mon-agent-local
```

L'instruction donnée à l'outil ne contient alors aucun secret :

> Lis l'offre dans `offre.txt`, produis un JSON conforme à `examples/agent-application.example.json`, enregistre-le dans `candidature.json`, puis exécute
> `.\scripts\import-application.ps1 -InputFile .\candidature.json`
> et rapporte-moi `status`, `applicationId`, `duplicate` et `idempotent`.

##### Modèle de menace — ce qui est réellement protégé

| | |
| --- | --- |
| ✅ | La clé n'est **pas** placée dans le prompt, ni dans un fichier, ni dans le dépôt, ni dans l'historique de la conversation. |
| ✅ | Le script ne l'affiche pas, ne la journalise pas, ne l'écrit nulle part, ne la transmet qu'en HTTPS hors machine locale, et la masque (`[REDACTED]`) dans tout message d'erreur — y compris si le serveur la recopie dans sa réponse. |
| ⚠️ | **Tout processus lancé depuis cette session hérite de la variable d'environnement et peut techniquement la lire.** L'outil local exécute le script dans un processus enfant : rien ne l'empêche, techniquement, de lire `JOB_JOURNEY_AGENT_KEY` directement. |
| ⚠️ | Ne pas placer la clé dans le prompt réduit la surface d'exposition (pas de fuite vers un historique de conversation, un journal distant ou une capture d'écran). **Ce n'est pas un isolement.** |

Conséquences pratiques :

- **N'utiliser que des outils locaux de confiance** dans une session où la variable est posée. Le modèle de sécurité repose sur la confiance accordée au binaire lancé, pas sur un cloisonnement technique.
- **Garder la clé limitée** : elle ne porte que le scope `applications:create` et ne donne accès à aucune lecture, modification ou suppression (voir « Authentification » plus haut).
- **La garder temporaire** : créer les clés avec `--expires-days` (voir la commande de génération) plutôt que sans expiration.
- **Savoir la révoquer** : poser `revokedAt = now()` sur la ligne `AgentApiKey` correspondante suffit à la neutraliser immédiatement.
- **La retirer dès la fin de l'import** (étape 4), ou simplement fermer la fenêtre PowerShell.

#### ⚠️ Règles de sécurité

- **Ne pas mettre la clé dans un `.env`** ni dans aucun fichier du dépôt : elle se pose en variable de session uniquement.
- **Ne jamais committer de secret** — ni clé, ni fichier d'environnement, ni exemple contenant une vraie clé.
- **Ne jamais coller la clé dans une conversation** (agent, chat, ticket, capture d'écran) : un secret collé doit être considéré comme compromis et révoqué (`revokedAt` sur la ligne `AgentApiKey`, voir plus haut).
- **Ne pas laisser la variable posée plus longtemps que nécessaire** : le script n'efface que ses propres copies en mémoire, la variable de session reste posée jusqu'au nettoyage manuel de l'étape 4.
- Le script ne journalise, n'affiche et n'écrit jamais la clé, ne crée aucun fichier, et masque sa valeur dans tout message d'erreur.

### Revue utilisateur d'un import

`PATCH /applications/:id` (route existante, auth cookie classique) accepte désormais `confirmImportReview: true` en plus des champs métier habituels. Sur une candidature dont `creationSource === "AGENT_IMPORT"`, cela positionne `importReviewStatus = "REVIEWED"` et `reviewedAt = now()`. Ce n'est jamais transmis tel quel à Prisma, et le frontend ne peut pas modifier directement `creationSource`, `agentImportMetadata`, `importedByApiKeyId` ni `agentDedupKey` via cette route (absents du schéma de validation, donc silencieusement ignorés s'ils sont envoyés).

### Rate limiting

60 requêtes / 10 minutes, indexé par clé API (jamais sur les routes utilisateur classiques). Implémentation en mémoire (`src/middlewares/agent-rate-limit.middleware.ts`) : **limite locale à chaque instance Render**, pas de compteur partagé entre instances. Suffisant pour une seule instance ; prévoir un store partagé (Redis) avant de scaler horizontalement.

### Déploiement

Nouvelle migration `secure_agent_application_import` à appliquer sur Render via `npx prisma migrate deploy` avant le déploiement du code (pas exécutée automatiquement par ce dépôt). Ajouter `AGENT_API_KEY_PEPPER` aux variables d'environnement Render — sans elle, `/agent/*` répond `503` mais le reste de l'API continue de fonctionner normalement.

### Sécurité

L'agent n'a **aucun accès SQL**, aucune route de lecture, de modification ou de suppression — uniquement `POST /agent/applications` avec le scope `applications:create`. Toute autre tentative (scope insuffisant, méthode/route différente) est refusée par le middleware avant d'atteindre Prisma.
