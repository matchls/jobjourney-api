// Configuration centralisée du fournisseur d'extraction IA.
//
// Tout ce qui est propre à Groq (modèle, URL, timeout) est ici, et nulle part
// ailleurs : le jour où l'on change de fournisseur ou de modèle, aucun fichier
// du domaine candidature ne bouge.
//
// Les variables sont lues à CHAQUE appel, jamais figées au chargement du
// module : le serveur doit pouvoir démarrer sans GROQ_API_KEY (les endpoints
// manuels continuent de fonctionner, seul /applications/parse-offer répond
// 503), et les tests doivent pouvoir poser/retirer la variable.

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";

// Le strict mode (décodage contraint, conformité garantie au JSON Schema)
// n'est supporté que par une liste restreinte de modèles Groq — voir
// https://console.groq.com/docs/structured-outputs. Ce défaut en fait partie.
const DEFAULT_MODEL = "openai/gpt-oss-120b";

const DEFAULT_TIMEOUT_MS = 20_000;

// Plafond de sécurité : au-delà, un timeout côté client/proxy arriverait de
// toute façon avant la réponse du fournisseur.
const MAX_TIMEOUT_MS = 60_000;

export const getGroqApiKey = (): string | undefined => {
  const key = process.env.GROQ_API_KEY?.trim();
  return key ? key : undefined;
};

export const isGroqConfigured = (): boolean => getGroqApiKey() !== undefined;

export const getGroqBaseUrl = (): string =>
  process.env.GROQ_BASE_URL?.trim() || DEFAULT_BASE_URL;

export const getGroqModel = (): string =>
  process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;

export const getGroqTimeoutMs = (): number => {
  const raw = Number(process.env.GROQ_TIMEOUT_MS);

  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.min(raw, MAX_TIMEOUT_MS);
};
