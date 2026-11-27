param([Parameter(Mandatory=$true)][string]$Bundle, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
# Run only on an ephemeral Windows build runner. Never inspect other windows.
New-Item -ItemType Directory -Force $Output | Out-Null
$Output = (Resolve-Path $Output).Path
$installer = (Get-ChildItem "$Bundle/nsis/*-setup.exe" | Select-Object -First 1).FullName
$install = Join-Path $Output 'installed'
$setup = Start-Process $installer -ArgumentList @('/S', "/D=$install") -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw "Installer failed: $($setup.ExitCode)" }
$exe = Join-Path $install 'linger-client.exe'
node scripts/package-icons.mjs --pe $installer --pe $exe --pe (Join-Path $install 'uninstall.exe')
if ($LASTEXITCODE -ne 0) { throw 'Packaged Windows icon mismatch' }

# Each bundle stamps its format into the executable, so MSI/NSIS bytes differ
# legitimately. Check the embedded artwork independently in both packages.
$msi = (Get-ChildItem "$Bundle/msi/*.msi" | Select-Object -First 1).FullName
$msiRoot = Join-Path $Output 'msi'
$extract = Start-Process msiexec.exe -ArgumentList @('/a', "`"$msi`"", '/qn', "TARGETDIR=`"$msiRoot`"") -Wait -PassThru
if ($extract.ExitCode -ne 0) { throw "MSI extraction failed: $($extract.ExitCode)" }
# WiX names its installed executable after productName (Linger.exe), while
# NSIS retains the Cargo binary name (linger-client.exe).
$msiExe = Get-ChildItem $msiRoot -Recurse -Filter 'linger*.exe' | Select-Object -First 1
if (!$msiExe) { throw 'MSI application executable missing' }
node scripts/package-icons.mjs --pe $msiExe.FullName
if ($LASTEXITCODE -ne 0) { throw 'MSI application icon mismatch' }

$shell = New-Object -ComObject WScript.Shell
$shortcuts = @()
foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
    foreach ($file in Get-ChildItem $folder -Filter '*linger*.lnk' -Recurse) {
        $shortcut = $shell.CreateShortcut($file.FullName)
        if ($shortcut.TargetPath -eq $exe) {
            # NSIS leaves the icon path empty to use the target's first icon.
            # WScript serializes that default as ",0", not an empty string.
            $location = $shortcut.IconLocation.Trim()
            Write-Output "Linger shortcut icon location: '$location'"
            if ($location -and $location -notmatch '^,\s*0$' -and $location -ne "$exe,0" -and $location -ne "$exe, 0") {
                throw 'Shortcut uses another icon'
            }
            $shortcuts += $file.Name
        }
    }
}
if ($shortcuts.Count -eq 0) { throw 'No installed Linger shortcut points to the packaged executable' }
Write-Output 'PASS installed shortcut identity and MSI executable'

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LingerIconProbe {
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", EntryPoint="GetClassLongPtrW")] public static extern IntPtr GetClassLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  public delegate bool Each(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumThreadWindows(uint thread, Each each, IntPtr l);
  // Linger's own windows only, by its own threads, so no other program's
  // window is ever looked at: each one's class, whether it shows, whether
  // it has an owner, and whether it has a small icon.
  public static string Describe(int[] threads, IntPtr found) {
    var lines = new System.Text.StringBuilder();
    foreach (var thread in threads) {
      EnumThreadWindows((uint)thread, (h, l) => {
        var name = new System.Text.StringBuilder(256);
        GetClassName(h, name, 256);
        var icon = SendMessage(h, 0x7F, IntPtr.Zero, IntPtr.Zero) != IntPtr.Zero || GetClassLongPtr(h, -34) != IntPtr.Zero;
        lines.AppendLine(string.Format("  {0} class={1} visible={2} owned={3} icon={4}{5}", h, name, IsWindowVisible(h), GetWindow(h, 4) != IntPtr.Zero, icon, h == found ? "  <- the one found" : ""));
        return true;
      }, IntPtr.Zero);
    }
    return lines.ToString();
  }
  // The shown top-level window of Linger's with this class (the list is
  // Tauri's), or none: by its own threads only, as above.
  public static IntPtr Shown(int[] threads, string wanted) {
    var found = IntPtr.Zero;
    foreach (var thread in threads) {
      EnumThreadWindows((uint)thread, (h, l) => {
        var name = new System.Text.StringBuilder(256);
        GetClassName(h, name, 256);
        if (found == IntPtr.Zero && name.ToString() == wanted && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) { found = h; }
        return true;
      }, IntPtr.Zero);
    }
    return found;
  }
}
'@
$app = Start-Process $exe -PassThru
$started = Get-Date
try {
    # The list, by its class: Windows' own idea of the main window can be one
    # of Linger's message windows (single instance, tao's events), which
    # report themselves shown and have no icon. A runner's first start is
    # slow, so it gets thirty seconds.
    $list = [IntPtr]::Zero
    for ($i = 0; $i -lt 150; $i++) {
        Start-Sleep -Milliseconds 200
        $app.Refresh()
        if ($app.HasExited) { throw 'Installed app exited before opening a window' }
        $list = [LingerIconProbe]::Shown(@($app.Threads | ForEach-Object { $_.Id }), 'Tauri Window')
        if ($list -ne [IntPtr]::Zero) { break }
    }
    if ($list -eq [IntPtr]::Zero) {
        Write-Output "Linger's top-level windows:"
        Write-Output ([LingerIconProbe]::Describe(@($app.Threads | ForEach-Object { $_.Id }), [IntPtr]::Zero))
        throw 'Installed app did not show its list'
    }
    Write-Output ("The list shown {0:N1} s after start" -f ((Get-Date) - $started).TotalSeconds)
    # Tao's window icon uses ICON_SMALL; ICON_BIG is a separate taskbar override
    # and may be unset. Its absence does not mean the window has no icon.
    # Tao sets the icon just after the window appears, so one look the moment
    # it does can find none (#348): keep looking for up to ten seconds.
    $icon = [IntPtr]::Zero
    for ($i = 0; $i -lt 50; $i++) {
        $icon = [LingerIconProbe]::SendMessage($list, 0x7F, [IntPtr]::Zero, [IntPtr]::Zero)
        if ($icon -eq [IntPtr]::Zero) { $icon = [LingerIconProbe]::GetClassLongPtr($list, -34) }
        if ($icon -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 200
    }
    if ($icon -eq [IntPtr]::Zero) {
        Write-Output "Linger's top-level windows:"
        Write-Output ([LingerIconProbe]::Describe(@($app.Threads | ForEach-Object { $_.Id }), $list))
        throw 'Running app has no caption icon'
    }
    $taskbarIcon = [LingerIconProbe]::SendMessage($list, 0x7F, [IntPtr]1, [IntPtr]::Zero)
    Write-Output "Separate taskbar icon override present: $($taskbarIcon -ne [IntPtr]::Zero)"
    $bitmap = [System.Drawing.Icon]::FromHandle($icon).ToBitmap()
    $bitmap.Save((Join-Path $Output 'running-window-icon.png'))
    $bitmap.Dispose()
    Write-Output 'PASS running window supplies an icon; inspect running-window-icon.png for appearance'
} finally {
    if (!$app.HasExited) { Stop-Process -Id $app.Id; $app.WaitForExit(10000) | Out-Null }
}

# Both installer formats must run Web Audio in their actual WebView2 engine.
# The Node harness launches each process directly with a private debug endpoint.
foreach ($package in @(@{Name='nsis'; Exe=$exe}, @{Name='msi'; Exe=$msiExe.FullName})) {
    $probeDir = Join-Path $Output "audio-$($package.Name)"
    New-Item -ItemType Directory -Force $probeDir | Out-Null
    node client/scripts/windows-audio-check.mjs $package.Exe $probeDir 2>&1 | Tee-Object -FilePath (Join-Path $probeDir 'result.log')
    if ($LASTEXITCODE -ne 0) { throw "Packaged $($package.Name) WebView2 audio failed" }
}

# The Buddy list client starts in the installed app's WebView2 (T-1812), and
# a screenshot of it is kept with the evidence.
$nextDir = Join-Path $Output 'next'
node client/scripts/windows-next-check.mjs $exe $nextDir 2>&1 | Tee-Object -FilePath (Join-Path $Output 'next-result.log')
if ($LASTEXITCODE -ne 0) { throw "The Buddy list didn't start in packaged WebView2" }
