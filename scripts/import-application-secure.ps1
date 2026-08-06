#Requires -Version 5.1

<#
.SYNOPSIS
    Importe une candidature en réutilisant la clé agent chiffrée par Windows.

.DESCRIPTION
    Enveloppe scripts/import-application.ps1 : plus besoin de ressaisir la clé
    ni de nettoyer JOB_JOURNEY_AGENT_KEY à la main.

    Déroulé :
      1. lit %APPDATA%\JobJourney\agent-key.xml, déchiffré par DPAPI pour le
         compte Windows courant (fichier créé par scripts/setup-agent-key.ps1) ;
      2. pose JOB_JOURNEY_AGENT_KEY le temps d'un appel, et uniquement pour lui ;
      3. délègue TOUT le travail — validation, transport, redaction des erreurs —
         à scripts/import-application.ps1, qui reste la seule implémentation ;
      4. supprime JOB_JOURNEY_AGENT_KEY dans un bloc finally, succès ou échec.

    Le script ne journalise ni la clé, ni le contenu déchiffré, ni le blob
    chiffré lu sur disque, et renvoie tel quel le résultat de l'import.

    À la sortie, JOB_JOURNEY_AGENT_KEY n'existe plus dans la session —
    y compris si elle avait été posée manuellement avant l'appel. Ce script est
    propriétaire de cette variable pendant son exécution et la laisse absente.

.PARAMETER InputFile
    Chemin du fichier JSON à importer. Obligatoire.

.PARAMETER ApiBaseUrl
    URL de base de l'API. Par défaut l'instance déployée.
    Contrairement à import-application.ps1 (dont le défaut vise le serveur de
    développement local), ce wrapper est l'outil du geste quotidien : son défaut
    est donc la cible réelle. Les règles de transport restent celles du script
    appelé — HTTPS obligatoire hors machine locale.

.PARAMETER IdempotencyKey
    Clé d'idempotence à envoyer. Si elle est absente, le script appelé en génère
    une unique (GUID).

.OUTPUTS
    Le résultat de scripts/import-application.ps1 : status, applicationId,
    duplicate et idempotent.

.EXAMPLE
    .\scripts\import-application-secure.ps1 -InputFile .\ma-candidature.json

.EXAMPLE
    .\scripts\import-application-secure.ps1 -InputFile .\ma-candidature.json -ApiBaseUrl http://localhost:4000
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputFile,

    [Parameter()]
    [string]$ApiBaseUrl = 'https://jobjourney-api.onrender.com',

    [Parameter()]
    [string]$IdempotencyKey
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$STORE_DIRECTORY_NAME = 'JobJourney'
$STORE_FILE_NAME = 'agent-key.xml'

# Chemin en dur, identique à celui de setup-agent-key.ps1 : aucun paramètre ne
# permet de désigner un autre magasin, donc aucun appelant ne peut faire lire
# un fichier arbitraire à ce script.
function Get-AgentKeyStorePath {
    $appData = $env:APPDATA

    if ([string]::IsNullOrWhiteSpace($appData)) {
        throw "La variable d'environnement APPDATA est absente : impossible de localiser le magasin utilisateur Windows."
    }

    return Join-Path (Join-Path $appData $STORE_DIRECTORY_NAME) $STORE_FILE_NAME
}

$SETUP_HINT = "Lancez d'abord :`n    .\scripts\setup-agent-key.ps1"

# ---------------------------------------------------------------------------
# 1. Vérifications locales — avant toute lecture de secret
# ---------------------------------------------------------------------------

$importScript = Join-Path $PSScriptRoot 'import-application.ps1'
if (-not (Test-Path -LiteralPath $importScript -PathType Leaf)) {
    throw "Script d'import introuvable : '$importScript'. Ce wrapper doit rester dans le même dossier que import-application.ps1."
}

$storePath = Get-AgentKeyStorePath

if (-not (Test-Path -LiteralPath $storePath -PathType Leaf)) {
    throw @"
Aucune clé agent enregistrée : '$storePath' est introuvable.

$SETUP_HINT
"@
}

# ---------------------------------------------------------------------------
# 2. Déchiffrement
# ---------------------------------------------------------------------------

# Le message d'erreur ne reprend volontairement PAS le détail de l'exception ni
# le contenu du fichier : ce contenu est le blob DPAPI du secret. Il n'est pas
# exploitable tel quel, mais rien ne justifie de l'écrire dans une console, un
# transcript ou un rapport d'agent.
$secureKey = $null
try {
    $secureKey = Import-Clixml -LiteralPath $storePath
}
catch {
    throw @"
Le fichier '$storePath' est illisible ou corrompu.

Cela arrive si le fichier a été modifié, tronqué, ou copié depuis une autre
machine ou un autre compte Windows : le chiffrement DPAPI est lié au compte
courant et ne se transporte pas.

$SETUP_HINT
"@
}

# Un fichier .xml valide mais contenant autre chose (une chaîne en clair, un
# objet quelconque) doit être refusé : sans ce contrôle, une clé stockée en
# clair par erreur serait acceptée en silence, et tout l'intérêt du chiffrement
# disparaîtrait.
if (-not ($secureKey -is [System.Security.SecureString])) {
    throw @"
Le fichier '$storePath' ne contient pas un secret chiffré exploitable.

$SETUP_HINT
"@
}

if ($secureKey.Length -eq 0) {
    $secureKey.Dispose()
    throw @"
La clé enregistrée dans '$storePath' est vide.

$SETUP_HINT
"@
}

# ---------------------------------------------------------------------------
# 3. Import — la variable de session ne vit que le temps de cet appel
# ---------------------------------------------------------------------------

$splat = @{
    InputFile  = $InputFile
    ApiBaseUrl = $ApiBaseUrl
}
if (-not [string]::IsNullOrWhiteSpace($IdempotencyKey)) {
    $splat['IdempotencyKey'] = $IdempotencyKey
}

try {
    # L'affectation est DANS le try : si elle échouait à mi-chemin, ou si
    # l'utilisateur interrompait ici, le finally nettoierait quand même.
    $bstr = [IntPtr]::Zero
    try {
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        $env:JOB_JOURNEY_AGENT_KEY = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        # Mémoire non managée : le ramasse-miettes ne la libère pas. Sans
        # ZeroFreeBSTR, la clé resterait en clair dans le processus.
        if ($bstr -ne [IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
        Remove-Variable -Name bstr -ErrorAction SilentlyContinue
    }

    # Toute la logique (validation, JSON, transport HTTPS, idempotence,
    # redaction des erreurs) vit dans import-application.ps1 : ce wrapper
    # n'en réimplémente aucune part et remonte sa sortie telle quelle.
    & $importScript @splat
}
finally {
    # Exigence de l'issue #13 : la variable ne survit jamais au wrapper.
    # Elle est supprimée, pas restaurée à une éventuelle valeur précédente —
    # laisser un secret posé « parce qu'il y était avant » irait contre le
    # but même de ce script.
    Remove-Item Env:JOB_JOURNEY_AGENT_KEY -ErrorAction SilentlyContinue

    if ($secureKey -is [System.Security.SecureString]) { $secureKey.Dispose() }
    Remove-Variable -Name secureKey -ErrorAction SilentlyContinue
}
