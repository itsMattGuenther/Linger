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

# Every install, update and uninstall here takes seconds. One that hasn't
# finished in five minutes is stuck: once an NSIS update sat for 29 minutes
# until the job was cancelled, saying nothing about where (#414).
$installerLimitSeconds = 300
$stuckCount = 0

# The installer's own processes: everything this script started (the
# installers run in a thread job, so in this process), and the copy of
# itself NSIS's uninstaller runs from the temp folder after its parent exits.
function Get-InstallerProcesses {
    $all = @(Get-CimInstance Win32_Process)
    $found = @{}
    $queue = [Collections.Generic.Queue[int]]::new()
    $queue.Enqueue($PID)
    foreach ($process in $all) {
        if ($process.ExecutablePath -match '\\~nsu[^\\]*\.tmp\\') { $queue.Enqueue([int]$process.ProcessId); $found[[int]$process.ProcessId] = $process }
    }
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        foreach ($process in $all) {
            $id = [int]$process.ProcessId
            if ($process.ParentProcessId -eq $parent -and $id -ne $PID -and -not $found.ContainsKey($id)) {
                $found[$id] = $process
                $queue.Enqueue($id)
            }
        }
    }
    @($found.Values | Sort-Object CreationDate)
}

# Only when an installer is stuck: what it is waiting on, saved next to the
# installer logs and uploaded with them (#568). The process tree, each
# process's threads, the installer's windows with their controls' text (a
# dialog's message and buttons), and a picture of the runner's screen. It
# looks only at the installer's own processes, on a disposable runner.
function Save-StuckInstallerEvidence([string]$Name) {
    $script:stuckCount++
    $base = Join-Path $Output "stuck-$script:stuckCount"
    $processes = Get-InstallerProcesses
    $report = [Collections.Generic.List[string]]::new()
    $report.Add("Stuck: $Name")
    $report.Add('Processes:')
    foreach ($process in $processes) {
        $started = if ($process.CreationDate) { $process.CreationDate.ToString('HH:mm:ss.fff') } else { '?' }
        $report.Add("  $($process.ProcessId) (parent $($process.ParentProcessId)) $($process.Name) started ${started}: $($process.CommandLine)")
        $threads = (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue).Threads
        foreach ($thread in $threads) {
            $wait = if ($thread.ThreadState -eq 'Wait') { " $($thread.WaitReason)" } else { '' }
            $report.Add("    thread $($thread.Id) $($thread.ThreadState)$wait")
        }
    }
    try {
        if (-not ('StuckInstallerWindows' -as [type])) {
            Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class StuckInstallerWindows {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out IntPtr result);
  // WM_GETTEXT with a time limit, so a hung window can't hang this too.
  static string Text(IntPtr hwnd) {
    var text = new StringBuilder(2048);
    IntPtr result;
    SendMessageTimeout(hwnd, 0x000D, (IntPtr)text.Capacity, text, 0x0002, 2000, out result);
    return text.ToString().Replace("\r", " ").Replace("\n", " ");
  }
  static string Describe(string indent, IntPtr hwnd, uint pid) {
    var name = new StringBuilder(256);
    GetClassName(hwnd, name, name.Capacity);
    return String.Format("{0}{1} pid {2} [{3}]{4} \"{5}\"", indent, hwnd, pid, name, IsWindowVisible(hwnd) ? "" : " hidden", Text(hwnd));
  }
  public static List<string> Of(int[] pids) {
    var wanted = new HashSet<uint>();
    foreach (var pid in pids) wanted.Add((uint)pid);
    var lines = new List<string>();
    EnumWindows((hwnd, _) => {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (!wanted.Contains(pid)) return true;
      lines.Add(Describe("  ", hwnd, pid));
      EnumChildWindows(hwnd, (child, __) => { lines.Add(Describe("    ", child, pid)); return true; }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return lines;
  }
}
'@
        }
        $report.Add('Windows:')
        foreach ($line in [StuckInstallerWindows]::Of([int[]]@($processes | ForEach-Object { [int]$_.ProcessId }))) { $report.Add($line) }
    } catch {
        $report.Add("Windows: couldn't list them: $_")
    }
    try {
        Add-Type -AssemblyName System.Drawing, System.Windows.Forms
        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $bitmap.Save("$base.png", [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bitmap.Dispose()
        $report.Add("Screen: $(Split-Path -Leaf "$base.png")")
    } catch {
        $report.Add("Screen: couldn't take a picture: $_")
    }
    $report | Set-Content "$base.log"
    foreach ($line in $report) { Write-Host $line }
    $processes
}

function Invoke-Installer([string]$File, [string]$Arguments) {
    # Start-Process -Wait waits for everything the installer starts as well,
    # which the checks below need: NSIS's uninstaller hands off to a copy of
    # itself and exits, and the copy removes the files and shortcuts. Waiting
    # on the first process alone checked them too early. So the whole wait
    # runs in a job, and the job gets the limit.
    $job = Start-ThreadJob -ArgumentList $File, $Arguments -ScriptBlock {
        param($File, $Arguments)
        (Start-Process $File -ArgumentList $Arguments -Wait -PassThru).ExitCode
    }
    if (-not (Wait-Job $job -Timeout $installerLimitSeconds)) {
        $name = "$(Split-Path -Leaf $File) $Arguments"
        $stuck = @()
        try { $stuck = @(Save-StuckInstallerEvidence $name) } catch { Write-Host "Couldn't save what it was doing: $_" }
        foreach ($process in $stuck) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
        Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($File)) -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
        Remove-Job $job -Force
        throw "Installer stuck: $name was still running after $installerLimitSeconds seconds, and was stopped. What it was doing is in $(Split-Path -Leaf $Output)/stuck-$stuckCount.log and .png"
    }
    $exitCode = Receive-Job $job -ErrorAction Stop
    Remove-Job $job
    if ($exitCode -notin @(0, 3010)) { throw "Installer failed: $exitCode" }
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
        # Said before it starts, so a stuck installer is seen in its scenario.
        Write-Output "$kind ${scenario}: installing"
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

# Windows opens a program for a moment now and then: Explorer to read its
# icon, the compatibility scanner after an install. An NSIS update that met
# that stopped on "Error opening file for writing" and waited for a click,
# and an uninstall left the program behind (#568). The installer hooks
# (client/src-tauri/windows/installer-hooks.nsh) wait for it instead. Hold
# the program open the way an icon is read, for two seconds, as an update
# and then an uninstall start.
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class BusyProgram {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
  [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
  public static void HoldFor(string path, int milliseconds) {
    // LOAD_LIBRARY_AS_IMAGE_RESOURCE | LOAD_LIBRARY_AS_DATAFILE
    IntPtr module = LoadLibraryEx(path, IntPtr.Zero, 0x22);
    if (module == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    new Thread(() => { Thread.Sleep(milliseconds); FreeLibrary(module); }) { IsBackground = true }.Start();
  }
}
'@
Write-Output 'nsis busy: installing'
$nsisOld = Join-Path $Output 'Linger_0.3.0_x64-setup.exe'
$nsisNew = @(Get-ChildItem (Join-Path $Bundle 'nsis') -Filter '*-setup.exe')[0].FullName
$prefix = Join-Path $Output 'nsis-busy'
Install-Package nsis $nsisOld "$prefix-install.log"
$exe = @(Get-LingerShortcuts)[0].Target
[BusyProgram]::HoldFor($exe, 2000)
Install-Package nsis $nsisNew "$prefix-update.log" -Update
if ((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion -ne $version) { throw 'nsis busy: the update did not replace the program' }
[BusyProgram]::HoldFor($exe, 2000)
Uninstall-Package nsis $nsisNew $exe "$prefix-uninstall.log"
if (Test-Path -LiteralPath (Split-Path $exe)) { throw 'nsis busy: the uninstall left the program folder' }
if (@(Get-LingerShortcuts).Count -ne 0) { throw 'nsis busy: the uninstall left a desktop shortcut' }
Write-Output 'PASS nsis busy: an update and an uninstall wait for a program something has open'
