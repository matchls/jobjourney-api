// Politique CORS de l'API.
//
// Deux familles d'origines sont autorisées, et seulement deux :
//
// 1. l'origine exacte du frontend (`CLIENT_URL`, ou localhost en dev) ;
// 2. les previews Vercel d'UN projet dans UNE team, déclarés explicitement.
//
// Il n'y a volontairement aucune règle globale `*.vercel.app` : ce domaine est
// ouvert à l'inscription, une telle règle autoriserait le site de n'importe
// qui à parler à l'API avec les cookies de nos utilisateurs (`credentials:
// true`).
//
// Comme les autres modules de config, les variables sont lues à CHAQUE appel
// et jamais figées au chargement : le serveur doit démarrer sans elles, et les
// tests doivent pouvoir les poser/retirer.

const DEFAULT_CLIENT_URL = "http://localhost:3000";

// Domaine sur lequel Vercel publie les déploiements. Comparé label par label
// plus bas, jamais en sous-chaîne.
const VERCEL_APP_LABELS = ["vercel", "app"] as const;

// Une URL de preview Vercel a exactement trois labels :
// `<projet>-<hash>-<team>` + `vercel` + `app`.
const VERCEL_PREVIEW_LABEL_COUNT = VERCEL_APP_LABELS.length + 1;

const readEnv = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

export const getClientUrl = (): string =>
  readEnv("CLIENT_URL") ?? DEFAULT_CLIENT_URL;

// Nom du projet Vercel dont les previews sont acceptées (ex. `jobjourney-web`).
// Préfixé `CORS_` parce que cette valeur décrit ce que CETTE API autorise, et
// non l'environnement dans lequel elle tourne : l'API vit sur Render, et
// `VERCEL_*` est le préfixe que Vercel injecte lui-même dans ses propres
// runtimes. Les confondre rendrait la variable illisible côté Render.
export const getCorsVercelProject = (): string | undefined =>
  readEnv("CORS_VERCEL_PROJECT")?.toLowerCase();

// Slug de la team Vercel propriétaire du projet (ex. `mathieu-chales-projects`).
export const getCorsVercelTeam = (): string | undefined =>
  readEnv("CORS_VERCEL_TEAM")?.toLowerCase();

// Normalise en origine (`scheme://host[:port]`). Rend la comparaison immunisée
// à un `CLIENT_URL` renseigné avec un slash final ou un chemin, ce qui ne
// correspondrait jamais au header `Origin` envoyé par le navigateur.
const toOrigin = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

// Preview du projet et de la team déclarés, et rien d'autre.
//
// La vérification est structurelle : on découpe le hostname en labels DNS et
// on impose leur nombre exact, plutôt que de chercher une sous-chaîne. Un
// `includes("vercel.app")` accepterait `vercel.app.attaquant.net`, et un
// `includes(projet)` accepterait `evil-<projet>-xyz-<team>.vercel.app`.
//
// Le verrou réel est le SUFFIXE team : le slug est attribué par Vercel, donc
// personne hors de la team ne peut produire une URL qui s'y termine. Le nom de
// projet seul ne protégerait rien — n'importe qui peut nommer son projet
// comme le nôtre.
const isAllowedVercelPreview = (url: URL): boolean => {
  const project = getCorsVercelProject();
  const team = getCorsVercelTeam();

  // Fail-closed : sans configuration explicite, aucune preview n'est
  // autorisée. Une instance qui ne déclare rien se comporte donc exactement
  // comme avant l'existence de cette règle.
  if (!project || !team) return false;

  // Les previews sont servies en HTTPS uniquement. Accepter `http://`
  // reviendrait à autoriser une origine dont le contenu est modifiable en
  // transit, alors qu'elle porte des cookies d'authentification.
  if (url.protocol !== "https:") return false;

  // `vercel.app` n'expose aucun port alternatif : un port explicite signale
  // une origine fabriquée.
  if (url.port !== "") return false;

  // `URL` a déjà mis le hostname en minuscules et converti les IDN en
  // punycode : la comparaison porte sur une valeur normalisée.
  const labels = url.hostname.split(".");
  if (labels.length !== VERCEL_PREVIEW_LABEL_COUNT) return false;
  if (labels[1] !== VERCEL_APP_LABELS[0]) return false;
  if (labels[2] !== VERCEL_APP_LABELS[1]) return false;

  const deployment = labels[0];
  const prefix = `${project}-`;
  const suffix = `-${team}`;

  if (!deployment.startsWith(prefix)) return false;
  if (!deployment.endsWith(suffix)) return false;

  // Il doit rester quelque chose entre les deux (le hash ou `git-<branche>`).
  // Écarte au passage le cas dégénéré `<projet>-<team>`, où préfixe et suffixe
  // se chevauchent.
  return deployment.slice(prefix.length, deployment.length - suffix.length) !== "";
};

// Décide si une origine a le droit de parler à l'API.
//
// `origin` est `undefined` quand la requête ne porte pas de header `Origin` :
// curl, appel serveur-à-serveur, health check. Ce n'est pas une origine
// refusée, c'est une requête hors navigateur — la refuser casserait ces
// clients sans rien protéger, le header étant posé par le navigateur seul.
export const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (origin === undefined) return true;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  // Origine opaque (`file://`, `data:`, iframe sandboxée) : `URL` en fait la
  // chaîne littérale "null", qui ne se compare à rien d'utile — c'est
  // d'ailleurs exactement ce que le navigateur envoie dans ces cas
  // (`Origin: null`). Jamais autorisée.
  if (url.origin === "null") return false;

  if (url.origin === toOrigin(getClientUrl())) return true;

  return isAllowedVercelPreview(url);
};

// Délégué passé à `cors`. Une origine refusée renvoie `false` (aucun en-tête
// CORS, le navigateur bloque) et non une `Error`, qui ferait répondre 500 à
// une requête simplement non autorisée.
export const corsOrigin = (
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void => {
  callback(null, isAllowedOrigin(origin));
};
