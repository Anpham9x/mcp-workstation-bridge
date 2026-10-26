param(
  [Parameter(Mandatory = $true)]
  [string]$RequestPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Convert-HexColor([string]$Hex, [string]$Fallback = '#000000') {
  $value = if ($Hex) { $Hex } else { $Fallback }
  if ($value -notmatch '^#[0-9A-Fa-f]{6}$') { throw "Invalid color value." }
  $r = [Convert]::ToInt32($value.Substring(1, 2), 16)
  $g = [Convert]::ToInt32($value.Substring(3, 2), 16)
  $b = [Convert]::ToInt32($value.Substring(5, 2), 16)
  return $r + ($g * 256) + ($b * 65536)
}

function Convert-Point($Inches) { return [single]([double]$Inches * 72.0) }
function Get-Value($Object, [string]$Name, $Fallback) {
  if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name] -and $null -ne $Object.$Name) { return $Object.$Name }
  return $Fallback
}
function Convert-BoolToMso($Value) { if ($Value) { return -1 } return 0 }
function Convert-Alignment([string]$Value) {
  switch ($Value) { 'center' { 2 } 'right' { 3 } 'justify' { 4 } default { 1 } }
}
function Convert-VerticalAlignment([string]$Value) {
  switch ($Value) { 'middle' { 3 } 'bottom' { 4 } default { 1 } }
}
function Convert-Dash([string]$Value) {
  switch ($Value) { 'dash' { 4 } 'dot' { 3 } default { 1 } }
}
function Convert-Arrow([string]$Value) {
  switch ($Value) { 'triangle' { 3 } 'stealth' { 4 } 'diamond' { 5 } 'oval' { 6 } default { 1 } }
}
function Convert-AutoShape([string]$Value) {
  switch ($Value) {
    'roundedRectangle' { 5 }
    'ellipse' { 9 }
    'triangle' { 7 }
    'chevron' { 52 }
    'pentagon' { 51 }
    'hexagon' { 10 }
    default { 1 }
  }
}

function Set-ShapeName($Shape, $Element) {
  if ($Element.name) { $Shape.Name = [string]$Element.name }
}

function Add-TextElement($Slide, $Element, $Theme, [System.Collections.ArrayList]$Warnings, [int]$SlideNumber) {
  $shape = $Slide.Shapes.AddTextbox(1, (Convert-Point $Element.x), (Convert-Point $Element.y), (Convert-Point $Element.width), (Convert-Point $Element.height))
  Set-ShapeName $shape $Element
  $frame = $shape.TextFrame2
  $frame.AutoSize = if (Get-Value $Element 'autoFit' $false) { 2 } else { 0 }
  $margin = Convert-Point (Get-Value $Element 'margin' 0.08)
  $frame.MarginLeft = $margin; $frame.MarginRight = $margin; $frame.MarginTop = $margin; $frame.MarginBottom = $margin
  $frame.VerticalAnchor = Convert-VerticalAlignment (Get-Value $Element 'verticalAlign' 'top')
  $range = $frame.TextRange
  $range.Text = [string]$Element.text
  $range.Font.Name = [string](Get-Value $Element 'fontFamily' (Get-Value $Theme 'fontFamily' 'Aptos'))
  $range.Font.Size = [single](Get-Value $Element 'fontSize' 18)
  $range.Font.Bold = Convert-BoolToMso (Get-Value $Element 'bold' $false)
  $range.Font.Italic = Convert-BoolToMso (Get-Value $Element 'italic' $false)
  $range.Font.Fill.ForeColor.RGB = Convert-HexColor (Get-Value $Element 'color' (Get-Value $Theme 'textColor' '#111111'))
  $range.Font.Fill.Transparency = [single](Get-Value $Element 'transparency' 0)
  $range.ParagraphFormat.Alignment = Convert-Alignment (Get-Value $Element 'align' 'left')
  $shape.Rotation = [single](Get-Value $Element 'rotation' 0)
  if (-not (Get-Value $Element 'autoFit' $false) -and $range.BoundHeight -gt ($shape.Height - $frame.MarginTop - $frame.MarginBottom + 1)) {
    [void]$Warnings.Add("Slide $SlideNumber text '$($shape.Name)' may overflow vertically.")
  }
}

function Add-ShapeElement($Slide, $Element) {
  $left = Convert-Point $Element.x; $top = Convert-Point $Element.y; $width = Convert-Point $Element.width; $height = Convert-Point $Element.height
  if ($Element.shape -eq 'line') {
    $shape = $Slide.Shapes.AddLine($left, $top, ($left + $width), ($top + $height))
  } else {
    $shape = $Slide.Shapes.AddShape((Convert-AutoShape $Element.shape), $left, $top, $width, $height)
    if ($Element.fillColor) {
      $shape.Fill.Solid(); $shape.Fill.ForeColor.RGB = Convert-HexColor $Element.fillColor; $shape.Fill.Transparency = [single](Get-Value $Element 'fillTransparency' 0)
    } else { $shape.Fill.Visible = 0 }
  }
  Set-ShapeName $shape $Element
  if ($Element.lineColor -or $Element.shape -eq 'line') {
    $shape.Line.Visible = -1
    $shape.Line.ForeColor.RGB = Convert-HexColor (Get-Value $Element 'lineColor' '#000000')
    $shape.Line.Weight = [single](Get-Value $Element 'lineWidth' 1)
    $shape.Line.DashStyle = Convert-Dash (Get-Value $Element 'dash' 'solid')
    $shape.Line.BeginArrowheadStyle = Convert-Arrow (Get-Value $Element 'startArrow' 'none')
    $shape.Line.EndArrowheadStyle = Convert-Arrow (Get-Value $Element 'endArrow' 'none')
  } else { $shape.Line.Visible = 0 }
  $shape.Rotation = [single](Get-Value $Element 'rotation' 0)
}

function Add-ImageElement($Slide, $Element) {
  $targetLeft = Convert-Point $Element.x; $targetTop = Convert-Point $Element.y; $targetWidth = Convert-Point $Element.width; $targetHeight = Convert-Point $Element.height
  if ((Get-Value $Element 'fit' 'stretch') -eq 'contain') {
    $shape = $Slide.Shapes.AddPicture([string]$Element.path, 0, -1, $targetLeft, $targetTop, -1, -1)
    $scale = [Math]::Min($targetWidth / $shape.Width, $targetHeight / $shape.Height)
    $shape.Width = [single]($shape.Width * $scale); $shape.Height = [single]($shape.Height * $scale)
    $shape.Left = [single]($targetLeft + (($targetWidth - $shape.Width) / 2)); $shape.Top = [single]($targetTop + (($targetHeight - $shape.Height) / 2))
  } else {
    $shape = $Slide.Shapes.AddPicture([string]$Element.path, 0, -1, $targetLeft, $targetTop, $targetWidth, $targetHeight)
  }
  Set-ShapeName $shape $Element
  $shape.Rotation = [single](Get-Value $Element 'rotation' 0)
}

function Add-TableElement($Slide, $Element, $Theme) {
  $rowCount = $Element.rows.Count
  $columnCount = @($Element.rows | ForEach-Object { $_.Count } | Measure-Object -Maximum).Maximum
  foreach ($row in $Element.rows) { if ($row.Count -ne $columnCount) { throw 'All table rows must contain the same number of cells.' } }
  $shape = $Slide.Shapes.AddTable($rowCount, $columnCount, (Convert-Point $Element.x), (Convert-Point $Element.y), (Convert-Point $Element.width), (Convert-Point $Element.height))
  Set-ShapeName $shape $Element
  for ($rowIndex = 1; $rowIndex -le $rowCount; $rowIndex++) {
    for ($columnIndex = 1; $columnIndex -le $columnCount; $columnIndex++) {
      $tableCell = $shape.Table.Cell($rowIndex, $columnIndex)
      $cell = $tableCell.Shape
      $range = $cell.TextFrame2.TextRange
      $range.Text = [string]$Element.rows[$rowIndex - 1][$columnIndex - 1]
      $range.Font.Name = [string](Get-Value $Element 'fontFamily' (Get-Value $Theme 'fontFamily' 'Aptos'))
      $range.Font.Size = [single](Get-Value $Element 'fontSize' 14)
      $range.Font.Fill.ForeColor.RGB = Convert-HexColor $(if ($rowIndex -eq 1) { Get-Value $Element 'headerColor' '#FFFFFF' } else { Get-Value $Element 'color' (Get-Value $Theme 'textColor' '#111111') })
      $range.Font.Bold = if ($rowIndex -eq 1) { -1 } else { 0 }
      $range.ParagraphFormat.Alignment = Convert-Alignment (Get-Value $Element 'align' 'left')
      $cell.Fill.Solid(); $cell.Fill.ForeColor.RGB = Convert-HexColor $(if ($rowIndex -eq 1) { Get-Value $Element 'headerFillColor' '#333333' } else { Get-Value $Element 'bodyFillColor' '#FFFFFF' })
      for ($borderIndex = 1; $borderIndex -le 4; $borderIndex++) {
        $tableCell.Borders.Item($borderIndex).ForeColor.RGB = Convert-HexColor (Get-Value $Element 'borderColor' '#D0D0D0')
      }
    }
  }
}

function Set-SlideNotes($Slide, [string]$Notes) {
  if (-not $Notes) { return }
  foreach ($shape in $Slide.NotesPage.Shapes) {
    if ($shape.PlaceholderFormat.Type -eq 2) { $shape.TextFrame.TextRange.Text = $Notes; return }
  }
}

function Build-Presentation($Application, $Payload) {
  if ((Test-Path -LiteralPath $Payload.presentationPath) -and -not $Payload.overwrite) { throw 'Presentation already exists.' }
  $presentation = $Application.Presentations.Add()
  try {
    $presentation.PageSetup.SlideWidth = Convert-Point (Get-Value $Payload.deck 'width' 13.333333)
    $presentation.PageSetup.SlideHeight = Convert-Point (Get-Value $Payload.deck 'height' 7.5)
    $theme = Get-Value $Payload.deck 'theme' ([pscustomobject]@{})
    $warnings = New-Object System.Collections.ArrayList
    $slideNumber = 0
    foreach ($slideSpec in $Payload.deck.slides) {
      $slideNumber++
      $slide = $presentation.Slides.Add($slideNumber, 12)
      $slide.FollowMasterBackground = 0
      $slide.Background.Fill.Solid()
      $slide.Background.Fill.ForeColor.RGB = Convert-HexColor (Get-Value $slideSpec 'backgroundColor' (Get-Value $theme 'backgroundColor' '#FFFFFF'))
      foreach ($element in $slideSpec.elements) {
        switch ($element.type) {
          'text' { Add-TextElement $slide $element $theme $warnings $slideNumber }
          'shape' { Add-ShapeElement $slide $element }
          'image' { Add-ImageElement $slide $element }
          'table' { Add-TableElement $slide $element $theme }
          default { throw "Unsupported presentation element type." }
        }
      }
      Set-SlideNotes $slide ([string](Get-Value $slideSpec 'notes' ''))
    }
    $presentation.SaveAs([string]$Payload.presentationPath, 24)
    return [ordered]@{ ok = $true; action = 'build'; presentationPath = [string]$Payload.presentationPath; slideCount = $presentation.Slides.Count; warnings = @($warnings) }
  } finally { $presentation.Close() }
}

function Inspect-Presentation($Application, $Payload) {
  $presentation = $Application.Presentations.Open([string]$Payload.presentationPath, -1, 0, 0)
  try {
    $slides = @()
    $slideLimit = [Math]::Min($presentation.Slides.Count, 100)
    for ($slideIndex = 1; $slideIndex -le $slideLimit; $slideIndex++) {
      $slide = $presentation.Slides.Item($slideIndex)
      $shapes = @()
      $shapeLimit = [Math]::Min($slide.Shapes.Count, 100)
      for ($shapeIndex = 1; $shapeIndex -le $shapeLimit; $shapeIndex++) {
        $shape = $slide.Shapes.Item($shapeIndex)
        $text = ''
        try { if ($shape.HasTextFrame -and $shape.TextFrame2.HasText) { $text = [string]$shape.TextFrame2.TextRange.Text } } catch {}
        if ($text.Length -gt 300) { $text = $text.Substring(0, 300) + '...' }
        $overflow = $false
        try { if ($shape.HasTextFrame -and $shape.TextFrame2.HasText) { $overflow = $shape.TextFrame2.TextRange.BoundHeight -gt ($shape.Height - $shape.TextFrame2.MarginTop - $shape.TextFrame2.MarginBottom + 1) } } catch {}
        $shapes += [ordered]@{ name = [string]$shape.Name; type = [int]$shape.Type; x = [Math]::Round($shape.Left / 72, 3); y = [Math]::Round($shape.Top / 72, 3); width = [Math]::Round($shape.Width / 72, 3); height = [Math]::Round($shape.Height / 72, 3); text = $text; overflow = $overflow }
      }
      $slides += [ordered]@{ number = [int]$slide.SlideIndex; shapeCount = [int]$slide.Shapes.Count; shapesTruncated = $slide.Shapes.Count -gt $shapeLimit; shapes = $shapes }
    }
    return [ordered]@{ ok = $true; action = 'inspect'; presentationPath = [string]$Payload.presentationPath; width = [Math]::Round($presentation.PageSetup.SlideWidth / 72, 3); height = [Math]::Round($presentation.PageSetup.SlideHeight / 72, 3); slideCount = $presentation.Slides.Count; slidesTruncated = $presentation.Slides.Count -gt $slideLimit; slides = $slides }
  } finally { $presentation.Close() }
}

function Render-Presentation($Application, $Payload) {
  $presentation = $Application.Presentations.Open([string]$Payload.presentationPath, -1, 0, 0)
  try {
    $slideNumber = [int]$Payload.slideNumber
    if ($slideNumber -lt 1 -or $slideNumber -gt $presentation.Slides.Count) { throw 'slideNumber is outside the presentation.' }
    $width = [int]$Payload.renderWidth
    $height = [int][Math]::Round($width * $presentation.PageSetup.SlideHeight / $presentation.PageSetup.SlideWidth)
    $presentation.Slides.Item($slideNumber).Export([string]$Payload.renderPath, 'PNG', $width, $height)
    return [ordered]@{ ok = $true; action = 'render'; presentationPath = [string]$Payload.presentationPath; slideNumber = $slideNumber; width = $width; height = $height; renderPath = [string]$Payload.renderPath }
  } finally { $presentation.Close() }
}

$application = $null
try {
  $payload = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $application = New-Object -ComObject PowerPoint.Application
  $application.DisplayAlerts = 1
  switch ($payload.action) {
    'build' { $result = Build-Presentation $application $payload }
    'inspect' { $result = Inspect-Presentation $application $payload }
    'render' { $result = Render-Presentation $application $payload }
    default { throw 'Unsupported presentation action.' }
  }
  $result | ConvertTo-Json -Depth 10 -Compress
} catch {
  [ordered]@{ ok = $false; error = $_.Exception.Message; line = $_.InvocationInfo.ScriptLineNumber } | ConvertTo-Json -Compress
  exit 1
} finally {
  if ($application) {
    try { $application.Quit() } catch {}
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($application)
  }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
