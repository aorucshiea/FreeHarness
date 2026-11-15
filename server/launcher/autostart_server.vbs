' FreeHarness 登录静默启动本地服务（无窗口，位置无关）
Option Explicit
Dim fso, sh, here, serverDir, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
serverDir = fso.GetParentFolderName(here)
sh.CurrentDirectory = serverDir
On Error Resume Next
rc = sh.Run("cmd /c where python >nul 2>nul", 0, True)
If rc <> 0 Then
    sh.Run "py harness_server.py", 0, False
Else
    sh.Run "python harness_server.py", 0, False
End If