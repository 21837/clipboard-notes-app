# 生成应用图标的脚本
# 运行方式：右键点击此文件 -> 使用 PowerShell 运行

Add-Type -AssemblyName System.Drawing

$iconPath = Join-Path $PSScriptRoot "assets\icon.ico"

# 创建 256x256 的位图
$bitmap = New-Object System.Drawing.Bitmap(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

# 填充背景（紫色渐变）
$gradientBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point(256, 256)),
    [System.Drawing.Color]::FromArgb(99, 102, 241),
    [System.Drawing.Color]::FromArgb(79, 70, 229)
)
$graphics.FillRectangle($gradientBrush, 0, 0, 256, 256)

# 绘制圆角矩形背景
$rect = New-Object System.Drawing.Rectangle(20, 20, 216, 216)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 30
$path.AddArc($rect.X, $rect.Y, $radius, $radius, 180, 90)
$path.AddArc($rect.Right - $radius, $rect.Y, $radius, $radius, 270, 90)
$path.AddArc($rect.Right - $radius, $rect.Bottom - $radius, $radius, $radius, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $radius, $radius, $radius, 90, 90)
$path.CloseFigure()
$whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$graphics.FillPath($whiteBrush, $path)

# 绘制剪贴板图标
$clipPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(99, 102, 241), 12)
$clipPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$clipPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

# 剪贴板主体
$graphics.DrawRectangle($clipPen, 78, 88, 100, 100)

# 剪贴板顶部
$graphics.DrawLine($clipPen, 103, 88, 103, 68)
$graphics.DrawLine($clipPen, 153, 88, 153, 68)
$graphics.DrawLine($clipPen, 78, 68, 178, 68)

# 顶部小矩形
$graphics.FillRectangle($whiteBrush, 103, 60, 50, 16)

# 绘制文字 "笔记"
$font = New-Object System.Drawing.Font("Microsoft YaHei", 28, [System.Drawing.FontStyle]::Bold)
$textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(99, 102, 241))
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = New-Object System.Drawing.RectangleF(78, 130, 100, 50)
$graphics.DrawString("笔记", $font, $textBrush, $textRect, $format)

# 清理
$graphics.Dispose()

# 保存为临时 PNG
$tempPng = Join-Path $PSScriptRoot "assets\temp_icon.png"
$bitmap.Save($tempPng, [System.Drawing.Imaging.ImageFormat]::Png)

# 转换为 ICO（手动创建）
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())

# 保存 ICO 文件
$fs = [System.IO.File]::Create($iconPath)
$icon.Save($fs)
$fs.Close()

# 清理临时文件
$bitmap.Dispose()
Remove-Item $tempPng -ErrorAction SilentlyContinue

Write-Host "图标已生成: $iconPath"
Write-Host "现在可以运行 npm run dev 启动应用"
Write-Host "或运行 npm run build:win 打包应用"