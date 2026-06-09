# Progression — Job Journey API

## ✅ Fait

- ...
- src/validators/auth.validator.ts
- src/services/auth.service.ts
- src/controllers/auth.controller.ts
- src/routes/auth.routes.ts
- src/middlewares/auth.middleware.ts
- Auth testée et fonctionnelle (register, login, logout)

## 🔄 En cours

- CRUD Applications

## ⏭️ Prochaine étape

- src/validators/application.validator.ts
- src/services/application.service.ts
- src/controllers/application.controller.ts
- src/routes/application.routes.ts

## Décisions importantes

- `LearningItem` et `Resource` → reportés en V2
- `defaultInterviewSteps` → stocké en `Json` dans `User` (pas de table dédiée)
- `questionsAsked`, `blockers`, `toReview`, `notes` dans `InterviewStep` → `String` (texte libre, pas `String[]`)
- `PreparationTask` → a un champ `link String?` (pas de table Resource séparée)
- `Skill` (renommé depuis SkillTag) → many-to-many implicite avec `InterviewStep`
- Enums : `ApplicationStatus` (TARGETED/APPLIED/INTERVIEWING/OFFER/REJECTED), `InterviewStepStatus` (PLANNED/COMPLETED/CANCELLED), `InterviewStepType` (HR/TECHNICAL/FINAL/CUSTOM)
