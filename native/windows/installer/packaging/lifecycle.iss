// Bounded application adapter. Inno owns copying, cancellation cleanup, log and uninstall.
// Inno does not back up prior files automatically: old-version restoration is NOT promised.
// All Win32 pointer declarations target the 32-bit Inno Setup 6 Unicode engine.
const
  OldKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentOpsDeck';
  InnoKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentOpsDeck.Desktop.CurrentUser_is1';
  WriteRights = $500D0156;
type
  TBytes1024 = array[0..1023] of Byte;
  TAclHeader = record Revision, Reserved: Byte; Size, Count, Reserved2: Word; end;
  TAceHeader = record Kind, Flags: Byte; Size: Word; Mask: LongWord; end;
  TFileInfo = record
    Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh,
    WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, NumberOfLinks,
    IndexHigh, IndexLow: LongWord;
  end;
var
  KnownFiles, PriorFiles: TStringList;
  LegacyApplicationVersion, LegacyRevision, ActiveMetadataHash, ActiveUninstallerHash: String;
  Root, Detected, Action, Blocker, FailureReason, MarkerDiagnostic, MetadataDiagnostic: String;
  Legacy, Modern: Boolean;
  Nodes: Integer;
  Preview: TNewStaticText;

function Attr(Name: String): LongWord;
  external 'GetFileAttributesW@kernel32.dll stdcall';
function GetSecurityInfo(H, Kind, Flags: LongWord;
  var Owner, Group, Dacl, Sacl, Descriptor: LongWord): LongWord;
  external 'GetSecurityInfo@advapi32.dll stdcall';
function LocalFree(P: LongWord): LongWord;
  external 'LocalFree@kernel32.dll stdcall';
function LocalAlloc(Flags, Size: LongWord): LongWord;
  external 'LocalAlloc@kernel32.dll stdcall';
function OpenProcessToken(Process: LongWord; Access: LongWord; var Token: LongWord): Boolean;
  external 'OpenProcessToken@advapi32.dll stdcall';
function GetCurrentProcess: LongWord;
  external 'GetCurrentProcess@kernel32.dll stdcall';
function GetTokenInformation(Token, Kind, Data: LongWord;
  Size: LongWord; var Needed: LongWord): Boolean;
  external 'GetTokenInformation@advapi32.dll stdcall';
function EqualSid(A, B: LongWord): Boolean;
  external 'EqualSid@advapi32.dll stdcall';
function IsWellKnownSid(Sid, Kind: LongWord): Boolean;
  external 'IsWellKnownSid@advapi32.dll stdcall';
function GetAce(Acl, Index: LongWord; var Ace: LongWord): Boolean;
  external 'GetAce@advapi32.dll stdcall';

procedure ReadAcl(var Dest: TAclHeader; Source, Count: LongWord);
  external 'RtlMoveMemory@kernel32.dll stdcall';
procedure ReadDword(var Dest: LongWord; Source, Count: LongWord);
  external 'RtlMoveMemory@kernel32.dll stdcall';
procedure ReadAce(var Dest: TAceHeader; Source, Count: LongWord);
  external 'RtlMoveMemory@kernel32.dll stdcall';
function CloseHandle(H: LongWord): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';
function OpenFile(Name: String; Access, Share, Security, Disposition, Flags, Template: LongWord): LongWord;
  external 'CreateFileW@kernel32.dll stdcall';
function GetFileInformationByHandle(H: LongWord; var Info: TFileInfo): Boolean;
  external 'GetFileInformationByHandle@kernel32.dll stdcall';
function RegOpenKeyExW(H: LongWord; Name: String; Options, Access: LongWord; var Key: LongWord): LongWord;
  external 'RegOpenKeyExW@advapi32.dll stdcall';
function RegQueryValueExW(Key: LongWord; Name: String; Reserved: LongWord;
  var Kind: LongWord; var Data: TBytes1024; var Size: LongWord): LongWord;
  external 'RegQueryValueExW@advapi32.dll stdcall';
function RegCloseKey(Key: LongWord): LongWord;
  external 'RegCloseKey@advapi32.dll stdcall';

#include "..\generated\trusted-baseline.iss"
#include "..\generated\target-files.iss"
#include "..\generated\prior9-files.iss"
#include "..\generated\prior10-files.iss"
#include "..\generated\prior11-files.iss"
#include "..\generated\trusted-priors.iss"

// Only fixed role-based reasons reach our UI/log; system exception text can
// contain private paths. Do not copy it into installer diagnostics.
procedure Reject(Reason: String);
begin
  FailureReason := Reason;
  RaiseException(Reason);
end;

function SafeFailure: String;
begin
  Result := FailureReason;
  if Result = '' then Result := 'Installer inspection failed; existing files preserved';
end;

// Only Strings[]/Count are exposed by Inno's Pascal Script TStrings binding.
function KnownPath(Index: Integer): String;
var Row: String;
begin
  Row := KnownFiles.Strings[Index];
  Result := Copy(Row, 1, Pos('|', Row) - 1);
end;

function KnownHash(Index: Integer): String;
var Row: String;
begin
  Row := KnownFiles.Strings[Index];
  Result := Copy(Row, Pos('|', Row) + 1, 64);
end;

function IndexKnownPath(Rel: String): Integer;
var I: Integer;
begin
  Result := -1;
  for I := 0 to KnownFiles.Count - 1 do
    if CompareText(KnownPath(I), Rel) = 0 then begin Result := I; Exit; end;
end;

procedure CheckSecurity(H: LongWord);
var O, G, D, S, SD, Token, Needed, UserBuffer, UserSid, Ace, I: LongWord;
    Acl: TAclHeader; Hdr: TAceHeader;
begin
  O := 0; G := 0; D := 0; S := 0; SD := 0; Token := 0; UserBuffer := 0;
  if GetSecurityInfo(H, 1, 5, O, G, D, S, SD) <> 0 then
    Reject('Cannot inspect ownership/permissions');
  try
    if (O = 0) or (D = 0) then Reject('Unbounded permissions');
    if not OpenProcessToken(GetCurrentProcess, 8, Token) then Reject('Cannot inspect current user');
    try
      UserBuffer := LocalAlloc(0, 1024);
      if UserBuffer = 0 then Reject('Cannot allocate bounded identity buffer');
      if not GetTokenInformation(Token, 1, UserBuffer, 1024, Needed) then Reject('Cannot inspect current identity');
      { TOKEN_USER begins with a SID pointer. }
      ReadDword(UserSid, UserBuffer, 4);
      if not EqualSid(O, UserSid) then Reject('Different owner; permissions were not changed');
      ReadAcl(Acl, D, 8);
      if Acl.Count > 0 then
      for I := 0 to Acl.Count - 1 do begin
        if not GetAce(D, I, Ace) then Reject('Unreadable ACL');
        ReadAce(Hdr, Ace, 8);
        if (Hdr.Kind <> 0) and (Hdr.Kind <> 1) then Reject('Unsupported ACL; unchanged');
        { CREATOR_OWNER is accepted only as the standard OI/CI inherit-only
          template (optionally inherited). It grants nothing on this object.
          Every existing child is checked independently by CheckTree. }
        if (Hdr.Kind = 0) and IsWellKnownSid(Ace + 8, 3) and
           ((Hdr.Flags and $EF) <> $0B) then
          Reject('Unsupported creator-owner ACL template; unchanged');
        if (Hdr.Kind = 0) and ((Hdr.Flags and 8) = 0) and
           ((Hdr.Mask and WriteRights) <> 0) then
          if not EqualSid(Ace + 8, UserSid) and not IsWellKnownSid(Ace + 8, 26) and
             not IsWellKnownSid(Ace + 8, 22) then
            Reject('Other identities can modify this path; unchanged');
      end;
    finally
      if UserBuffer <> 0 then LocalFree(UserBuffer);
      CloseHandle(Token);
    end;
  finally
    if SD <> 0 then LocalFree(SD);
  end;
end;

procedure CheckNode(Name: String);
var A, H: LongWord; Info: TFileInfo;
begin
  A := Attr(Name);
  if A = $FFFFFFFF then Reject('Cannot inspect path');
  if (A and $400) <> 0 then Reject('Reparse/link path preserved');
  { READ_CONTROL; share-read only; BACKUP_SEMANTICS | OPEN_REPARSE_POINT.
    Inspect identity, attributes and ACL through the same pinned handle.
    No permission edits and no following the final reparse component. }
  H := OpenFile(Name, $20000, 1, 0, 3, $02200000, 0);
  if H = $FFFFFFFF then Reject('Cannot inspect file identity');
  try
    if not GetFileInformationByHandle(H, Info) then Reject('Cannot inspect links');
    A := Info.Attributes;
    if (A and $400) <> 0 then Reject('Reparse/link path preserved');
    CheckSecurity(H);
    if ((A and 16) = 0) and (Info.NumberOfLinks <> 1) then
      Reject('Hard-linked file preserved');
  finally
    CloseHandle(H);
  end;
end;

procedure CheckTree(Dir, Prefix: String; Depth: Integer);
var F: TFindRec; Rel: String; Index: Integer;
begin
  if Depth > 32 then Reject('Directory depth exceeds safe inspection bound');
  if FindFirst(Dir + '\*', F) then begin
    try
      repeat
        if (F.Name <> '.') and (F.Name <> '..') then begin
          Nodes := Nodes + 1;
          if Nodes > 20000 then Reject('Directory exceeds safe inspection bound');
          Rel := Prefix + F.Name;
          CheckNode(Dir + '\' + F.Name);
          Index := IndexKnownPath(Rel);
          if (Index >= 0) and (KnownPath(Index) <> Rel) then
            Reject('Case/path alias preserved');
          if (F.Attributes and 16) <> 0 then CheckTree(Dir + '\' + F.Name, Rel + '\', Depth + 1);
        end;
      until not FindNext(F);
    finally
      FindClose(F);
    end;
  end;
end;

function PriorIndex(Rel: String): Integer;
var I, P: Integer; Row: String;
begin
  Result := -1;
  for I := 0 to PriorFiles.Count - 1 do begin
    Row := PriorFiles.Strings[I]; P := Pos('|', Row);
    if CompareText(Copy(Row, 1, P - 1), Rel) = 0 then begin
      if Copy(Row, 1, P - 1) <> Rel then Reject('Prior case/path alias preserved');
      Result := I; Exit;
    end;
  end;
end;

procedure CheckPriorPayload;
var I, P: Integer; Row, Name: String; F: TFindRec;
begin
  for I := 0 to PriorFiles.Count - 1 do begin
    Row := PriorFiles.Strings[I]; P := Pos('|', Row);
    Name := Root + '\' + Copy(Row, 1, P - 1);
    if not FileExists(Name) then Reject('Owned prior baseline file missing');
    if not FindFirst(Name, F) then Reject('Cannot inspect owned prior name');
    try
      if F.Name <> ExtractFileName(Name) then Reject('Prior case/path alias preserved');
    finally
      FindClose(F);
    end;
    CheckNode(Name);
    if GetSHA256OfFile(Name) <> Copy(Row, P + 1, 64) then Reject('Owned prior file differs; preserved');
  end;
end;

// Whole-profile match only: no per-file union of old and new hashes.
function MatchesPriorPayload: Boolean;
var I, P: Integer; Row, Name: String;
begin
  Result := False;
  for I := 0 to PriorFiles.Count - 1 do begin
    Row := PriorFiles.Strings[I]; P := Pos('|', Row);
    Name := Root + '\' + Copy(Row, 1, P - 1);
    if not FileExists(Name) then Exit;
    if GetSHA256OfFile(Name) <> Copy(Row, P + 1, 64) then Exit;
  end;
  Result := True;
end;

procedure LoadTargetAsPrior;
var I: Integer;
begin
  PriorFiles.Clear;
  for I := 0 to KnownFiles.Count - 1 do PriorFiles.Add(KnownFiles.Strings[I]);
end;

procedure CheckTargetCollisions;
var I: Integer; Rel, Name: String;
begin
  for I := 0 to KnownFiles.Count - 1 do begin
    Rel := KnownPath(I); Name := Root + '\' + Rel;
    if DirExists(Name) then Reject('Directory would be overwritten');
    if FileExists(Name) and (PriorIndex(Rel) < 0) then Reject('Unknown file would be overwritten');
  end;
end;

procedure CheckPayload(RequireAll: Boolean);
var I: Integer; Rel, Name: String;
begin
  for I := 0 to KnownFiles.Count - 1 do begin
    Rel := KnownPath(I);
    Name := Root + '\' + Rel;
    if FileExists(Name) then begin
      if not RequireAll then Reject('Unknown file would be overwritten');
      CheckNode(Name);
      if GetSHA256OfFile(Name) <> KnownHash(I) then
        Reject('Owned file differs; preserved');
    end else if RequireAll then Reject('Owned baseline file missing');
    if DirExists(Name) then Reject('Directory would be overwritten');
  end;
end;

function RegStringEquals(Key, Name, Expected: String): Boolean;
var Value: String; Hive: Integer;
begin
  Hive := HKCU32;
  if Key = InnoKey then Hive := HKCU64;
  Result := RegQueryStringValue(Hive, Key, Name, Value) and (Value = Expected);
end;

function RegistryBytesEqual(Name, Expected: String; ExpectedType, ExpectedDword: LongWord): Boolean;
var Key, Kind, Size, ExpectedSize: LongWord; Data: TBytes1024; I, Code: Integer;
begin
  Result := False;
  { Exact original NSIS 32-bit registry view. Do not expand/trim registry strings. }
  if RegOpenKeyExW($80000001, OldKey, 0, $20219, Key) <> 0 then Exit;
  try
    Size := 1024;
    if RegQueryValueExW(Key, Name, 0, Kind, Data, Size) <> 0 then Exit;
    if Kind <> ExpectedType then Exit;
    if ExpectedType = 1 then begin
      ExpectedSize := (Length(Expected) + 1) * 2;
      if Size <> ExpectedSize then Exit;
      for I := 1 to Length(Expected) do begin
        Code := Ord(Expected[I]);
        if (Data[(I-1)*2] <> (Code and 255)) or (Data[(I-1)*2+1] <> (Code shr 8)) then Exit;
      end;
      Result := (Data[Size-2] = 0) and (Data[Size-1] = 0);
    end else if ExpectedType = 4 then begin
      if Size <> 4 then Exit;
      Result := (Data[0] = ExpectedDword) and (Data[1] = 0) and (Data[2] = 0) and (Data[3] = 0);
    end;
  finally
    RegCloseKey(Key);
  end;
end;

function LegacyRegistryExact: Boolean;
var Names, Subkeys: TArrayOfString;
begin
  Result := False;
  if not RegGetValueNames(HKCU32, OldKey, Names) then Exit;
  if GetArrayLength(Names) <> 6 then Exit;
  if not RegGetSubkeyNames(HKCU32, OldKey, Subkeys) then Exit;
  if GetArrayLength(Subkeys) <> 0 then Exit;
  Result := RegistryBytesEqual('DisplayName', 'AgentOpsDeck', 1, 0) and
     RegistryBytesEqual('DisplayVersion', LegacyApplicationVersion, 1, 0) and
     RegistryBytesEqual('InstallLocation', Root, 1, 0) and
     RegistryBytesEqual('UninstallString', '"' + Root + '\Uninstall.exe"', 1, 0) and
     RegistryBytesEqual('NoModify', '', 4, 1) and
     RegistryBytesEqual('NoRepair', '', 4, 0);
end;

function DeclaredVersion: String;
var V: String; I: Integer;
begin
  Result := 'unknown';
  if not RegQueryStringValue(HKCU32, OldKey, 'DisplayVersion', V) then Exit;
  if (Length(V) = 0) or (Length(V) > 48) then Exit;
  for I := 1 to Length(V) do
    if Pos(V[I], '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-+') = 0 then Exit;
  Result := V + ' (registry declaration; identity not authenticated)';
end;

// Diagnostics accept only a public 64-lowercase-hex package ID, never arbitrary bytes.
function PublicMarker(Value: String): String;
var I: Integer;
begin
  Result := 'invalid / unavailable';
  if Length(Value) <> 64 then Exit;
  for I := 1 to 64 do if Pos(Value[I], '0123456789abcdef') = 0 then Exit;
  Result := Value;
end;

// Read only explicitly allowed version declarations, never print raw metadata.
function PublicVersionField(Text, Field: String): String;
var Token, Tail, Value: String; P, I: Integer;
begin
  Result := 'unknown'; Token := '"' + Field + '":"';
  P := Pos(Token, Text); if P = 0 then Exit;
  Tail := Copy(Text, P + Length(Token), 50);
  P := Pos('"', Tail); if (P < 2) or (P > 49) then Exit;
  Value := Copy(Tail, 1, P - 1);
  for I := 1 to Length(Value) do
    if Pos(Value[I], '0123456789.') = 0 then Exit;
  Result := Value;
end;

function DeclaredMetadataIdentity: String;
var Text: AnsiString; Size: Int64; Name: String;
begin
  Result := 'unknown'; Name := Root + '\.agentopsdeck-installed.json';
  if not FileExists(Name) then Exit;
  CheckNode(Name);
  if not FileSize64(Name, Size) then Exit;
  if (Size < 2) or (Size > 4194304) then Exit;
  if not LoadStringFromFile(Name, Text) then Exit;
  Result := PublicVersionField(Text, 'application_version') + ' / ' +
            PublicVersionField(Text, 'installer_revision') + ' (metadata declaration only)';
end;

procedure CheckAncestors;
var P: String;
begin
  P := Root;
  while not DirExists(P) do begin
    if FileExists(P) then Reject('Program directory collides with a file');
    P := ExtractFileDir(P);
    if Length(P) < 4 then Reject('Cannot inspect program ancestor');
  end;
  CheckNode(P);
  { Inspect every writable ancestor inside the user data boundary, not just the leaf. }
  while CompareText(P, ExpandConstant('{localappdata}')) <> 0 do begin
    P := ExtractFileDir(P);
    if Length(P) < Length(ExpandConstant('{localappdata}')) then Reject('Path escaped local application directory');
    CheckNode(P);
  end;
end;

// Existing files/directories/reparse entries and unreadable destinations are
// preserved. Only positively absent destinations may receive this optional icon.
function ShouldCreateDesktopShortcut: Boolean;
var Attributes: LongWord; ErrorCode: LongInt;
begin
  Result := False;
  if not WizardIsTaskSelected('desktopicon') then Exit;
  Attributes := Attr(ExpandConstant('{userdesktop}\AgentOpsDeck.lnk'));
  ErrorCode := DLLGetLastError;
  Result := (Attributes = $FFFFFFFF) and ((ErrorCode = 2) or (ErrorCode = 3));
end;

procedure CheckShortcutPaths;
var P, Boundary: String; Steps: Integer;
begin
  P := ExpandConstant('{userprograms}\AgentOpsDeck');
  Boundary := ExpandConstant('{userappdata}');
  if FileExists(P) then Reject('Start menu group collides with an unknown file');
  Steps := 0;
  while not DirExists(P) do begin
    Steps := Steps + 1;
    if Steps > 32 then Reject('Cannot inspect Start menu ancestors within bound');
    P := ExtractFileDir(P);
  end;
  CheckNode(P);
  while CompareText(P, Boundary) <> 0 do begin
    P := ExtractFileDir(P);
    if Length(P) < Length(Boundary) then Reject('Redirected Start menu path requires independent review');
    CheckNode(P);
  end;
  if ShouldCreateDesktopShortcut then begin
    CheckNode(ExpandConstant('{userdesktop}'));
  end;
end;

#ifdef PortableUpgradeProfiles
#include "..\generated\portable-upgrade-profiles.iss"
#endif

procedure Preflight;
var Marker: AnsiString; MarkerSize, MetadataSize: Int64;
begin
  Root := ExpandConstant('{localappdata}\Programs\AgentOpsDeck');
  if ExpandConstant('{app}') <> Root then Reject('Only the current-user default program directory is supported');
  Legacy := False; Modern := False;
  MarkerDiagnostic := 'absent'; MetadataDiagnostic := 'unknown';
  LegacyApplicationVersion := '2.4.6'; LegacyRevision := '2.4.6.0';
  ActiveMetadataHash := LegacyMetadataHash; ActiveUninstallerHash := LegacyUninstallerHash;
  PriorFiles.Clear;
  Detected := DeclaredVersion; Action := 'Install';
  CheckAncestors;
  Modern := RegStringEquals(InnoKey, 'Inno Setup: App Path', Root) and
            RegStringEquals(InnoKey, 'DisplayVersion', '2.4.6');
#ifdef PortableUpgradeProfiles
  if not Modern then
    Modern := RegStringEquals(InnoKey, 'Inno Setup: App Path', Root) and PortableRegistrationVersion;
#endif
  if not Modern and RegKeyExists(HKCU64, InnoKey) then Reject('Existing unknown Inno registration; preserved');
  if Modern then begin
    Detected := '2.4.6 (Inno; exact baseline checked)'; Action := 'Upgrade / reinstall';
    LoadBaselineFiles;
    if not MatchesPriorPayload then LoadPrior9Files;
    if not MatchesPriorPayload then LoadPrior10Files;
    if not MatchesPriorPayload then LoadPrior11Files;
    if not MatchesPriorPayload then LoadTargetAsPrior;
#ifdef PortableUpgradeProfiles
    if not MatchesPriorPayload then LoadPortableUpgradeProfile;
#endif
  end;
  if DirExists(Root) then begin
    if FileExists(Root + '\.agentopsdeck-inventory.json') or DirExists(Root + '\.agentopsdeck-txn') or
       FileExists(Root + '\.agentopsdeck-txn') then Reject('Other installer ownership/transaction state requires independent review; preserved');
    Nodes := 0; CheckTree(Root, '', 0);
    if not Modern and FileExists(Root + '\.agentopsdeck-install-id') then begin
      if not FileSize64(Root + '\.agentopsdeck-install-id', MarkerSize) then Reject('Cannot inspect legacy marker size');
      if MarkerSize > 64 then Reject('Legacy marker exceeds 64-byte identity bound');
      if not LoadStringFromFile(Root + '\.agentopsdeck-install-id', Marker) then Reject('Cannot read legacy identity');
      MarkerDiagnostic := PublicMarker(Marker);
      MetadataDiagnostic := DeclaredMetadataIdentity;
      if MarkerDiagnostic = 'invalid / unavailable' then Reject('Legacy marker is not a valid 64-hex package identity; preserved');
      if Marker = '1e8ecbee4eef8f94a558c6678e91fef54444b9114996b20eeb40bc2bbf7e6c36' then
        Detected := '2.3.6 engineering (known inventory marker; full identity unproven)';
      if Marker = '99db7341d9676a5d57da9988bca0e20153876488a320ac9cbf3786b63d1863cf' then
        Detected := '2.3.6 Codex engineering (known inventory marker; full identity unproven)';
      if (Marker <> LegacyId) and not LoadPriorFiles(Marker) then
        Reject('This prior identity lacks an independently pinned migration/stop contract. No files changed.');
      if Marker = LegacyId then LoadBaselineFiles;
      Detected := LegacyApplicationVersion + ' / NSIS ' + LegacyRevision + ' (marker declaration)';
      if not FileExists(Root + '\.agentopsdeck-installed.json') or
         not FileExists(Root + '\Uninstall.exe') then Reject('Legacy identity controls missing; preserved');
      if not FileSize64(Root + '\.agentopsdeck-installed.json', MetadataSize) then Reject('Cannot inspect legacy metadata size');
      if MetadataSize > 4194304 then Reject('Legacy metadata exceeds 4 MiB bound');
      if GetSHA256OfFile(Root + '\.agentopsdeck-installed.json') <> ActiveMetadataHash then
        Reject('Legacy metadata is not the exact authenticated schema-1 baseline; preserved');
      if GetSHA256OfFile(Root + '\Uninstall.exe') <> ActiveUninstallerHash then
        Reject('Legacy uninstaller bytes do not match the independent pin; preserved');
      if not LegacyRegistryExact then Reject('Legacy registration differs from the exact six-value baseline; preserved');
      Legacy := True; Action := 'Upgrade in place';
    end;
    if not Legacy and not Modern and (Nodes <> 0) then
      Reject('Existing root has no supported authenticated prior identity; preserved');
    if Legacy or Modern then begin
      CheckPriorPayload;
      CheckTargetCollisions;
    end else CheckPayload(Legacy or Modern);
    if Legacy then Detected := LegacyApplicationVersion + ' / NSIS ' + LegacyRevision + ' (authenticated baseline)';
  end else if RegKeyExists(HKCU32, OldKey) or RegKeyExists(HKCU64, InnoKey) then
    Reject('Registration exists but program baseline is missing; preserved');
  if not Modern then begin
    if FileExists(Root + '\unins000.exe') or FileExists(Root + '\unins000.dat') then
      Reject('Existing unknown Inno control filename; preserved');
    if FileExists(ExpandConstant('{userprograms}\AgentOpsDeck\AgentOpsDeck.lnk')) then
      Reject('Unknown Start menu shortcut would be overwritten; preserved');

  end;
  if not Legacy and not Modern and RegKeyExists(HKCU32, OldKey) then
    Reject('Existing unrecognized registry declaration; preserved');
  CheckShortcutPaths;
end;

procedure StopOwnedApplication;
var Code: Integer;
begin
  { Full immutable payload, path security and identity have already been checked. }
  if not Exec(Root + '\AgentOpsDeck.exe', '--stop', Root, SW_HIDE, ewWaitUntilTerminated, Code) then
    Reject('Could not request graceful application stop; files preserved');
  if Code <> 0 then Reject('Application stop was refused or ambiguous (exit ' + IntToStr(Code) + '); files preserved');
  if not Exec(Root + '\AgentOpsDeck.exe', '--status', Root, SW_HIDE, ewWaitUntilTerminated, Code) then
    Reject('Cannot confirm stopped application; files preserved');
  if Code <> 0 then Reject('Application is not confirmed stopped (exit ' + IntToStr(Code) + '); files preserved');
end;

procedure ReadIdentityPreview;
var Marker: AnsiString; MarkerSize: Int64;
begin
  Root := ExpandConstant('{localappdata}\Programs\AgentOpsDeck');
  Detected := DeclaredVersion; Action := 'Install'; Legacy := False; Modern := False;
  MarkerDiagnostic := 'absent'; MetadataDiagnostic := 'unknown';
  if RegStringEquals(InnoKey, 'Inno Setup: App Path', Root) and
     RegStringEquals(InnoKey, 'DisplayVersion', '2.4.6') then begin
    Detected := '2.4.6 (Inno registration; verified when you click Reinstall)';
    Modern := True; Action := 'Reinstall'; Exit;
  end;
#ifdef PortableUpgradeProfiles
  if RegStringEquals(InnoKey, 'Inno Setup: App Path', Root) and PortableRegistrationVersion then begin
    Detected := 'Known Inno version (full payload verified before replacement)';
    Modern := True; Action := 'Upgrade / reinstall'; Exit;
  end;
#endif
  if FileExists(Root + '\.agentopsdeck-install-id') then begin
    CheckAncestors;
    CheckNode(Root + '\.agentopsdeck-install-id');
    if not FileSize64(Root + '\.agentopsdeck-install-id', MarkerSize) then Reject('Cannot inspect legacy marker');
    if MarkerSize > 64 then Reject('Legacy marker exceeds 64-byte identity bound');
    if not LoadStringFromFile(Root + '\.agentopsdeck-install-id', Marker) then Reject('Cannot read legacy marker');
    MarkerDiagnostic := PublicMarker(Marker);
    MetadataDiagnostic := DeclaredMetadataIdentity;
    if MarkerDiagnostic = 'invalid / unavailable' then Reject('Legacy marker is not a valid 64-hex package identity; preserved');
    LegacyApplicationVersion := '2.4.6'; LegacyRevision := '2.4.6.0';
    if (Marker = LegacyId) or LoadPriorFiles(Marker) then begin
      Detected := LegacyApplicationVersion + ' / NSIS ' + LegacyRevision + ' (declaration; verified when you click Upgrade)';
      Legacy := True; Action := 'Upgrade in place';
    end else begin
      if Marker = '1e8ecbee4eef8f94a558c6678e91fef54444b9114996b20eeb40bc2bbf7e6c36' then
        Detected := '2.3.6 engineering (known marker; full identity unproven)';
      if Marker = '99db7341d9676a5d57da9988bca0e20153876488a320ac9cbf3786b63d1863cf' then
        Detected := '2.3.6 Codex engineering (known marker; full identity unproven)';
      Action := 'Preserve / blocked';
      Reject('No independently pinned migration and graceful-stop contract for this identity');
    end;
  end else if DirExists(Root) or RegKeyExists(HKCU32, OldKey) then
    Action := 'Install only if empty / otherwise preserve';
end;

procedure UpdatePreview;
begin
  Blocker := ''; FailureReason := '';
  try ReadIdentityPreview; except Blocker := SafeFailure; end;
  Preview.Caption := 'Detected: ' + Detected + #13#10 + 'Target: AgentOpsDeck 2.4.6 (installer 2.4.6.12-Inno)' + #13#10 +
    'Action: ' + Action + #13#10 + 'Location: ' + Root;
  Preview.Caption := Preview.Caption + #13#10 + 'Package marker: ' + MarkerDiagnostic + #13#10 +
    'Declared metadata: ' + MetadataDiagnostic;
  if Blocker <> '' then Preview.Caption := Preview.Caption + #13#10 + 'Preserve / blocked: ' + Blocker;
end;

procedure InitializeWizard;
begin
  PriorFiles := TStringList.Create;
  KnownFiles := TStringList.Create;
  KnownFiles.NameValueSeparator := '|';
  LoadKnownFiles;
  Preview := TNewStaticText.Create(WizardForm);
  Preview.Parent := WizardForm.WelcomePage;
  Preview.Left := WizardForm.WelcomeLabel2.Left;
  Preview.Top := WizardForm.WelcomeLabel2.Top;
  Preview.Width := WizardForm.WelcomeLabel2.Width;
  Preview.Height := WizardForm.WelcomeLabel2.Height;
  Preview.AutoSize := False;
  Preview.WordWrap := True;
  WizardForm.WelcomeLabel2.Visible := False;
  UpdatePreview;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpReady then begin
    UpdatePreview;
    if Modern then WizardForm.NextButton.Caption := 'Reinstall'
    else if Legacy then WizardForm.NextButton.Caption := 'Upgrade'
    else WizardForm.NextButton.Caption := 'Install';
  end;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  UpdatePreview;
  Result := Preview.Caption + NewLine + NewLine +
    'AgentOpsDeck will be gracefully stopped before files are replaced. User data and credentials are not modified.' + NewLine +
    'Unknown non-conflicting program files and legacy controls are preserved. Cancelling after stop does not restart the app.' + NewLine +
    'Existing desktop shortcuts are kept unchanged; the optional desktop icon is created only if absent.' + NewLine +
    'After replacement begins, cancelling does not guarantee restoration of the previous application version.' + NewLine +
    MemoTasksInfo;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := ''; FailureReason := '';
  try
    Preflight;
    WizardForm.StatusLabel.Caption := 'Checking AgentOpsDeck and stopping the application safely...';
#ifdef PortableUpgradeProfiles
    if ExpandConstant('{param:PREFLIGHTONLY|0}') = '1' then begin
      Log('LOCAL_INSTALLER_UPGRADE_PREFLIGHT_PASS');
      Result := 'Read-only preflight verified; installation intentionally not started';
      Exit;
    end;
#endif
    if Legacy or Modern then begin
      StopOwnedApplication;
      { A stopped launcher cannot certify another file remained unchanged. Recheck. }
      Preflight;
    end;
  except
    Result := 'Detected: ' + Detected + #13#10 + 'Target: 2.4.6; action: preserve / blocked' + #13#10 +
      'Package marker: ' + MarkerDiagnostic + #13#10 + 'Declared metadata: ' + MetadataDiagnostic + #13#10 + SafeFailure;
    Log(Result);
  end;
end;

#ifdef PortableUpgradeProfiles
procedure RemoveAuthenticatedSupersededFiles;
var I, P: Integer; Row, Rel, Name, Parent, TargetPaths: String; Incomplete: Boolean;
begin
  CheckPayload(True);
  Incomplete := False;
  TargetPaths := #1;
  for I := 0 to KnownFiles.Count - 1 do
    TargetPaths := TargetPaths + Lowercase(KnownPath(I)) + #1;
  for I := 0 to PriorFiles.Count - 1 do begin
    Row := PriorFiles.Strings[I]; P := Pos('|', Row);
    Rel := Copy(Row, 1, P - 1);
    if Pos(#1 + Lowercase(Rel) + #1, TargetPaths) > 0 then Continue;
    Name := Root + '\' + Rel;
    if not FileExists(Name) then Continue;
    CheckNode(Name);
    if GetSHA256OfFile(Name) <> Copy(Row, P + 1, 64) then begin
      Log('Changed superseded program file preserved');
      Incomplete := True; Continue;
    end;
    if not DeleteFile(Name) then begin
      Log('Could not remove authenticated superseded program file; preserved');
      Incomplete := True; Continue;
    end;
    Parent := ExtractFileDir(Name);
    while (CompareText(Parent, Root) <> 0) and (Length(Parent) > Length(Root)) do begin
      if not RemoveDir(Parent) then Break;
      Parent := ExtractFileDir(Parent);
    end;
  end;
  if Incomplete then
    MsgBox('AgentOpsDeck is installed, but some old program files were preserved. Review the installer log before reinstalling after uninstall. User data was not removed.',
      mbInformation, MB_OK);
end;
#endif

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssDone then begin
#ifdef PortableUpgradeProfiles
    RemoveAuthenticatedSupersededFiles;
#endif
    { Only after successful standard Inno installation. No pre-commit NSIS retirement. }
    if RegKeyExists(HKCU32, OldKey) then begin
      if Legacy and RegStringEquals(InnoKey, 'Inno Setup: App Path', Root) and LegacyRegistryExact then begin
        if not RegDeleteKeyIncludingSubkeys(HKCU32, OldKey) then
          MsgBox('AgentOpsDeck is installed, but the old NSIS registry entry could not be retired. Do not run the old uninstaller.', mbError, MB_OK);
        if RegKeyExists(HKCU32, OldKey) then Log('Legacy registration remains; no success claim for retirement')
        else Log('Exact legacy six-value registration retired; Inno owns the installed business files');
      end else Log('Changed/unknown legacy registration preserved');
    end;
  end;
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  { Inno owns CancelEnabled. It does NOT automatically back up replaced prior files. }
  Log('Cancellation requested; prior-version byte restoration is not guaranteed');
end;

function InitializeUninstall: Boolean;
begin
  Root := ExpandConstant('{app}');
  KnownFiles := TStringList.Create;
  KnownFiles.NameValueSeparator := '|';
  LoadKnownFiles;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then begin
    FailureReason := '';
    try
      CheckAncestors;
      CheckNode(Root);
      Nodes := 0; CheckTree(Root, '', 0);
      CheckPayload(True);
      StopOwnedApplication;
      CheckPayload(True);
    except
      RaiseException(SafeFailure);
    end;
  end;
end;
