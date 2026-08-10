import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  extractJobOffer,
  __setJobOfferExtractionProviderForTests,
} from "./job-offer-extraction.service";
import {
  JobOfferExtractionError,
  JobOfferExtractionProvider,
} from "./job-offer-extraction.provider";

// Le service est la derniere barriere avant le frontend : quoi que renvoie le
// fournisseur, la sortie doit etre conforme au contrat #16 ou echouer.

const stubProvider = (value: unknown): JobOfferExtractionProvider => ({
  extract: async () => value,
});

const failingProvider = (error: unknown): JobOfferExtractionProvider => ({
  extract: async () => {
    throw error;
  },
});

afterEach(() => {
  __setJobOfferExtractionProviderForTests(null);
});

describe("extractJobOffer", () => {
  test("retourne l'apercu quand la reponse respecte le contrat #16", async () => {
    __setJobOfferExtractionProviderForTests(
      stubProvider({
        fields: { company: "Acme", position: "Backend Engineer" },
        confidenceByField: { company: 1 },
        uncertainFields: ["salary"],
        warnings: ["Salaire absent."],
      }),
    );

    const result = await extractJobOffer({ offerText: "texte" });

    assert.equal(result.fields.company, "Acme");
    assert.deepEqual(result.uncertainFields, ["salary"]);
  });

  test("accepte une extraction partielle", async () => {
    __setJobOfferExtractionProviderForTests(
      stubProvider({ fields: { location: "Paris" }, confidenceByField: {} }),
    );

    const result = await extractJobOffer({ offerText: "texte" });

    assert.deepEqual(Object.keys(result.fields), ["location"]);
  });

  test("rejette une reponse hors contrat (champ inconnu)", async () => {
    __setJobOfferExtractionProviderForTests(
      stubProvider({
        fields: { company: "Acme", recruiterPhone: "0600000000" },
        confidenceByField: {},
      }),
    );

    await assert.rejects(extractJobOffer({ offerText: "texte" }), (error) => {
      assert.ok(error instanceof JobOfferExtractionError);
      assert.equal((error as JobOfferExtractionError).code, "extraction_invalid_response");
      return true;
    });
  });

  test("rejette un champ que l'IA n'a pas le droit d'inventer", async () => {
    __setJobOfferExtractionProviderForTests(
      stubProvider({
        fields: { company: "Acme", status: "APPLIED", appliedAt: "2026-08-10" },
        confidenceByField: {},
      }),
    );

    await assert.rejects(extractJobOffer({ offerText: "texte" }), (error) => {
      assert.equal(
        (error as JobOfferExtractionError).code,
        "extraction_invalid_response",
      );
      return true;
    });
  });

  test("rejette une confiance hors bornes", async () => {
    __setJobOfferExtractionProviderForTests(
      stubProvider({
        fields: { company: "Acme" },
        confidenceByField: { company: 1.4 },
      }),
    );

    await assert.rejects(extractJobOffer({ offerText: "texte" }), (error) => {
      assert.equal(
        (error as JobOfferExtractionError).code,
        "extraction_invalid_response",
      );
      return true;
    });
  });

  test("rejette une reponse qui n'est pas un objet", async () => {
    __setJobOfferExtractionProviderForTests(stubProvider("Acme, Paris, CDI"));

    await assert.rejects(extractJobOffer({ offerText: "texte" }), (error) => {
      assert.equal(
        (error as JobOfferExtractionError).code,
        "extraction_invalid_response",
      );
      return true;
    });
  });

  test("laisse remonter telle quelle l'erreur typee du fournisseur", async () => {
    __setJobOfferExtractionProviderForTests(
      failingProvider(new JobOfferExtractionError("extraction_rate_limited")),
    );

    await assert.rejects(extractJobOffer({ offerText: "texte" }), (error) => {
      assert.equal(
        (error as JobOfferExtractionError).code,
        "extraction_rate_limited",
      );
      return true;
    });
  });

  test("l'erreur de revalidation ne contient aucun fragment de la reponse", async () => {
    __setJobOfferExtractionProviderForTests(
      stubProvider({
        fields: { company: "Acme", secretLeak: "texte confidentiel de l'offre" },
        confidenceByField: {},
      }),
    );

    await assert.rejects(extractJobOffer({ offerText: "texte" }), (error) => {
      const serialized = `${(error as Error).message}${(error as Error).stack ?? ""}`;
      assert.equal(serialized.includes("texte confidentiel"), false);
      return true;
    });
  });
});
