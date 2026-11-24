// Read-only payload extraction; never stops or modifies the installed app.
function InitializeSetup: Boolean;
var I, Code, Extracted: Integer; Base, Name, Script, Params: String;
begin
  Result := True;
  if ExpandConstant('{param:VERIFYONLY|0}') <> '1' then Exit;
  KnownFiles := TStringList.Create;
  try
    KnownFiles.NameValueSeparator := '|';
    LoadKnownFiles;
    Extracted := ExtractTemporaryFiles('{app}\*');
    if Extracted <> KnownFiles.Count then RaiseException('Extracted file count differs from compiled inventory');
    Base := ExpandConstant('{tmp}') + '\{app}';
    for I := 0 to KnownFiles.Count - 1 do begin
      Name := Base + '\' + KnownPath(I);
      if not FileExists(Name) then RaiseException('Extracted application file missing');
      if GetSHA256OfFile(Name) <> KnownHash(I) then RaiseException('Extracted application hash differs');
    end;
    Script := 'const{pathToFileURL}=await import(''node:url'');const m=await import(pathToFileURL(process.argv[1]).href);if(typeof m.createApplication!==''function'')process.exit(5);';
    Params := '--input-type=module -e "' + Script + '" "' + Base + '\apps\server\dist\application.js"';
    if not Exec(Base + '\runtime\node.exe', Params, Base, SW_HIDE, ewWaitUntilTerminated, Code) then
      RaiseException('Bundled Node import did not start');
    if Code <> 0 then RaiseException('Bundled application import failed');
    Log('LOCAL_INSTALLER_PAYLOAD_PASS files=' + IntToStr(Extracted));
    Log('LOCAL_INSTALLER_BUNDLED_NODE_IMPORT_PASS');
  finally
    KnownFiles.Free;
  end;
  Result := False;
end;
