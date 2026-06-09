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
- `src/app.ts` (Express + cors + cookieParser)
- `src/server.ts` (point d'entrée, port 4000)
- `src/validators/auth.validator.ts`
- `src/services/auth.service.ts`
- `src/controllers/auth.controller.ts`
- `src/routes/auth.routes.ts`
- `src/middlewares/auth.middleware.ts`
- Auth testée et fonctionnelle (register, login, logout)
- `src/validators/application.validator.ts`
- `src/services/application.service.ts`
- `src/controllers/application.controller.ts`
- `src/routes/application.routes.ts`
- CRUD Applications complet et testé (GET, POST, PATCH, DELETE)
- `src/validators/interview-step.validator.ts`
- `src/services/interview-step.service.ts`
- `src/controllers/interview-step.controller.ts`
- `src/routes/interview-step.routes.ts`
- CRUD InterviewSteps complet et testé (GET, POST, PATCH, DELETE)

## 🔄 En cours

- CRUD PreparationTasks

## ⏭️ Prochaine étape

- `src/validators/preparation-task.validator.ts`
- `src/services/preparation-task.service.ts`
- `src/controllers/preparation-task.controller.ts`
- `src/routes/preparation-task.routes.ts`

## Décisions importantes

- `LearningItem` et `Resource` → reportés en V2
- `defaultInterviewSteps` → stocké en `Json` dans `User` (pas de table dédiée)
- `questionsAsked`, `blockers`, `toReview`, `notes` dans `InterviewStep` → `String` (texte libre)
- `PreparationTask` → a un champ `link String?` (pas de table Resource séparée)
- `Skill` → many-to-many implicite avec `InterviewStep`
- Auth : JWT dans cookie httpOnly, pas de librairie externe (fait main)
- Base de données : PostgreSQL/Prisma/Neon (PAS MongoDB — Notion mis à jour)
- Google OAuth → reporté en V1.1
