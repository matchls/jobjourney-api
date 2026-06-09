# Job Journey — API (Express)

## Règles de collaboration

- **Ne crée rien sans demande explicite.** C'est le développeur qui code. Tu guides pas à pas : tu dis quoi créer, quoi écrire, quoi modifier — le développeur exécute.
- Avance fichier par fichier. Si un fichier est long, décompose-le en morceaux et explique chaque partie.
- Explique le pourquoi de chaque décision avant que le développeur écrive la moindre ligne.
- Pour chaque fichier : expliquer son rôle dans l'architecture ET sa logique de construction (comment il est organisé, dans quel ordre ça s'exécute) — sans décortiquer ligne par ligne, mais en donnant la vision d'ensemble avant les points clés.
- Réponds en français.
- **Niveau développeur : junior** (bootcamp fullstack 10 semaines). Les explications doivent être concises ET claires, accessibles à un débutant. Tu es expert, il est élève. Pas de jargon sans définition, pas d'étape sautée.
- **Fin de chaque feature commitable :** mettre à jour `PROGRESS.md` (✅ Fait, 🔄 En cours, ⏭️ Prochaine étape, décisions importantes), puis signaler exactement quand commiter avec le message formaté et la liste des fichiers concernés.

## Stack

- Node.js + Express + TypeScript
- Prisma ORM
- PostgreSQL via Neon (London, PG 18)
- JWT (cookies httpOnly) + Google OAuth

## Structure du projet

```
src/
├── config/         # variables d'env, configuration Prisma
├── controllers/    # logique des routes (handlers)
├── middlewares/    # auth, validation, erreurs
├── routes/         # déclaration des endpoints
├── services/       # logique métier
├── validators/     # schémas de validation (zod)
├── utils/          # helpers
├── types/          # types TypeScript partagés
├── app.ts          # configuration Express
└── server.ts       # point d'entrée
```

## Commandes utiles

```bash
npm run dev                  # démarre en mode watch (ts-node-dev ou tsx)
npx prisma studio            # interface visuelle pour la DB
npx prisma migrate dev       # crée et applique une migration
npx prisma generate          # régénère le client Prisma
```
