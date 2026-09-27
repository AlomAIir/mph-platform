param([int]$Port = 5173, [string]$Root = (Split-Path -Parent $PSScriptRoot))
# Minimal static file server (no Node/Python on this machine).
$mime = @{
  '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.mjs'='text/javascript; charset=utf-8'
  '.css'='text/css; charset=utf-8'; '.json'='application/json'; '.svg'='image/svg+xml'; '.png'='image/png'
  '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.webp'='image/webp'; '.pdf'='application/pdf'; '.ico'='image/x-icon'
  '.woff2'='font/woff2'; '.txt'='text/plain; charset=utf-8'
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $Root at http://localhost:$Port/"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($rel -eq '') { $rel = 'index.html' }
    $path = Join-Path $Root $rel
    if (Test-Path $path -PathType Container) { $path = Join-Path $path 'index.html' }
    $full = [IO.Path]::GetFullPath($path)
    if ($ctx.Request.HttpMethod -eq 'POST' -and $rel -like 'tools/out/*') {
      # dev-only sink so browser-side extractors can save results
      New-Item -ItemType Directory -Force (Split-Path $full) | Out-Null
      $fs = [IO.File]::Create($full); $ctx.Request.InputStream.CopyTo($fs); $fs.Close()
      $ctx.Response.StatusCode = 204
    } elseif ($full.StartsWith([IO.Path]::GetFullPath($Root)) -and (Test-Path $full -PathType Leaf)) {
      $bytes = [IO.File]::ReadAllBytes($full)
      $ext = [IO.Path]::GetExtension($full).ToLower()
      $ctx.Response.ContentType = if ($mime[$ext]) { $mime[$ext] } else { 'application/octet-stream' }
      $ctx.Response.Headers.Add('Cache-Control', 'no-store')
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
  } catch { $ctx.Response.StatusCode = 500 } finally { $ctx.Response.Close() }
}
