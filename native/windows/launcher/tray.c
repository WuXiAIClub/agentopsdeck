#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <windowsx.h>
#include <shellapi.h>
#include <shlobj.h>
#include <sddl.h>
#include <wininet.h>
#include <stdio.h>
#include <stdint.h>
#include <wchar.h>
static wchar_t root[32768],node[32768];static HWND window;static NOTIFYICONDATAW tray;static LONG checking=0;static UINT taskbarCreated;static int state=12;static BOOL stopping=FALSE;
#define TRAY_MSG (WM_APP+1)
#define STATE_MSG (WM_APP+2)
#define OPEN_MSG (WM_APP+3)
#define SHUTDOWN_MSG (WM_APP+4)
#define CMD_OPEN 100
#define CMD_START 101
#define CMD_WORKSPACE 102
#define CMD_STOP 103
static void output(const char *s){DWORD n;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),s,(DWORD)strlen(s),&n,NULL);}
static void jsonString(const wchar_t *s,char *out,size_t cap){char utf[131072];int n=WideCharToMultiByte(CP_UTF8,0,s,-1,utf,sizeof(utf),NULL,NULL);size_t j=0;if(!n){out[0]=0;return;}for(int i=0;i<n-1&&j+7<cap;i++){unsigned char c=utf[i];if(c=='"'||c=='\\'){out[j++]='\\';out[j++]=c;}else if(c<32){j+=(size_t)sprintf(out+j,"\\u%04x",c);}else out[j++]=c;}out[j]=0;}
static int identify(DWORD pid){HANDLE p=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,pid);if(!p){output(GetLastError()==ERROR_INVALID_PARAMETER?"{\"state\":\"dead\"}\n":"{\"state\":\"ambiguous\"}\n");return 0;}
 if(WaitForSingleObject(p,0)==WAIT_OBJECT_0){CloseHandle(p);output("{\"state\":\"dead\"}\n");return 0;}
 FILETIME ct,et,kt,ut;wchar_t exe[32768];DWORD len=32768;HANDLE token=NULL;DWORD bytes=0;LPWSTR sid=NULL;BOOL ok=GetProcessTimes(p,&ct,&et,&kt,&ut)&&QueryFullProcessImageNameW(p,0,exe,&len)&&OpenProcessToken(p,TOKEN_QUERY,&token);void *user=NULL;
 if(ok){GetTokenInformation(token,TokenUser,NULL,0,&bytes);user=HeapAlloc(GetProcessHeap(),0,bytes);ok=user&&GetTokenInformation(token,TokenUser,user,bytes,&bytes)&&ConvertSidToStringSidW(((TOKEN_USER*)user)->User.Sid,&sid);}
 if(ok){char escaped[131072],owner[512],line[132000];jsonString(exe,escaped,sizeof(escaped));jsonString(sid,owner,sizeof(owner));unsigned long long created=((unsigned long long)ct.dwHighDateTime<<32)|ct.dwLowDateTime;snprintf(line,sizeof(line),"{\"state\":\"live\",\"pid\":%lu,\"created\":\"%llu\",\"exe\":\"%s\",\"owner\":\"%s\"}\n",(unsigned long)pid,created,escaped,owner);output(line);}else output("{\"state\":\"ambiguous\"}\n");if(sid)LocalFree(sid);if(user)HeapFree(GetProcessHeap(),0,user);if(token)CloseHandle(token);CloseHandle(p);return 0;}
static BOOL quote(wchar_t *out,size_t cap,const wchar_t *s){size_t j=0;out[j++]='"';while(*s){size_t bs=0;while(*s=='\\'){bs++;s++;}size_t count=(*s=='"'||!*s)?bs*2:bs;if(*s=='"')count++;if(j+count+3>=cap)return FALSE;while(count--)out[j++]='\\';if(*s)out[j++]=*s++;}out[j++]='"';out[j]=0;return TRUE;}
static int runNode(const wchar_t *module,const wchar_t *action,const wchar_t *value,BOOL wait){wchar_t script[32768],qn[65536],qs[65536],qv[65536],cmd[200000];swprintf(script,32768,L"%ls\\%ls",root,module);if(!quote(qn,65536,node)||!quote(qs,65536,script)||!quote(qv,65536,value?value:L""))return 12;swprintf(cmd,200000,L"%ls %ls %ls %ls",qn,qs,action?action:L"",value?qv:L"");STARTUPINFOW si={0};PROCESS_INFORMATION pi={0};si.cb=sizeof(si);si.dwFlags=STARTF_USESHOWWINDOW;si.wShowWindow=SW_HIDE;if(!CreateProcessW(node,cmd,NULL,NULL,FALSE,CREATE_NO_WINDOW,NULL,root,&si,&pi))return 12;CloseHandle(pi.hThread);if(!wait){CloseHandle(pi.hProcess);return 0;}DWORD result=12;if(WaitForSingleObject(pi.hProcess,22000)==WAIT_OBJECT_0)GetExitCodeProcess(pi.hProcess,&result);CloseHandle(pi.hProcess);return (int)result;}
static int closeOwnedShell(void){HWND h=FindWindowW(L"AgentOpsDeckDesktopTray",NULL);if(!h)return 0;DWORD pid=0;GetWindowThreadProcessId(h,&pid);HANDLE p=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,pid),other=NULL,self=NULL;if(!p)return 11;wchar_t exe[32768],own[32768];DWORD len=32768;BOOL ok=QueryFullProcessImageNameW(p,0,exe,&len)&&GetModuleFileNameW(NULL,own,32768)&&!_wcsicmp(exe,own)&&OpenProcessToken(p,TOKEN_QUERY,&other)&&OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&self);DWORD a=0,b=0;void *ua=NULL,*ub=NULL;if(ok){GetTokenInformation(other,TokenUser,NULL,0,&a);GetTokenInformation(self,TokenUser,NULL,0,&b);ua=HeapAlloc(GetProcessHeap(),0,a);ub=HeapAlloc(GetProcessHeap(),0,b);ok=ua&&ub&&GetTokenInformation(other,TokenUser,ua,a,&a)&&GetTokenInformation(self,TokenUser,ub,b,&b)&&EqualSid(((TOKEN_USER*)ua)->User.Sid,((TOKEN_USER*)ub)->User.Sid);}int result=11;if(ok&&PostMessageW(h,SHUTDOWN_MSG,0,0)&&WaitForSingleObject(p,20000)==WAIT_OBJECT_0)result=0;if(ua)HeapFree(GetProcessHeap(),0,ua);if(ub)HeapFree(GetProcessHeap(),0,ub);if(other)CloseHandle(other);if(self)CloseHandle(self);CloseHandle(p);return result;}

static int runCli(int argc,wchar_t **argv){
 wchar_t script[32768],quoted[65536],cmd[200000];size_t used=0;
 if(argc>5)return 12;
 swprintf(script,32768,L"%ls\\cli.cjs",root);
 const wchar_t *initial[]={node,script};
 for(int i=0;i<2;i++){if(!quote(quoted,65536,initial[i]))return 12;size_t n=wcslen(quoted);if(used+n+2>=200000)return 12;memcpy(cmd+used,quoted,n*sizeof(wchar_t));used+=n;cmd[used++]=' ';}
 for(int i=2;i<argc;i++){if(!quote(quoted,65536,argv[i]))return 12;size_t n=wcslen(quoted);if(used+n+2>=200000)return 12;memcpy(cmd+used,quoted,n*sizeof(wchar_t));used+=n;cmd[used++]=' ';}
 cmd[used]=0;
 AttachConsole(ATTACH_PARENT_PROCESS);
 STARTUPINFOW si={0};PROCESS_INFORMATION pi={0};si.cb=sizeof(si);si.dwFlags=STARTF_USESHOWWINDOW|STARTF_USESTDHANDLES;si.wShowWindow=SW_HIDE;
 si.hStdInput=GetStdHandle(STD_INPUT_HANDLE);si.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE);si.hStdError=GetStdHandle(STD_ERROR_HANDLE);
 HANDLE handles[]={si.hStdInput,si.hStdOutput,si.hStdError};for(int i=0;i<3;i++)if(handles[i]&&handles[i]!=INVALID_HANDLE_VALUE)SetHandleInformation(handles[i],HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT);
 if(!CreateProcessW(node,cmd,NULL,NULL,TRUE,CREATE_NO_WINDOW,NULL,root,&si,&pi))return 12;
 CloseHandle(pi.hThread);DWORD result=11;if(WaitForSingleObject(pi.hProcess,120000)==WAIT_OBJECT_0)GetExitCodeProcess(pi.hProcess,&result);CloseHandle(pi.hProcess);return (int)result;
}
#include "cli_uninstall.h"

static const wchar_t* label(void){switch(state){case 13:return (ui_is_zh()?L"AgentOpsDeck · 启动中（HTTP 未确认）":L"AgentOpsDeck · Starting (HTTP Unconfirmed)");case 0:return (ui_is_zh()?L"AgentOpsDeck · 已停止":L"AgentOpsDeck · Stopped");case 10:return (ui_is_zh()?L"AgentOpsDeck · 正在运行":L"AgentOpsDeck · Running");case 11:return (ui_is_zh()?L"AgentOpsDeck · 状态未确认":L"AgentOpsDeck · Status Unconfirmed");default:return (ui_is_zh()?L"AgentOpsDeck · 本机管理":L"AgentOpsDeck · Local Manager");}}
static void update(void){wcsncpy(tray.szTip,label(),127);Shell_NotifyIconW(NIM_MODIFY,&tray);}
#include "repair_native.h"
#include "management.h"
/* Called from the install helper within its assigned Job. The helper and this
   probe are the only two processes permitted when releasing the operation lease. */
static int waitInstallChildren(void){BOOL inJob=FALSE;if(!IsProcessInJob(GetCurrentProcess(),NULL,&inJob)||!inJob)return 12;ULONGLONG started=GetTickCount64();for(;;){JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info={0};if(!QueryInformationJobObject(NULL,JobObjectBasicAccountingInformation,&info,sizeof(info),NULL))return 12;if(info.ActiveProcesses<=2)return 0;if(GetTickCount64()-started>=110000)return 11;Sleep(50);}}
static int privateBackup(const wchar_t *target){
 wchar_t local[32768],data[32768],stateDir[32768],prefix[32768];DWORD count=GetEnvironmentVariableW(L"LOCALAPPDATA",local,32768);if(!count||count>=32600||local[1]!=L':'||local[2]!=L'\\')return 12;
 swprintf(data,32768,L"%ls\\AgentOpsDeck",local);swprintf(stateDir,32768,L"%ls\\state",data);swprintf(prefix,32768,L"%ls\\.env.backup-",stateDir);size_t n=wcslen(prefix);if(_wcsnicmp(target,prefix,n)||wcslen(target+n)!=36)return 12;for(size_t i=0;i<36;i++){wchar_t c=target[n+i];if(i==8||i==13||i==18||i==23){if(c!=L'-')return 12;}else if(!((c>=L'0'&&c<=L'9')||(c>=L'a'&&c<=L'f')))return 12;}
 DWORD attr=GetFileAttributesW(data);if(attr==INVALID_FILE_ATTRIBUTES||!(attr&FILE_ATTRIBUTE_DIRECTORY)||(attr&FILE_ATTRIBUTE_REPARSE_POINT))return 12;attr=GetFileAttributesW(stateDir);if(attr==INVALID_FILE_ATTRIBUTES||!(attr&FILE_ATTRIBUTE_DIRECTORY)||(attr&FILE_ATTRIBUTE_REPARSE_POINT))return 12;
 HANDLE token=NULL;DWORD bytes=0;LPWSTR sid=NULL;void *user=NULL;PSECURITY_DESCRIPTOR descriptor=NULL;BOOL ok=OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token);if(ok){GetTokenInformation(token,TokenUser,NULL,0,&bytes);user=HeapAlloc(GetProcessHeap(),0,bytes);ok=user&&GetTokenInformation(token,TokenUser,user,bytes,&bytes)&&ConvertSidToStringSidW(((TOKEN_USER*)user)->User.Sid,&sid);}
 if(ok){wchar_t acl[2048];swprintf(acl,2048,L"D:P(A;;FA;;;SY)(A;;FA;;;%ls)",sid);ok=ConvertStringSecurityDescriptorToSecurityDescriptorW(acl,SDDL_REVISION_1,&descriptor,NULL);}HANDLE file=INVALID_HANDLE_VALUE;if(ok){SECURITY_ATTRIBUTES sa={sizeof(sa),descriptor,FALSE};file=CreateFileW(target,GENERIC_WRITE,0,&sa,CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,NULL);ok=file!=INVALID_HANDLE_VALUE;}
 if(descriptor)LocalFree(descriptor);if(sid)LocalFree(sid);if(user)HeapFree(GetProcessHeap(),0,user);if(token)CloseHandle(token);
 if(!ok)return 12;char buffer[8192];DWORD got=0,written=0,total=0;for(;;){if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),buffer,sizeof(buffer),&got,NULL)){if(GetLastError()!=ERROR_BROKEN_PIPE)ok=FALSE;break;}if(!got)break;total+=got;if(total>1048576||!WriteFile(file,buffer,got,&written,NULL)||written!=got){ok=FALSE;break;}}if(ok)ok=FlushFileBuffers(file);CloseHandle(file);return ok?0:12;
}
static int provisionPrivate(void){
 wchar_t local[32768],data[32768],home[32768],workspace[32768];DWORD count=GetEnvironmentVariableW(L"LOCALAPPDATA",local,32768);if(!count||count>=32700||local[1]!=L':'||local[2]!=L'\\')return 12;
 swprintf(data,32768,L"%ls\\AgentOpsDeck",local);swprintf(home,32768,L"%ls\\claude-home",data);swprintf(workspace,32768,L"%ls\\claude-workspace",data);
 int create=SHCreateDirectoryExW(NULL,data,NULL);if(create!=ERROR_SUCCESS&&create!=ERROR_ALREADY_EXISTS&&create!=ERROR_FILE_EXISTS)return 12;DWORD attr=GetFileAttributesW(data);if(attr==INVALID_FILE_ATTRIBUTES||attr&FILE_ATTRIBUTE_REPARSE_POINT)return 12;
 /* Refuse existing HOME rather than silently changing its ownership / ACL. */
 if(GetFileAttributesW(home)!=INVALID_FILE_ATTRIBUTES)return 11;
 HANDLE token=NULL;DWORD bytes=0;LPWSTR sid=NULL;void *user=NULL;PSECURITY_DESCRIPTOR descriptor=NULL;BOOL ok=OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token);if(ok){GetTokenInformation(token,TokenUser,NULL,0,&bytes);user=HeapAlloc(GetProcessHeap(),0,bytes);ok=user&&GetTokenInformation(token,TokenUser,user,bytes,&bytes)&&ConvertSidToStringSidW(((TOKEN_USER*)user)->User.Sid,&sid);}
 if(ok){wchar_t acl[2048];swprintf(acl,2048,L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;%ls)",sid);ok=ConvertStringSecurityDescriptorToSecurityDescriptorW(acl,SDDL_REVISION_1,&descriptor,NULL);}
 if(ok){SECURITY_ATTRIBUTES sa={sizeof(sa),descriptor,FALSE};ok=CreateDirectoryW(home,&sa);}
 if(descriptor)LocalFree(descriptor);if(sid)LocalFree(sid);if(user)HeapFree(GetProcessHeap(),0,user);if(token)CloseHandle(token);
 if(!ok)return 12;if(!CreateDirectoryW(workspace,NULL)&&GetLastError()!=ERROR_ALREADY_EXISTS)return 12;attr=GetFileAttributesW(workspace);return attr!=INVALID_FILE_ATTRIBUTES&&(attr&FILE_ATTRIBUTE_DIRECTORY)&&!(attr&FILE_ATTRIBUTE_REPARSE_POINT)?0:12;
}
static LRESULT CALLBACK proc(HWND h,UINT m,WPARAM w,LPARAM l){if(taskbarCreated&&m==taskbarCreated){Shell_NotifyIconW(NIM_ADD,&tray);return 0;}switch(m){case WM_TIMER:if(!checking&&!exiting)begin(L"status",NULL);return 0;
 case TRAY_MSG:if(l==WM_LBUTTONDBLCLK){showManager();return 0;}if(l==WM_RBUTTONUP||l==WM_CONTEXTMENU){POINT p;GetCursorPos(&p);HMENU menu=CreatePopupMenu();AppendMenuW(menu,MF_STRING|((checking||!(ui.http_hub||ui.http_connector))?MF_GRAYED:0),ID_SITE,(ui_is_zh()?L"打开 AgentOpsDeck（业务网站）":L"Open AgentOpsDeck (Workbench Web)"));AppendMenuW(menu,MF_STRING,CMD_OPEN,(ui_is_zh()?L"打开本机管理窗口":L"Open Local Manager"));AppendMenuW(menu,MF_STRING|((checking||ui.pending)?MF_GRAYED:0),ID_START,(ui_is_zh()?L"启动服务":L"Start Service"));AppendMenuW(menu,MF_STRING|((checking||ui.pending)?MF_GRAYED:0),ID_RESTART,(ui_is_zh()?L"重启整个本机服务":L"Restart Local Service"));AppendMenuW(menu,MF_STRING|(checking?MF_GRAYED:0),ID_STOP,(ui_is_zh()?L"停止本机服务":L"Stop Local Service"));AppendMenuW(menu,MF_STRING,ID_EXIT,(ui_is_zh()?L"退出并停止…":L"Exit & Stop..."));SetForegroundWindow(h);int id=TrackPopupMenu(menu,TPM_RETURNCMD|TPM_RIGHTBUTTON,p.x,p.y,0,h,NULL);DestroyMenu(menu);PostMessageW(h,WM_NULL,0,0);if(id==CMD_OPEN)showManager();else if(id==ID_EXIT)exitRequest(FALSE);else command(id);}return 0;
 case WM_DESTROY:KillTimer(h,1);Shell_NotifyIconW(NIM_DELETE,&tray);freeFonts();if(cancelEvent)CloseHandle(cancelEvent);PostQuitMessage(0);return 0;}return managementMessage(h,m,w,l);}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE previous,LPWSTR commandLine,int show){(void)previous;(void)commandLine;(void)show;GetModuleFileNameW(NULL,root,32768);wchar_t *last=wcsrchr(root,'\\');if(!last)return 12;*last=0;swprintf(node,32768,L"%ls\\runtime\\node.exe",root);int argc;wchar_t **argv=CommandLineToArgvW(GetCommandLineW(),&argc);
 if(argc>1&&!wcscmp(argv[1],L"--cli")){int result=runCli(argc,argv);LocalFree(argv);return result;}
 if(argc>1&&!wcscmp(argv[1],L"--uninstall-supervisor")){int result=cliUninstallSupervisor(argc,argv);LocalFree(argv);return result;}
 if(argc==2&&!wcscmp(argv[1],L"--repair-held")){LocalFree(argv);return repairHeld();}
 if(argc>2&&!wcscmp(argv[1],L"--identity")){wchar_t *end;unsigned long pid=wcstoul(argv[2],&end,10);int result=(!*end&&pid)?identify((DWORD)pid):12;LocalFree(argv);return result;}
 if(argc==3&&!wcscmp(argv[1],L"--private-backup")){int result=privateBackup(argv[2]);LocalFree(argv);return result;}
 if(argc>1&&!wcscmp(argv[1],L"--wait-install-children")){LocalFree(argv);return waitInstallChildren();}
 if(argc>1&&!wcscmp(argv[1],L"--provision-private")){LocalFree(argv);return provisionPrivate();}
 if(argc>1&&!wcscmp(argv[1],L"--open")){HWND prior=FindWindowW(L"AgentOpsDeckDesktopTray",NULL);if(prior){PostMessageW(prior,OPEN_MSG,0,0);LocalFree(argv);return 0;}}
 if(argc>1&&(!wcscmp(argv[1],L"--status")||!wcscmp(argv[1],L"--stop"))){BOOL stop=!wcscmp(argv[1],L"--stop");LocalFree(argv);if(stop){int closed=closeOwnedShell();if(closed!=0)return closed;}return runNode(L"lifecycle.cjs",stop?L"stop":L"status",NULL,TRUE);}LocalFree(argv);
 SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);CoInitializeEx(NULL,COINIT_APARTMENTTHREADED);wchar_t mutexName[512]=L"Local\\AgentOpsDeck-Desktop-";HANDLE token;DWORD bytes=0;LPWSTR sid=NULL;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))return 12;GetTokenInformation(token,TokenUser,NULL,0,&bytes);void *user=HeapAlloc(GetProcessHeap(),0,bytes);if(!user||!GetTokenInformation(token,TokenUser,user,bytes,&bytes)||!ConvertSidToStringSidW(((TOKEN_USER*)user)->User.Sid,&sid))return 12;wcsncat(mutexName,sid,400);LocalFree(sid);HeapFree(GetProcessHeap(),0,user);CloseHandle(token);HANDLE mutex=CreateMutexW(NULL,FALSE,mutexName);if(!mutex)return 12;if(GetLastError()==ERROR_ALREADY_EXISTS){HWND prior=FindWindowW(L"AgentOpsDeckDesktopTray",NULL);if(prior)PostMessageW(prior,OPEN_MSG,0,0);CloseHandle(mutex);CoUninitialize();return 0;}

 taskbarCreated=RegisterWindowMessageW(L"TaskbarCreated");WNDCLASSW wc={0};wc.lpfnWndProc=proc;wc.hInstance=instance;wc.lpszClassName=L"AgentOpsDeckDesktopTray";wc.hCursor=LoadCursorW(NULL,IDC_ARROW);wc.hbrBackground=(HBRUSH)(COLOR_WINDOW+1);wc.hIcon=LoadIconW(instance,MAKEINTRESOURCEW(1));RegisterClassW(&wc);
 window=CreateWindowExW(0,wc.lpszClassName,(ui_is_zh()?L"AgentOpsDeck · 本机管理":L"AgentOpsDeck · Local Manager"),WS_OVERLAPPEDWINDOW,CW_USEDEFAULT,CW_USEDEFAULT,1100,800,NULL,NULL,instance,NULL);if(!window){CloseHandle(mutex);return 12;}createControls();
 tray.cbSize=sizeof(tray);tray.hWnd=window;tray.uID=1;tray.uFlags=NIF_ICON|NIF_MESSAGE|NIF_TIP;tray.uCallbackMessage=TRAY_MSG;tray.hIcon=wc.hIcon?wc.hIcon:LoadIconW(NULL,IDI_APPLICATION);wcscpy(tray.szTip,(ui_is_zh()?L"AgentOpsDeck · 本机管理":L"AgentOpsDeck · Local Manager"));Shell_NotifyIconW(NIM_ADD,&tray);
 ShowWindow(window,SW_SHOW);UpdateWindow(window);begin(L"load",NULL);SetTimer(window,1,5000,NULL);MSG msg;while(GetMessageW(&msg,NULL,0,0)>0){if(!IsDialogMessageW(window,&msg)){TranslateMessage(&msg);DispatchMessageW(&msg);}}CloseHandle(mutex);CoUninitialize();return 0;
}
