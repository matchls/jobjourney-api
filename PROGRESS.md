# Progression — Job Journey API

## ✅ Fait

- ...
- Schéma Prisma V1 + migration Neon
- src/config/prisma.ts (singleton client)
- tsconfig.json + scripts npm (dev/build/start)
- src/app.ts (Express + cors + cookieParser)
- src/server.ts (point d'entrée, port 4000)

## 🔄 En cours

- Auth (register, login, JWT, middleware)

## ⏭️ Prochaine étape

- src/validators/auth.validator.ts
- src/services/auth.service.ts
- src/controllers/auth.controller.ts
- src/routes/auth.routes.ts
- src/middlewares/auth.middleware.ts

## Décisions importantes

- `LearningItem` et `Resource` → reportés en V2
- `defaultInterviewSteps` → stocké en `Json` dans `User` (pas de table dédiée)
- `questionsAsked`, `blockers`, `toReview`, `notes` dans `InterviewStep` → `String` (texte libre, pas `String[]`)
- `PreparationTask` → a un champ `link String?` (pas de table Resource séparée)
- `Skill` (renommé depuis SkillTag) → many-to-many implicite avec `InterviewStep`
- Enums : `ApplicationStatus` (TARGETED/APPLIED/INTERVIEWING/OFFER/REJECTED), `InterviewStepStatus` (PLANNED/COMPLETED/CANCELLED), `InterviewStepType` (HR/TECHNICAL/FINAL/CUSTOM)
