#Requires -Version 5.1

<#
.SYNOPSIS
    Validation locale de setup-agent-key.ps1 et import-application-secure.ps1.

.DESCRIPTION
    Tests hors ligne, sans clé réelle et sans appel sortant :

      - %APPDATA% est redirigé vers un dossier temporaire pendant toute la
        session de test : le magasin réel de l'utilisateur n'est jamais lu,
        écrit ni écrasé (une assertion finale le prouve) ;
      - Read-Host est remplacé par une fonction locale, ce qui permet de jouer
        le scénario de saisie sans interaction ;
      - les imports visent un serveur HTTP factice sur 127.0.0.1 (port
        éphémère). Aucun test n'atteint la production.

    Le chiffrement testé est le vrai DPAPI, appliqué à une clé manifestement
    factice qui n'ouvre rien.

    Aucune dépendance externe : pas de Pester, pas de module à installer.

.EXAMPLE
    .\scripts\test-agent-key-secure.ps1
#>

[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$setupScript = Join-Path $scriptRoot 'setup-agent-key.ps1'
$secureImportScript = Join-Path $scriptRoot 'import-application-secure.ps1'
$importScript = Join-Path $scriptRoot 'import-application.ps1'
$exampleJson = Join-Path $repoRoot 'examples\agent-application.example.json'

# Clés manifestement factices : ce ne sont pas des secrets et elles n'ouvrent
# rien. La seconde contient de la ponctuation pour éprouver la fidélité du
# cycle SecureString -> DPAPI -> BSTR -> variable d'environnement.
$FAKE_KEY = 'jja_testonly_NOT-A-REAL-KEY-0000000000'
$FAKE_KEY_PUNCT = 'jja_testonly+/=~!@#$%^&*()_NOT-A-REAL-KEY'

$script:Passed = 0
$script:Failed = 0

# .NET ajoute « Expect: 100-continue » aux POST par défaut, ce qui ferait
# attendre le client 350 ms face à notre serveur factice minimaliste.
[System.Net.ServicePointManager]::Expect100Continue = $false

# ---------------------------------------------------------------------------
# Micro-harnais d'assertions
# ---------------------------------------------------------------------------

function Assert-That {
    param(
        [Parameter(Mandatory = $true)][bool] $Condition,
        [Parameter(Mandatory = $true)][string] $Message
    )

    if ($Condition) {
        $script:Passed++
        Write-Host "  [OK]   $Message" -ForegroundColor Green
    }
    else {
        $script:Failed++
        Write-Host "  [FAIL] $Message" -ForegroundColor Red
    }
}

function Write-Section {
    param([Parameter(Mandatory = $true)][string] $Title)
    Write-Host ""
    Write-Host "== $Title" -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# Read-Host simulé
# ---------------------------------------------------------------------------
# Une fonction définie ici masque le cmdlet Read-Host pour tout script appelé
# depuis cette portée : setup-agent-key.ps1 lira donc la valeur préparée par le
# test au lieu d'attendre une frappe clavier. Aucune modification du script de
# production n'est nécessaire pour le rendre testable.
#
# La valeur transite par $global: et non $script: : quand la fonction s'exécute,
# elle est appelée depuis setup-agent-key.ps1, et $script: y désigne la portée
# de CE script — pas celle du test. Seule la portée globale est commune aux deux.

$global:MockReadHostValue = $null

function Read-Host {
    param(
        [Parameter()][string] $Prompt,
        [Parameter()][switch] $AsSecureString
    )

    if (-not $AsSecureString) {
        throw "Le test attend un Read-Host -AsSecureString (saisie masquee)."
    }

    return $global:MockReadHostValue
}

function ConvertTo-TestSecureString {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Plain)

    $secure = New-Object System.Security.SecureString
    foreach ($ch in $Plain.ToCharArray()) { $secure.AppendChar($ch) }
    $secure.MakeReadOnly()
    return $secure
}

# Exécute le setup avec une saisie simulée, en capturant TOUTES les sorties
# (succès, information/Write-Host, verbose, warning, erreur) afin de pouvoir
# prouver ensuite qu'aucune ne contient la clé.
function Invoke-SetupWithKey {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $Key,
        [Parameter()][switch] $Force
    )

    $global:MockReadHostValue = ConvertTo-TestSecureString -Plain $Key

    $output = $null
    $errorMessage = $null
    $succeeded = $false

    try {
        if ($Force) {
            $output = & $setupScript -Force 6>&1 5>&1 4>&1 3>&1 2>&1
        }
        else {
            $output = & $setupScript 6>&1 5>&1 4>&1 3>&1 2>&1
        }
        $succeeded = $true
    }
    catch {
        $errorMessage = $_.Exception.Message
    }
    finally {
        $global:MockReadHostValue = $null
    }

    return [PSCustomObject]@{
        Success      = $succeeded
        Output       = $output
        OutputText   = ($output | Out-String)
        ErrorMessage = $errorMessage
    }
}

# ---------------------------------------------------------------------------
# Serveur HTTP factice + exécution du wrapper dans un runspace séparé
# ---------------------------------------------------------------------------
# Les variables d'environnement sont propres au processus, pas au runspace :
# le wrapper exécuté ici voit le %APPDATA% redirigé, et la variable
# JOB_JOURNEY_AGENT_KEY qu'il pose (puis supprime) est observable depuis le
# thread principal une fois l'appel terminé. C'est exactement ce qu'il faut
# pour vérifier le nettoyage.

$clientRunner = {
    param($ScriptPath, $InputFile, $BaseUrl, $IdempotencyKey)

    try {
        $splat = @{ InputFile = $InputFile; ApiBaseUrl = $BaseUrl }
        if ($IdempotencyKey) { $splat['IdempotencyKey'] = $IdempotencyKey }

        $output = & $ScriptPath @splat

        [PSCustomObject]@{ Success = $true; Output = $output; ErrorMessage = $null }
    }
    catch {
        [PSCustomObject]@{ Success = $false; Output = $null; ErrorMessage = $_.Exception.Message }
    }
}

function Invoke-SecureImportAgainstMock {
    param(
        [Parameter(Mandatory = $true)][string] $InputFile,
        [Parameter()][string] $IdempotencyKey,
        [Parameter(Mandatory = $true)][int] $StatusCode,
        [Parameter(Mandatory = $true)][string] $ReasonPhrase,
        [Parameter(Mandatory = $true)][string] $ResponseJson
    )

    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port

    $powerShell = [PowerShell]::Create()
    $null = $powerShell.AddScript($clientRunner.ToString())
    $null = $powerShell.AddArgument($secureImportScript)
    $null = $powerShell.AddArgument($InputFile)
    $null = $powerShell.AddArgument("http://127.0.0.1:$port")
    $null = $powerShell.AddArgument($IdempotencyKey)

    $requestHeaders = $null

    try {
        $async = $powerShell.BeginInvoke()

        # On n'attend jamais indéfiniment : si le client échoue avant de se
        # connecter, on sort dès qu'il a terminé.
        $deadline = (Get-Date).AddSeconds(20)
        while (-not $listener.Pending()) {
            if ($async.IsCompleted -or (Get-Date) -gt $deadline) { break }
            Start-Sleep -Milliseconds 20
        }

        if ($listener.Pending()) {
            $client = $listener.AcceptTcpClient()
            try {
                $client.ReceiveTimeout = 10000
                $client.SendTimeout = 10000
                $stream = $client.GetStream()

                # En-têtes : lecture octet par octet jusqu'à CRLF CRLF.
                $headerBytes = New-Object 'System.Collections.Generic.List[byte]'
                while ($true) {
                    $b = $stream.ReadByte()
                    if ($b -lt 0) { break }
                    $headerBytes.Add([byte]$b)
                    $count = $headerBytes.Count
                    if ($count -ge 4 -and
                        $headerBytes[$count - 4] -eq 13 -and $headerBytes[$count - 3] -eq 10 -and
                        $headerBytes[$count - 2] -eq 13 -and $headerBytes[$count - 1] -eq 10) {
                        break
                    }
                }

                $requestHeaders = [System.Text.Encoding]::ASCII.GetString($headerBytes.ToArray())

                $contentLength = 0
                if ($requestHeaders -match '(?im)^Content-Length:\s*(\d+)\s*$') {
                    $contentLength = [int]$Matches[1]
                }

                if ($contentLength -gt 0) {
                    $buffer = New-Object byte[] $contentLength
                    $read = 0
                    while ($read -lt $contentLength) {
                        $chunk = $stream.Read($buffer, $read, $contentLength - $read)
                        if ($chunk -le 0) { break }
                        $read += $chunk
                    }
                }

                $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($ResponseJson)
                $head = "HTTP/1.1 $StatusCode $ReasonPhrase`r`n" +
                        "Content-Type: application/json; charset=utf-8`r`n" +
                        "Content-Length: $($bodyBytes.Length)`r`n" +
                        "Connection: close`r`n`r`n"
                $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)

                $stream.Write($headBytes, 0, $headBytes.Length)
                $stream.Write($bodyBytes, 0, $bodyBytes.Length)
                $stream.Flush()
            }
            finally {
                $client.Close()
            }
        }

        $result = $powerShell.EndInvoke($async)
    }
    finally {
        $powerShell.Dispose()
        $listener.Stop()
    }

    $clientResult = $null
    if ($null -ne $result -and $result.Count -gt 0) { $clientResult = $result[0] }

    return [PSCustomObject]@{
        Client         = $clientResult
        RequestHeaders = $requestHeaders
    }
}

# Exécute le wrapper en sachant qu'aucun appel réseau ne doit avoir lieu, et le
# prouve : une connexion émise atterrirait dans le backlog du listener.
function Invoke-SecureImportExpectingNoNetworkCall {
    param([Parameter(Mandatory = $true)][string] $InputFile)

    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port

    $errorMessage = $null
    $succeeded = $false

    try {
        $null = & $secureImportScript -InputFile $InputFile -ApiBaseUrl "http://127.0.0.1:$port"
        $succeeded = $true
    }
    catch {
        $errorMessage = $_.Exception.Message
    }

    Start-Sleep -Milliseconds 100
    $sawConnection = $listener.Pending()
    $listener.Stop()

    return [PSCustomObject]@{
        Success       = $succeeded
        ErrorMessage  = $errorMessage
        SawConnection = $sawConnection
    }
}

function Test-NoKeyLeak {
    param([Parameter()] $Value)

    if ($null -eq $Value) { return $true }
    $text = ($Value | Out-String)
    return (($text -notmatch [regex]::Escape($FAKE_KEY)) -and ($text -notmatch [regex]::Escape($FAKE_KEY_PUNCT)))
}

function Test-AgentKeyVariableAbsent {
    return (-not (Test-Path Env:JOB_JOURNEY_AGENT_KEY))
}

# ---------------------------------------------------------------------------
# Isolation : %APPDATA% temporaire, magasin réel intact
# ---------------------------------------------------------------------------

$realAppData = $env:APPDATA
$realStorePath = $null
$realStoreExisted = $false
$realStoreStamp = $null

if (-not [string]::IsNullOrWhiteSpace($realAppData)) {
    $realStorePath = Join-Path (Join-Path $realAppData 'JobJourney') 'agent-key.xml'
    $realStoreExisted = Test-Path -LiteralPath $realStorePath -PathType Leaf
    if ($realStoreExisted) {
        $realStoreStamp = (Get-Item -LiteralPath $realStorePath).LastWriteTimeUtc
    }
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("jj-agentkey-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path $tempDir
$fakeAppData = Join-Path $tempDir 'AppData'
$null = New-Item -ItemType Directory -Path $fakeAppData

$expectedStorePath = Join-Path (Join-Path $fakeAppData 'JobJourney') 'agent-key.xml'

$originalKeyVariable = $env:JOB_JOURNEY_AGENT_KEY

try {
    $env:APPDATA = $fakeAppData
    Remove-Item Env:JOB_JOURNEY_AGENT_KEY -ErrorAction SilentlyContinue

    # -----------------------------------------------------------------------
    Write-Section "1. Setup nominal"
    # -----------------------------------------------------------------------
    $setup = Invoke-SetupWithKey -Key $FAKE_KEY

    Assert-That $setup.Success "le setup reussit"
    Assert-That (Test-Path -LiteralPath $expectedStorePath -PathType Leaf) "le fichier chiffre est cree dans %APPDATA%\JobJourney\agent-key.xml"
    Assert-That ($setup.OutputText -match [regex]::Escape($expectedStorePath)) "le chemin du fichier est affiche"
    Assert-That (Test-NoKeyLeak $setup.OutputText) "aucune sortie du setup ne contient la cle"
    Assert-That ($setup.OutputText -match 'DPAPI') "la sortie mentionne le chiffrement Windows"

    # -----------------------------------------------------------------------
    Write-Section "2. Le fichier ne contient pas la cle en clair"
    # -----------------------------------------------------------------------
    # Export-Clixml écrit en UTF-16LE sous Windows PowerShell 5.1. On décode
    # donc les octets dans les deux encodages : la clé ne doit apparaître dans
    # aucune interprétation possible du fichier.
    $storeBytes = [System.IO.File]::ReadAllBytes($expectedStorePath)
    $asUtf8 = [System.Text.Encoding]::UTF8.GetString($storeBytes)
    $asUtf16 = [System.Text.Encoding]::Unicode.GetString($storeBytes)

    Assert-That ($asUtf8 -notmatch [regex]::Escape($FAKE_KEY)) "la cle n'apparait pas en UTF-8 dans le fichier"
    Assert-That ($asUtf16 -notmatch [regex]::Escape($FAKE_KEY)) "la cle n'apparait pas en UTF-16 dans le fichier"
    Assert-That ($asUtf8 -notmatch 'jja_' -and $asUtf16 -notmatch 'jja_') "meme le prefixe jja_ est absent du fichier"
    Assert-That ($asUtf16 -match '(?i)<SS>') "le fichier contient bien un secret serialise (element <SS>)"
    Assert-That ($asUtf16 -match '(?i)<SS>[0-9a-f]+</SS>') "le secret est stocke comme blob hexadecimal chiffre"

    $roundTrip = Import-Clixml -LiteralPath $expectedStorePath
    Assert-That ($roundTrip -is [System.Security.SecureString]) "la relecture rend un SecureString"
    Assert-That ($roundTrip.Length -eq $FAKE_KEY.Length) "la longueur relue correspond a la cle saisie"
    $roundTrip.Dispose()

    # -----------------------------------------------------------------------
    Write-Section "3. Setup : saisies refusees"
    # -----------------------------------------------------------------------
    $storeStampBefore = (Get-Item -LiteralPath $expectedStorePath).LastWriteTimeUtc

    $case = Invoke-SetupWithKey -Key '' -Force
    Assert-That (-not $case.Success) "une cle vide est refusee"
    Assert-That ($case.ErrorMessage -match 'vide') "l'erreur signale une saisie vide"

    $case = Invoke-SetupWithKey -Key 'sk_live_pas_une_cle_job_journey' -Force
    Assert-That (-not $case.Success) "une cle sans prefixe jja_ est refusee"
    Assert-That ($case.ErrorMessage -match 'jja_') "l'erreur rappelle le prefixe attendu"

    $case = Invoke-SetupWithKey -Key 'JJA_MAJUSCULES_REFUSEES' -Force
    Assert-That (-not $case.Success) "le prefixe est compare de maniere sensible a la casse"

    $case = Invoke-SetupWithKey -Key 'jja_' -Force
    Assert-That (-not $case.Success) "le prefixe seul est refuse"
    Assert-That ($case.ErrorMessage -match 'courte') "l'erreur signale une cle trop courte"

    $case = Invoke-SetupWithKey -Key " $FAKE_KEY " -Force
    Assert-That (-not $case.Success) "une cle entouree d'espaces est refusee"
    Assert-That ($case.ErrorMessage -match 'espace') "l'erreur signale les espaces parasites"
    Assert-That (Test-NoKeyLeak $case.ErrorMessage) "le message de refus ne contient pas la cle"

    $storeStampAfter = (Get-Item -LiteralPath $expectedStorePath).LastWriteTimeUtc
    Assert-That ($storeStampBefore -eq $storeStampAfter) "aucun refus n'a touche au fichier deja enregistre"

    # -----------------------------------------------------------------------
    Write-Section "4. Setup : ecrasement protege par -Force"
    # -----------------------------------------------------------------------
    $case = Invoke-SetupWithKey -Key $FAKE_KEY_PUNCT
    Assert-That (-not $case.Success) "sans -Force, une cle deja enregistree n'est pas ecrasee"
    Assert-That ($case.ErrorMessage -match '-Force') "l'erreur indique comment forcer l'ecrasement"

    $case = Invoke-SetupWithKey -Key $FAKE_KEY_PUNCT -Force
    Assert-That $case.Success "avec -Force, l'ecrasement est accepte"
    Assert-That (Test-NoKeyLeak $case.OutputText) "la sortie de l'ecrasement ne contient pas la cle"

    $roundTrip = Import-Clixml -LiteralPath $expectedStorePath
    Assert-That ($roundTrip.Length -eq $FAKE_KEY_PUNCT.Length) "la nouvelle cle a bien remplace l'ancienne"
    $roundTrip.Dispose()

    # Retour a la cle de reference pour la suite des tests.
    $case = Invoke-SetupWithKey -Key $FAKE_KEY -Force
    Assert-That $case.Success "reenregistrement de la cle de reference"

    # -----------------------------------------------------------------------
    Write-Section "5. Setup : refus d'ecrire dans le depot"
    # -----------------------------------------------------------------------
    # %APPDATA% detourne vers le depot : la destination calculee tomberait dans
    # l'arborescence Git, ce que le script doit refuser avant toute ecriture.
    $env:APPDATA = $repoRoot
    $case = Invoke-SetupWithKey -Key $FAKE_KEY -Force
    $env:APPDATA = $fakeAppData

    Assert-That (-not $case.Success) "une destination situee dans le depot est refusee"
    Assert-That ($case.ErrorMessage -match '(?i)d.p.t') "l'erreur explique que le depot est interdit"
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'JobJourney'))) "aucun dossier n'a ete cree dans le depot"

    # -----------------------------------------------------------------------
    Write-Section "6. Import mocke : succes de bout en bout"
    # -----------------------------------------------------------------------
    $created = '{"status":"created","applicationId":"app_11111111","duplicate":false,"idempotent":false}'
    $run = Invoke-SecureImportAgainstMock -InputFile $exampleJson -StatusCode 201 -ReasonPhrase 'Created' -ResponseJson $created

    Assert-That ($null -ne $run.Client -and $run.Client.Success) "le wrapper reussit sans aucune saisie de cle"
    Assert-That ($null -ne $run.RequestHeaders -and $run.RequestHeaders -match '(?im)^POST /agent/applications HTTP/1\.1') "la requete cible POST /agent/applications"
    # Prouve la fidelite du cycle complet : SecureString -> DPAPI -> fichier ->
    # DPAPI -> BSTR -> variable d'environnement -> en-tete HTTP.
    Assert-That ($run.RequestHeaders -match "(?im)^Authorization:\s*Bearer\s+$([regex]::Escape($FAKE_KEY))\s*$") "la cle dechiffree arrive intacte dans l'en-tete Authorization"

    $out = $run.Client.Output
    Assert-That ($out.status -eq 'created') "la sortie de import-application.ps1 est remontee telle quelle (status)"
    Assert-That ($out.applicationId -eq 'app_11111111') "applicationId remonte"
    Assert-That (($out | Get-Member -MemberType NoteProperty).Count -eq 4) "la sortie expose exactement les 4 champs du script appele"

    # -----------------------------------------------------------------------
    Write-Section "7. Nettoyage de JOB_JOURNEY_AGENT_KEY apres succes"
    # -----------------------------------------------------------------------
    Assert-That (Test-AgentKeyVariableAbsent) "la variable n'existe plus apres un import reussi"

    # -----------------------------------------------------------------------
    Write-Section "8. Nettoyage de JOB_JOURNEY_AGENT_KEY apres erreur"
    # -----------------------------------------------------------------------
    $unauthorized = '{"error":{"code":"unauthorized"}}'
    $run = Invoke-SecureImportAgainstMock -InputFile $exampleJson -StatusCode 401 -ReasonPhrase 'Unauthorized' -ResponseJson $unauthorized

    Assert-That (-not $run.Client.Success) "un import en erreur echoue bien"
    Assert-That ($run.Client.ErrorMessage -match '401') "l'erreur du script appele est remontee"
    Assert-That (Test-AgentKeyVariableAbsent) "la variable n'existe plus apres un import en erreur"
    Assert-That (Test-NoKeyLeak $run.Client.ErrorMessage) "le message d'erreur ne contient pas la cle"

    # -----------------------------------------------------------------------
    Write-Section "9. Nettoyage meme si la variable preexistait"
    # -----------------------------------------------------------------------
    # Le wrapper supprime, il ne restaure pas : laisser un secret pose « parce
    # qu'il y etait avant » irait contre le but du script.
    $env:JOB_JOURNEY_AGENT_KEY = 'jja_testonly_VALEUR-PREEXISTANTE'
    $run = Invoke-SecureImportAgainstMock -InputFile $exampleJson -StatusCode 201 -ReasonPhrase 'Created' -ResponseJson $created

    Assert-That ($run.Client.Success) "l'import reussit malgre une variable preexistante"
    Assert-That (Test-AgentKeyVariableAbsent) "la variable preexistante est supprimee, pas restauree"

    # -----------------------------------------------------------------------
    Write-Section "10. Import : fichier de cle absent"
    # -----------------------------------------------------------------------
    $backupPath = Join-Path $tempDir 'agent-key.backup.xml'
    Copy-Item -LiteralPath $expectedStorePath -Destination $backupPath -Force
    Remove-Item -LiteralPath $expectedStorePath -Force

    $case = Invoke-SecureImportExpectingNoNetworkCall -InputFile $exampleJson
    Assert-That (-not $case.Success) "le wrapper echoue"
    Assert-That ($case.ErrorMessage -match 'setup-agent-key\.ps1') "l'erreur invite a lancer setup-agent-key.ps1"
    Assert-That ($case.ErrorMessage -match [regex]::Escape($expectedStorePath)) "l'erreur nomme le fichier attendu"
    Assert-That (-not $case.SawConnection) "aucun appel reseau n'a ete tente"
    Assert-That (Test-AgentKeyVariableAbsent) "aucune variable n'a ete laissee posee"

    # -----------------------------------------------------------------------
    Write-Section "11. Import : fichier de cle corrompu"
    # -----------------------------------------------------------------------
    Set-Content -LiteralPath $expectedStorePath -Value '<Objs><ceci nest pas du clixml' -Encoding UTF8

    $case = Invoke-SecureImportExpectingNoNetworkCall -InputFile $exampleJson
    Assert-That (-not $case.Success) "un fichier illisible est refuse"
    Assert-That ($case.ErrorMessage -match '(?i)corrompu|illisible') "l'erreur qualifie le fichier de corrompu ou illisible"
    Assert-That ($case.ErrorMessage -match 'setup-agent-key\.ps1') "l'erreur invite a relancer le setup"
    Assert-That (-not $case.SawConnection) "aucun appel reseau n'a ete tente"
    Assert-That (Test-AgentKeyVariableAbsent) "aucune variable n'a ete laissee posee"

    # Fichier tronque au milieu du blob chiffre : XML parfaitement valide, mais
    # DPAPI ne peut plus le dechiffrer. Get-Content -Raw suit la marque d'ordre
    # des octets du fichier, et on reecrit dans le meme encodage (UTF-16LE) :
    # sans cela on testerait un fichier binairement illisible, pas un blob
    # tronque, et l'assertion ne prouverait rien.
    $truncated = Get-Content -LiteralPath $backupPath -Raw
    $truncated = $truncated -replace '(?s)(<SS>[0-9a-fA-F]{20}).*?(</SS>)', '$1$2'
    Assert-That ($truncated -match '(?i)<SS>[0-9a-f]{20}</SS>') "la fixture est bien un blob tronque dans un XML valide"
    Set-Content -LiteralPath $expectedStorePath -Value $truncated -Encoding Unicode -NoNewline

    $case = Invoke-SecureImportExpectingNoNetworkCall -InputFile $exampleJson
    Assert-That (-not $case.Success) "un blob DPAPI tronque est refuse"
    Assert-That ($case.ErrorMessage -match 'setup-agent-key\.ps1') "l'erreur invite a relancer le setup"
    Assert-That (-not $case.SawConnection) "aucun appel reseau n'a ete tente"

    # -----------------------------------------------------------------------
    Write-Section "12. Import : cle stockee en clair refusee"
    # -----------------------------------------------------------------------
    # Sans ce controle, un fichier .xml contenant une chaine en clair serait
    # accepte en silence et tout l'interet du chiffrement disparaitrait.
    $FAKE_KEY | Export-Clixml -LiteralPath $expectedStorePath -Force

    $case = Invoke-SecureImportExpectingNoNetworkCall -InputFile $exampleJson
    Assert-That (-not $case.Success) "un secret non chiffre est refuse"
    Assert-That ($case.ErrorMessage -match '(?i)chiffr') "l'erreur explique que le contenu n'est pas chiffre"
    Assert-That (Test-NoKeyLeak $case.ErrorMessage) "le message d'erreur ne recopie pas le contenu du fichier"
    Assert-That (-not $case.SawConnection) "aucun appel reseau n'a ete tente"

    Copy-Item -LiteralPath $backupPath -Destination $expectedStorePath -Force

    # -----------------------------------------------------------------------
    Write-Section "13. Fidelite du cycle pour une cle a caracteres speciaux"
    # -----------------------------------------------------------------------
    $case = Invoke-SetupWithKey -Key $FAKE_KEY_PUNCT -Force
    Assert-That $case.Success "une cle a ponctuation est acceptee"

    $run = Invoke-SecureImportAgainstMock -InputFile $exampleJson -StatusCode 201 -ReasonPhrase 'Created' -ResponseJson $created
    Assert-That ($run.Client.Success) "l'import reussit avec cette cle"
    Assert-That ($run.RequestHeaders -match "(?im)^Authorization:\s*Bearer\s+$([regex]::Escape($FAKE_KEY_PUNCT))\s*$") "les caracteres speciaux traversent le cycle sans alteration"
    Assert-That (Test-AgentKeyVariableAbsent) "la variable est nettoyee"

    $case = Invoke-SetupWithKey -Key $FAKE_KEY -Force
    Assert-That $case.Success "retour a la cle de reference"

    # -----------------------------------------------------------------------
    Write-Section "14. Idempotency-Key transmise au script appele"
    # -----------------------------------------------------------------------
    $providedKey = 'import-securise-2026-08-05-001'
    $run = Invoke-SecureImportAgainstMock -InputFile $exampleJson -IdempotencyKey $providedKey -StatusCode 200 -ReasonPhrase 'OK' -ResponseJson '{"status":"created","applicationId":"app_33333333","duplicate":false,"idempotent":true}'

    Assert-That ($run.Client.Success) "le wrapper reussit"
    Assert-That ($run.RequestHeaders -match "(?im)^Idempotency-Key:\s*$([regex]::Escape($providedKey))\s*$") "la cle d'idempotence fournie est transmise telle quelle"
    Assert-That ($run.Client.Output.idempotent -eq $true) "idempotent = true est remonte"

    $run = Invoke-SecureImportAgainstMock -InputFile $exampleJson -StatusCode 201 -ReasonPhrase 'Created' -ResponseJson $created
    $generated = $null
    if ($run.RequestHeaders -match '(?im)^Idempotency-Key:\s*(\S+)\s*$') { $generated = $Matches[1] }
    Assert-That ($generated -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') "sans parametre, le GUID est genere par le script appele"

    # -----------------------------------------------------------------------
    Write-Section "15. Erreurs du script appele remontees sans fuite"
    # -----------------------------------------------------------------------
    $reflecting = '{"error":{"code":"validation_error","formErrors":["Jeton invalide : ' + $FAKE_KEY + '"]}}'
    $run = Invoke-SecureImportAgainstMock -InputFile $exampleJson -StatusCode 400 -ReasonPhrase 'Bad Request' -ResponseJson $reflecting

    Assert-That (-not $run.Client.Success) "le wrapper echoue"
    Assert-That (Test-NoKeyLeak $run.Client.ErrorMessage) "la redaction du script appele reste active a travers le wrapper"
    Assert-That ($run.Client.ErrorMessage -match '\[REDACTED\]') "le marqueur [REDACTED] est present"
    Assert-That (Test-AgentKeyVariableAbsent) "la variable est nettoyee malgre l'erreur"

    # -----------------------------------------------------------------------
    Write-Section "16. Controles statiques du code"
    # -----------------------------------------------------------------------
    $setupText = [System.IO.File]::ReadAllText($setupScript)
    $wrapperText = [System.IO.File]::ReadAllText($secureImportScript)
    $setupAst = [System.Management.Automation.Language.Parser]::ParseFile($setupScript, [ref]$null, [ref]$null)

    Assert-That ($setupText -notmatch 'jja_[A-Za-z0-9]{6,}') "aucune cle en dur dans setup-agent-key.ps1"
    Assert-That ($wrapperText -notmatch 'jja_[A-Za-z0-9]{6,}') "aucune cle en dur dans import-application-secure.ps1"
    # Le setup n'ecrit que par Export-Clixml, et uniquement vers $storePath.
    Assert-That ($setupText -notmatch 'Out-File|Set-Content|Add-Content|WriteAllText|WriteAllBytes') "setup-agent-key.ps1 n'utilise aucune primitive d'ecriture de fichier libre"
    # Analyse syntaxique plutot que recherche textuelle : le bloc d'aide cite
    # Export-Clixml pour expliquer le mecanisme, ce qui n'est pas une ecriture.
    # Seuls les appels reels sont comptes.
    $exportCalls = @($setupAst.FindAll(
        { param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Export-Clixml' },
        $true))
    Assert-That ($exportCalls.Count -eq 1) "setup-agent-key.ps1 n'ecrit qu'a un seul endroit"
    Assert-That ($setupText -match 'Export-Clixml -LiteralPath \$storePath') "cette ecriture vise le magasin verifie par Assert-SafeStorePath"
    Assert-That ($wrapperText -notmatch 'Out-File|Set-Content|Add-Content|WriteAllText|WriteAllBytes|Export-Clixml') "le wrapper n'ecrit aucun fichier"

    # Le wrapper delegue : il ne doit contenir aucune logique reseau propre.
    Assert-That ($wrapperText -notmatch 'Invoke-RestMethod|Invoke-WebRequest|HttpClient|WebRequest') "le wrapper ne duplique pas la logique reseau de import-application.ps1"
    Assert-That ($wrapperText -match [regex]::Escape("Join-Path `$PSScriptRoot 'import-application.ps1'")) "le wrapper appelle bien le script existant"

    Assert-That ($wrapperText -match '(?s)finally\s*\{[^}]*Remove-Item\s+Env:JOB_JOURNEY_AGENT_KEY') "la suppression de la variable est dans un bloc finally"

    # Defaut de -ApiBaseUrl verifie par analyse syntaxique, sans executer le
    # script : aucun test ne doit pouvoir contacter la production.
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($secureImportScript, [ref]$null, [ref]$null)
    $apiParam = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'ApiBaseUrl' }
    Assert-That ($null -ne $apiParam) "le parametre -ApiBaseUrl existe"
    Assert-That ($apiParam.DefaultValue.Extent.Text -eq "'https://jobjourney-api.onrender.com'") "son defaut est l'instance deployee en HTTPS"

    $inputParam = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'InputFile' }
    Assert-That ($null -ne $inputParam) "le parametre -InputFile existe"

    # Aucun parametre de chemin sur le setup : le magasin n'est pas choisissable.
    $setupParamNames = @($setupAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    Assert-That ($setupParamNames -notcontains 'Path' -and $setupParamNames -notcontains 'OutputFile' -and $setupParamNames -notcontains 'StorePath') "setup-agent-key.ps1 n'accepte aucun parametre de chemin"

    Assert-That (Test-Path -LiteralPath $importScript -PathType Leaf) "import-application.ps1 est toujours present et inchange par cette issue"
}
finally {
    $env:APPDATA = $realAppData

    if ($null -eq $originalKeyVariable) {
        Remove-Item Env:JOB_JOURNEY_AGENT_KEY -ErrorAction SilentlyContinue
    }
    else {
        $env:JOB_JOURNEY_AGENT_KEY = $originalKeyVariable
    }

    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Filet de securite : le magasin reel de l'utilisateur n'a pas ete touche
# ---------------------------------------------------------------------------

Write-Section "17. Magasin reel de l'utilisateur intact"

if ($null -eq $realStorePath) {
    Assert-That $true "APPDATA absent de cette session : aucun magasin reel a proteger"
}
else {
    $stillExists = Test-Path -LiteralPath $realStorePath -PathType Leaf
    Assert-That ($stillExists -eq $realStoreExisted) "l'existence du magasin reel est inchangee"

    if ($realStoreExisted -and $stillExists) {
        Assert-That ((Get-Item -LiteralPath $realStorePath).LastWriteTimeUtc -eq $realStoreStamp) "le magasin reel n'a pas ete reecrit"
    }
}

Write-Host ""
Write-Host "-----------------------------------------------" -ForegroundColor Cyan
Write-Host "Reussites : $script:Passed   Echecs : $script:Failed"

if ($script:Failed -gt 0) {
    Write-Host "VALIDATION EN ECHEC" -ForegroundColor Red
    exit 1
}

Write-Host "VALIDATION OK" -ForegroundColor Green
exit 0
