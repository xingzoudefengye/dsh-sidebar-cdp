<#
  维护脚本：把（或去掉）桌面版快捷方式上的 --remote-debugging-port。

  纯插件路线不需要这个开关——它只服务可选的 CDP 旁路。留着它是因为曾经加过：
  用 -Remove 就能原样退回去，不必手工编辑快捷方式的属性。

    powershell -NoProfile -ExecutionPolicy Bypass -File patch-shortcuts.ps1 -Remove
    powershell -NoProfile -ExecutionPolicy Bypass -File patch-shortcuts.ps1 -Port 9222

  桌面、开始菜单（含子目录）、任务栏固定项都会扫；认不出 exe 时按默认安装位置兜底。
#>
param(
  [int]$Port = 9222,
  [switch]$Remove,
  [string]$OutFile = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$flag = "--remote-debugging-port=$Port"
$pattern = '--remote-debugging-port(=\d+)?'

$shell = New-Object -ComObject WScript.Shell

if ($DryRun) { Write-Host "[dry-run] 只报告，不改快捷方式" }

$dirs = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
)

$files = foreach ($dir in $dirs) {
  if ($dir -and (Test-Path -LiteralPath $dir)) {
    Get-ChildItem -LiteralPath $dir -Filter *.lnk -Recurse -File -ErrorAction SilentlyContinue
  }
}

$found = @()
foreach ($file in $files) {
  try {
    $shortcut = $shell.CreateShortcut($file.FullName)
    $found += [pscustomobject]@{
      Path   = $file.FullName
      Target = $shortcut.TargetPath
      Args   = $shortcut.Arguments
      Handle = $shortcut
    }
  } catch {
    # 个别损坏的 lnk 读不出来，跳过即可
  }
}

# 先认出桌面版 exe：优先按 target 名匹配，认不出来再按默认安装位置兜底
$exe = $null
$candidate = $found | Where-Object { $_.Target -and ($_.Target -like '*DeepSeek Harness.exe') } | Select-Object -First 1
if ($candidate) {
  $exe = $candidate.Target
} else {
  $fallback = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
  if (Test-Path -LiteralPath $fallback) { $exe = $fallback }
}

$items = @()
if ($exe) {
  foreach ($item in $found) {
    if (-not $item.Target) { continue }
    if ($item.Target -ine $exe) { continue }

    $hasFlag = $item.Args -match $pattern

    if ($Remove) {
      if (-not $hasFlag) {
        $items += [pscustomobject]@{ path = $item.Path; action = 'clean'; arguments = $item.Args }
        continue
      }
      $newArgs = ($item.Args -replace $pattern, '').Trim() -replace '\s{2,}', ' '
      $action = 'removed'
      if (-not $DryRun) {
        $item.Handle.Arguments = $newArgs
        $item.Handle.Save()
      } else {
        $action = 'would-remove'
      }
      $items += [pscustomobject]@{ path = $item.Path; action = $action; arguments = $newArgs }
      continue
    }

    if ($hasFlag) {
      $items += [pscustomobject]@{ path = $item.Path; action = 'kept'; arguments = $item.Args }
      continue
    }

    $newArgs = (@($item.Args, $flag) | Where-Object { $_ }) -join ' '
    $action = 'patched'
    if (-not $DryRun) {
      $item.Handle.Arguments = $newArgs
      $item.Handle.Save()
    } else {
      $action = 'would-patch'
    }
    $items += [pscustomobject]@{ path = $item.Path; action = $action; arguments = $newArgs }
  }
}

$result = [pscustomobject]@{
  exe     = $exe
  port    = $Port
  mode    = $(if ($Remove) { 'remove' } else { 'add' })
  scanned = $found.Count
  items   = $items
}

if ($OutFile) {
  $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $OutFile -Encoding UTF8
} else {
  $result | ConvertTo-Json -Depth 4
}
