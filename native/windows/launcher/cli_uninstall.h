/* A relocated GUI-subsystem supervisor can outlive the launcher without
   holding any installed executable open or depending on a console host. */
static BOOL cliSameUser(HANDLE process){
 HANDLE a=NULL,b=NULL;DWORD na=0,nb=0;void *ua=NULL,*ub=NULL;BOOL ok=OpenProcessToken(process,TOKEN_QUERY,&a)&&OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&b);
 if(ok){GetTokenInformation(a,TokenUser,NULL,0,&na);GetTokenInformation(b,TokenUser,NULL,0,&nb);ua=HeapAlloc(GetProcessHeap(),0,na);ub=HeapAlloc(GetProcessHeap(),0,nb);ok=ua&&ub&&GetTokenInformation(a,TokenUser,ua,na,&na)&&GetTokenInformation(b,TokenUser,ub,nb,&nb)&&EqualSid(((TOKEN_USER*)ua)->User.Sid,((TOKEN_USER*)ub)->User.Sid);}
 if(ua)HeapFree(GetProcessHeap(),0,ua);if(ub)HeapFree(GetProcessHeap(),0,ub);if(a)CloseHandle(a);if(b)CloseHandle(b);return ok;
}
static BOOL cliReceipt(const wchar_t *receipt,const char *text){
 wchar_t temp[32768];swprintf(temp,32768,L"%ls.write",receipt);HANDLE f=CreateFileW(temp,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,NULL);if(f==INVALID_HANDLE_VALUE)return FALSE;
 DWORD length=(DWORD)strlen(text),written=0;BOOL ok=WriteFile(f,text,length,&written,NULL)&&written==length&&FlushFileBuffers(f);CloseHandle(f);if(!ok)return FALSE;return MoveFileExW(temp,receipt,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH);
}
static int cliUninstallSupervisor(int argc,wchar_t **argv){
 if(argc!=5)return 12;const wchar_t *id=argv[2];if(wcslen(id)!=36)return 12;
 for(size_t i=0;i<36;i++){wchar_t c=id[i];if(i==8||i==13||i==18||i==23){if(c!='-')return 12;}else if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return 12;}
 wchar_t local[32768],app[32768],logs[32768],expected[32768],self[32768],receipt[32768],uninstaller[32768],log[32768];
 DWORD n=GetEnvironmentVariableW(L"LOCALAPPDATA",local,32768);if(!n||n>30000)return 12;
 swprintf(app,32768,L"%ls\\Programs\\AgentOpsDeck",local);swprintf(logs,32768,L"%ls\\AgentOpsDeck\\logs",local);
 swprintf(expected,32768,L"%ls\\uninstall-%ls-supervisor.exe",logs,id);if(!GetModuleFileNameW(NULL,self,32768)||_wcsicmp(expected,self))return 12;
 DWORD attr=GetFileAttributesW(logs);if(attr==INVALID_FILE_ATTRIBUTES||!(attr&FILE_ATTRIBUTE_DIRECTORY)||(attr&FILE_ATTRIBUTE_REPARSE_POINT))return 12;
 swprintf(receipt,32768,L"%ls\\uninstall-%ls.json",logs,id);swprintf(uninstaller,32768,L"%ls\\unins000.exe",app);swprintf(log,32768,L"%ls\\uninstall-%ls.log",logs,id);
 HANDLE parents[2]={NULL,NULL};BOOL ok=TRUE;
 for(int i=0;i<2;i++){wchar_t *end=NULL;unsigned long pid=wcstoul(argv[3+i],&end,10);if(!pid||*end){ok=FALSE;break;}parents[i]=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,(DWORD)pid);if(!parents[i]||!cliSameUser(parents[i])){ok=FALSE;break;}wchar_t actual[32768],wanted[32768];DWORD size=32768;swprintf(wanted,32768,i==0?L"%ls\\runtime\\node.exe":L"%ls\\AgentOpsDeck.exe",app);if(!QueryFullProcessImageNameW(parents[i],0,actual,&size)||_wcsicmp(actual,wanted)){ok=FALSE;break;}}
 if(!ok){for(int i=0;i<2;i++)if(parents[i])CloseHandle(parents[i]);return 12;}
 ok=cliReceipt(receipt,"{\"state\":\"scheduled\",\"completed\":false}");
 if(ok)for(int i=0;i<2;i++)if(WaitForSingleObject(parents[i],60000)!=WAIT_OBJECT_0)ok=FALSE;
 for(int i=0;i<2;i++)CloseHandle(parents[i]);
 DWORD exitCode=12;
 if(ok){wchar_t qexe[65536],qlog[65536],logarg[32768],cmd[200000];swprintf(logarg,32768,L"/LOG=%ls",log);if(quote(qexe,65536,uninstaller)&&quote(qlog,65536,logarg)){swprintf(cmd,200000,L"%ls /VERYSILENT /SUPPRESSMSGBOXES /NORESTART %ls",qexe,qlog);STARTUPINFOW si={0};PROCESS_INFORMATION pi={0};si.cb=sizeof(si);si.dwFlags=STARTF_USESHOWWINDOW;si.wShowWindow=SW_HIDE;if(CreateProcessW(uninstaller,cmd,NULL,NULL,FALSE,CREATE_NO_WINDOW,NULL,local,&si,&pi)){CloseHandle(pi.hThread);if(WaitForSingleObject(pi.hProcess,600000)==WAIT_OBJECT_0)GetExitCodeProcess(pi.hProcess,&exitCode);CloseHandle(pi.hProcess);}}}
 char result[256];snprintf(result,sizeof(result),"{\"state\":\"%s\",\"completed\":%s,\"exitCode\":%lu,\"userDataPreserved\":true}",exitCode==0?"completed":"failed",exitCode==0?"true":"false",(unsigned long)exitCode);
 if(!cliReceipt(receipt,result))return 12;return exitCode==0?0:12;
}
