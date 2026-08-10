import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_OFFER_TEXT_LENGTH,
  parseOfferSchema,
} from "./parse-offer.validator";

describe("parseOfferSchema", () => {
  test("accepte un payload minimal", () => {
    const result = parseOfferSchema.safeParse({ offerText: "Acme recrute." });

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.data.offerUrl, undefined);
      assert.equal(result.data.sourceHint, undefined);
    }
  });

  test("accepte un payload complet et trim le texte", () => {
    const result = parseOfferSchema.safeParse({
      offerText: "  Acme recrute.  ",
      offerUrl: "https://example.com/jobs/42",
      sourceHint: "LinkedIn",
    });

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.data.offerText, "Acme recrute.");
    }
  });

  test("refuse un texte vide ou uniquement des espaces", () => {
    for (const offerText of ["", "   ", "\n\t "]) {
      assert.equal(
        parseOfferSchema.safeParse({ offerText }).success,
        false,
        `attendu refuse : ${JSON.stringify(offerText)}`,
      );
    }
  });

  test("refuse un offerText absent ou d'un mauvais type", () => {
    assert.equal(parseOfferSchema.safeParse({}).success, false);
    assert.equal(parseOfferSchema.safeParse({ offerText: 42 }).success, false);
  });

  test("accepte la limite exacte et refuse un caractere de plus", () => {
    assert.ok(
      parseOfferSchema.safeParse({ offerText: "a".repeat(MAX_OFFER_TEXT_LENGTH) })
        .success,
    );
    assert.equal(
      parseOfferSchema.safeParse({
        offerText: "a".repeat(MAX_OFFER_TEXT_LENGTH + 1),
      }).success,
      false,
    );
  });

  test("applique les memes regles d'URL que l'import agent", () => {
    for (const offerUrl of [
      "pas-une-url",
      "javascript:alert(1)",
      "ftp://example.com/a",
      "https://user:pass@example.com/a",
    ]) {
      assert.equal(
        parseOfferSchema.safeParse({ offerText: "Acme", offerUrl }).success,
        false,
        `attendu refuse : ${offerUrl}`,
      );
    }

    assert.ok(
      parseOfferSchema.safeParse({
        offerText: "Acme",
        offerUrl: "https://example.com/jobs/1",
      }).success,
    );
  });

  test("traite une chaine vide comme un champ absent", () => {
    const result = parseOfferSchema.safeParse({
      offerText: "Acme",
      offerUrl: "",
      sourceHint: "  ",
    });

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.data.offerUrl, undefined);
      assert.equal(result.data.sourceHint, undefined);
    }
  });

  test("refuse tout champ inconnu, y compris les donnees personnelles", () => {
    for (const extra of [
      { resumeText: "mon CV" },
      { coverLetterText: "ma lettre" },
      { userId: "abc" },
      { status: "APPLIED" },
    ]) {
      assert.equal(
        parseOfferSchema.safeParse({ offerText: "Acme", ...extra }).success,
        false,
        `attendu refuse : ${Object.keys(extra)[0]}`,
      );
    }
  });
});
