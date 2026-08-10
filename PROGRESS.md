# Progression — Job Journey API

## ✅ Fait

- Initialisation du projet (npm, TypeScript, Express, Prisma, Git)
- Arborescence `src/` créée
- Connexion Neon + `DATABASE_URL` configurée
- Schéma Prisma V1 écrit et validé (User, Application, InterviewStep, PreparationTask, Skill)
- Migration initiale appliquée sur Neon (`20260608170351_init`)
- Downgrade Prisma v7 → v5 (v7 incompatible avec config classique)
- `src/config/prisma.ts` (singleton client)
- `tsconfig.json` + scripts npm (dev/build/start)
- `src/app.ts` (Express + cors + cookieParser + error handler global)
- `src/server.ts` (point d'entrée, port 4000)
- Auth complète : register, login, logout, GET /auth/me
- CRUD Applications complet et testé
- CRUD InterviewSteps complet et testé (nested sous /applications/:id)
- CRUD PreparationTasks complet et testé (nested sous /applications/:id)
- GET + PATCH /users/me (profil utilisateur)
- Backend V1 complet ✅
- `GET /dashboard` — stats candidatures + prochains entretiens (BFF endpoint)
- Historisation des statuts de candidature :
  - `statusChangedAt` (DateTime?) ajouté sur `Application`
  - Table `ApplicationStatusHistory` (fromStatus, toStatus, changedAt, createdAt)
  - Migration `20260714164748_add_status_history`
  - `createApplication` initialise `statusChangedAt`
  - `updateApplication` : détecte un changement de statut, met à jour `statusChangedAt` et crée une entrée d'historique dans une transaction Prisma (`$transaction`) — pas d'historique créé si le statut ne change pas
  - `getApplicationById` retourne `statusHistory` (trié du plus ancien au plus récent)
- API Skills (débloque jobjourney-web#9) :
  - CRUD complet `GET/POST/PATCH/DELETE /skills`, scopé par `userId`
  - `InterviewStep` accepte `skillIds?: string[]` en création/modification (`connect` en création, `set` en modification), renvoie `skills`
  - `PreparationTask` : `skillId` existant désormais vérifié (appartenance à l'utilisateur) en création/modification, renvoie `skill`
  - `getApplicationById` inclut `skills` sur les étapes d'entretien et `skill` sur les tâches de préparation
  - Vérification d'appartenance centralisée (`verifySkillOwnership` dans `skill.service.ts`) réutilisée par interview-steps et preparation-tasks — erreur `INVALID_SKILLS` → 400
  - `PATCH` preparation-task accepte `skillId: null` pour détacher une compétence liée
- Contrat commun d'extraction d'offre (`job-offer-extraction.validator.ts`) — données uniquement, aucun fournisseur IA branché

## 🔄 En cours

- Frontend (jobjourney-web)

## ⏭️ Prochaine étape

- Setup shadcn/ui
- Setup TanStack Query
- Layout + navigation (sidebar)
- Page Kanban

## Décisions importantes

- `LearningItem` et `Resource` → reportés en V2
- `defaultInterviewSteps` → stocké en `Json` dans `User` (pas de table dédiée)
- `questionsAsked`, `blockers`, `toReview`, `notes` dans `InterviewStep` → `String` (texte libre)
- `PreparationTask` → a un champ `link String?` (pas de table Resource séparée)
- `Skill` → many-to-many implicite avec `InterviewStep`
- Auth : JWT dans cookie httpOnly, pas de librairie externe (fait main)
- Base de données : PostgreSQL/Prisma/Neon (PAS MongoDB — Notion mis à jour)
- Google OAuth → reporté en V1.1
- Pas d'entrée d'historique créée à la création d'une candidature (seulement lors d'un changement de statut) — le champ `fromStatus` reste nullable en DB pour rester safe, mais n'est jamais `null` en pratique avec ce flux
- Skills : pas de nouvelle migration Prisma nécessaire, le modèle `Skill` et ses relations existaient déjà dans le schéma avant que le code applicatif ne les utilise
- `src/app.ts` : incompatibilité de types entre `cors@2.8.6` et les overloads Express 5 sur `app.use(cors(...))` (préexistante, reproduite sur `main`) — corrigée par un cast ciblé `cors(...) as unknown as express.RequestHandler` (contournement documenté pour ce mismatch de typings, sans impact runtime)
- Google OAuth backend (V1.1, `matchls/jobjourney-api#5`) :
  - `GET /auth/google` et `GET /auth/google/callback` (flux Authorization Code, sans Passport, dépendance `google-auth-library` uniquement)
  - State CSRF : valeur aléatoire (`crypto.randomBytes`) stockée dans un cookie httpOnly temporaire (`oauth_state`, 10 min, `sameSite: "lax"`), comparée puis supprimée à chaque appel du callback, que le flux réussisse ou échoue
  - `id_token` vérifié cryptographiquement par `google-auth-library` (signature, audience = `GOOGLE_CLIENT_ID`, `email_verified === true`) — les access/refresh tokens Google ne sont jamais stockés
  - Liaison de compte (`findOrCreateGoogleUser` dans `auth.service.ts`) : recherche par `googleId` → recherche par email (insensible à la casse) → création. Liaison automatique uniquement si le compte email existant a `googleId === null` ET `passwordHash === null` (compte OAuth pur non encore lié), sans écraser un `name`/`avatarUrl` déjà présent. Compte email/mot de passe existant (`passwordHash !== null`) → conflit (`account_conflict`), jamais de liaison automatique. Compte email existant avec un `googleId` différent → conflit (`account_conflict`), pas de fusion silencieuse. Conflit Prisma `P2002` (requêtes concurrentes) géré par re-lecture de l'utilisateur, mais uniquement si son `googleId` correspond exactement au profil Google du callback courant — sinon conflit (jamais de fallback par simple correspondance d'email)
  - Cookie JWT (`token`) : options extraites dans `src/config/cookie.config.ts`, réutilisées telles quelles par register/login/Google/logout — corrige au passage `logout` qui ne précisait pas `secure`/`sameSite`/`path` lors du `clearCookie` (risque de cookie non supprimé en prod)
  - Redirections frontend uniquement via des codes d'erreur publics stables (`oauthError=...`), jamais de message interne, de token ou de code OAuth dans une URL
  - Absence de configuration Google (`GOOGLE_CLIENT_ID`/`SECRET`/`CALLBACK_URL`) : les deux routes échouent proprement (redirection `oauthError=google_not_configured`), le reste du serveur et de l'auth email démarrent et fonctionnent normalement
  - Aucune migration Prisma nécessaire (`googleId` déjà présent dans le schéma), aucune modification de `jobjourney-web` (traité séparément dans `jobjourney-web#12`)
  - `.env.example` créé (n'existait pas)
- Import sécurisé des candidatures par agent (V1.1, `matchls/jobjourney-api#6`) :
  - Nouvelle route `POST /agent/applications`, isolée du reste de l'API : workflow exclusif `agent → JSON → validation Zod (.strict()) → service applicatif → Prisma`, aucun accès SQL/lecture/modification/suppression accordé à l'agent
  - Modèles Prisma `AgentApiKey` (clé limitée au scope `applications:create`, `secretHash` uniquement, `expiresAt`/`revokedAt`/`lastUsedAt`) et `AgentImportReceipt` (idempotence, unique `(apiKeyId, idempotencyKey)`) — migration `secure_agent_application_import`
  - `Application` : nouveaux champs `contractType`, `creationSource` (`MANUAL`/`AGENT_IMPORT`), `importReviewStatus` (`NOT_REQUIRED`/`PENDING`/`REVIEWED`), `uncertainFields`, `agentImportMetadata`, `agentDedupKey`, `importedByApiKeyId`, `reviewedAt` — anciennes candidatures conservées telles quelles (`creationSource = MANUAL`, `importReviewStatus = NOT_REQUIRED`, `uncertainFields = []` par défaut sur la colonne), contrainte unique `(userId, agentDedupKey)`
  - Format de clé `jja_<prefix>_<secret>` (`src/services/agent-api-key.service.ts`) : hash HMAC-SHA-256 salé par `AGENT_API_KEY_PEPPER`, comparaison `crypto.timingSafeEqual`, secret jamais stocké ni loggué. Script admin `npm run agent-key:create -- --user-email=... --name=... --expires-days=...` (affiche le secret complet une seule fois)
  - Middleware Bearer dédié (`agent-auth.middleware.ts`), totalement séparé de l'auth cookie : parsing strict, lookup par préfixe, hash constant-time, révocation/expiration/scope, réponses génériques (`401` ne révèle jamais si un préfixe existe ; `403` scope/révocation/expiration ; `503` si `AGENT_API_KEY_PEPPER` absent — le reste du serveur démarre normalement)
  - Rate limiting en mémoire dédié (`agent-rate-limit.middleware.ts`), 60 req/10 min par clé API, `429` + `Retry-After` — local à l'instance Render, documenté comme tel dans le README, n'affecte pas les routes utilisateur classiques
  - Déduplication (`src/utils/agent-dedup.ts`) : fingerprint SHA-256 par URL d'offre normalisée (fragment retiré, host/port par défaut normalisés par l'URL parser, paramètres de tracking `utm_*`/`gclid`/`fbclid` retirés) avec fallback `entreprise+poste+localisation` normalisés (Unicode NFKC, casse insensible, espaces réduits) si pas d'URL — `offerUrl` original toujours conservé tel quel
  - Idempotence : `requestHash` calculé sur une représentation canonique (clés triées) du payload validé ; même clé + même payload → `200 idempotent: true` ; même clé + payload différent → `409 idempotency_conflict` ; création + réservation d'idempotence + détection de doublon dans une même transaction Prisma, avec re-résolution explicite des courses concurrentes via capture des erreurs `P2002` (mêmes principes que `findOrCreateGoogleUser`)
  - Réponses : `201` création, `200` doublon ou relecture idempotente, `409` conflit d'idempotence, `400` erreurs Zod structurées (`{error:{code,fieldErrors,formErrors}}`), `413` body > 32 Ko (limite scoppée à `/agent` uniquement, sans impact sur les autres routes), `429` rate limit
  - Revue frontend (`web#14`) : `PATCH /applications/:id` accepte `confirmImportReview: true`, traduit en `importReviewStatus = REVIEWED` + `reviewedAt` uniquement sur une candidature `AGENT_IMPORT`, jamais transmis tel quel à Prisma ; `creationSource`/`agentImportMetadata`/`importedByApiKeyId`/`agentDedupKey` toujours absents du schéma de validation donc non modifiables par le frontend
  - Logs minimaux structurés (`src/utils/agent-logger.ts`) : événement, préfixe de clé, userId, résultat (`created`/`duplicate`/`idempotent`/`rejected`/`rate_limited`), jamais de secret/hash/payload
  - Tests `node:test` (`npm test`, aucune nouvelle dépendance de test) : unitaires (parsing de clé, hash/comparaison, validation Zod, normalisation/dédup) + intégration sur la vraie base de dev (nettoyage strict via cascade au delete du user de test) couvrant scope/révocation/expiration/idempotence/doublon (URL et fallback)/concurrence/ownership/absence de secret dans les logs/confirmation de revue/non-régression de l'auth email
  - **Limite connue V1.1** : rate limiting en mémoire non partagé entre instances si l'API tourne un jour sur plusieurs instances Render simultanées ; pas d'interface de gestion/révocation des clés (script de création uniquement, révocation manuelle en base)
- Import simplifié par clé agent chiffrée (V1.1, `matchls/jobjourney-api#13`) :
  - `scripts/setup-agent-key.ps1` : saisie masquée (`Read-Host -AsSecureString`), validation du préfixe `jja_` faite en lisant le tampon non managé du `SecureString` (jamais de `String` .NET, qui serait immuable donc ineffaçable), puis stockage chiffré DPAPI via `Export-Clixml` dans `%APPDATA%\JobJourney\agent-key.xml`
  - Chemin de destination **en dur** (aucun paramètre de chemin) + garde-fous refusant le dépôt Git, un `.env` et tout chemin non absolu — au cas où `%APPDATA%` serait détourné. Écrasement protégé par `-Force`. Relecture de contrôle après écriture (type + longueur), sans jamais déchiffrer en clair
  - `scripts/import-application-secure.ps1` : enveloppe pure — pose `JOB_JOURNEY_AGENT_KEY` le temps d'un appel, délègue **toute** la logique à `scripts/import-application.ps1` (aucune duplication réseau/validation), renvoie sa sortie telle quelle, et supprime la variable dans un bloc `finally` (succès comme échec). Défaut `-ApiBaseUrl` = instance déployée, contrairement au script appelé dont le défaut reste `localhost`
  - Refus explicite d'un magasin contenant un secret **non chiffré** (`Import-Clixml` ne rendant pas un `SecureString`) : sans ce contrôle, une clé stockée en clair par erreur serait acceptée en silence. Les messages d'erreur ne recopient jamais le contenu du fichier, pas même le blob chiffré
  - Tests hors ligne `scripts/test-agent-key-secure.ps1` (91 assertions, sans Pester) : `%APPDATA%` redirigé vers un dossier temporaire, `Read-Host` simulé par une fonction locale qui masque le cmdlet, imports contre un serveur factice sur `127.0.0.1`, assertion finale prouvant que le magasin réel n'a pas été touché
  - **Limite connue** : DPAPI lie le secret au compte Windows, pas au programme — tout processus exécuté sous ce compte peut déchiffrer le fichier. Protège contre la copie du fichier vers une autre machine ou un autre compte, pas contre un logiciel malveillant lancé par l'utilisateur
- Contrat commun d'extraction d'offre (V1.2, `matchls/jobjourney-api#16`) — **contrat de données uniquement**, aucun appel IA/réseau, aucune migration Prisma, aucun endpoint :
  - `src/validators/field-rules.ts` : source de vérité unique des règles de champ, organisée en deux familles assumées. Famille **form** (`emptyStringToUndefined`, `optionalFormUrl`, `optionalFormEmail`) = ce que le navigateur envoie (`""` quand on vide un champ, formats permissifs). Famille **machine** (`blankStringToUndefined`, `requiredText`, `optionalText`, `optionalEmail`, `optionalOfferUrl`, `isSafeOfferUrl`, `confidenceScore`, plafonds `MAX_SHORT_TEXT`/`MAX_LONG_TEXT`/`MAX_URL_LENGTH`) = ce qu'un agent ou un extracteur produit (trim, longueurs bornées, URL `http(s)` sans identifiants intégrés). Les règles *machine* sont strictement plus strictes que les règles *form*, donc une valeur extraite valide reste valide à la création manuelle
  - `application.validator.ts` et `agent-application.validator.ts` consomment désormais ces règles au lieu de les redéfinir — **aucun changement de comportement** (les règles ont été déplacées à l'identique, pas durcies). Les bornes propres au flux agent (`MAX_STACK_*`, `MAX_UNCERTAIN_FIELDS`, `MAX_FIELD_NAME_LENGTH`, `MAX_CONFIDENCE_ENTRIES`) restent locales au validateur agent
  - `src/validators/job-offer-extraction.validator.ts` : `jobOfferExtractionResultSchema` = aperçu d'offre **avant** confirmation utilisateur. Champs extraits imbriqués sous `fields` (12 champs, tous optionnels, `.strict()`), métadonnées non persistées à côté (`confidenceByField`, `uncertainFields`, `warnings`). L'imbrication évite toute collision entre un futur champ d'offre et un nom de métadonnée, et rend `fields` directement mappable
  - Périmètre fermé : `JOB_OFFER_EXTRACTION_FIELDS` (company, position, source, offerUrl, location, contractType, salary, jobDescription, notes, contactName, contactRole, contactEmail) vs `USER_OWNED_APPLICATION_FIELDS` (`appliedAt`, `status`, `resumeText`, `coverLetterText`, `referralNote`) — ces derniers relèvent de l'action ou des données personnelles de l'utilisateur et sont refusés par le `.strict()`
  - `confidenceByField` utilise `z.partialRecord(z.enum(...), 0..1)` : en Zod 4, `z.record()` avec des clés d'enum est **exhaustif** (il exigerait les 12 clés) — `partialRecord` donne le comportement voulu et rejette gratuitement les clés hors périmètre. `uncertainFields` est un tableau du même enum, sans doublon
  - Trois assertions vérifiées à la compilation (`npm run build`) : chaque champ extrait existe sur `createApplicationSchema`, aucun champ extrait n'empiète sur les champs possédés par l'utilisateur, et la liste `JOB_OFFER_EXTRACTION_FIELDS` ne peut pas diverger des clés du schéma. Le contrat ne peut donc pas dériver en silence
  - `toApplicationPrefill()` : fonction pure qui traduit un résultat d'extraction en `Partial<CreateApplicationInput>` pour préremplir la modale. Aucune écriture en base, aucune métadonnée recopiée, champs absents omis (le frontend distingue « non extrait » de « extrait vide »). `company`/`position` restent obligatoires **côté création manuelle uniquement** — une extraction peut légitimement ne rien trouver
  - Tests `node:test` : `job-offer-extraction.validator.test.ts` (contrat complet/partiel/vide, normalisation des chaînes vides, URL et email invalides, bornes de confiance 0 et 1 acceptées / hors bornes refusées, clés inconnues, champs utilisateur refusés, mapping) et `application.validator.test.ts` (non-régression du formulaire manuel, qui n'avait pas de test unitaire dédié jusqu'ici)
