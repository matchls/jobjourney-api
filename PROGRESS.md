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
