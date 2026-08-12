# jobjourney-api

## Configuration

Copier `.env.example` vers `.env` et renseigner les valeurs (voir ce fichier pour la liste des variables et leur rôle).

## CORS

L'API accepte les requêtes navigateur de **deux** familles d'origines, et d'aucune autre (`src/config/cors.config.ts`) :

1. l'origine exacte de `CLIENT_URL` (à défaut `http://localhost:3000` en développement) ;
2. les previews Vercel **d'un seul projet dans une seule team**, déclarés explicitement.

`credentials: true` est conservé : les cookies d'authentification circulent, ce qui rend la restriction d'origine critique.

### Previews Vercel

Une preview Vercel a l'URL `https://<projet>-<hash>-<team>.vercel.app`. Deux variables décrivent celle qu'on accepte :

| Variable | Exemple | Rôle |
| --- | --- | --- |
| `CORS_VERCEL_PROJECT` | `jobjourney-web` | Nom du projet Vercel du frontend |
| `CORS_VERCEL_TEAM` | `mathieu-chales-projects` | Slug de la team Vercel propriétaire |

Les deux sont **optionnelles et sans secret**. Elles sont publiques par nature : ces valeurs apparaissent déjà dans l'URL de chaque preview.

**Fail-closed** : si l'une des deux manque ou est vide, **aucune** preview n'est autorisée et l'API se comporte exactement comme avant (seul `CLIENT_URL` passe).

Règle appliquée, volontairement structurelle :

- HTTPS uniquement — une preview en `http://` est refusée ;
- hostname découpé en labels DNS, avec **exactement** `<déploiement>.vercel.app` (3 labels, aucun port) ;
- le label de déploiement doit commencer par `<projet>-` **et** finir par `-<team>`, avec quelque chose entre les deux.

Il n'y a **aucune** règle `*.vercel.app` : ce domaine est ouvert à l'inscription, une telle règle autoriserait le site de n'importe qui à parler à l'API avec les cookies de nos utilisateurs. La comparaison ne fait jamais de `includes` : `evil-jobjourney-web-x-team.vercel.app`, `jobjourney-web-x-team.vercel.app.evil.net` et `jobjourney-web-x-teamevil.vercel.app` sont tous refusés.

Le verrou réel est le **suffixe team** : le slug est attribué par Vercel, personne hors de la team ne peut produire une URL qui s'y termine. Le nom de projet seul ne protégerait rien.

### À ajouter dans Render

Dans *Environment* du service API, ajouter ces deux variables (aucun secret, aucune migration, aucun redéploiement du frontend nécessaire) :

```
CORS_VERCEL_PROJECT=jobjourney-web
CORS_VERCEL_TEAM=<slug-de-la-team-vercel>
```

Le slug de team se lit dans l'URL d'une preview existante : c'est le segment juste avant `.vercel.app`. Vérifier aussi que `CLIENT_URL` pointe bien sur le domaine de production du frontend — il reste la seule origine de production autorisée.

Sans ces variables, l'API démarre et fonctionne normalement : seules les previews restent bloquées.

## Authentification

- Email/mot de passe : `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
- Google OAuth : `GET /auth/google` (redirige vers Google), `GET /auth/google/callback` (échange le code, crée/lie l'utilisateur, pose le cookie `token`, puis redirige vers le frontend).
  - Sans `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL`, ces deux routes échouent proprement (redirection avec `oauthError=google_not_configured`) sans affecter l'auth email.
  - En cas d'erreur, redirection vers `${CLIENT_URL}/login?oauthError=<code>` avec un code stable (`google_cancelled`, `invalid_state`, `invalid_google_account`, `account_conflict`, `google_oauth_failed`, `google_not_configured`) — jamais de détail interne dans l'URL.

## Extraction IA d'une offre (V1.2)

`POST /applications/parse-offer` — auth cookie utilisateur classique (`authenticate`), **jamais la clé agent**.

Transforme le texte brut d'une annonce en aperçu structuré destiné à préremplir le formulaire de nouvelle candidature. **Cet endpoint n'écrit rien** : il ne crée, ne modifie et ne supprime aucune `Application`. Le service métier n'importe même pas Prisma. C'est l'utilisateur qui valide ensuite le formulaire, ce qui appelle le `POST /applications` habituel.

```jsonc
// Requête
{
  "offerText": "texte brut collé par l'utilisateur", // obligatoire, 1 à 20 000 caractères
  "offerUrl": "https://example.com/jobs/42",         // optionnel, http(s) sans identifiants
  "sourceHint": "LinkedIn"                           // optionnel
}
```

La réponse est exactement le contrat d'extraction défini en #16 (`jobOfferExtractionResultSchema`) : `fields` (12 champs, ceux qui sont absents de l'offre sont omis), plus `confidenceByField`, `uncertainFields` et `warnings`, qui ne sont jamais persistés.

### Fournisseur

Groq, isolé derrière l'interface `JobOfferExtractionProvider` (`src/services/job-offer-extraction.provider.ts`). Seul `groq-job-offer-extraction.provider.ts` connaît l'API Groq ; le contrôleur et le service n'en savent rien. La réponse du modèle est **toujours revalidée** par le schéma Zod de #16, même si Groq garantit la conformité au JSON Schema en strict mode.

Configuration : `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_TIMEOUT_MS` (voir `.env.example`). Le modèle et le timeout sont centralisés dans `src/config/groq.config.ts`, jamais dispersés dans le code.

### Confidentialité

Seuls `offerText`, `offerUrl` et `sourceHint` sont envoyés au fournisseur. Aucun profil utilisateur, email de connexion, CV, lettre de motivation ni mot de passe ne quitte l'API. Les logs (`src/utils/extraction-logger.ts`) n'acceptent structurellement que des identifiants et des codes : ni le texte de l'offre, ni la réponse brute du modèle, ni la clé Groq ne peuvent y être écrits.

**Prompt injection.** Les trois champs viennent du même formulaire utilisateur : aucun n'est traité comme une métadonnée de confiance. Ils sont sérialisés en JSON à l'intérieur d'une **même zone non fiable**, encadrée par une balise dont le suffixe est régénéré à chaque requête. Deux protections superposées : le nonce empêche un contenu piégé de « fermer » la zone pour faire passer la suite pour des instructions, et l'encodage JSON empêche un champ de se faire passer pour un autre. Le prompt système déclare explicitement que les trois champs sont des données à analyser, qu'aucune instruction qui s'y trouve ne doit être exécutée, et que `sourceHint` n'est qu'un indice de provenance — ni une consigne, ni une vérité absolue (si l'annonce indique une autre provenance, l'annonce prime et l'écart part dans `warnings`).

### Erreurs

| Code | HTTP | Cause |
| --- | --- | --- |
| `validation_error` | 400 | `offerText` vide, trop long, ou champ inconnu |
| `payload_too_large` | 413 | Corps de requête au-delà de 256 kb |
| `rate_limited` | 429 | Budget utilisateur dépassé (voir ci-dessous) |
| `extraction_rate_limited` | 429 | Quota du fournisseur épuisé |
| `extraction_not_configured` | 503 | `GROQ_API_KEY` absente ou refusée |
| `extraction_timeout` | 504 | Le fournisseur n'a pas répondu à temps |
| `extraction_unavailable` | 502 | Fournisseur en panne (5xx, réseau) |
| `extraction_invalid_response` | 502 | Réponse non conforme au contrat #16 |

**Fallback manuel :** une indisponibilité de l'IA ne bloque jamais la création d'une candidature. Les limites et quotas du fournisseur peuvent évoluer sans préavis ; en cas d'échec, le frontend doit simplement ouvrir le formulaire vide et laisser l'utilisateur saisir sa candidature normalement via `POST /applications`.

### Rate limiting

20 requêtes / 10 minutes, indexé par utilisateur (`src/middlewares/parse-offer-rate-limit.middleware.ts`). Chaque appel consomme du quota Groq payant, d'où une limite plus basse que celle du flux agent. Même réserve que pour l'agent : compteur en mémoire, **local à chaque instance Render**.

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

### Import simplifié — clé chiffrée par Windows (méthode recommandée)

Deux scripts, compatibles Windows PowerShell 5.1, qui évitent de ressaisir la clé à chaque session et de nettoyer `JOB_JOURNEY_AGENT_KEY` à la main :

| Script | Fréquence | Rôle |
| --- | --- | --- |
| `scripts/setup-agent-key.ps1` | **une seule fois** | enregistre la clé, chiffrée par Windows |
| `scripts/import-application-secure.ps1` | à chaque candidature | déchiffre, importe, nettoie |

Le second n'est qu'une enveloppe : toute la logique (validation, JSON, transport HTTPS, idempotence, redaction des erreurs) reste dans `scripts/import-application.ps1`, décrit plus bas.

#### 1. Enregistrer la clé — une seule fois

```powershell
.\scripts\setup-agent-key.ps1
```

La saisie est masquée (`Read-Host -AsSecureString`). Le script vérifie que la clé n'est pas vide, ne commence ni ne finit par une espace, et commence bien par `jja_`, puis l'écrit **chiffrée** dans :

```
%APPDATA%\JobJourney\agent-key.xml
```

Le chiffrement repose sur **DPAPI** (Data Protection API de Windows), appliqué automatiquement par `Export-Clixml` à un `SecureString`. La clé de chiffrement est dérivée du **compte Windows courant** : le fichier n'est déchiffrable que par cet utilisateur, sur cette machine. Copié ailleurs, il est inexploitable.

Ce que le script ne fait jamais : afficher la clé, la journaliser, l'écrire en clair, la placer dans un `.env` ou dans le dépôt. Le chemin de destination est **en dur** — aucun paramètre ne permet de désigner un autre emplacement — et trois garde-fous refusent malgré tout d'écrire dans le dépôt Git, dans un `.env`, ou vers un chemin relatif, au cas où `%APPDATA%` pointerait ailleurs.

La clé enregistrée n'est jamais écrasée par accident : réenregistrer exige `-Force`.

```powershell
.\scripts\setup-agent-key.ps1 -Force   # remplace la cle existante
```

Sortie (aucun secret) :

```
Cle enregistree, chiffree par Windows (DPAPI).
Fichier   : C:\Users\<vous>\AppData\Roaming\JobJourney\agent-key.xml
Longueur  : 42 caracteres
```

#### 2. Importer une candidature — une seule commande

```powershell
.\scripts\import-application-secure.ps1 -InputFile .\ma-candidature.json
```

Plus de préparation, plus de nettoyage manuel. Le wrapper :

1. lit et déchiffre `%APPDATA%\JobJourney\agent-key.xml` ;
2. pose `JOB_JOURNEY_AGENT_KEY` **le temps d'un seul appel** ;
3. appelle `scripts/import-application.ps1`, dont il renvoie la sortie telle quelle ;
4. **supprime `JOB_JOURNEY_AGENT_KEY` dans un bloc `finally`** — donc aussi quand l'import échoue.

Paramètres :

| Paramètre | Obligatoire | Défaut | Rôle |
| --- | --- | --- | --- |
| `-InputFile` | oui | — | Chemin du fichier JSON à importer |
| `-ApiBaseUrl` | non | `https://jobjourney-api.onrender.com` | URL de base de l'API |
| `-IdempotencyKey` | non | GUID généré par le script appelé | Clé d'idempotence |

> **Attention au défaut.** Contrairement à `import-application.ps1` (qui vise `http://localhost:4000`), ce wrapper est l'outil du geste quotidien : son défaut est **l'instance déployée**. Pour tester en local, passer explicitement `-ApiBaseUrl http://localhost:4000`.

Les règles de transport restent celles du script appelé : HTTPS obligatoire hors machine locale, refus **avant** ouverture du moindre socket.

À la sortie, la variable n'existe plus :

```powershell
Test-Path Env:JOB_JOURNEY_AGENT_KEY   # False, apres succes comme apres echec
```

Elle est **supprimée, pas restaurée** : si une valeur avait été posée manuellement avant l'appel, elle disparaît aussi. Laisser un secret posé « parce qu'il y était avant » irait contre le but du script.

#### 3. Messages d'erreur

| Situation | Message |
| --- | --- |
| Aucune clé enregistrée | `Aucune clé agent enregistrée : '...agent-key.xml' est introuvable.` + invitation à lancer `setup-agent-key.ps1` |
| Fichier modifié, tronqué, ou copié depuis une autre machine/un autre compte | `Le fichier '...' est illisible ou corrompu.` + invitation à relancer le setup |
| Fichier contenant un secret **non chiffré** | refusé explicitement — sans ce contrôle, une clé stockée en clair par erreur serait acceptée en silence |

Aucun de ces messages ne recopie le contenu du fichier, pas même le blob chiffré.

#### 4. Modèle de menace — ce que DPAPI protège et ne protège pas

| | |
| --- | --- |
| ✅ | La clé n'est plus ressaisie à chaque session, ni collée dans un prompt, ni écrite en clair où que ce soit. |
| ✅ | Le fichier est **inexploitable sur une autre machine ou sous un autre compte Windows** : sauvegarde cloud, clé USB, dépôt, partage réseau. |
| ✅ | `JOB_JOURNEY_AGENT_KEY` ne survit pas à l'import, même en cas d'erreur — la fenêtre d'exposition passe de « toute la session » à « la durée d'un appel HTTP ». |
| ⚠️ | **Tout processus exécuté sous CE compte Windows peut déchiffrer ce fichier.** DPAPI lie le secret à l'utilisateur, il ne cloisonne pas les programmes de cet utilisateur entre eux. Un logiciel malveillant lancé par vous y a accès, exactement comme vous. |
| ⚠️ | Pendant l'appel, la clé existe en clair dans le processus et dans son bloc d'environnement — c'est inévitable puisqu'elle part dans un en-tête HTTP. |
| ⚠️ | Un `Ctrl+C` est intercepté par le `finally` et la variable est nettoyée ; une **fermeture brutale du processus** (kill, coupure de courant) ne l'est pas. La variable n'existant que dans ce processus, elle disparaît malgré tout avec lui. |

Conséquences pratiques : garder la clé limitée au scope `applications:create`, la créer avec `--expires-days`, savoir la révoquer (`revokedAt` sur la ligne `AgentApiKey`), et supprimer le fichier quand il n'est plus utile :

```powershell
Remove-Item "$env:APPDATA\JobJourney\agent-key.xml"
```

#### 5. Validation locale

Tests hors ligne, sans clé réelle et sans appel sortant — `%APPDATA%` est redirigé vers un dossier temporaire, `Read-Host` est simulé, et les imports visent un serveur factice sur `127.0.0.1`. Une assertion finale prouve que le magasin réel n'a pas été touché :

```powershell
.\scripts\test-agent-key-secure.ps1
```

Couverture : setup nominal, saisies refusées (vide, mauvais préfixe, casse, trop courte, espaces), protection contre l'écrasement, refus d'écrire dans le dépôt, absence de la clé en clair dans le fichier, import mocké de bout en bout, fidélité du cycle pour une clé à caractères spéciaux, nettoyage de la variable après succès **et** après erreur, fichier absent, fichier corrompu, blob DPAPI tronqué, secret non chiffré refusé, et absence de fuite du secret dans toutes les sorties.

---

### Import local depuis PowerShell (`scripts/import-application.ps1`) — méthode manuelle, conservée en secours

Script versionné permettant d'envoyer un fichier JSON vers `POST /agent/applications` depuis un poste Windows, **sans connecteur MCP et sans stocker le moindre secret dans le dépôt**. Compatible Windows PowerShell 5.1 (aucun module externe requis).

C'est **l'implémentation de référence** : le wrapper sécurisé ci-dessus l'appelle sans rien réimplémenter. Cette section reste la méthode de secours, utile quand DPAPI n'est pas disponible ou souhaitable — poste partagé, compte de service, machine autre que celle où la clé a été enregistrée, ou débogage du script lui-même.

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

- **Ne pas mettre la clé dans un `.env`** ni dans aucun fichier du dépôt : elle se pose en variable de session uniquement, ou dans le magasin chiffré `%APPDATA%\JobJourney\agent-key.xml` (hors dépôt, hors `.env`, voir la méthode recommandée plus haut).
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
