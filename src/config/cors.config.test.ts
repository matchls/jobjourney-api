import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { corsOrigin, isAllowedOrigin } from "./cors.config";

// Tests unitaires purs : aucune base, aucun serveur, aucun reseau. La regle
// CORS est une decision de securite, elle doit etre lisible et verifiable
// isolement.

const PROJECT = "jobjourney-web";
const TEAM = "mathieu-chales-projects";
const PROD = "https://jobjourney-web.vercel.app";
const PREVIEW = `https://${PROJECT}-a1b2c3d4e-${TEAM}.vercel.app`;

const ENV_KEYS = [
  "CLIENT_URL",
  "CORS_VERCEL_PROJECT",
  "CORS_VERCEL_TEAM",
] as const;

let saved: Record<string, string | undefined>;

// Les variables sont relues a chaque appel : chaque test pose exactement le
// decor dont il a besoin, et le restaure ensuite.
const configure = (values: Partial<Record<(typeof ENV_KEYS)[number], string>>) => {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
};

const configureProduction = () =>
  configure({
    CLIENT_URL: PROD,
    CORS_VERCEL_PROJECT: PROJECT,
    CORS_VERCEL_TEAM: TEAM,
  });

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("CORS — origine de production", () => {
  test("autorise exactement CLIENT_URL", () => {
    configureProduction();

    assert.equal(isAllowedOrigin(PROD), true);
  });

  test("tolere un CLIENT_URL renseigne avec un slash final", () => {
    configure({ CLIENT_URL: `${PROD}/` });

    // Le navigateur n'envoie jamais de slash dans Origin : sans
    // normalisation, la production entiere serait refusee.
    assert.equal(isAllowedOrigin(PROD), true);
  });

  test("refuse une origine voisine de CLIENT_URL", () => {
    configureProduction();

    assert.equal(isAllowedOrigin("https://jobjourney-web.vercel.app.evil.net"), false);
    assert.equal(isAllowedOrigin("https://evil-jobjourney-web.vercel.app"), false);
    assert.equal(isAllowedOrigin("http://jobjourney-web.vercel.app"), false);
  });
});

describe("CORS — previews Vercel du projet declare", () => {
  test("autorise une preview du bon projet dans la bonne team", () => {
    configureProduction();

    assert.equal(isAllowedOrigin(PREVIEW), true);
  });

  test("refuse un autre projet Vercel de la meme team", () => {
    configureProduction();

    assert.equal(
      isAllowedOrigin(`https://autre-projet-a1b2c3d4e-${TEAM}.vercel.app`),
      false,
    );
  });

  test("refuse un projet dont le nom est prefixe par le notre", () => {
    configureProduction();

    // `jobjourney-web-copy` est un AUTRE projet, dans la MEME team : son URL
    // commence par `jobjourney-web-` et finit par `-<team>`. Seul le format
    // exact du hash central le distingue du notre.
    assert.equal(
      isAllowedOrigin(`https://${PROJECT}-copy-a1b2c3d4e-${TEAM}.vercel.app`),
      false,
    );
    assert.equal(
      isAllowedOrigin(`https://${PROJECT}-staging-a1b2c3d4e-${TEAM}.vercel.app`),
      false,
    );
    assert.equal(
      isAllowedOrigin(`https://${PROJECT}-2-a1b2c3d4e-${TEAM}.vercel.app`),
      false,
    );
  });

  test("exige un hash de 9 caracteres alphanumeriques exactement", () => {
    configureProduction();

    const wrongHashes = [
      "a1b2c3d4", // 8
      "a1b2c3d4ef", // 10
      "a1b2-c3d4", // 9 caracteres mais un tiret
      "a1b2_c3d4", // 9 caracteres mais un underscore
      "", // aucun hash
    ];

    for (const hash of wrongHashes) {
      const origin = `https://${PROJECT}-${hash}-${TEAM}.vercel.app`;
      assert.equal(isAllowedOrigin(origin), false, `devrait refuser ${origin}`);
    }

    // Le format exact, lui, passe.
    assert.equal(
      isAllowedOrigin(`https://${PROJECT}-a1b2c3d4e-${TEAM}.vercel.app`),
      true,
    );
  });

  test("refuse les URL de branche git, non distinguables de facon sure", () => {
    configureProduction();

    // `<projet>-git-<branche>-<team>` a un segment central de forme libre :
    // rien ne le distingue structurellement du nom d'un autre projet prefixe
    // par le notre. Hors perimetre de cette issue — utiliser l'URL commit
    // « View deployment ».
    assert.equal(
      isAllowedOrigin(`https://${PROJECT}-git-main-${TEAM}.vercel.app`),
      false,
    );
    assert.equal(
      isAllowedOrigin(
        `https://${PROJECT}-git-fix-25-vercel-preview-cors-${TEAM}.vercel.app`,
      ),
      false,
    );
  });

  test("refuse le bon projet dans une autre team", () => {
    configureProduction();

    assert.equal(
      isAllowedOrigin(`https://${PROJECT}-a1b2c3d4e-team-attaquant.vercel.app`),
      false,
    );
  });

  test("refuse une preview en HTTP", () => {
    configureProduction();

    assert.equal(
      isAllowedOrigin(`http://${PROJECT}-a1b2c3d4e-${TEAM}.vercel.app`),
      false,
    );
  });

  test("n'ouvre jamais *.vercel.app", () => {
    configureProduction();

    assert.equal(isAllowedOrigin("https://vercel.app"), false);
    assert.equal(isAllowedOrigin("https://n-importe-quoi.vercel.app"), false);
    assert.equal(isAllowedOrigin("https://attaquant-a1b2c3d4e-sa-team.vercel.app"), false);
  });

  test("refuse les lookalikes que laisserait passer un includes", () => {
    configureProduction();

    const lookalikes = [
      // Le projet apparait dans le hostname, mais pas en tete du label.
      `https://evil-${PROJECT}-a1b2c3d4e-${TEAM}.vercel.app`,
      `https://x${PROJECT}-a1b2c3d4e-${TEAM}.vercel.app`,
      // La team apparait, mais pas en fin de label.
      `https://${PROJECT}-a1b2c3d4e-${TEAM}-evil.vercel.app`,
      `https://${PROJECT}-a1b2c3d4e-${TEAM}evil.vercel.app`,
      // Un autre projet dont le nom commence par le notre.
      `https://${PROJECT}-copy-a1b2c3d4e-${TEAM}.vercel.app`,
      // vercel.app apparait, mais le domaine enregistrable est ailleurs.
      `https://${PROJECT}-a1b2c3d4e-${TEAM}.vercel.app.evil.net`,
      `https://${PROJECT}-a1b2c3d4e-${TEAM}.vercel.app.evil.app`,
      `https://vercel.app.evil.net`,
      // Label supplementaire : ce n'est pas l'URL de deploiement.
      `https://sub.${PROJECT}-a1b2c3d4e-${TEAM}.vercel.app`,
      // Domaine voisin de vercel.app.
      `https://${PROJECT}-a1b2c3d4e-${TEAM}.vercel.com`,
      `https://${PROJECT}-a1b2c3d4e-${TEAM}.notvercel.app`,
      // Port explicite : vercel.app n'en sert aucun.
      `https://${PROJECT}-a1b2c3d4e-${TEAM}.vercel.app:8443`,
      // Rien entre le prefixe projet et le suffixe team.
      `https://${PROJECT}-${TEAM}.vercel.app`,
    ];

    for (const origin of lookalikes) {
      assert.equal(isAllowedOrigin(origin), false, `devrait refuser ${origin}`);
    }
  });

  test("compare le hostname sans tenir compte de la casse", () => {
    configure({
      CLIENT_URL: PROD,
      CORS_VERCEL_PROJECT: PROJECT.toUpperCase(),
      CORS_VERCEL_TEAM: TEAM.toUpperCase(),
    });

    assert.equal(isAllowedOrigin(PREVIEW), true);
  });

  test("n'autorise aucune preview tant que la configuration est incomplete", () => {
    configure({ CLIENT_URL: PROD });
    assert.equal(isAllowedOrigin(PREVIEW), false);

    configure({ CLIENT_URL: PROD, CORS_VERCEL_PROJECT: PROJECT });
    assert.equal(isAllowedOrigin(PREVIEW), false);

    configure({ CLIENT_URL: PROD, CORS_VERCEL_TEAM: TEAM });
    assert.equal(isAllowedOrigin(PREVIEW), false);

    // La production, elle, reste autorisee dans tous ces cas.
    assert.equal(isAllowedOrigin(PROD), true);
  });
});

describe("CORS — requetes sans header Origin", () => {
  test("accepte une requete sans Origin", () => {
    configureProduction();

    // curl, appel serveur-a-serveur, health check : le header n'est pose que
    // par un navigateur, le refuser casserait ces clients sans rien proteger.
    assert.equal(isAllowedOrigin(undefined), true);
  });
});

describe("CORS — developpement local", () => {
  test("autorise localhost:3000 par defaut, sans CLIENT_URL", () => {
    configure({});

    assert.equal(isAllowedOrigin("http://localhost:3000"), true);
  });

  test("autorise le CLIENT_URL local quand il est renseigne", () => {
    configure({ CLIENT_URL: "http://localhost:3000" });

    assert.equal(isAllowedOrigin("http://localhost:3000"), true);
  });

  test("ne rend pas localhost universel", () => {
    configure({});

    assert.equal(isAllowedOrigin("http://localhost:4000"), false);
    assert.equal(isAllowedOrigin("http://evil.localhost:3000"), false);
  });

  test("ne laisse pas localhost ouvert quand CLIENT_URL vise la production", () => {
    configureProduction();

    assert.equal(isAllowedOrigin("http://localhost:3000"), false);
  });
});

describe("CORS — entrees malformees", () => {
  test("refuse ce qui n'est pas une URL absolue", () => {
    configureProduction();

    assert.equal(isAllowedOrigin(""), false);
    assert.equal(isAllowedOrigin("null"), false);
    assert.equal(isAllowedOrigin("jobjourney-web.vercel.app"), false);
    assert.equal(isAllowedOrigin("file:///etc/passwd"), false);
  });
});

describe("CORS — delegue passe a cors()", () => {
  test("repond sans erreur, avec un booleen", () => {
    configureProduction();

    const calls: Array<[Error | null, unknown]> = [];
    const callback = (err: Error | null, allowed?: unknown) =>
      calls.push([err, allowed]);

    corsOrigin(PREVIEW, callback);
    corsOrigin("https://evil.example.com", callback);
    corsOrigin(undefined, callback);

    // Une origine refusee renvoie `false`, jamais une Error : le navigateur
    // bloque de lui-meme, l'API n'a pas a repondre 500.
    assert.deepEqual(calls, [
      [null, true],
      [null, false],
      [null, true],
    ]);
  });
});
