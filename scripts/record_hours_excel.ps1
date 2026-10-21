# 录制“真实打开导出的工时统计 Excel”素材（s5 段用）。
# 流程：
#   1. 用真实 Excel（新 COM 实例）打开 downloads 下真实导出的工时统计 xlsx（只读）
#   2. ffmpeg gdigrab 仅录制 Excel 客户区（DPI aware）
#   3. COM 真实操作：标题 → 表头 → 首位员工行 → 有效工时列
#   4. 输出 scripts/output/recordings/hours_excel.mp4（22 秒）
# 注意：必须在本机交互桌面会话中运行。

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$proj = "C:\Users\He-TW\Downloads\Project\claude code\shiftlite"
$ffmpeg = "C:\Users\He-TW\AppData\Local\Python\pythoncore-3.14-64\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
$outDir = "$proj\scripts\output\recordings"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$out = "$outDir\hours_excel.mp4"

# 0) 找到真实导出的工时统计文件（downloads 目录，最新一个）
$dl = Get-ChildItem "$proj\scripts\output\downloads" -Filter "*工时统计*.xlsx" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $dl) { throw "未找到导出的工时统计 xlsx" }
$xlsx = $dl.FullName
Write-Host "打开：$xlsx"

# 0b) 清掉残留 Excel 进程，避免窗口叠加干扰
Get-Process EXCEL -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# 1) 新建真实 Excel 实例并打开文件（显式 Workbooks.Item，避免名称匹配不稳）
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $true
try { $excel.ScreenUpdating = $true } catch {}
[void]$excel.Workbooks.Open($xlsx, $null, $true)   # ReadOnly
$wb = $excel.Workbooks.Item($excel.Workbooks.Count)
Start-Sleep -Milliseconds 400

# 2) 计算客户区（物理像素，DPI aware）
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct EXRECT { public int L, T, R, B; }
public struct EXPOINT { public int X, Y; }
public class EXWIN {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out EXRECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref EXPOINT p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hgt, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
[EXWIN]::SetProcessDPIAware() | Out-Null
$proc = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'EXCEL' } | Select-Object -First 1
if (-not $proc) { throw "未找到 Excel 窗口" }
$h = $proc.MainWindowHandle
# 固定窗口尺寸（捕获期间不得改动）：内容居中，客户区约 1340x780
[EXWIN]::SetWindowPos($h, [IntPtr](0), 290, 90, 1340, 900, 0x0004) | Out-Null  # SWP_NOZORDER
Start-Sleep -Milliseconds 600
$excel.ActiveWindow.Zoom = 130
Start-Sleep -Milliseconds 400
$rc = New-Object EXRECT
[EXWIN]::GetClientRect($h, [ref]$rc) | Out-Null
$pt = New-Object EXPOINT; $pt.X = 0; $pt.Y = 0
[EXWIN]::ClientToScreen($h, [ref]$pt) | Out-Null
$w = $rc.R - $rc.L; $hgt = $rc.B - $rc.T
$w = $w - ($w % 2); $hgt = $hgt - ($hgt % 2)
Write-Host "capture rect: x=$($pt.X) y=$($pt.Y) w=$w h=$hgt"

# 3) 启动捕获（PrintWindow 客户区提取，不受前台弹窗遮挡影响；23 秒）
$cap = Start-Process -FilePath "python" -ArgumentList @(
    "`"$proj\scripts\capture_hx.py`"", "`"$out`"", "23"
) -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1

# 4) 真实操作序列（主持人查看工时统计）
try {
    $ws = $wb.Worksheets.Item("工时统计")
    [void]$excel.Goto($ws.Range("A1"), $true);   Start-Sleep -Milliseconds 1900
    [void]$ws.Range("A3").Select();              Start-Sleep -Milliseconds 1200   # 表头：员工/岗位
    [void]$ws.Range("F3").Select();              Start-Sleep -Milliseconds 1100   # 有效工时列头
    [void]$ws.Range("A4").Select();              Start-Sleep -Milliseconds 1300   # 首位员工
    [void]$ws.Range("F4").Select();              Start-Sleep -Milliseconds 1200   # 首行工时
    [void]$ws.Range("F4:F13").Select();          Start-Sleep -Milliseconds 2400   # 整列有效工时
    [void]$ws.Range("A13").Select();             Start-Sleep -Milliseconds 1500   # 合计行附近
    [void]$ws.Range("A1").Select();              Start-Sleep -Seconds 3           # 回顶收尾
}
finally {
    try { $cap.WaitForExit(60000) | Out-Null } catch {}
    $excel.DisplayAlerts = $false
    $excel.Quit()
}
if (Test-Path $out) {
    "已录制：$out ($([math]::Round((Get-Item $out).Length/1KB)) KB)"
} else {
    throw "录屏输出不存在"
}