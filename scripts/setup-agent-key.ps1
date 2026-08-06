#Requires -Version 5.1

<#
.SYNOPSIS
    Enregistre une seule fois la clé agent Job Journey, chiffrée par Windows.

.DESCRIPTION
    Demande la clé API (saisie masquée), la valide, puis l'enregistre chiffrée
    dans %APPDATA%\JobJourney\agent-key.xml.

    Le chiffrement repose sur DPAPI (Data Protection API de Windows), utilisé
    automatiquement par Export-Clixml lorsqu'on lui passe un SecureString : la
    clé de chiffrement est dérivée du compte Windows courant. Le fichier n'est
    donc déchiffrable que par cet utilisateur, sur cette machine. Copié
    ailleurs, il est inexploitable.

    Le chemin de destination est EN DUR. Le script n'accepte aucun paramètre de
    chemin : il ne peut donc jamais écrire dans le dépôt, dans un .env, ni dans
    un emplacement choisi par l'appelant. Trois garde-fous vérifient malgré tout
    la destination avant écriture, au cas où %APPDATA% pointerait ailleurs.

    La clé n'est jamais affichée, jamais journalisée, jamais écrite en clair.
    Seuls une confirmation et le chemin du fichier chiffré sont affichés.

.PARAMETER Force
    Autorise l'écrasement d'une clé déjà enregistrée. Sans ce commutateur, le
    script refuse d'écraser un fichier existant : réenregistrer une clé est une
    action destructive (l'ancienne valeur est irrécupérable).

.OUTPUTS
    Un objet avec les champs Path et Length (longueur en caractères de la clé
    enregistrée — jamais la clé elle-même).

.EXAMPLE
    .\scripts\setup-agent-key.ps1

.EXAMPLE
    .\scripts\setup-agent-key.ps1 -Force
#>

[CmdletBinding()]
param(
    [Parameter()]
    [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$KEY_PREFIX = 'jja_'
$STORE_DIRECTORY_NAME = 'JobJourney'
$STORE_FILE_NAME = 'agent-key.xml'

# ---------------------------------------------------------------------------
# Emplacement du magasin — en dur, puis vérifié
# ---------------------------------------------------------------------------

# Normalise un chemin sans exiger qu'il existe : Resolve-Path échouerait sur le
# fichier qu'on s'apprête à créer.
function Get-NormalizedPath {
    param([Parameter(Mandatory = $true)][string] $Path)

    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-PathIsInside {
    param(
        [Parameter(Mandatory = $true)][string] $Candidate,
        [Parameter(Mandatory = $true)][string] $Container
    )

    $normalizedCandidate = Get-NormalizedPath $Candidate
    $normalizedContainer = (Get-NormalizedPath $Container) + '\'

    # Comparaison ordinale insensible à la casse : le système de fichiers
    # Windows ne distingue pas la casse, et une comparaison culturelle donnerait
    # des résultats dépendants de la locale.
    return $normalizedCandidate.StartsWith($normalizedContainer, [System.StringComparison]::OrdinalIgnoreCase)
}

# Refuse toute destination qui ne serait pas le magasin utilisateur attendu.
# Ces contrôles sont redondants avec le chemin en dur : ils existent pour le cas
# où %APPDATA% aurait été redéfini (profil détourné, session de test mal isolée,
# variable d'environnement injectée par un parent).
function Assert-SafeStorePath {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $RepositoryRoot
    )

    $normalized = Get-NormalizedPath $Path

    if (-not [System.IO.Path]::IsPathRooted($normalized)) {
        throw "Destination refusée : '$normalized' n'est pas un chemin absolu."
    }

    $fileName = [System.IO.Path]::GetFileName($normalized)
    if ($fileName -ne $STORE_FILE_NAME) {
        throw "Destination refusée : le fichier doit s'appeler '$STORE_FILE_NAME', pas '$fileName'."
    }

    # Ceinture et bretelles : un magasin nommé .env, ou situé dans un dossier
    # .env, signalerait une confusion avec le fichier d'environnement du projet.
    if ($normalized -match '(?i)(^|\\)\.env(\\|$)') {
        throw "Destination refusée : '$normalized' ressemble à un fichier .env. La clé ne doit jamais y être écrite."
    }

    if (Test-PathIsInside -Candidate $normalized -Container $RepositoryRoot) {
        throw "Destination refusée : '$normalized' se trouve dans le dépôt Git. La clé ne doit jamais être écrite dans le dépôt."
    }
}

function Get-AgentKeyStorePath {
    $appData = $env:APPDATA

    if ([string]::IsNullOrWhiteSpace($appData)) {
        throw "La variable d'environnement APPDATA est absente : impossible de localiser le magasin utilisateur Windows."
    }

    return Join-Path (Join-Path $appData $STORE_DIRECTORY_NAME) $STORE_FILE_NAME
}

# ---------------------------------------------------------------------------
# Validation de la clé — sans jamais construire de String
# ---------------------------------------------------------------------------

# Une String .NET est immuable : une fois la clé recopiée dedans, plus aucun
# moyen de l'effacer, elle reste lisible dans le processus jusqu'à un éventuel
# passage du ramasse-miettes. On inspecte donc le tampon non managé du
# SecureString caractère par caractère, puis on le libère avec ZeroFreeBSTR
# (qui écrase la zone mémoire avant de la rendre).
#
# Renvoie $null si la clé est acceptable, sinon le message d'erreur à afficher.
function Test-AgentKeyFormat {
    param([Parameter()] $Secure)

    if ($null -eq $Secure -or -not ($Secure -is [System.Security.SecureString])) {
        throw "Saisie invalide : aucune valeur sécurisée n'a été lue."
    }

    if ($Secure.Length -eq 0) {
        return "La clé saisie est vide. Relancez le script et collez la clé fournie par l'API."
    }

    $bstr = [IntPtr]::Zero
    try {
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)

        # Lecture d'un caractère UTF-16 à l'index $i, sans passer par une String.
        # Le cast en uint16 avant char évite qu'un code > 0x7FFF, lu comme Int16
        # signé donc négatif, ne fasse échouer la conversion.
        $charAt = {
            param([int] $Index)
            [char][uint16][System.Runtime.InteropServices.Marshal]::ReadInt16($bstr, $Index * 2)
        }

        # Espaces en tête ou en fin : contrôlés AVANT le préfixe, sinon un
        # copier-coller avec une espace initiale produirait un message parlant
        # de préfixe alors que le vrai problème est ailleurs.
        if ([char]::IsWhiteSpace((& $charAt 0)) -or [char]::IsWhiteSpace((& $charAt ($Secure.Length - 1)))) {
            return "La clé saisie commence ou finit par une espace. Recollez-la sans espace ni retour à la ligne."
        }

        if ($Secure.Length -le $KEY_PREFIX.Length) {
            return "La clé saisie est trop courte : elle doit comporter des caractères après le préfixe '$KEY_PREFIX'."
        }

        for ($i = 0; $i -lt $KEY_PREFIX.Length; $i++) {
            # -cne : comparaison sensible à la casse. 'JJA_' n'est pas 'jja_'.
            if ((& $charAt $i) -cne $KEY_PREFIX[$i]) {
                return "La clé saisie ne commence pas par '$KEY_PREFIX'. Vérifiez que vous avez collé une clé agent Job Journey."
            }
        }
    }
    finally {
        if ($bstr -ne [IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }

    return $null
}

# ---------------------------------------------------------------------------
# 1. Destination
# ---------------------------------------------------------------------------

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$storePath = Get-AgentKeyStorePath
Assert-SafeStorePath -Path $storePath -RepositoryRoot $repositoryRoot

$storeDirectory = Split-Path -Parent $storePath

if ((Test-Path -LiteralPath $storePath) -and -not $Force) {
    throw @"
Une clé est déjà enregistrée dans :
    $storePath

Réenregistrer une clé écrase définitivement l'ancienne valeur, qui n'est pas
récupérable. Si c'est bien ce que vous voulez :

    .\scripts\setup-agent-key.ps1 -Force
"@
}

# ---------------------------------------------------------------------------
# 2. Saisie et validation
# ---------------------------------------------------------------------------

$secureKey = $null
try {
    # -AsSecureString : la saisie n'apparaît ni à l'écran, ni dans l'historique
    # de la console, et n'existe jamais comme String dans le processus.
    $secureKey = Read-Host -Prompt "Cle agent Job Journey (saisie masquee)" -AsSecureString

    $validationError = Test-AgentKeyFormat -Secure $secureKey
    if ($null -ne $validationError) {
        throw $validationError
    }

    $keyLength = $secureKey.Length

    # -------------------------------------------------------------------
    # 3. Écriture chiffrée
    # -------------------------------------------------------------------

    if (-not (Test-Path -LiteralPath $storeDirectory -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $storeDirectory -Force
    }

    # Export-Clixml sérialise un SecureString sous forme de blob DPAPI lié à
    # l'utilisateur Windows courant : le fichier ne contient à aucun moment la
    # clé en clair. C'est le mécanisme demandé par l'issue #13.
    $secureKey | Export-Clixml -LiteralPath $storePath -Force

    # -------------------------------------------------------------------
    # 4. Vérification du cycle complet, sans exposer la clé
    # -------------------------------------------------------------------

    # Écrire sans relire laisserait passer un fichier illisible (disque plein,
    # antivirus, profil itinérant). On revérifie donc que DPAPI redonne bien un
    # SecureString de la bonne longueur — sans jamais le déchiffrer en String.
    $roundTrip = $null
    try {
        $roundTrip = Import-Clixml -LiteralPath $storePath

        if (-not ($roundTrip -is [System.Security.SecureString])) {
            throw "le fichier relu ne contient pas un secret chiffré."
        }

        if ($roundTrip.Length -ne $keyLength) {
            throw "la longueur relue ne correspond pas à la clé saisie."
        }
    }
    catch {
        throw "La clé a été écrite dans '$storePath' mais la relecture a échoué : $($_.Exception.Message) Supprimez ce fichier et relancez le script."
    }
    finally {
        if ($roundTrip -is [System.Security.SecureString]) { $roundTrip.Dispose() }
    }
}
finally {
    # Libère le tampon non managé du SecureString : le GC ne le ferait pas.
    if ($secureKey -is [System.Security.SecureString]) { $secureKey.Dispose() }
    Remove-Variable -Name secureKey -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 5. Confirmation — jamais la clé, seulement sa longueur
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "Cle enregistree, chiffree par Windows (DPAPI)." -ForegroundColor Green
Write-Host "Fichier   : $storePath"
Write-Host "Longueur  : $keyLength caracteres"
Write-Host ""
Write-Host "Import d'une candidature (plus besoin de ressaisir la cle) :"
Write-Host "    .\scripts\import-application-secure.ps1 -InputFile .\ma-candidature.json"
Write-Host ""
Write-Host "Limite connue : tout processus lance sous CE compte Windows peut" -ForegroundColor Yellow
Write-Host "dechiffrer ce fichier. DPAPI protege contre la copie du fichier vers" -ForegroundColor Yellow
Write-Host "une autre machine ou un autre compte, pas contre un programme" -ForegroundColor Yellow
Write-Host "malveillant execute par vous." -ForegroundColor Yellow

[PSCustomObject]@{
    Path   = $storePath
    Length = $keyLength
}
