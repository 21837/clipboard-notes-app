@echo off
echo ====================================
echo   功能笔记应用 - 打包工具
echo ====================================
echo.
echo 正在打包应用，请稍候...
echo.

cd /d "%~dp0"

call npm run build:win

echo.
echo 打包完成！
echo.
echo 可执行文件位于: dist\win-unpacked\ 功能笔记.exe
echo.
pause