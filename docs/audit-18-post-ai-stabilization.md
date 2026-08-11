# Audit de stabilisation post-IA — #18

**Date :** 11 août 2026
**Périmètre :** `jobjourney-api` (`ac0f74b`) et `jobjourney-web` (`83128aa`), après #16, #17, web#23 et web#24.

## Verdict

**READY FOR DAILY USE**

L'audit statique et les suites automatisées ne révèlent aucun défaut : les trois workflows (création manuelle, import agent, préremplissage IA) sont cohérents, ne se marchent pas dessus, et une panne du fournisseur IA ne bloque jamais la saisie manuelle.

La réserve qui maintenait ce rapport en `NOT READY` — tout ce qui touche au fournisseur n'avait été vérifié qu'avec Groq mocké — est levée : le smoke test E2E réel exigé par les critères de clôture de #18 a été exécuté avec succès le **11/08/2026**. Les dettes restantes sont listées plus bas et suivies en issues ; aucune n'empêche l'usage quotidien.

## Bloquants avant usage réel

Aucun.

## Validation E2E réelle — exécutée le 11/08/2026

Workflow complet déroulé une fois dans l'application déployée, contre le vrai fournisseur : frontend → API → Groq réel → préremplissage → correction humaine → création → relecture.

- [x] `GROQ_API_KEY` configurée sur l'environnement visé.
- [x] Ouverture de « Nouvelle candidature » puis « Importer une offre avec l'IA ».
- [x] Collage d'une annonce réelle (offre WeScale) et clic sur « Traiter l'offre » : chargement affiché, bouton désactivé.
- [x] Préremplissage correct des champs attendus, avec des valeurs exploitables.
- [x] **Aucune candidature créée pendant l'analyse.**
- [x] Correction humaine d'au moins un champ avant validation.
- [x] Création : **une seule** candidature, avec les valeurs visibles à l'écran.
- [x] Relecture de la candidature créée : valeurs persistées conformes, aucune métadonnée d'extraction.

Ce passage confirme ce que les tests mockés ne pouvaient pas prouver : clé effectivement prise en compte sur l'environnement déployé, réponse du modèle retenu conforme au JSON Schema en strict mode, et qualité d'extraction exploitable sur une annonce réelle.

Deux améliorations UX **non bloquantes** ont été repérées pendant ce passage et sont tracées : [web#29](https://github.com/matchls/jobjourney-web/issues/29) et [web#30](https://github.com/matchls/jobjourney-web/issues/30) (voir « Améliorations futures »).

## À corriger prochainement

| # | Sujet |
| --- | --- |
| [web#27](https://github.com/matchls/jobjourney-web/issues/27) | `contractType` et `notes` sont extraits, préremplis et persistés, mais absents de la fiche candidature : information capturée et non restituée. |
| [api#21](https://github.com/matchls/jobjourney-api/issues/21) | Pas de détection de doublon sur `POST /applications`, alors qu'elle existe sur l'import agent et sur `PATCH`. L'import IA rend le doublon accidentel plus probable. |
| [api#22](https://github.com/matchls/jobjourney-api/issues/22) | La section « Déploiement » du README ne mentionne pas `GROQ_API_KEY` : un déploiement qui la suit seule obtient une feature IA silencieusement en `503`. |

## Améliorations futures

| # | Sujet |
| --- | --- |
| [api#23](https://github.com/matchls/jobjourney-api/issues/23) | Aucun lint côté API ; l'export `isGroqConfigured` est mort depuis #17. |
| [web#28](https://github.com/matchls/jobjourney-web/issues/28) | La limite de 20 000 caractères est dupliquée en dur côté frontend, sans lien avec `MAX_LONG_TEXT` de l'API. |
| [web#29](https://github.com/matchls/jobjourney-web/issues/29) | Repéré au smoke test E2E : préremplir le lien et la source depuis une URL d'offre collée dans l'import IA. |
| [web#30](https://github.com/matchls/jobjourney-web/issues/30) | Repéré au smoke test E2E : replier le bloc « Détails de l'offre » sur la fiche candidature. |

Sans issue dédiée : la modale de création reste en `sm:max-w-sm` (384 px) alors qu'elle héberge désormais un textarea d'import de 6 lignes en plus des 14 champs. Utilisable, mais à réévaluer à l'usage réel plutôt que sur hypothèse.

## Vérifications sans action

**Architecture.** Un seul modèle `Application` (Prisma). Le contrat d'extraction #16 est une vue partielle explicite de `createApplicationSchema`, verrouillée par des assertions de type vérifiées au build : il ne peut pas dériver en troisième modèle. Les règles de champ (`field-rules.ts`) sont partagées entre formulaire, agent et extraction. Aucune migration Prisma ajoutée pour #16/#17, aucune dépendance npm ajoutée (appel Groq via `fetch` natif), aucun code temporaire laissé. Côté frontend, #24 étend `job-offer-prefill.ts` au lieu de créer une seconde liste de champs.

**Sécurité / confidentialité.** Aucune clé réelle dans les deux dépôts, ni dans l'historique : les seules occurrences sont des valeurs factices de test et `.env.example` ne contient que des placeholders. Le bundle client ne référence pas le fournisseur ; la seule variable `NEXT_PUBLIC_*` est l'URL de l'API. Seuls `offerText`, `offerUrl` et `sourceHint` partent chez le fournisseur, recopiés champ par champ dans le contrôleur — ni CV, ni profil, ni email de connexion, ni token. Le type `ExtractionLogEntry` n'a structurellement aucun champ où faire passer le texte de l'offre, la réponse du modèle ou la clé. Aucune erreur fournisseur n'est propagée : seul le statut HTTP est lu, et le frontend ne réaffiche jamais le message serveur.

**Endpoint IA.** `POST /applications/parse-offer` : auth cookie utilisateur (la clé agent ne l'ouvre pas), rate limit 20/10 min par utilisateur, corps plafonné à 256 kb, `offerText` borné à 20 000 caractères, timeout explicite (20 s, plafond 60 s), réponse du modèle systématiquement revalidée par Zod. Le service métier n'importe pas Prisma : l'absence de persistance est structurelle, pas déclarative.

**Prompt injection.** Les trois champs utilisateur sont sérialisés en JSON dans une même zone non fiable, encadrée par une balise à nonce régénéré à chaque requête ; le prompt système déclare qu'aucune instruction qui s'y trouve ne doit être exécutée. Couvert par des tests dédiés, y compris une injection placée dans `sourceHint` et dans le path d'une URL.

**Flux agent.** Intact et indépendant du nouveau workflow. Les deux suites hors ligne passent : `test-import-application.ps1` (88/88) et `test-agent-key-secure.ps1` (91/91), sans clé réelle ni appel sortant. La clé reste chiffrée par DPAPI, jamais en clair.

**Human-in-the-loop.** « Traiter l'offre » n'écrit rien : prouvé côté API (aucune `Application` créée, même après dix extractions) et côté frontend (aucun `POST /applications` pendant l'analyse). L'IA ne remplit que les champs vides, une saisie utilisateur n'est jamais écrasée, la candidature peut être créée avec des champs encore marqués « À vérifier », et `uncertainFields` / `warnings` / `confidenceByField` n'entrent jamais dans le payload de création.

**UX / accessibilité.** Textarea labellisé, disclosure avec `aria-expanded`, chargement annoncé (`role="status"`, `aria-busy`), erreurs en `role="alert"` et jamais signalées par la seule couleur, double appel bloqué par un verrou synchrone, focus placé sur le premier champ après succès et sur le textarea après erreur. « À vérifier » est un texte porté par le label, donc annoncé avec le champ. Aucun pourcentage de confiance n'est affiché. Une réponse arrivant après la fermeture de la modale est invalidée par une génération de session : ni préremplissage fantôme, ni badge résiduel.

**Cas IA.** Couverts par les tests des deux dépôts, fournisseur mocké : extraction complète et partielle, champs absents omis, texte vide / à la limite / au-delà, URL invalide ou dangereuse, champ inconnu, réponse hors contrat, timeout, 429 fournisseur, 5xx, panne réseau, rate limit API, et injection dans chacun des trois champs. Les cas de qualité d'extraction dépendant du modèle (entreprise masquée, cabinet de recrutement, contrat implicite, fourchette de salaire) relèvent de `uncertainFields`/`warnings`, dont l'affichage est vérifié côté frontend ; ils ne sont pas testables sans appel réel et sont à évaluer à l'usage.

## Tests exécutés

| | Commande | Résultat |
| --- | --- | --- |
| API | `npm test` | 193 tests, 0 échec |
| API | `npm run build` | OK |
| API | lint | inexistant — voir [api#23](https://github.com/matchls/jobjourney-api/issues/23) |
| API | `scripts/test-import-application.ps1` | 88/88 |
| API | `scripts/test-agent-key-secure.ps1` | 91/91 |
| Web | `npm test` | 64 tests, 0 échec |
| Web | `npm run build` | OK |
| Web | `npm run lint` | OK |
| E2E | smoke test manuel contre Groq réel (11/08/2026) | OK — voir la section dédiée |

CI : le frontend a un check Vercel (vert sur les PR #25 et #26). L'API n'a pas de CI configurée ; les commandes ci-dessus sont à lancer localement avant chaque merge.

Aucun test **automatisé** n'utilise de clé Groq réelle ni ne sort sur le réseau : le seul passage contre le vrai fournisseur est le smoke test manuel ci-dessus.
