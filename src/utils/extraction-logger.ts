// Journalisation minimale du flux d'extraction IA, sur le modèle de
// agent-logger.ts : la structure de l'entrée est elle-même la protection.
//
// Il n'existe AUCUN champ où faire passer le texte de l'offre, la réponse
// brute du modèle, la clé Groq ou une donnée personnelle. Ce n'est pas une
// consigne de revue, c'est le type qui l'interdit. `offerTextLength` est un
// nombre : utile pour diagnostiquer un rejet de taille, sans révéler le
// contenu.
export type ExtractionLogResult =
  | "succeeded"
  | "rejected"
  | "failed"
  | "rate_limited";

export interface ExtractionLogEntry {
  event: string;
  result: ExtractionLogResult;
  userId?: string;
  errorCode?: string;
  offerTextLength?: number;
  durationMs?: number;
}

export const logExtractionEvent = (entry: ExtractionLogEntry): void => {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      ...entry,
    }),
  );
};
