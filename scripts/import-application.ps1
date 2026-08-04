#Requires -Version 5.1

<#
.SYNOPSIS
    Importe une candidature dans Job Journey depuis un fichier JSON local.

.DESCRIPTION
    Envoie le contenu d'un fichier JSON vers POST /agent/applications.

    La clé API est lue UNIQUEMENT depuis la variable d'environnement de session
    JOB_JOURNEY_AGENT_KEY. Le script ne l'affiche jamais, ne l'écrit dans aucun
    fichier et ne l'enregistre nulle part sur disque. Sa valeur est masquée
    ([REDACTED]) dans tout message d'erreur, y compris lorsqu'un serveur la
    recopie dans son corps de réponse.

    En fin d'exécution, le script efface ses propres copies en mémoire. Il ne
    supprime PAS $env:JOB_JOURNEY_AGENT_KEY : la variable de session persiste
    volontairement pour permettre plusieurs imports d'affilée. Son nettoyage
    est manuel :
        Remove-Item Env:JOB_JOURNEY_AGENT_KEY -ErrorAction SilentlyContinue

    Toutes les vérifications (fichier présent, clé présente, JSON valide,
    transport autorisé) ont lieu AVANT le moindre appel réseau.

.PARAMETER InputFile
    Chemin du fichier JSON à importer. Obligatoire.

.PARAMETER ApiBaseUrl
    URL de base de l'API. Par défaut http://localhost:4000, c'est-à-dire le
    serveur de développement local : aucune exécution ne vise la production
    tant qu'on ne le demande pas explicitement.

    HTTP n'est accepté que vers la machine locale (localhost, 127.0.0.1, ::1).
    Toute destination distante impose HTTPS, sans quoi la clé circulerait en
    clair dans l'en-tête Authorization. Le refus intervient avant tout appel
    réseau.

.PARAMETER IdempotencyKey
    Clé d'idempotence à envoyer. Si elle est absente, le script en génère une
    unique (GUID). Rejouer le même import avec la même clé et le même contenu
    ne crée pas de doublon.

.OUTPUTS
    Un objet avec les champs status, applicationId, duplicate et idempotent.

.EXAMPLE
    .\scripts\import-application.ps1 -InputFile .\examples\agent-application.example.json

.EXAMPLE
    .\scripts\import-application.ps1 -InputFile .\ma-candidature.json -ApiBaseUrl https://jobjourney-api.onrender.com
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputFile,

    [Parameter()]
    [string]$ApiBaseUrl = 'http://localhost:4000',

    [Parameter()]
    [string]$IdempotencyKey
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Set-StrictMode 2.0 fait échouer l'accès à une propriété inexistante : on
# passe donc systématiquement par cet accès défensif pour lire une réponse
# JSON dont on ne contrôle pas la forme.
function Get-OptionalProperty {
    param(
        [Parameter()] $InputObject,
        [Parameter(Mandatory = $true)][string] $Name
    )

    if ($null -eq $InputObject) { return $null }

    $psObject = $InputObject.PSObject
    if ($null -eq $psObject) { return $null }

    $property = $psObject.Properties[$Name]
    if ($null -eq $property) { return $null }

    return $property.Value
}

function Read-Utf8Text {
    param([Parameter(Mandatory = $true)][string] $Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)

    # Un fichier enregistré par Notepad ou par PowerShell 5.1 commence souvent
    # par un BOM UTF-8, que ConvertFrom-Json refuse.
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) {
        $text = $text.Substring(1)
    }

    return $text
}

# Secret à masquer dans toute sortie. Renseigné une fois la clé lue, effacé
# dans le bloc finally de l'appel réseau.
$script:RedactionSecret = $null
$REDACTION_MARKER = '[REDACTED]'

# Point de passage unique avant tout affichage ou toute exception remontée à
# l'utilisateur. Le corps d'une réponse HTTP vient d'un serveur qu'on ne
# contrôle pas : une API, un proxy ou un serveur factice qui refléterait
# l'en-tête Authorization ferait réapparaître la clé dans la console.
#
# Le remplacement est LITTÉRAL (String.Replace, comparaison ordinale) et
# jamais une regex construite à partir du secret : une clé contenant des
# métacaractères (« . », « + », « [ ») produirait un motif qui ne
# reconnaîtrait pas sa propre valeur, et la redaction échouerait en silence.
function Protect-Secret {
    param([Parameter()] $Text)

    if ($null -eq $Text) { return $Text }

    $value = [string]$Text
    $secret = $script:RedactionSecret

    if ([string]::IsNullOrEmpty($secret)) { return $value }

    return $value.Replace($secret, $REDACTION_MARKER)
}

# Extrait un message lisible d'une réponse d'erreur HTTP, sans jamais toucher
# aux en-têtes de la requête (donc sans jamais exposer l'en-tête Authorization)
# et en masquant la clé si le serveur l'a recopiée dans son corps de réponse.
function Format-ApiErrorDetail {
    param([Parameter()][string] $ResponseBody)

    if ([string]::IsNullOrWhiteSpace($ResponseBody)) { return $null }

    $parsed = $null
    try {
        $parsed = $ResponseBody | ConvertFrom-Json
    }
    catch {
        # Corps non JSON : recopié tronqué, donc systématiquement redacté.
        $trimmed = $ResponseBody.Trim()
        if ($trimmed.Length -gt 500) { $trimmed = $trimmed.Substring(0, 500) + '...' }
        return (Protect-Secret $trimmed)
    }

    $apiError = Get-OptionalProperty -InputObject $parsed -Name 'error'
    if ($null -eq $apiError) { return $null }

    $parts = @()

    $code = Get-OptionalProperty -InputObject $apiError -Name 'code'
    if ($code) { $parts += "code=$code" }

    # formErrors et fieldErrors portent des messages produits par le serveur :
    # leur contenu est recopié tel quel, donc redacté comme le reste.
    $formErrors = Get-OptionalProperty -InputObject $apiError -Name 'formErrors'
    if ($formErrors) { $parts += ($formErrors -join ' ; ') }

    $fieldErrors = Get-OptionalProperty -InputObject $apiError -Name 'fieldErrors'
    if ($null -ne $fieldErrors -and $null -ne $fieldErrors.PSObject) {
        foreach ($field in $fieldErrors.PSObject.Properties) {
            $parts += ("{0}: {1}" -f $field.Name, ($field.Value -join ' ; '))
        }
    }

    if ($parts.Count -eq 0) { return $null }
    return (Protect-Secret ($parts -join ' | '))
}

# ---------------------------------------------------------------------------
# 1. Vérifications locales — aucune n'entraîne d'appel réseau
# ---------------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($InputFile)) {
    throw "Le paramètre -InputFile est vide. Indiquez le chemin d'un fichier JSON."
}

if (-not (Test-Path -LiteralPath $InputFile -PathType Leaf)) {
    throw "Fichier introuvable : '$InputFile'. Vérifiez le chemin passé à -InputFile."
}

# [IO.File] résout les chemins relatifs depuis le répertoire du processus, pas
# depuis l'emplacement PowerShell courant : on résout donc explicitement.
$resolvedInputFile = (Resolve-Path -LiteralPath $InputFile).ProviderPath

$apiKey = $env:JOB_JOURNEY_AGENT_KEY
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw @"
La variable d'environnement JOB_JOURNEY_AGENT_KEY est absente ou vide.
Définissez-la pour la session PowerShell courante uniquement :

    `$secure = Read-Host 'Cle API Job Journey' -AsSecureString
    `$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(`$secure)
    try {
        `$env:JOB_JOURNEY_AGENT_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(`$bstr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR(`$bstr)
        Remove-Variable secure, bstr -ErrorAction SilentlyContinue
    }

Conserver le pointeur puis appeler ZeroFreeBSTR est indispensable : la mémoire
non managée allouée par SecureStringToBSTR n'est pas libérée par le GC et
resterait en clair dans le processus.

N'écrivez jamais cette clé dans un fichier .env, dans le dépôt ou dans une conversation.
"@
}
$apiKey = $apiKey.Trim()

# À partir d'ici, toute sortie passe par Protect-Secret.
$script:RedactionSecret = $apiKey

$jsonText = Read-Utf8Text -Path $resolvedInputFile

if ([string]::IsNullOrWhiteSpace($jsonText)) {
    throw "Le fichier '$resolvedInputFile' est vide : rien à importer."
}

try {
    $parsedPayload = $jsonText | ConvertFrom-Json
}
catch {
    throw "Le fichier '$resolvedInputFile' ne contient pas du JSON valide : $($_.Exception.Message)"
}

if ($null -eq $parsedPayload -or $parsedPayload -is [array] -or $parsedPayload -is [string] -or $parsedPayload -is [valuetype]) {
    throw "Le fichier '$resolvedInputFile' doit contenir un objet JSON (accolades), pas un tableau ni une valeur simple."
}

# Clé d'idempotence : fournie par l'appelant, sinon générée. Le serveur exige
# 1 à 128 caractères ; on valide ici pour échouer avant l'appel réseau plutôt
# que de récolter un 400.
if ([string]::IsNullOrWhiteSpace($IdempotencyKey)) {
    $effectiveIdempotencyKey = [guid]::NewGuid().ToString()
}
else {
    $effectiveIdempotencyKey = $IdempotencyKey.Trim()

    if ($effectiveIdempotencyKey.Length -gt 128) {
        throw "La clé d'idempotence dépasse 128 caractères (longueur : $($effectiveIdempotencyKey.Length))."
    }

    if ($effectiveIdempotencyKey -notmatch '^[\x20-\x7E]+$') {
        throw "La clé d'idempotence doit être composée de caractères ASCII imprimables uniquement."
    }
}

if ([string]::IsNullOrWhiteSpace($ApiBaseUrl)) {
    throw "Le paramètre -ApiBaseUrl est vide."
}

$normalizedBaseUrl = $ApiBaseUrl.Trim().TrimEnd('/')
$parsedUri = $null
if (-not [System.Uri]::TryCreate($normalizedBaseUrl, [System.UriKind]::Absolute, [ref]$parsedUri) -or
    ($parsedUri.Scheme -ne 'http' -and $parsedUri.Scheme -ne 'https')) {
    throw "L'URL '$ApiBaseUrl' n'est pas une URL http(s) absolue valide."
}

# La clé part en clair dans l'en-tête Authorization : en HTTP, n'importe quel
# intermédiaire réseau la lit. On refuse donc HTTP dès que la destination
# quitte la machine locale, et ce contrôle a lieu AVANT toute ouverture de
# socket — la clé n'est jamais émise, même une seule fois.
# Uri.IsLoopback couvre localhost, 127.0.0.0/8 et ::1.
if ($parsedUri.Scheme -eq 'http' -and -not $parsedUri.IsLoopback) {
    throw "HTTPS est obligatoire pour '$ApiBaseUrl' : en HTTP, la clé JOB_JOURNEY_AGENT_KEY circulerait en clair sur le réseau. HTTP n'est accepté que vers la machine locale (localhost, 127.0.0.1, ::1). Utilisez https:// pour toute destination distante."
}

$requestUri = "$normalizedBaseUrl/agent/applications"

# ---------------------------------------------------------------------------
# 2. Appel réseau
# ---------------------------------------------------------------------------

# Windows PowerShell 5.1 négocie encore TLS 1.0 par défaut sur certaines
# machines, ce que refusent les hébergeurs HTTPS actuels.
try {
    [System.Net.ServicePointManager]::SecurityProtocol =
        [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
}
catch {
    Write-Verbose "Impossible d'ajuster le protocole TLS ; poursuite avec la valeur par défaut."
}

$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($jsonText)

Write-Verbose "POST $requestUri ($($bodyBytes.Length) octets, Idempotency-Key: $effectiveIdempotencyKey)"

$headers = @{
    'Authorization'   = "Bearer $apiKey"
    'Idempotency-Key' = $effectiveIdempotencyKey
}

try {
    # -Verbose:$false : on ne laisse jamais un -Verbose de l'appelant se
    # propager au client HTTP, dont la trace détaille la requête sortante.
    $response = Invoke-RestMethod `
        -Uri $requestUri `
        -Method Post `
        -Headers $headers `
        -ContentType 'application/json; charset=utf-8' `
        -Body $bodyBytes `
        -UseBasicParsing `
        -Verbose:$false
}
catch [System.Net.WebException] {
    $webResponse = $_.Exception.Response

    if ($null -eq $webResponse) {
        throw "Impossible de contacter l'API à $requestUri ($($_.Exception.Status)). Vérifiez -ApiBaseUrl et que le serveur est démarré."
    }

    $statusCode = [int]$webResponse.StatusCode
    $statusText = $webResponse.StatusDescription

    # PowerShell 5.1 place généralement le corps de la réponse d'erreur dans
    # ErrorDetails ; sinon on relit le flux nous-mêmes.
    $responseBody = $null
    if ($null -ne $_.ErrorDetails) { $responseBody = $_.ErrorDetails.Message }

    if ([string]::IsNullOrWhiteSpace($responseBody)) {
        try {
            $stream = $webResponse.GetResponseStream()
            if ($null -ne $stream) {
                $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
                try { $responseBody = $reader.ReadToEnd() } finally { $reader.Dispose() }
            }
        }
        catch {
            $responseBody = $null
        }
    }

    $message = "L'API a répondu HTTP $statusCode ($statusText)."

    $detail = Format-ApiErrorDetail -ResponseBody $responseBody
    if ($detail) { $message += " $detail" }

    if ($statusCode -eq 401) {
        $message += " La clé JOB_JOURNEY_AGENT_KEY est absente du serveur, inconnue ou invalide."
    }
    elseif ($statusCode -eq 429) {
        $retryAfter = $null
        try { $retryAfter = $webResponse.Headers['Retry-After'] } catch { $retryAfter = $null }
        if ($retryAfter) { $message += " Réessayez dans $retryAfter secondes." }
    }

    # Filet de sécurité final : quel que soit le chemin ayant construit le
    # message, il ne sort jamais d'ici sans être passé par la redaction.
    throw (Protect-Secret $message)
}
catch {
    # Le message d'exception générique peut lui aussi véhiculer un corps de
    # réponse ou une URL fournis par un tiers.
    throw (Protect-Secret "Échec de l'appel à $requestUri : $($_.Exception.Message)")
}
finally {
    # Efface uniquement les copies locales détenues par ce script : la chaîne
    # $apiKey, l'en-tête Authorization et le secret de redaction.
    #
    # $env:JOB_JOURNEY_AGENT_KEY n'est volontairement PAS supprimée ici : la
    # variable de session doit rester disponible pour les imports suivants
    # dans la même fenêtre PowerShell. Son nettoyage est une action manuelle,
    # documentée dans le README :
    #     Remove-Item Env:JOB_JOURNEY_AGENT_KEY -ErrorAction SilentlyContinue
    $headers = $null
    $apiKey = $null
    $script:RedactionSecret = $null
    Remove-Variable -Name headers, apiKey -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 3. Sortie — uniquement les champs opérationnels
# ---------------------------------------------------------------------------

# Projection explicite : un champ ajouté plus tard côté API ne serait pas
# recopié aveuglément dans la sortie du script.
[PSCustomObject]@{
    status        = Get-OptionalProperty -InputObject $response -Name 'status'
    applicationId = Get-OptionalProperty -InputObject $response -Name 'applicationId'
    duplicate     = Get-OptionalProperty -InputObject $response -Name 'duplicate'
    idempotent    = Get-OptionalProperty -InputObject $response -Name 'idempotent'
}
