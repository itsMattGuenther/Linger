# The Win32 half of windows-hidden-check.mjs (#594): does to Linger's own list
# window what a person does to it (minimize, restore, close it to the tray),
# and looks at it: whether WebView2's own windows inside it are switched on,
# and whether it's drawn.
#
# Reads one JSON command per line on stdin and answers each with one line,
# "LINGER-REPLY {json}", so Add-Type is compiled once rather than per step.
# It only ever touches the window handle it's given and the windows inside it:
# it never lists, names or looks at any other window. Run only on a disposable
# runner.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class LingerWindowProbe {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public delegate bool ChildProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, ChildProc f, IntPtr l);
  // How many windows inside this one (WebView2's own, here) are shown, and
  // how many there are. Only counted: nothing about them is read.
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
  // Of the windows inside this one (WebView2's own, here): how many are shown
  // on screen, how many are set to show themselves (WS_VISIBLE, whatever
  // their parent does), and how many there are. Only counted: nothing about
  // them is read.
  public static int[] ShownChildren(IntPtr parent) {
    int shown = 0, styled = 0, all = 0;
    EnumChildWindows(parent, (h, l) => {
      all++;
      if (IsWindowVisible(h)) shown++;
      if (((long)GetWindowLongPtr(h, -16) & 0x10000000L) != 0) styled++;
      return true;
    }, IntPtr.Zero);
    return new int[] { shown, styled, all };
  }
  // The share of pixels (32 bpp rows) that are the most common colour: about
  // 1 for a blank window, well under it for one with words and marks drawn.
  public static double Dominant(byte[] px, int stride, int width, int height) {
    var counts = new Dictionary<int, int>();
    int total = 0, best = 0;
    for (int y = 0; y < height; y++) {
      for (int x = 0; x < width; x++) {
        int i = y * stride + x * 4;
        int c = px[i] | (px[i + 1] << 8) | (px[i + 2] << 16);
        int n;
        counts.TryGetValue(c, out n);
        n++;
        counts[c] = n;
        if (n > best) best = n;
        total++;
      }
    }
    return total == 0 ? 1.0 : (double)best / total;
  }
}
'@

function Handle($value) { [IntPtr][int64]$value }

# Draws the window into a bitmap and measures it. "print" asks the window to
# draw itself (PrintWindow with PW_RENDERFULLCONTENT, which includes
# WebView2's composited content); "screen" copies what's on the screen there.
function Capture($hwnd, $path, $how) {
  $r = New-Object LingerWindowProbe+RECT
  [void][LingerWindowProbe]::GetWindowRect($hwnd, [ref]$r)
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { return @{ ok = $false; reason = "the window has no size ($w x $h)" } }
  $format = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  $bmp = New-Object System.Drawing.Bitmap $w, $h, $format
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $drawn = $true
    if ($how -eq 'screen') {
      $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h))
    } else {
      $hdc = $g.GetHdc()
      $drawn = [LingerWindowProbe]::PrintWindow($hwnd, $hdc, 2)
      $g.ReleaseHdc($hdc)
    }
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $format)
    $bytes = New-Object byte[] ($data.Stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    $stride = $data.Stride
    $bmp.UnlockBits($data)
    return @{ ok = [bool]$drawn; width = $w; height = $h; dominant = [LingerWindowProbe]::Dominant($bytes, $stride, $w, $h) }
  } finally {
    $bmp.Dispose()
  }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Trim() -eq '') { continue }
  try {
    $cmd = $line | ConvertFrom-Json
    $reply = switch ($cmd.op) {
      # The app's top-level window, as the icon check finds it: at start the
      # list is the only window Linger shows.
      'main' {
        $p = Get-Process -Id $cmd.pid -ErrorAction SilentlyContinue
        if (!$p) { @{ hwnd = 0; exited = $true } } else { $p.Refresh(); @{ hwnd = [int64]$p.MainWindowHandle } }
      }
      'state' {
        $hwnd = Handle $cmd.hwnd
        $inside = [LingerWindowProbe]::ShownChildren($hwnd)
        @{ visible = [LingerWindowProbe]::IsWindowVisible($hwnd); minimized = [LingerWindowProbe]::IsIconic($hwnd); innerShown = $inside[0]; innerSetToShow = $inside[1]; inner = $inside[2] }
      }
      # SW_MINIMIZE, as the taskbar or the title bar's button does.
      'minimize' { @{ done = [LingerWindowProbe]::ShowWindow((Handle $cmd.hwnd), 6) } }
      # SW_RESTORE, as clicking it on the taskbar does.
      'restore' {
        $hwnd = Handle $cmd.hwnd
        $done = [LingerWindowProbe]::ShowWindow($hwnd, 9)
        [void][LingerWindowProbe]::SetForegroundWindow($hwnd)
        @{ done = $done }
      }
      # WM_CLOSE, as the desktop's close does. Linger closes the list to the tray.
      'close' { @{ done = [LingerWindowProbe]::PostMessage((Handle $cmd.hwnd), 0x10, [IntPtr]::Zero, [IntPtr]::Zero) } }
      'capture' { Capture (Handle $cmd.hwnd) $cmd.path $cmd.how }
      default { throw "unknown op $($cmd.op)" }
    }
    [Console]::Out.WriteLine('LINGER-REPLY ' + ($reply | ConvertTo-Json -Compress -Depth 4))
  } catch {
    [Console]::Out.WriteLine('LINGER-REPLY ' + (@{ error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress))
  }
  [Console]::Out.Flush()
}
