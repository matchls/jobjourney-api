import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../app";
import prisma from "../config/prisma";
import {
  __setJobOfferExtractionProviderForTests,
} from "../services/job-offer-extraction.service";
import {
  JobOfferExtractionError,
  JobOfferExtractionErrorCode,
  JobOfferExtractionInput,
} from "../services/job-offer-extraction.provider";
import { __resetParseOfferRateLimitStateForTests } from "../middlewares/parse-offer-rate-limit.middleware";
import { jobOfferExtractionResultSchema } from "../validators/job-offer-extraction.validator";
import { MAX_OFFER_TEXT_LENGTH } from "../validators/parse-offer.validator";

// Tests d'integration sur la vraie app Express et la base de dev, mais SANS
// aucun appel reseau externe : le fournisseur d'extraction est remplace par un
// double injecte. Aucune cle Groq n'est necessaire ni utilisee.

const TEST_RUN_ID = `parseoffer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_EMAIL = `${TEST_RUN_ID}@example.test`;
const TEST_PASSWORD = "correct-horse-battery-staple";

const OFFER_TEXT =
  "Acme recrute un Backend Engineer a Paris en CDI, 55k. Contact : camille@example.com";

let server: http.Server;
let baseUrl: string;
let userId: string;
let authCookie: string;

const FULL_PREVIEW = {
  fields: {
    company: "Acme",
    position: "Backend Engineer",
    source: "LinkedIn",
    offerUrl: "https://example.com/jobs/42",
    location: "Paris",
    contractType: "CDI",
    salary: "55k",
    jobDescription: "Construire l'API de facturation.",
    notes: "Equipe de 6.",
    contactName: "Camille Durand",
    contactRole: "Recruteuse",
    contactEmail: "camille@example.com",
  },
  confidenceByField: { company: 1, salary: 0.4 },
  uncertainFields: ["salary"],
  warnings: ["Salaire exprime en fourchette."],
};

// Le double n'appelle rien : il rend ce qu'on lui demande de rendre.
const useProviderReturning = (value: unknown) =>
  __setJobOfferExtractionProviderForTests({ extract: async () => value });

const useProviderFailing = (code: JobOfferExtractionErrorCode) =>
  __setJobOfferExtractionProviderForTests({
    extract: async () => {
      throw new JobOfferExtractionError(code);
    },
  });

const captureProviderInput = () => {
  const seen: JobOfferExtractionInput[] = [];
  __setJobOfferExtractionProviderForTests({
    extract: async (input) => {
      seen.push(input);
      return { fields: { company: "Acme" } };
    },
  });
  return seen;
};

const postParseOffer = (body: unknown, cookie: string | null = authCookie) =>
  fetch(`${baseUrl}/applications/parse-offer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });

const countApplications = () => prisma.application.count({ where: { userId } });

describe("POST /applications/parse-offer", () => {
  before(async () => {
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine test server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    const registerRes = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    assert.equal(registerRes.status, 201);
    const setCookie = registerRes.headers.get("set-cookie");
    assert.ok(setCookie, "expected a Set-Cookie header");
    authCookie = setCookie!.split(";")[0];
    userId = (await registerRes.json()).id;
  });

  after(async () => {
    __setJobOfferExtractionProviderForTests(null);
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(() => {
    __resetParseOfferRateLimitStateForTests();
    useProviderReturning({ fields: { company: "Acme" } });
  });

  describe("authentification", () => {
    test("refuse une requete sans cookie avec 401", async () => {
      const res = await postParseOffer({ offerText: OFFER_TEXT }, null);
      assert.equal(res.status, 401);
    });

    test("refuse un cookie invalide avec 401", async () => {
      const res = await postParseOffer({ offerText: OFFER_TEXT }, "token=nimportequoi");
      assert.equal(res.status, 401);
    });

    test("la cle agent n'ouvre pas cette route", async () => {
      const res = await fetch(`${baseUrl}/applications/parse-offer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer jja_whatever_secret",
        },
        body: JSON.stringify({ offerText: OFFER_TEXT }),
      });
      assert.equal(res.status, 401);
    });
  });

  describe("validation de l'entree", () => {
    test("accepte un payload valide", async () => {
      const res = await postParseOffer({
        offerText: OFFER_TEXT,
        offerUrl: "https://example.com/jobs/42",
        sourceHint: "LinkedIn",
      });
      assert.equal(res.status, 200);
    });

    test("refuse un texte vide", async () => {
      for (const offerText of ["", "   ", "\n\t "]) {
        const res = await postParseOffer({ offerText });
        assert.equal(res.status, 400, `attendu 400 pour ${JSON.stringify(offerText)}`);
        const body = await res.json();
        assert.equal(body.error.code, "validation_error");
      }
    });

    test("refuse un offerText absent", async () => {
      const res = await postParseOffer({ sourceHint: "LinkedIn" });
      assert.equal(res.status, 400);
    });

    test("refuse un texte trop long", async () => {
      const res = await postParseOffer({
        offerText: "a".repeat(MAX_OFFER_TEXT_LENGTH + 1),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, "validation_error");
      assert.ok(body.error.fieldErrors.offerText);
    });

    test("accepte un texte exactement a la limite", async () => {
      const res = await postParseOffer({
        offerText: "a".repeat(MAX_OFFER_TEXT_LENGTH),
      });
      assert.equal(res.status, 200);
    });

    test("refuse une offerUrl invalide ou dangereuse", async () => {
      for (const offerUrl of ["pas-une-url", "javascript:alert(1)", "https://u:p@x.com/a"]) {
        const res = await postParseOffer({ offerText: OFFER_TEXT, offerUrl });
        assert.equal(res.status, 400, `attendu 400 pour ${offerUrl}`);
      }
    });

    test("refuse un champ inconnu", async () => {
      const res = await postParseOffer({
        offerText: OFFER_TEXT,
        resumeText: "mon CV",
      });
      assert.equal(res.status, 400);
    });

    test("aucun appel fournisseur si la validation echoue", async () => {
      const seen = captureProviderInput();
      const res = await postParseOffer({ offerText: "" });
      assert.equal(res.status, 400);
      assert.equal(seen.length, 0);
    });
  });

  describe("donnees transmises au fournisseur", () => {
    test("ne transmet que offerText, offerUrl et sourceHint", async () => {
      const seen = captureProviderInput();

      await postParseOffer({
        offerText: OFFER_TEXT,
        offerUrl: "https://example.com/jobs/42",
        sourceHint: "LinkedIn",
      });

      assert.equal(seen.length, 1);
      assert.deepEqual(Object.keys(seen[0]).sort(), [
        "offerText",
        "offerUrl",
        "sourceHint",
      ]);
      // Rien du compte Job Journey ne doit fuiter vers le fournisseur.
      const serialized = JSON.stringify(seen[0]);
      assert.equal(serialized.includes(TEST_EMAIL), false);
      assert.equal(serialized.includes(userId), false);
      assert.equal(serialized.includes(TEST_PASSWORD), false);
    });
  });

  describe("sortie conforme au contrat #16", () => {
    test("extraction complete", async () => {
      useProviderReturning(FULL_PREVIEW);

      const res = await postParseOffer({ offerText: OFFER_TEXT });
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(jobOfferExtractionResultSchema.safeParse(body).success);
      assert.equal(body.fields.company, "Acme");
      assert.deepEqual(body.uncertainFields, ["salary"]);
    });

    test("extraction partielle : les champs absents sont omis", async () => {
      useProviderReturning({ fields: { company: "Acme", location: "Paris" } });

      const res = await postParseOffer({ offerText: OFFER_TEXT });
      const body = await res.json();

      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(body.fields).sort(), ["company", "location"]);
      assert.equal("salary" in body.fields, false);
    });

    test("la reponse ne contient jamais de champ possede par l'utilisateur", async () => {
      useProviderReturning(FULL_PREVIEW);

      const body = await (await postParseOffer({ offerText: OFFER_TEXT })).json();

      for (const field of ["status", "appliedAt", "resumeText", "coverLetterText", "referralNote"]) {
        assert.equal(field in body.fields, false, `${field} ne doit pas sortir`);
      }
    });

    test("une reponse fournisseur hors contrat est rejetee en 502", async () => {
      useProviderReturning({ fields: { company: "Acme", recruiterPhone: "0600" } });

      const res = await postParseOffer({ offerText: OFFER_TEXT });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).error.code, "extraction_invalid_response");
    });
  });

  describe("aucune persistance", () => {
    test("une extraction reussie ne cree aucune Application", async () => {
      useProviderReturning(FULL_PREVIEW);
      const before = await countApplications();

      const res = await postParseOffer({ offerText: OFFER_TEXT });
      assert.equal(res.status, 200);

      assert.equal(await countApplications(), before);
    });

    test("dix extractions d'affilee ne creent toujours rien", async () => {
      useProviderReturning(FULL_PREVIEW);
      const before = await countApplications();

      for (let i = 0; i < 10; i += 1) {
        assert.equal((await postParseOffer({ offerText: OFFER_TEXT })).status, 200);
      }

      assert.equal(await countApplications(), before);
    });
  });

  describe("erreurs fournisseur mappees sur des codes stables", () => {
    const cases: Array<[JobOfferExtractionErrorCode, number]> = [
      ["extraction_not_configured", 503],
      ["extraction_timeout", 504],
      ["extraction_rate_limited", 429],
      ["extraction_unavailable", 502],
      ["extraction_invalid_response", 502],
    ];

    for (const [code, status] of cases) {
      test(`${code} -> ${status}`, async () => {
        useProviderFailing(code);

        const res = await postParseOffer({ offerText: OFFER_TEXT });

        assert.equal(res.status, status);
        assert.deepEqual(await res.json(), { error: { code } });
      });
    }

    test("une panne du fournisseur ne cree aucune Application", async () => {
      useProviderFailing("extraction_unavailable");
      const before = await countApplications();

      await postParseOffer({ offerText: OFFER_TEXT });

      assert.equal(await countApplications(), before);
    });

    test("une erreur inattendue est mappee en 500 sans detail", async () => {
      __setJobOfferExtractionProviderForTests({
        extract: async () => {
          throw new Error(`fuite potentielle : ${OFFER_TEXT}`);
        },
      });

      const res = await postParseOffer({ offerText: OFFER_TEXT });
      const body = await res.json();

      assert.equal(res.status, 500);
      assert.equal(body.error.code, "extraction_unexpected_error");
      assert.equal(JSON.stringify(body).includes("Backend Engineer"), false);
    });
  });

  describe("rate limiting par utilisateur", () => {
    test("bloque en 429 au-dela du budget et renvoie Retry-After", async () => {
      useProviderReturning({ fields: { company: "Acme" } });

      let lastStatus = 0;
      let attempts = 0;

      // Le budget est de 20 requetes par fenetre de 10 minutes.
      while (attempts < 25) {
        const res = await postParseOffer({ offerText: OFFER_TEXT });
        lastStatus = res.status;
        const body = await res.json();
        attempts += 1;
        if (lastStatus === 429) {
          assert.equal(body.error.code, "rate_limited");
          assert.ok(res.headers.get("retry-after"));
          break;
        }
        assert.equal(lastStatus, 200);
      }

      assert.equal(lastStatus, 429, "le limiteur doit finir par bloquer");
      assert.equal(attempts, 21, "20 requetes autorisees, la 21e bloquee");
    });

    test("le rate limit du fournisseur et celui de l'API ont des codes distincts", async () => {
      useProviderFailing("extraction_rate_limited");

      const res = await postParseOffer({ offerText: OFFER_TEXT });

      assert.equal(res.status, 429);
      assert.equal((await res.json()).error.code, "extraction_rate_limited");
    });
  });

  describe("journalisation", () => {
    const withCapturedLogs = async (fn: () => Promise<void>): Promise<string> => {
      const original = console.log;
      const lines: string[] = [];
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      try {
        await fn();
      } finally {
        console.log = original;
      }
      return lines.join("\n");
    };

    test("ne logue ni le texte de l'offre ni la reponse du modele", async () => {
      useProviderReturning(FULL_PREVIEW);

      const logs = await withCapturedLogs(async () => {
        await postParseOffer({ offerText: OFFER_TEXT, sourceHint: "LinkedIn" });
      });

      assert.equal(logs.includes("Backend Engineer"), false);
      assert.equal(logs.includes("camille@example.com"), false);
      assert.equal(logs.includes("Construire l'API"), false);
      // La longueur, elle, est utile et sans risque.
      assert.ok(logs.includes("offerTextLength"));
    });

    test("ne logue aucun secret ni identite utilisateur en clair", async () => {
      process.env.GROQ_API_KEY = "gsk_fake-key-for-log-assertions";

      const logs = await withCapturedLogs(async () => {
        useProviderFailing("extraction_unavailable");
        await postParseOffer({ offerText: OFFER_TEXT });
      });

      assert.equal(logs.includes("gsk_fake-key-for-log-assertions"), false);
      assert.equal(logs.includes(TEST_EMAIL), false);
      assert.equal(logs.includes(process.env.JWT_SECRET ?? "@@none@@"), false);

      delete process.env.GROQ_API_KEY;
    });

    test("logue un evenement structure en cas d'echec, avec le code seul", async () => {
      useProviderFailing("extraction_timeout");

      const logs = await withCapturedLogs(async () => {
        await postParseOffer({ offerText: OFFER_TEXT });
      });

      assert.ok(logs.includes("extraction_timeout"));
      assert.ok(logs.includes("job_offer_extraction"));
      assert.equal(logs.includes(OFFER_TEXT), false);
    });
  });

  describe("non-regression des endpoints manuels", () => {
    test("la creation manuelle fonctionne toujours", async () => {
      const res = await fetch(`${baseUrl}/applications`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie },
        body: JSON.stringify({ company: "Acme", position: "Backend Engineer" }),
      });

      assert.equal(res.status, 201);
      const created = await res.json();
      assert.equal(created.company, "Acme");

      await prisma.application.delete({ where: { id: created.id } });
    });

    test("l'indisponibilite de l'IA ne bloque pas la creation manuelle", async () => {
      useProviderFailing("extraction_unavailable");

      const parseRes = await postParseOffer({ offerText: OFFER_TEXT });
      assert.equal(parseRes.status, 502);

      const createRes = await fetch(`${baseUrl}/applications`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie },
        body: JSON.stringify({ company: "Fallback", position: "Dev" }),
      });

      assert.equal(createRes.status, 201, "le fallback manuel reste disponible");
      const created = await createRes.json();
      await prisma.application.delete({ where: { id: created.id } });
    });

    test("GET /applications repond toujours normalement", async () => {
      const res = await fetch(`${baseUrl}/applications`, {
        headers: { Cookie: authCookie },
      });

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(await res.json()));
    });
  });
});
