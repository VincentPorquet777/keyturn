' Keyturn launcher: starts the local service with no console window and opens the Keyturn window.
' If Keyturn is already running, it just brings the window up.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
appDir = fso.BuildPath(baseDir, "app")
node = fso.BuildPath(baseDir, "node\node.exe")
If Not fso.FileExists(node) Then node = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(node) Then node = "node"
sh.CurrentDirectory = appDir
sh.Run """" & node & """ """ & fso.BuildPath(appDir, "server.js") & """ --open", 0, False
