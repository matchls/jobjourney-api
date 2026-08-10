import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createApplicationSchema,
  updateApplicationSchema,
} from "./application.validator";

// Tests de non-régression : le contrat d'extraction (#16) a déplacé les règles
// de normalisation vers field-rules.ts. Le comportement du formulaire manuel,
// lui, ne doit pas bouger d'un iota.
describe("createApplicationSchema (non-régression)", () => {
  test("accepte un payload minimal", () => {
    const result = createApplicationSchema.safeParse({
      company: "Acme",
      position: "Backend Engineer",
    });

    assert.ok(result.success);
  });

  test("refuse un payload sans company/position", () => {
    assert.equal(
      createApplicationSchema.safeParse({ company: "Acme" }).success,
      false,
    );
    assert.equal(
      createApplicationSchema.safeParse({ company: "", position: "Dev" })
        .success,
      false,
    );
  });

  test("traite \"\" comme absent pour offerUrl et contactEmail", () => {
    const result = createApplicationSchema.safeParse({
      company: "Acme",
      position: "Dev",
      offerUrl: "",
      contactEmail: "",
    });

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.data.offerUrl, undefined);
      assert.equal(result.data.contactEmail, undefined);
    }
  });

  test("refuse une offerUrl et un contactEmail invalides", () => {
    assert.equal(
      createApplicationSchema.safeParse({
        company: "Acme",
        position: "Dev",
        offerUrl: "not-a-url",
      }).success,
      false,
    );
    assert.equal(
      createApplicationSchema.safeParse({
        company: "Acme",
        position: "Dev",
        contactEmail: "pas-un-email",
      }).success,
      false,
    );
  });

  test("accepte encore les champs pilotés par l'utilisateur", () => {
    const result = createApplicationSchema.safeParse({
      company: "Acme",
      position: "Dev",
      appliedAt: "2026-08-10T09:00:00.000Z",
      status: "APPLIED",
      resumeText: "Mon CV",
      coverLetterText: "Ma lettre",
      referralNote: "Recommandé par X",
    });

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.data.status, "APPLIED");
      assert.equal(result.data.referralNote, "Recommandé par X");
    }
  });

  test("ne trim pas les champs texte libres (comportement historique)", () => {
    const result = createApplicationSchema.safeParse({
      company: "  Acme  ",
      position: "Dev",
    });

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.data.company, "  Acme  ");
    }
  });

  test("ignore les clés inconnues au lieu de les rejeter (schéma non strict)", () => {
    const result = createApplicationSchema.safeParse({
      company: "Acme",
      position: "Dev",
      champInconnu: "valeur",
    });

    assert.ok(result.success);
    if (result.success) {
      assert.equal("champInconnu" in result.data, false);
    }
  });
});

describe("updateApplicationSchema (non-régression)", () => {
  test("accepte une mise à jour partielle", () => {
    const result = updateApplicationSchema.safeParse({ location: "Lyon" });
    assert.ok(result.success);
  });

  test("accepte confirmImportReview: true et refuse false", () => {
    assert.ok(
      updateApplicationSchema.safeParse({ confirmImportReview: true }).success,
    );
    assert.equal(
      updateApplicationSchema.safeParse({ confirmImportReview: false }).success,
      false,
    );
  });

  test("refuse un statut hors enum", () => {
    assert.equal(
      updateApplicationSchema.safeParse({ status: "PENDING" }).success,
      false,
    );
  });
});
