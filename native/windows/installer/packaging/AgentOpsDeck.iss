; Inno Setup 6.7.4. Compile only after explicit target seal and payload verification.
#error Native release blocked: VERSION-POLICY.json has no approved AOD core seal or platform/rights acceptance.
#ifndef PayloadDir
  #define PayloadDir "..\payload"
#endif
[Setup]
AppId=AgentOpsDeck.Desktop.CurrentUser
AppName=AgentOpsDeck
AppVersion=2.4.6
AppVerName=AgentOpsDeck 2.4.6
AppPublisher=AgentOpsDeck
VersionInfoVersion=2.4.6.12
VersionInfoDescription=AgentOpsDeck current-user installer
DefaultDirName={localappdata}\Programs\AgentOpsDeck
DefaultGroupName=AgentOpsDeck
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
DisableWelcomePage=no
DisableDirPage=yes
DisableProgramGroupPage=yes
UsePreviousAppDir=no
UsePreviousTasks=no
UninstallLogMode=append
UninstallDisplayName=AgentOpsDeck
UninstallDisplayIcon={app}\AgentOpsDeck.exe
OutputDir=..\out
OutputBaseFilename=AgentOpsDeck-Setup-2.4.6.12-Inno-Windows-x64
Compression=lzma2
SolidCompression=yes
CloseApplications=no
RestartApplications=no
SetupLogging=yes
SetupMutex=Local\AgentOpsDeck.Inno.Setup
SetupIconFile=..\..\inno-installer-2.4.6\assets\AgentOpsDeck.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
#if FileExists(AddBackslash(CompilerPath) + "Languages\ChineseSimplified.isl")
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopShortcut}"; Flags: unchecked

[CustomMessages]
english.DesktopShortcut=Create a desktop shortcut
chinesesimp.DesktopShortcut=创建桌面快捷方式
english.LaunchAOD=Launch AgentOpsDeck
chinesesimp.LaunchAOD=启动 AgentOpsDeck

[Files]
#include "..\generated\payload-files.iss"

[Icons]
Name: "{userprograms}\AgentOpsDeck\AgentOpsDeck"; Filename: "{app}\AgentOpsDeck.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\AgentOpsDeck"; Filename: "{app}\AgentOpsDeck.exe"; WorkingDir: "{app}"; Tasks: desktopicon; Check: ShouldCreateDesktopShortcut

[Run]
Filename: "{app}\AgentOpsDeck.exe"; Description: "{cm:LaunchAOD}"; Flags: nowait postinstall skipifsilent unchecked

[Code]
#include "lifecycle.iss"
#ifdef PortableUpgradeProfiles
#include "payload-verification.iss"
#endif
