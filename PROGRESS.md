# Progression — Job Journey API

## ✅ Fait

- Initialisation du projet (npm, TypeScript, Express, Prisma, Git)
- Arborescence `src/` créée
- Connexion Neon + `DATABASE_URL` configurée
- Schéma Prisma V1 écrit et validé (User, Application, InterviewStep, PreparationTask, Skill)
- Migration initiale appliquée sur Neon (`20260608170351_init`)
- Downgrade Prisma v7 → v5 (v7 incompatible avec config classique)

## 🔄 En cours

- Setup client Prisma (`src/config/prisma.ts`)

## ⏭️ Prochaine étape

- `src/config/prisma.ts` — singleton Prisma Client
- Auth (register, login, JWT, middleware)

## Décisions importantes

- `LearningItem` et `Resource` → reportés en V2
- `defaultInterviewSteps` → stocké en `Json` dans `User` (pas de table dédiée)
- `questionsAsked`, `blockers`, `toReview`, `notes` dans `InterviewStep` → `String` (texte libre, pas `String[]`)
- `PreparationTask` → a un champ `link String?` (pas de table Resource séparée)
- `Skill` (renommé depuis SkillTag) → many-to-many implicite avec `InterviewStep`
- Enums : `ApplicationStatus` (TARGETED/APPLIED/INTERVIEWING/OFFER/REJECTED), `InterviewStepStatus` (PLANNED/COMPLETED/CANCELLED), `InterviewStepType` (HR/TECHNICAL/FINAL/CUSTOM)
