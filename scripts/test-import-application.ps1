#Requires -Version 5.1

<#
.SYNOPSIS
    Validation locale de scripts/import-application.ps1.

.DESCRIPTION
    Exécute le script d'import contre un serveur HTTP factice écoutant sur
    127.0.0.1 (port éphémère). Aucune clé réelle n'est utilisée et aucun appel
    n'est effectué vers la production ni vers un serveur distant.

    Aucune dépendance externe : pas de Pester, pas de module à installer.

.EXAMPLE
    .\scripts\test-import-application.ps1
#>

[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$importScript = Join-Path $scriptRoot 'import-application.ps1'
$exampleJson = Join-Path (Split-Path -Parent $scriptRoot) 'examples\agent-application.example.json'

# Clé manifestement factice : ce n'est pas un secret et elle n'ouvre rien.
$FAKE_KEY = 'jja_testonly_NOT-A-REAL-KEY-0000000000'

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
# Exécution du script d'import dans un runspace séparé, pendant que le thread
# principal joue le rôle du serveur HTTP.
# ---------------------------------------------------------------------------

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

function Invoke-ImportAgainstMock {
    param(
        [Parameter(Mandatory = $true)][string] $InputFile,
        [Parameter()][string] $IdempotencyKey,
        [Parameter(Mandatory = $true)][int] $StatusCode,
        [Parameter(Mandatory = $true)][string] $ReasonPhrase,
        [Parameter(Mandatory = $true)][string] $ResponseJson,
        [Parameter()][string] $ResponseContentType = 'application/json; charset=utf-8'
    )

    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port

    $powerShell = [PowerShell]::Create()
    $null = $powerShell.AddScript($clientRunner.ToString())
    $null = $powerShell.AddArgument($importScript)
    $null = $powerShell.AddArgument($InputFile)
    $null = $powerShell.AddArgument("http://127.0.0.1:$port")
    $null = $powerShell.AddArgument($IdempotencyKey)

    $requestHeaders = $null
    $requestBody = $null

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
                    $requestBody = $buffer
                }

                $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($ResponseJson)
                $head = "HTTP/1.1 $StatusCode $ReasonPhrase`r`n" +
                        "Content-Type: $ResponseContentType`r`n" +
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
        RequestBody    = $requestBody
    }
}

# Exécute le script en sachant qu'aucun appel réseau ne doit avoir lieu, et
# le prouve : une connexion émise atterrirait dans le backlog du listener.
function Invoke-ImportExpectingNoNetworkCall {
    param(
        [Parameter(Mandatory = $true)][string] $InputFile,
        [Parameter()][string] $IdempotencyKey
    )

    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port

    $errorMessage = $null
    $succeeded = $false

    try {
        $splat = @{ InputFile = $InputFile; ApiBaseUrl = "http://127.0.0.1:$port" }
        if ($IdempotencyKey) { $splat['IdempotencyKey'] = $IdempotencyKey }

        $null = & $importScript @splat
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
    return ($text -notmatch [regex]::Escape($FAKE_KEY))
}

# Comparaison octet par octet, sans dépendre de LINQ ni de PowerShell 7 :
# renvoie l'index du premier octet divergent, ou -1 si les tableaux sont
# rigoureusement identiques (longueur comprise).
function Get-FirstByteDifference {
    param(
        [Parameter()] $Expected,
        [Parameter()] $Actual
    )

    if ($null -eq $Expected -or $null -eq $Actual) { return 0 }

    $shortest = [Math]::Min($Expected.Length, $Actual.Length)
    for ($i = 0; $i -lt $shortest; $i++) {
        if ($Expected[$i] -ne $Actual[$i]) { return $i }
    }

    if ($Expected.Length -ne $Actual.Length) { return $shortest }

    return -1
}

# Réserve puis libère un port de la loopback : il est alors très probablement
# fermé, ce qui permet de prouver qu'un appel réseau a bien été *tenté*.
function Get-ClosedLoopbackPort {
    $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $probe.Start()
    $port = $probe.LocalEndpoint.Port
    $probe.Stop()
    return $port
}

# Exécution directe, utilisée pour les cas où l'on teste la politique d'URL :
# soit le script refuse avant tout socket, soit il tente la connexion et
# échoue immédiatement sur un port fermé.
function Invoke-ImportDirect {
    param(
        [Parameter(Mandatory = $true)][string] $InputFile,
        [Parameter(Mandatory = $true)][string] $ApiBaseUrl,
        [Parameter()][string] $IdempotencyKey
    )

    $errorMessage = $null
    $succeeded = $false

    try {
        $splat = @{ InputFile = $InputFile; ApiBaseUrl = $ApiBaseUrl }
        if ($IdempotencyKey) { $splat['IdempotencyKey'] = $IdempotencyKey }

        $null = & $importScript @splat
        $succeeded = $true
    }
    catch {
        $errorMessage = $_.Exception.Message
    }

    return [PSCustomObject]@{
        Success      = $succeeded
        ErrorMessage = $errorMessage
    }
}

# ---------------------------------------------------------------------------
# Fixtures temporaires
# ---------------------------------------------------------------------------

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("jj-import-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path $tempDir

$invalidJsonFile = Join-Path $tempDir 'invalid.json'
Set-Content -LiteralPath $invalidJsonFile -Value '{ "company": "Acme", ' -Encoding UTF8

$missingFile = Join-Path $tempDir 'ce-fichier-nexiste-pas.json'

# Fixture volontairement hostile à l'encodage : accents (2 octets en UTF-8),
# symboles monétaires et CJK (3 octets), et un caractère hors BMP (4 octets,
# soit une paire de substitution côté chaîne .NET).
$multiByteFile = Join-Path $tempDir 'multibyte.json'
$multiByteJson = @'
{
  "company": "Crêpes & Cie",
  "position": "Développeur Backend",
  "location": "Zürich",
  "salary": "45-55 k€",
  "notes": "Accents éàçùî — Symboles €£¥ — CJK 日本語 — Hors BMP 🚀𝄞"
}
'@
[System.IO.File]::WriteAllText($multiByteFile, $multiByteJson, (New-Object System.Text.UTF8Encoding($false)))

$originalKey = $env:JOB_JOURNEY_AGENT_KEY

try {
    # -----------------------------------------------------------------------
    Write-Section "1. JOB_JOURNEY_AGENT_KEY absente"
    # -----------------------------------------------------------------------
    Remove-Item Env:JOB_JOURNEY_AGENT_KEY -ErrorAction SilentlyContinue

    $case = Invoke-ImportExpectingNoNetworkCall -InputFile $exampleJson
    Assert-That (-not $case.Success) "le script echoue"
    Assert-That ($case.ErrorMessage -match 'JOB_JOURNEY_AGENT_KEY') "l'erreur nomme la variable manquante"
    Assert-That (-not $case.SawConnection) "aucun appel reseau n'a ete tente"

    $env:JOB_JOURNEY_AGENT_KEY = $FAKE_KEY

    # -----------------------------------------------------------------------
    Write-Section "2. Fichier d'entree absent"
    # -----------------------------------------------------------------------
    $case = Invoke-ImportExpectingNoNetworkCall -InputFile $missingFile
    Assert-That (-not $case.Success) "le script echoue"
    Assert-That ($case.ErrorMessage -match 'introuvable') "l'erreur signale un fichier introuvable"
    Assert-That (-not $case.SawConnection) "aucun appel reseau n'a ete tente"

    # -----------------------------------------------------------------------
    Write-Section "3. JSON invalide"
    # -----------------------------------------------------------------------
    $case = Invoke-ImportExpectingNoNetworkCall -InputFile $invalidJsonFile
    Assert-That (-not $case.Success) "le script echoue"
    Assert-That ($case.ErrorMessage -match 'JSON valide') "l'erreur signale un JSON invalide"
    Assert-That (-not $case.SawConnection) "aucun appel reseau n'a ete tente"

    # -----------------------------------------------------------------------
    Write-Section "4. Cle d'idempotence trop longue"
    # -----------------------------------------------------------------------
    $case = Invoke-ImportExpectingNoNetworkCall -InputFile $exampleJson -IdempotencyKey ('x' * 129)
    Assert-That (-not $case.Success) "le script echoue"
    Assert-That ($case.ErrorMessage -match '128') "l'erreur rappelle la limite de 128 caracteres"
    Assert-That (-not $case.SawConnection) "aucun appel reseau n'a ete tente"

    # -----------------------------------------------------------------------
    Write-Section "5. HTTP distant refuse avant tout appel reseau"
    # -----------------------------------------------------------------------
    $case = Invoke-ImportDirect -InputFile $exampleJson -ApiBaseUrl 'http://example.com'
    Assert-That (-not $case.Success) "le script echoue"
    Assert-That ($case.ErrorMessage -match 'HTTPS est obligatoire') "l'erreur exige HTTPS"
    Assert-That ($case.ErrorMessage -match 'localhost|127\.0\.0\.1') "l'erreur precise l'exception loopback"
    # Le message est celui de la validation locale : si un socket avait ete
    # ouvert, on aurait recu une erreur reseau ou un code HTTP a la place.
    Assert-That ($case.ErrorMessage -notmatch 'Impossible de contacter|ConnectFailure|a repondu HTTP') "l'echec est une validation locale, pas une erreur reseau"
    Assert-That (Test-NoKeyLeak $case.ErrorMessage) "l'erreur ne contient pas la cle"

    $case = Invoke-ImportDirect -InputFile $exampleJson -ApiBaseUrl 'http://192.0.2.10:4000'
    Assert-That (-not $case.Success) "une IP distante en HTTP est refusee"
    Assert-That ($case.ErrorMessage -match 'HTTPS est obligatoire') "l'erreur exige HTTPS"
    Assert-That ($case.ErrorMessage -notmatch 'Impossible de contacter|ConnectFailure') "aucun appel reseau n'a ete tente"

    # -----------------------------------------------------------------------
    Write-Section "6. HTTP loopback accepte par la politique de transport"
    # -----------------------------------------------------------------------
    $closedPort = Get-ClosedLoopbackPort

    foreach ($loopbackHost in @('localhost', '127.0.0.1', '[::1]')) {
        $case = Invoke-ImportDirect -InputFile $exampleJson -ApiBaseUrl "http://${loopbackHost}:$closedPort"
        Assert-That (-not ($case.ErrorMessage -match 'HTTPS est obligatoire')) "$loopbackHost n'est pas bloque par la politique de transport"
        Assert-That ($case.ErrorMessage -match 'Impossible de contacter') "$loopbackHost atteint bien la couche reseau"
    }

    # -----------------------------------------------------------------------
    Write-Section "7. HTTPS accepte par la politique de transport"
    # -----------------------------------------------------------------------
    $case = Invoke-ImportDirect -InputFile $exampleJson -ApiBaseUrl "https://127.0.0.1:$closedPort"
    Assert-That (-not ($case.ErrorMessage -match 'HTTPS est obligatoire')) "https n'est jamais bloque par la politique de transport"
    Assert-That ($case.ErrorMessage -match 'Impossible de contacter') "https atteint bien la couche reseau"
    Assert-That (Test-NoKeyLeak $case.ErrorMessage) "l'erreur ne contient pas la cle"

    # -----------------------------------------------------------------------
    Write-Section "8. Reponse simulee 201 created"
    # -----------------------------------------------------------------------
    $created = '{"status":"created","applicationId":"app_11111111","duplicate":false,"idempotent":false}'
    $run = Invoke-ImportAgainstMock -InputFile $exampleJson -StatusCode 201 -ReasonPhrase 'Created' -ResponseJson $created

    Assert-That ($null -ne $run.Client -and $run.Client.Success) "le script reussit"
    Assert-That ($null -ne $run.RequestHeaders -and $run.RequestHeaders -match '(?im)^POST /agent/applications HTTP/1\.1') "la requete cible POST /agent/applications"
    Assert-That ($run.RequestHeaders -match "(?im)^Authorization:\s*Bearer\s+$([regex]::Escape($FAKE_KEY))\s*$") "l'en-tete Authorization porte le schema Bearer"
    Assert-That ($run.RequestHeaders -match '(?im)^Content-Type:\s*application/json') "l'en-tete Content-Type est application/json"

    $sentIdempotencyKey = $null
    if ($run.RequestHeaders -match '(?im)^Idempotency-Key:\s*(\S+)\s*$') { $sentIdempotencyKey = $Matches[1] }
    Assert-That ($null -ne $sentIdempotencyKey) "une Idempotency-Key est envoyee"
    Assert-That ($sentIdempotencyKey -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') "la cle generee est un GUID valide"
    Assert-That ($sentIdempotencyKey.Length -ge 1 -and $sentIdempotencyKey.Length -le 128) "la cle generee respecte la limite 1-128"

    # Le fichier d'exemple n'a pas de BOM : les octets recus doivent donc etre
    # exactement ceux du fichier sur disque, sans transformation.
    $exampleBytes = [System.IO.File]::ReadAllBytes($exampleJson)
    $hasBom = ($exampleBytes.Length -ge 3 -and $exampleBytes[0] -eq 0xEF -and $exampleBytes[1] -eq 0xBB -and $exampleBytes[2] -eq 0xBF)
    Assert-That (-not $hasBom) "le fichier d'exemple est sans BOM (l'attendu est donc valide)"

    $diffIndex = Get-FirstByteDifference -Expected $exampleBytes -Actual $run.RequestBody
    Assert-That ($diffIndex -eq -1) "le corps recu est identique octet par octet au fichier source (premier ecart : $diffIndex)"

    $out = $run.Client.Output
    Assert-That ($out.status -eq 'created') "status = created"
    Assert-That ($out.applicationId -eq 'app_11111111') "applicationId remonte"
    Assert-That ($out.duplicate -eq $false) "duplicate = false"
    Assert-That ($out.idempotent -eq $false) "idempotent = false"
    Assert-That (($out | Get-Member -MemberType NoteProperty).Count -eq 4) "la sortie expose exactement 4 champs"

    # -----------------------------------------------------------------------
    Write-Section "9. Cle d'idempotence generee unique a chaque appel"
    # -----------------------------------------------------------------------
    $run2 = Invoke-ImportAgainstMock -InputFile $exampleJson -StatusCode 201 -ReasonPhrase 'Created' -ResponseJson $created
    $secondKey = $null
    if ($run2.RequestHeaders -match '(?im)^Idempotency-Key:\s*(\S+)\s*$') { $secondKey = $Matches[1] }
    Assert-That ($null -ne $secondKey -and $secondKey -ne $sentIdempotencyKey) "deux executions produisent deux cles differentes"

    # -----------------------------------------------------------------------
    Write-Section "10. Reponse simulee 200 duplicate"
    # -----------------------------------------------------------------------
    $duplicate = '{"status":"duplicate","applicationId":"app_22222222","duplicate":true,"idempotent":false}'
    $run = Invoke-ImportAgainstMock -InputFile $exampleJson -StatusCode 200 -ReasonPhrase 'OK' -ResponseJson $duplicate

    Assert-That ($run.Client.Success) "le script reussit"
    Assert-That ($run.Client.Output.status -eq 'duplicate') "status = duplicate"
    Assert-That ($run.Client.Output.duplicate -eq $true) "duplicate = true"
    Assert-That ($run.Client.Output.idempotent -eq $false) "idempotent = false"

    # -----------------------------------------------------------------------
    Write-Section "11. Reponse simulee 200 idempotent (cle fournie)"
    # -----------------------------------------------------------------------
    $providedKey = 'import-manuel-2026-08-04-001'
    $idempotent = '{"status":"created","applicationId":"app_33333333","duplicate":false,"idempotent":true}'
    $run = Invoke-ImportAgainstMock -InputFile $exampleJson -IdempotencyKey $providedKey -StatusCode 200 -ReasonPhrase 'OK' -ResponseJson $idempotent

    Assert-That ($run.Client.Success) "le script reussit"
    Assert-That ($run.RequestHeaders -match "(?im)^Idempotency-Key:\s*$([regex]::Escape($providedKey))\s*$") "la cle fournie est transmise telle quelle"
    Assert-That ($run.Client.Output.idempotent -eq $true) "idempotent = true"
    Assert-That ($run.Client.Output.applicationId -eq 'app_33333333') "applicationId remonte"

    # -----------------------------------------------------------------------
    Write-Section "12. Erreur HTTP simulee 401 sans fuite du secret"
    # -----------------------------------------------------------------------
    $unauthorized = '{"error":{"code":"unauthorized"}}'
    $run = Invoke-ImportAgainstMock -InputFile $exampleJson -StatusCode 401 -ReasonPhrase 'Unauthorized' -ResponseJson $unauthorized

    Assert-That (-not $run.Client.Success) "le script echoue"
    Assert-That ($run.Client.ErrorMessage -match '401') "l'erreur mentionne le code HTTP 401"
    Assert-That ($run.Client.ErrorMessage -match 'unauthorized') "l'erreur mentionne le code d'erreur de l'API"
    Assert-That (Test-NoKeyLeak $run.Client.ErrorMessage) "l'erreur ne contient pas la cle"
    Assert-That ($run.Client.ErrorMessage -notmatch '(?i)authorization') "l'erreur ne cite pas l'en-tete Authorization"

    # -----------------------------------------------------------------------
    Write-Section "13. Erreur HTTP simulee 400 validation_error"
    # -----------------------------------------------------------------------
    $validation = '{"error":{"code":"validation_error","fieldErrors":{"company":["Requis"]},"formErrors":[]}}'
    $run = Invoke-ImportAgainstMock -InputFile $exampleJson -StatusCode 400 -ReasonPhrase 'Bad Request' -ResponseJson $validation

    Assert-That (-not $run.Client.Success) "le script echoue"
    Assert-That ($run.Client.ErrorMessage -match 'validation_error') "l'erreur remonte le code validation_error"
    Assert-That ($run.Client.ErrorMessage -match 'company') "l'erreur remonte le champ fautif"
    Assert-That (Test-NoKeyLeak $run.Client.ErrorMessage) "l'erreur ne contient pas la cle"

    # -----------------------------------------------------------------------
    Write-Section "14. Redaction : reponse JSON refletant la cle"
    # -----------------------------------------------------------------------
    # Simule une API (ou un proxy) qui recopie l'en-tete Authorization dans
    # formErrors et fieldErrors. Sans redaction, la cle s'afficherait en clair.
    $reflectingJson = '{"error":{"code":"validation_error",' +
        '"fieldErrors":{"authorization":["Bearer ' + $FAKE_KEY + ' refuse"]},' +
        '"formErrors":["Jeton invalide : ' + $FAKE_KEY + '"]}}'
    $run = Invoke-ImportAgainstMock -InputFile $exampleJson -StatusCode 400 -ReasonPhrase 'Bad Request' -ResponseJson $reflectingJson

    Assert-That (-not $run.Client.Success) "le script echoue"
    Assert-That (Test-NoKeyLeak $run.Client.ErrorMessage) "la cle factice est absente du message"
    Assert-That ($run.Client.ErrorMessage -match '\[REDACTED\]') "le marqueur [REDACTED] est present"
    Assert-That ($run.Client.ErrorMessage -match '400') "le code HTTP reste lisible"
    Assert-That ($run.Client.ErrorMessage -match 'validation_error') "le code metier reste lisible"
    Assert-That ($run.Client.ErrorMessage -match 'authorization') "le champ invalide reste lisible"
    # Le nom de champ et le mot « Bearer » viennent de la reponse du serveur :
    # les restituer n'est pas une fuite. Ce qui ne doit jamais apparaitre,
    # c'est un jeton Bearer non redacte.
    Assert-That ($run.Client.ErrorMessage -notmatch '(?i)Bearer\s+(?!\[REDACTED\])\S') "aucun jeton Bearer non redacte n'apparait"

    # -----------------------------------------------------------------------
    Write-Section "15. Redaction : reponse NON JSON refletant la cle"
    # -----------------------------------------------------------------------
    # Corps text/plain, typique d'une passerelle ou d'un reverse proxy.
    $reflectingText = "502 Bad Gateway - upstream rejected request with header Authorization: Bearer $FAKE_KEY"
    $run = Invoke-ImportAgainstMock -InputFile $exampleJson -StatusCode 502 -ReasonPhrase 'Bad Gateway' -ResponseJson $reflectingText -ResponseContentType 'text/plain; charset=utf-8'

    Assert-That (-not $run.Client.Success) "le script echoue"
    Assert-That (Test-NoKeyLeak $run.Client.ErrorMessage) "la cle factice est absente du message"
    Assert-That ($run.Client.ErrorMessage -match '\[REDACTED\]') "le marqueur [REDACTED] est present"
    Assert-That ($run.Client.ErrorMessage -match '502') "le code HTTP reste lisible"
    Assert-That ($run.Client.ErrorMessage -match '(?i)upstream rejected') "le contexte utile du corps est conserve"
    Assert-That ($run.Client.ErrorMessage -notmatch '(?i)Bearer\s+(?!\[REDACTED\])\S') "aucun jeton Bearer non redacte n'apparait"

    # -----------------------------------------------------------------------
    Write-Section "16. Le script ne supprime pas la variable de session"
    # -----------------------------------------------------------------------
    # Le finally efface les copies locales, pas $env:JOB_JOURNEY_AGENT_KEY :
    # plusieurs imports doivent rester possibles dans la meme session.
    $run = Invoke-ImportAgainstMock -InputFile $exampleJson -StatusCode 201 -ReasonPhrase 'Created' -ResponseJson $created
    Assert-That ($run.Client.Success) "un premier import reussit"
    Assert-That ($env:JOB_JOURNEY_AGENT_KEY -eq $FAKE_KEY) "la variable de session survit a un import reussi"

    $run = Invoke-ImportAgainstMock -InputFile $exampleJson -StatusCode 401 -ReasonPhrase 'Unauthorized' -ResponseJson '{"error":{"code":"unauthorized"}}'
    Assert-That (-not $run.Client.Success) "un second import echoue"
    Assert-That ($env:JOB_JOURNEY_AGENT_KEY -eq $FAKE_KEY) "la variable de session survit aussi a un import en erreur"

    $run = Invoke-ImportAgainstMock -InputFile $exampleJson -StatusCode 201 -ReasonPhrase 'Created' -ResponseJson $created
    Assert-That ($run.Client.Success) "un troisieme import reste possible dans la meme session"

    # -----------------------------------------------------------------------
    Write-Section "17. Comparaison reelle des octets UTF-8 (multi-octets)"
    # -----------------------------------------------------------------------
    $run = Invoke-ImportAgainstMock -InputFile $multiByteFile -StatusCode 201 -ReasonPhrase 'Created' -ResponseJson $created

    Assert-That ($run.Client.Success) "le script reussit sur une charge utile multi-octets"

    $multiByteBytes = [System.IO.File]::ReadAllBytes($multiByteFile)
    $diffIndex = Get-FirstByteDifference -Expected $multiByteBytes -Actual $run.RequestBody
    Assert-That ($diffIndex -eq -1) "le corps recu est identique octet par octet (premier ecart : $diffIndex)"

    # Verifie que la fixture contient bien les sequences multi-octets visees,
    # sans quoi la comparaison ci-dessus ne prouverait rien d'interessant.
    $sentText = [System.Text.Encoding]::UTF8.GetString($run.RequestBody)
    Assert-That ($sentText.Contains([string][char]0x00E9)) "sequence UTF-8 sur 2 octets presente (e accent aigu)"
    Assert-That ($sentText.Contains([string][char]0x20AC)) "sequence UTF-8 sur 3 octets presente (signe euro)"
    Assert-That ($multiByteBytes -contains 0xF0) "sequence UTF-8 sur 4 octets presente (caractere hors BMP)"
    Assert-That ($multiByteBytes.Length -gt $sentText.Length) "l'encodage est bien multi-octets (plus d'octets que de caracteres UTF-16)"

    # -----------------------------------------------------------------------
    Write-Section "18. Le script n'ecrit aucun fichier et ne cree pas de .env"
    # -----------------------------------------------------------------------
    $repoRoot = Split-Path -Parent $scriptRoot
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $scriptRoot '.env'))) "aucun .env dans scripts/"
    $scriptText = [System.IO.File]::ReadAllText($importScript)
    Assert-That ($scriptText -notmatch 'Out-File|Set-Content|Add-Content|WriteAllText|WriteAllBytes') "le script d'import n'ecrit dans aucun fichier"
    Assert-That ($scriptText -notmatch 'jja_[A-Za-z0-9]{6,}') "aucune cle en dur dans le script d'import"
}
finally {
    if ($null -eq $originalKey) {
        Remove-Item Env:JOB_JOURNEY_AGENT_KEY -ErrorAction SilentlyContinue
    }
    else {
        $env:JOB_JOURNEY_AGENT_KEY = $originalKey
    }

    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
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
