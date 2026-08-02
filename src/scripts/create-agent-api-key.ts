import "dotenv/config";
import prisma from "../config/prisma";
import {
  AgentApiKeyConfigError,
  generateAgentApiKey,
} from "../services/agent-api-key.service";

// Only scope this script (and the whole agent-import feature) supports today.
const AGENT_CREATE_SCOPE = "applications:create";

interface ParsedArgs {
  userEmail?: string;
  name?: string;
  expiresDays?: string;
}

const parseArgs = (argv: string[]): ParsedArgs => {
  const args: ParsedArgs = {};

  for (const raw of argv) {
    const [flag, ...rest] = raw.split("=");
    const value = rest.join("=");

    if (flag === "--user-email") args.userEmail = value;
    else if (flag === "--name") args.name = value;
    else if (flag === "--expires-days") args.expiresDays = value;
  }

  return args;
};

const fail = (message: string): never => {
  console.error(`✖ ${message}`);
  process.exit(1);
};

const main = async () => {
  const { userEmail, name, expiresDays } = parseArgs(process.argv.slice(2));

  if (!userEmail) fail("--user-email est requis");
  if (!name) fail("--name est requis");

  if (!process.env.AGENT_API_KEY_PEPPER) {
    fail(
      "AGENT_API_KEY_PEPPER n'est pas configuré — impossible de générer une clé.",
    );
  }

  let expiresAt: Date | null = null;

  if (expiresDays !== undefined) {
    const days = Number(expiresDays);

    if (!Number.isFinite(days) || days <= 0) {
      fail("--expires-days doit être un nombre de jours positif");
    }

    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const user = await prisma.user.findUnique({ where: { email: userEmail! } });

  if (!user) {
    fail(`Aucun utilisateur trouvé pour l'email "${userEmail}"`);
  }

  let generated;

  try {
    generated = generateAgentApiKey();
  } catch (error) {
    if (error instanceof AgentApiKeyConfigError) {
      fail("AGENT_API_KEY_PEPPER n'est pas configuré.");
    }
    throw error;
  }

  const apiKey = await prisma.agentApiKey.create({
    data: {
      userId: user!.id,
      name: name!,
      prefix: generated.prefix,
      secretHash: generated.secretHash,
      scopes: [AGENT_CREATE_SCOPE],
      expiresAt,
    },
  });

  // Le secret complet n'est jamais persisté ni loggué ailleurs qu'ici, une
  // seule fois, sur la sortie standard interactive de l'opérateur.
  console.log("");
  console.log("Clé API agent créée avec succès.");
  console.log(`  Utilisateur : ${user!.email}`);
  console.log(`  Nom         : ${apiKey.name}`);
  console.log(`  Préfixe     : ${apiKey.prefix}`);
  console.log(`  Scopes      : ${apiKey.scopes.join(", ")}`);
  console.log(
    `  Expire le   : ${expiresAt ? expiresAt.toISOString() : "jamais"}`,
  );
  console.log("");
  console.log("  Clé complète (à copier maintenant, elle ne sera plus jamais affichée) :");
  console.log(`  ${generated.fullKey}`);
  console.log("");
};

main()
  .catch((error) => {
    console.error("✖ Échec de la génération de la clé :", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
