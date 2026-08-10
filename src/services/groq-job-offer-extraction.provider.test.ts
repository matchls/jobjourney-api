import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createGroqJobOfferExtractionProvider } from "./groq-job-offer-extraction.provider";
import { JobOfferExtractionError } from "./job-offer-extraction.provider";

// Aucun appel réseau, aucune vraie clé : `fetchImpl` est injecté et renvoie
// des réponses fabriquées. Ces tests couvrent le mapping HTTP -> code
// applicatif et l'adaptation du schéma de transport vers le contrat #16.

const FAKE_KEY = "gsk_not-a-real-key-for-tests";

const OFFER_TEXT = "Nous recherchons un Backend Engineer a Paris. CDI, 55k.";

const wireResponse = (payload: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const allNull = (value: unknown = null) => ({
  company: value,
  position: value,
  source: value,
  offerUrl: value,
  location: value,
  contractType: value,
  salary: value,
  jobDescription: value,
  notes: value,
  contactName: value,
  contactRole: value,
  contactEmail: value,
});

const statusResponse = (status: number) =>
  new Response(JSON.stringify({ error: { message: "boom", type: "x" } }), {
    status,
  });

let originalKey: string | undefined;
let originalModel: string | undefined;

before(() => {
  originalKey = process.env.GROQ_API_KEY;
  originalModel = process.env.GROQ_MODEL;
});

after(() => {
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.GROQ_MODEL;
  else process.env.GROQ_MODEL = originalModel;
});

beforeEach(() => {
  process.env.GROQ_API_KEY = FAKE_KEY;
  delete process.env.GROQ_MODEL;
});

const expectErrorCode = async (
  promise: Promise<unknown>,
  expected: string,
): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(
      error instanceof JobOfferExtractionError,
      `attendu JobOfferExtractionError, recu ${String(error)}`,
    );
    assert.equal((error as JobOfferExtractionError).code, expected);
    return true;
  });
};

describe("createGroqJobOfferExtractionProvider — configuration", () => {
  test("echoue avec extraction_not_configured si GROQ_API_KEY est absente", async () => {
    delete process.env.GROQ_API_KEY;
    let called = false;
    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async () => {
        called = true;
        return wireResponse({});
      },
    });

    await expectErrorCode(
      provider.extract({ offerText: OFFER_TEXT }),
      "extraction_not_configured",
    );
    assert.equal(called, false, "aucun appel ne doit partir sans cle");
  });

  test("echoue aussi si GROQ_API_KEY ne contient que des espaces", async () => {
    process.env.GROQ_API_KEY = "   ";
    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async () => wireResponse({}),
    });

    await expectErrorCode(
      provider.extract({ offerText: OFFER_TEXT }),
      "extraction_not_configured",
    );
  });
});

describe("createGroqJobOfferExtractionProvider — requete envoyee", () => {
  test("demande une sortie structuree json_schema en strict mode", async () => {
    let capturedBody: any;
    let capturedUrl = "";
    let capturedAuth = "";

    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(String(init?.body));
        capturedAuth = String(
          (init?.headers as Record<string, string>).Authorization,
        );
        return wireResponse({
          fields: { ...allNull(), company: "Acme" },
          confidenceByField: { ...allNull(), company: 1 },
          uncertainFields: [],
          warnings: [],
        });
      },
    });

    await provider.extract({ offerText: OFFER_TEXT });

    assert.ok(capturedUrl.endsWith("/chat/completions"));
    assert.equal(capturedAuth, `Bearer ${FAKE_KEY}`);
    assert.equal(capturedBody.response_format.type, "json_schema");
    assert.equal(capturedBody.response_format.json_schema.strict, true);
    assert.equal(capturedBody.temperature, 0);
    // Le strict mode Groq impose tous les champs required + additionalProperties:false.
    const schema = capturedBody.response_format.json_schema.schema;
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.fields.required.length, 12);
    assert.equal(schema.properties.fields.additionalProperties, false);
  });

  test("le modele vient de la configuration, pas du code appelant", async () => {
    process.env.GROQ_MODEL = "openai/gpt-oss-20b";
    let capturedModel = "";

    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async (_url, init) => {
        capturedModel = JSON.parse(String(init?.body)).model;
        return wireResponse({
          fields: allNull(),
          confidenceByField: allNull(),
          uncertainFields: [],
          warnings: [],
        });
      },
    });

    await provider.extract({ offerText: OFFER_TEXT });

    assert.equal(capturedModel, "openai/gpt-oss-20b");
  });

  test("le prompt systeme impose de ne rien inventer et resiste au prompt injection", async () => {
    let systemPrompt = "";

    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async (_url, init) => {
        systemPrompt = JSON.parse(String(init?.body)).messages[0].content;
        return wireResponse({
          fields: allNull(),
          confidenceByField: allNull(),
          uncertainFields: [],
          warnings: [],
        });
      },
    });

    await provider.extract({ offerText: OFFER_TEXT });

    assert.match(systemPrompt, /n'invente jamais/i);
    assert.match(systemPrompt, /DONNÉE NON FIABLE/i);
    assert.match(systemPrompt, /instruction/i);
    assert.match(systemPrompt, /uncertainFields/);
    assert.match(systemPrompt, /warnings/);
  });

  test("n'envoie que le texte de l'offre et les indices de provenance", async () => {
    let capturedBody = "";

    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async (_url, init) => {
        capturedBody = String(init?.body);
        return wireResponse({
          fields: allNull(),
          confidenceByField: allNull(),
          uncertainFields: [],
          warnings: [],
        });
      },
    });

    await provider.extract({
      offerText: OFFER_TEXT,
      offerUrl: "https://example.com/jobs/42",
      sourceHint: "LinkedIn",
    });

    assert.ok(capturedBody.includes("Backend Engineer"));
    assert.ok(capturedBody.includes("example.com/jobs/42"));
    assert.ok(capturedBody.includes("LinkedIn"));
    // La cle vit dans l'en-tete Authorization, jamais dans le corps.
    assert.equal(capturedBody.includes(FAKE_KEY), false);
  });

  test("encadre le texte de l'offre par une balise imprevisible", async () => {
    const seen: string[] = [];

    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async (_url, init) => {
        seen.push(JSON.parse(String(init?.body)).messages[1].content);
        return wireResponse({
          fields: allNull(),
          confidenceByField: allNull(),
          uncertainFields: [],
          warnings: [],
        });
      },
    });

    await provider.extract({ offerText: OFFER_TEXT });
    await provider.extract({ offerText: OFFER_TEXT });

    const tagOf = (message: string) => /<offre_([0-9a-f]{16})>/.exec(message)?.[1];
    const first = tagOf(seen[0]);
    const second = tagOf(seen[1]);

    assert.ok(first, "une balise nonce doit encadrer l'offre");
    assert.ok(second);
    assert.notEqual(first, second, "la balise doit changer a chaque requete");
  });
});

describe("createGroqJobOfferExtractionProvider — adaptation de la reponse", () => {
  test("extraction complete : les 12 champs traversent l'adaptateur", async () => {
    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async () =>
        wireResponse({
          fields: {
            company: "Acme",
            position: "Backend Engineer",
            source: "LinkedIn",
            offerUrl: "https://example.com/jobs/42",
            location: "Paris",
            contractType: "CDI",
            salary: "55k",
            jobDescription: "Construire l'API.",
            notes: "Equipe de 6.",
            contactName: "Camille Durand",
            contactRole: "Recruteuse",
            contactEmail: "camille@example.com",
          },
          confidenceByField: { ...allNull(), company: 1, salary: 0.4 },
          uncertainFields: ["salary"],
          warnings: ["Salaire exprime en fourchette."],
        }),
    });

    const result: any = await provider.extract({ offerText: OFFER_TEXT });

    assert.equal(Object.keys(result.fields).length, 12);
    assert.equal(result.fields.company, "Acme");
    assert.deepEqual(result.uncertainFields, ["salary"]);
    assert.equal(result.confidenceByField.salary, 0.4);
  });

  test("extraction partielle : les null deviennent des champs omis", async () => {
    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async () =>
        wireResponse({
          fields: { ...allNull(), company: "Acme", location: "Paris" },
          confidenceByField: { ...allNull(), company: 0.9 },
          uncertainFields: [],
          warnings: [],
        }),
    });

    const result: any = await provider.extract({ offerText: OFFER_TEXT });

    assert.deepEqual(Object.keys(result.fields).sort(), ["company", "location"]);
    assert.equal("salary" in result.fields, false);
    assert.deepEqual(Object.keys(result.confidenceByField), ["company"]);
  });

  test("extraction vide : aucun champ retenu", async () => {
    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async () =>
        wireResponse({
          fields: allNull(),
          confidenceByField: allNull(),
          uncertainFields: [],
          warnings: [],
        }),
    });

    const result: any = await provider.extract({ offerText: OFFER_TEXT });

    assert.deepEqual(result.fields, {});
    assert.deepEqual(result.confidenceByField, {});
  });
});

describe("createGroqJobOfferExtractionProvider — mapping des erreurs", () => {
  const cases: Array<[number, string]> = [
    [401, "extraction_not_configured"],
    [403, "extraction_not_configured"],
    [429, "extraction_rate_limited"],
    [408, "extraction_timeout"],
    [499, "extraction_timeout"],
    [498, "extraction_unavailable"],
    [500, "extraction_unavailable"],
    [502, "extraction_unavailable"],
    [503, "extraction_unavailable"],
    [422, "extraction_unavailable"],
  ];

  for (const [status, expected] of cases) {
    test(`statut ${status} -> ${expected}`, async () => {
      const provider = createGroqJobOfferExtractionProvider({
        fetchImpl: async () => statusResponse(status),
      });

      await expectErrorCode(provider.extract({ offerText: OFFER_TEXT }), expected);
    });
  }

  test("timeout : l'appel est interrompu et mappe en extraction_timeout", async () => {
    const provider = createGroqJobOfferExtractionProvider({
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        }),
    });

    await expectErrorCode(
      provider.extract({ offerText: OFFER_TEXT }),
      "extraction_timeout",
    );
  });

  test("panne reseau -> extraction_unavailable", async () => {
    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    await expectErrorCode(
      provider.extract({ offerText: OFFER_TEXT }),
      "extraction_unavailable",
    );
  });

  test("enveloppe sans contenu exploitable -> extraction_invalid_response", async () => {
    for (const envelope of [
      {},
      { choices: [] },
      { choices: [{ message: {} }] },
      { choices: [{ message: { content: "" } }] },
    ]) {
      const provider = createGroqJobOfferExtractionProvider({
        fetchImpl: async () =>
          new Response(JSON.stringify(envelope), { status: 200 }),
      });

      await expectErrorCode(
        provider.extract({ offerText: OFFER_TEXT }),
        "extraction_invalid_response",
      );
    }
  });

  test("contenu qui n'est pas du JSON -> extraction_invalid_response", async () => {
    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "Bien sur ! Voici l'offre." } }],
          }),
          { status: 200 },
        ),
    });

    await expectErrorCode(
      provider.extract({ offerText: OFFER_TEXT }),
      "extraction_invalid_response",
    );
  });

  test("JSON qui n'est pas un objet -> extraction_invalid_response", async () => {
    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async () => wireResponse(["Acme"]),
    });

    await expectErrorCode(
      provider.extract({ offerText: OFFER_TEXT }),
      "extraction_invalid_response",
    );
  });

  test("corps HTTP illisible -> extraction_invalid_response", async () => {
    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async () => new Response("<html>oops</html>", { status: 200 }),
    });

    await expectErrorCode(
      provider.extract({ offerText: OFFER_TEXT }),
      "extraction_invalid_response",
    );
  });

  test("aucune erreur ne transporte la cle ni le texte de l'offre", async () => {
    const provider = createGroqJobOfferExtractionProvider({
      fetchImpl: async () => statusResponse(500),
    });

    await assert.rejects(provider.extract({ offerText: OFFER_TEXT }), (error) => {
      const serialized = `${(error as Error).message}${(error as Error).stack ?? ""}`;
      assert.equal(serialized.includes(FAKE_KEY), false);
      assert.equal(serialized.includes("Backend Engineer"), false);
      return true;
    });
  });
});
