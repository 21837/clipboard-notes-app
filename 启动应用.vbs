' 启动 功能笔记（从脚本所在目录启动，路径不写死，克隆到任何位置都能用）
Set fso = CreateObject("Scripting.FileSystemObject")
Set objShell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
objShell.Run "cmd /c cd /d """ & scriptDir & """ && start /B /MIN """" ""node_modules\.bin\electron"" .", 0, False
