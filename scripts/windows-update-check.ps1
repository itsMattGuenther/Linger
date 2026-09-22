param([ValidateSet('nsis', 'msi')][string]$Installer = 'nsis')
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Run only on a disposable Windows Actions runner' }
$output = Join-Path $env:RUNNER_TEMP 'linger-update-check'
New-Item -ItemType Directory -Force $output | Out-Null
$shell = New-Object -ComObject WScript.Shell
function Get-LingerShortcuts {
    foreach ($folder in @('Desktop', 'CommonDesktopDirectory')) {
        $directory = [Environment]::GetFolderPath($folder)
        foreach ($file in Get-ChildItem $directory -Filter '*linger*.lnk') {
            $shortcut = $shell.CreateShortcut($file.FullName)
            [pscustomobject]@{ Path = $file.FullName; Target = $shortcut.TargetPath }
        }
    }
}
if (@(Get-LingerShortcuts).Count -ne 0) { throw 'Runner already has Linger shortcuts' }
if ($Installer -eq 'nsis') {
    $package = Join-Path $output 'Linger_0.3.0_x64-setup.exe'
    Invoke-WebRequest 'https://github.com/itsMattGuenther/Linger/releases/download/v0.3.0/Linger_0.3.0_x64-setup.exe' -OutFile $package
    $setup = Start-Process $package -ArgumentList '/S' -Wait -PassThru
} else {
    $package = Join-Path $output 'Linger_0.3.0_x64_en-US.msi'
    Invoke-WebRequest 'https://github.com/itsMattGuenther/Linger/releases/download/v0.3.0/Linger_0.3.0_x64_en-US.msi' -OutFile $package
    $setup = Start-Process msiexec.exe -ArgumentList "/i `"$package`" /qn /norestart" -Wait -PassThru
}
if ($setup.ExitCode -notin @(0, 3010)) { throw "Initial installation failed: $($setup.ExitCode)" }
$before = @(Get-LingerShortcuts)
$before | ConvertTo-Json | Write-Output
if ($before.Count -ne 1) { throw "Expected one initial desktop shortcut, got $($before.Count)" }
$exe = $before[0].Target
node client/scripts/windows-update-check.mjs $exe $output
if ($LASTEXITCODE -ne 0) { throw 'In-app update failed' }
$after = @(Get-LingerShortcuts)
$after | ConvertTo-Json | Write-Output
if ($after.Count -ne 1) { throw "Update left $($after.Count) desktop shortcuts" }
if ($after[0].Path -ne $before[0].Path -or $after[0].Target -ne $before[0].Target) {
    throw 'Update changed shortcut or installation identity'
}
Write-Output 'PASS in-app update preserved the desktop shortcut and its target'
