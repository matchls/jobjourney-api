// Configuration ESLint (format « flat config », ESLint 9).
//
// Objectif principal : détecter les variables et les imports jamais utilisés
// à l'intérieur d'un fichier, ce que `tsc` ne signale pas — le compilateur
// vérifie les types, pas l'hygiène du code.
//
// PORTÉE À CONNAÎTRE : `no-unused-vars` raisonne fichier par fichier et
// considère tout symbole `export`é comme utilisé, faute de savoir ce que font
// les autres fichiers. Un **export mort** — exporté, jamais importé nulle part —
// n'est donc PAS détecté par cette configuration. Le repérer demande une
// analyse inter-fichiers du graphe d'imports, faite par un outil dédié
// (`knip`, `ts-prune`) qui n'est pas installé ici. En attendant, un export
// suspect se vérifie à la main (`git grep -n <symbole>`).
//
// Le fichier est en .mjs car le projet est en CommonJS : l'extension force Node
// à le lire comme un module ES, ce qui permet la syntaxe `import` ici sans
// toucher au reste de la configuration TypeScript.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Rien à analyser dans le build ni dans les dépendances.
    ignores: ["dist/**", "node_modules/**"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["src/**/*.ts"],
    rules: {
      // Règle centrale de cette configuration. On garde la détection stricte,
      // avec une porte de sortie explicite : un identifiant préfixé par « _ »
      // signale une non-utilisation volontaire (paramètre imposé par une
      // signature, valeur ignorée d'une déstructuration...).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",

          // `const { maxAge, ...options } = ...` est la façon idiomatique de
          // retirer une clé d'un objet : la variable extraite n'est pas du code
          // mort, elle EST le mécanisme d'omission (voir cookie.config.ts).
          // Sans cette option, ESLint la signalerait à tort.
          ignoreRestSiblings: true,
        },
      ],

      // Dette existante, hors périmètre de l'issue #23 : 11 `catch (error: any)`
      // et assimilés. Les corriger demanderait de retyper les chemins d'erreur
      // des contrôleurs — un refactor qui toucherait au comportement des
      // endpoints. On les rend visibles sans bloquer le lint, à traiter dans
      // une issue dédiée.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
