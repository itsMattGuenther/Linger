param(
    [Parameter(Mandatory=$true)][string]$Bundle,
    [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Run only on a disposable Windows Actions runner' }
New-Item -ItemType Directory -Force $Output | Out-Null
$Output = (Resolve-Path $Output).Path
$shell = New-Object -ComObject WScript.Shell
$desktopFolders = @('Desktop', 'CommonDesktopDirectory') | ForEach-Object { [Environment]::GetFolderPath($_) }
$version = (Get-Content client/src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version

function Get-LingerShortcuts {
    foreach ($directory in $desktopFolders) {
        foreach ($file in Get-ChildItem $directory -Filter '*linger*.lnk') {
            $shortcut = $shell.CreateShortcut($file.FullName)
            [pscustomobject]@{ Path = $file.FullName; Target = $shortcut.TargetPath }
        }
    }
}

function Invoke-Installer([string]$File, [string]$Arguments) {
    $process = Start-Process $File -ArgumentList $Arguments -Wait -PassThru
    if ($process.ExitCode -notin @(0, 3010)) { throw "Installer failed: $($process.ExitCode)" }
}

function Install-Package([string]$Kind, [string]$Package, [string]$Log, [switch]$Update) {
    if ($Kind -eq 'msi') {
        # Same installation path as the updater, without relaunching the app.
        Invoke-Installer msiexec.exe "/i `"$Package`" /passive /norestart /l*v `"$Log`""
    } elseif ($Update) {
        Invoke-Installer $Package '/P /UPDATE'
    } else {
        Invoke-Installer $Package '/S'
    }
}

function Uninstall-Package([string]$Kind, [string]$Package, [string]$Exe, [string]$Log) {
    if ($Kind -eq 'msi') {
        Invoke-Installer msiexec.exe "/x `"$Package`" /qn /norestart /l*v `"$Log`""
    } else {
        Invoke-Installer (Join-Path (Split-Path $Exe) 'uninstall.exe') '/S'
    }
    # NSIS hands off to a temporary uninstaller process.
    for ($attempt = 0; $attempt -lt 100 -and (Test-Path -LiteralPath $Exe); $attempt++) {
        Start-Sleep -Milliseconds 200
    }
    if (Test-Path -LiteralPath $Exe) { throw 'Uninstall left the application executable' }
}

if (@(Get-LingerShortcuts).Count -ne 0) { throw 'Runner already has Linger shortcuts' }
foreach ($kind in @('msi', 'nsis')) {
    $pattern = if ($kind -eq 'msi') { '*.msi' } else { '*-setup.exe' }
    $packages = @(Get-ChildItem (Join-Path $Bundle $kind) -Filter $pattern)
    if ($packages.Count -ne 1) { throw "Expected one $kind package" }
    $upgrade = $packages[0].FullName
    $name = if ($kind -eq 'msi') { 'Linger_0.3.0_x64_en-US.msi' } else { 'Linger_0.3.0_x64-setup.exe' }
    $old = Join-Path $Output $name
    Invoke-WebRequest "https://github.com/itsMattGuenther/Linger/releases/download/v0.3.0/$name" -OutFile $old

    foreach ($scenario in @('original', 'renamed', 'moved', 'deleted', 'fresh')) {
        $prefix = Join-Path $Output "$kind-$scenario"
        $initial = if ($scenario -eq 'fresh') { $upgrade } else { $old }
        Install-Package $kind $initial "$prefix-install.log"
        $before = @(Get-LingerShortcuts)
        if ($before.Count -ne 1) { throw "$kind initial install created $($before.Count) shortcuts" }
        $exe = $before[0].Target
        $initialVersion = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
        $expectedInitial = if ($scenario -eq 'fresh') { $version } else { '0.3.0' }
        if ($initialVersion -ne $expectedInitial) { throw "Initial version is $initialVersion" }

        switch ($scenario) {
            'renamed' { Rename-Item -LiteralPath $before[0].Path -NewName 'Linger custom.lnk' }
            'moved' {
                $destination = $desktopFolders | Where-Object { $_ -ne (Split-Path $before[0].Path) } | Select-Object -First 1
                $destination = Join-Path $destination 'Linger.lnk'
                if (Test-Path -LiteralPath $destination) { throw 'Move destination already exists' }
                Move-Item -LiteralPath $before[0].Path -Destination $destination
            }
            'deleted' { Remove-Item -LiteralPath $before[0].Path }
        }
        $before = @(Get-LingerShortcuts)
        $shortcutHash = if ($scenario -in @('renamed', 'moved')) { (Get-FileHash -LiteralPath $before[0].Path).Hash } else { $null }
        if ($scenario -ne 'fresh') { Install-Package $kind $upgrade "$prefix-update.log" -Update }
        $after = @(Get-LingerShortcuts)
        $after | ConvertTo-Json | Write-Output
        if ($after.Count -ne $before.Count) { throw "$kind $scenario update changed shortcut count from $($before.Count) to $($after.Count)" }
        if ($after.Count -eq 1) {
            if ($after[0].Path -ne $before[0].Path -or $after[0].Target -ne $exe) {
                throw "$kind $scenario update changed shortcut or installation identity"
            }
            if ($shortcutHash -and (Get-FileHash -LiteralPath $after[0].Path).Hash -ne $shortcutHash) {
                throw "$kind $scenario update modified the customized shortcut"
            }
        }
        if ((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion -ne $version) { throw 'Original installation did not update' }

        # MSI's uninstall shortcut contains a changing ProductCode. Check that
        # it still targets the newly installed product even when desktop creation
        # is skipped; globally disabling CreateShortcuts would break this link.
        if ($kind -eq 'msi') {
            $uninstallLink = Join-Path (Split-Path $exe) 'Uninstall Linger.lnk'
            if (!(Test-Path -LiteralPath $uninstallLink)) { throw 'MSI uninstall shortcut missing' }
            $arguments = $shell.CreateShortcut($uninstallLink).Arguments
            if ($arguments -notmatch '^/x (\{[0-9A-Fa-f-]+\})$') { throw 'Invalid MSI uninstall shortcut' }
            $productCode = $Matches[1]
            $installer = New-Object -ComObject WindowsInstaller.Installer
            if ($installer.ProductState($productCode) -ne 5) { throw 'MSI uninstall shortcut targets an uninstalled version' }
        }
        Uninstall-Package $kind $upgrade $exe "$prefix-uninstall.log"
        $remaining = @(Get-LingerShortcuts)
        if ($scenario -in @('renamed', 'moved')) {
            # These are test-created custom shortcuts, which installers do not own.
            if ($remaining.Count -ne 1 -or $remaining[0].Path -ne $before[0].Path) { throw 'Unexpected uninstall shortcut cleanup' }
            Remove-Item -LiteralPath $before[0].Path
        } elseif ($remaining.Count -ne 0) {
            throw "$kind $scenario uninstall left a desktop shortcut"
        }
        Write-Output "PASS $kind ${scenario}: desktop choice, executable version and uninstall"
    }
}
