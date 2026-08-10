import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  JOB_OFFER_EXTRACTION_FIELDS,
  USER_OWNED_APPLICATION_FIELDS,
  jobOfferExtractionResultSchema,
  toApplicationPrefill,
} from "./job-offer-extraction.validator";
import { createApplicationSchema } from "./application.validator";

const FULL_EXTRACTION = {
  fields: {
    company: "Acme",
    position: "Backend Engineer",
    source: "LinkedIn",
    offerUrl: "https://example.com/jobs/42",
    location: "Paris",
    contractType: "CDI",
    salary: "55k€",
    jobDescription: "Build and operate the billing API.",
    notes: "Équipe de 6 personnes.",
    contactName: "Camille Durand",
    contactRole: "Talent Acquisition",
    contactEmail: "camille@example.com",
  },
  confidenceByField: {
    company: 1,
    position: 0.95,
    salary: 0.4,
  },
  uncertainFields: ["salary"],
  warnings: ["Le salaire est exprimé en fourchette."],
};

describe("jobOfferExtractionResultSchema — résultat complet", () => {
  test("accepte un résultat complet avec toutes les métadonnées", () => {
    const result = jobOfferExtractionResultSchema.safeParse(FULL_EXTRACTION);

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.data.fields.company, "Acme");
      assert.equal(result.data.uncertainFields?.[0], "salary");
      assert.equal(result.data.confidenceByField?.company, 1);
    }
  });

  test("couvre exactement les 12 champs annoncés par le contrat", () => {
    const result = jobOfferExtractionResultSchema.safeParse(FULL_EXTRACTION);

    assert.ok(result.success);
    if (result.success) {
      assert.deepEqual(
        Object.keys(result.data.fields).sort(),
        [...JOB_OFFER_EXTRACTION_FIELDS].sort(),
      );
    }
  });
});

describe("jobOfferExtractionResultSchema — résultat partiel et champs absents", () => {
  test("accepte un résultat partiel", () => {
    const result = jobOfferExtractionResultSchema.safeParse({
      fields: { company: "Acme", position: "Backend Engineer" },
    });

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.data.fields.company, "Acme");
      assert.equal(result.data.fields.salary, undefined);
    }
  });

  test("accepte une extraction qui n'a rien trouvé", () => {
    const result = jobOfferExtractionResultSchema.safeParse({});

    assert.ok(result.success);
    if (result.success) {
      assert.deepEqual(result.data.fields, {});
      assert.equal(result.data.confidenceByField, undefined);
      assert.equal(result.data.uncertainFields, undefined);
      assert.equal(result.data.warnings, undefined);
    }
  });

  test("accepte un objet fields vide sans exiger company/position", () => {
    const result = jobOfferExtractionResultSchema.safeParse({ fields: {} });
    assert.ok(result.success);
  });
});

describe("jobOfferExtractionResultSchema — normalisation des chaînes vides", () => {
  test("traite \"\" et les chaînes d'espaces comme des champs absents", () => {
    const result = jobOfferExtractionResultSchema.safeParse({
      fields: {
        company: "Acme",
        location: "",
        salary: "   ",
        offerUrl: "",
        contactEmail: "  ",
        notes: "\n\t ",
      },
    });

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.data.fields.location, undefined);
      assert.equal(result.data.fields.salary, undefined);
      assert.equal(result.data.fields.offerUrl, undefined);
      assert.equal(result.data.fields.contactEmail, undefined);
      assert.equal(result.data.fields.notes, undefined);
    }
  });

  test("trim les valeurs réellement extraites", () => {
    const result = jobOfferExtractionResultSchema.safeParse({
      fields: { company: "  Acme  ", contactEmail: " camille@example.com " },
    });

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.data.fields.company, "Acme");
      assert.equal(result.data.fields.contactEmail, "camille@example.com");
    }
  });
});

describe("jobOfferExtractionResultSchema — offerUrl", () => {
  test("accepte une URL http(s) normale", () => {
    for (const offerUrl of [
      "https://example.com/jobs/1",
      "http://example.com/jobs/1",
    ]) {
      const result = jobOfferExtractionResultSchema.safeParse({
        fields: { offerUrl },
      });
      assert.ok(result.success, `attendu accepté : ${offerUrl}`);
    }
  });

  test("refuse une URL invalide", () => {
    const result = jobOfferExtractionResultSchema.safeParse({
      fields: { offerUrl: "not-a-url" },
    });

    assert.equal(result.success, false);
  });

  test("refuse les protocoles non http(s) et les identifiants intégrés", () => {
    for (const offerUrl of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ftp://example.com/file",
      "https://user:pass@example.com/jobs/1",
    ]) {
      const result = jobOfferExtractionResultSchema.safeParse({
        fields: { offerUrl },
      });
      assert.equal(result.success, false, `attendu refusé : ${offerUrl}`);
    }
  });
});

describe("jobOfferExtractionResultSchema — contactEmail", () => {
  test("refuse un email invalide", () => {
    for (const contactEmail of ["pas-un-email", "camille@", "@example.com"]) {
      const result = jobOfferExtractionResultSchema.safeParse({
        fields: { contactEmail },
      });
      assert.equal(result.success, false, `attendu refusé : ${contactEmail}`);
    }
  });
});

describe("jobOfferExtractionResultSchema — confidenceByField", () => {
  test("accepte les bornes 0 et 1", () => {
    const result = jobOfferExtractionResultSchema.safeParse({
      fields: { company: "Acme" },
      confidenceByField: { company: 0, position: 1 },
    });

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.data.confidenceByField?.company, 0);
      assert.equal(result.data.confidenceByField?.position, 1);
    }
  });

  test("refuse une confiance hors bornes", () => {
    for (const value of [-0.1, 1.5, -1, 2]) {
      const result = jobOfferExtractionResultSchema.safeParse({
        confidenceByField: { company: value },
      });
      assert.equal(result.success, false, `attendu refusé : ${value}`);
    }
  });

  test("refuse une clé hors du périmètre des champs extractibles", () => {
    const result = jobOfferExtractionResultSchema.safeParse({
      confidenceByField: { status: 0.9 },
    });

    assert.equal(result.success, false);
  });

  test("n'exige aucune clé (record partiel)", () => {
    const result = jobOfferExtractionResultSchema.safeParse({
      confidenceByField: { company: 0.8 },
    });

    assert.ok(result.success);
  });
});

describe("jobOfferExtractionResultSchema — uncertainFields", () => {
  test("accepte tous les champs du contrat", () => {
    const result = jobOfferExtractionResultSchema.safeParse({
      uncertainFields: [...JOB_OFFER_EXTRACTION_FIELDS],
    });

    assert.ok(result.success);
  });

  test("refuse un champ hors du périmètre extractible", () => {
    for (const field of ["appliedAt", "status", "resumeText", "inventé"]) {
      const result = jobOfferExtractionResultSchema.safeParse({
        uncertainFields: [field],
      });
      assert.equal(result.success, false, `attendu refusé : ${field}`);
    }
  });

  test("refuse les doublons", () => {
    const result = jobOfferExtractionResultSchema.safeParse({
      uncertainFields: ["salary", "salary"],
    });

    assert.equal(result.success, false);
  });
});

describe("jobOfferExtractionResultSchema — warnings", () => {
  test("accepte une liste d'avertissements courts", () => {
    const result = jobOfferExtractionResultSchema.safeParse({
      warnings: ["Deux intitulés de poste trouvés dans l'offre."],
    });

    assert.ok(result.success);
  });

  test("refuse un avertissement vide ou une liste trop longue", () => {
    assert.equal(
      jobOfferExtractionResultSchema.safeParse({ warnings: [""] }).success,
      false,
    );
    assert.equal(
      jobOfferExtractionResultSchema.safeParse({
        warnings: Array.from({ length: 21 }, (_, i) => `warning-${i}`),
      }).success,
      false,
    );
  });
});

describe("jobOfferExtractionResultSchema — champs inconnus", () => {
  test("refuse une clé inconnue à la racine (.strict())", () => {
    const result = jobOfferExtractionResultSchema.safeParse({
      fields: { company: "Acme" },
      sqlQuery: "DROP TABLE users;",
    });

    assert.equal(result.success, false);
  });

  test("refuse une clé inconnue dans fields (.strict())", () => {
    const result = jobOfferExtractionResultSchema.safeParse({
      fields: { company: "Acme", recruiterPhone: "0600000000" },
    });

    assert.equal(result.success, false);
  });

  test("refuse les champs qui relèvent de l'utilisateur, pas de l'offre", () => {
    const forbiddenSamples: Record<string, unknown> = {
      appliedAt: "2026-08-10T09:00:00.000Z",
      status: "APPLIED",
      resumeText: "Mon CV",
      coverLetterText: "Ma lettre",
      referralNote: "Recommandé par X",
    };

    for (const field of USER_OWNED_APPLICATION_FIELDS) {
      const result = jobOfferExtractionResultSchema.safeParse({
        fields: { company: "Acme", [field]: forbiddenSamples[field] },
      });
      assert.equal(result.success, false, `attendu refusé : ${field}`);
    }
  });
});

describe("toApplicationPrefill — mapping vers createApplicationSchema", () => {
  test("produit un préremplissage accepté par createApplicationSchema", () => {
    const extraction = jobOfferExtractionResultSchema.parse(FULL_EXTRACTION);
    const prefill = toApplicationPrefill(extraction);

    const created = createApplicationSchema.safeParse(prefill);

    assert.ok(created.success);
    if (created.success) {
      assert.equal(created.data.company, "Acme");
      assert.equal(created.data.offerUrl, "https://example.com/jobs/42");
      assert.equal(created.data.contactEmail, "camille@example.com");
    }
  });

  test("un résultat partiel reste accepté par createApplicationSchema.partial()", () => {
    const extraction = jobOfferExtractionResultSchema.parse({
      fields: { location: "Paris", salary: "55k€" },
    });

    const parsed = createApplicationSchema
      .partial()
      .safeParse(toApplicationPrefill(extraction));

    assert.ok(parsed.success);
  });

  test("omet les champs absents plutôt que de les mettre à \"\"", () => {
    const extraction = jobOfferExtractionResultSchema.parse({
      fields: { company: "Acme", location: "" },
    });

    const prefill = toApplicationPrefill(extraction);

    assert.deepEqual(Object.keys(prefill), ["company"]);
    assert.equal("location" in prefill, false);
  });

  test("ne recopie aucune métadonnée d'extraction dans le préremplissage", () => {
    const extraction = jobOfferExtractionResultSchema.parse(FULL_EXTRACTION);
    const prefill = toApplicationPrefill(extraction) as Record<string, unknown>;

    for (const key of ["confidenceByField", "uncertainFields", "warnings"]) {
      assert.equal(key in prefill, false, `${key} ne doit pas être mappé`);
    }
  });

  test("n'invente aucun champ possédé par l'utilisateur", () => {
    const extraction = jobOfferExtractionResultSchema.parse(FULL_EXTRACTION);
    const prefill = toApplicationPrefill(extraction) as Record<string, unknown>;

    for (const field of USER_OWNED_APPLICATION_FIELDS) {
      assert.equal(field in prefill, false, `${field} ne doit pas être mappé`);
    }
  });

  test("un préremplissage sans company/position est refusé à la création", () => {
    const extraction = jobOfferExtractionResultSchema.parse({
      fields: { location: "Paris" },
    });

    const created = createApplicationSchema.safeParse(
      toApplicationPrefill(extraction),
    );

    // L'extraction n'est qu'un aperçu : c'est bien la création manuelle qui
    // reste l'unique gardienne des champs obligatoires.
    assert.equal(created.success, false);
  });
});
