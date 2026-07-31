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

## ⚠️ Problème connu (préexistant, hors scope skills)

- `npx tsc --noEmit` et `npm run build` échouent sur `src/app.ts` (incompatibilité de types entre `cors@2.8.6` et les overloads Express 5 sur `app.use(cors(...))`). Reproduit à l'identique sur `main` avant la feature skills — à traiter séparément (upgrade `@types/cors` ou cast ciblé).
