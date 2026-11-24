/* Included in the NORMAL launcher, not a second recovery product.
 * Private stdin/stdout protocol is reachable only by explicit --repair-held.
 * No environment/time/PID overrides. Parent retains original operation lease.
 */
#include <stddef.h>
#include <winternl.h>
#include <wincrypt.h>
#include <aclapi.h>
#include <shlobj.h>
/* Roles: 1 strict private object, 0 ordinary protected ancestry, 2 only a
 * volume root or an existing ancestor STRICTLY ABOVE the OS Profile boundary.
 * Handles pin all existing components without share-delete. Create-only sibling
 * rights at role 2 cannot replace those pinned components; lower DB/config
 * ancestry remains role 0 so foreign journal/sidecar creation is refused. */
static int r_structural_match(const wchar_t *path,const wchar_t *profile){
 size_t n=wcslen(path);if(n==3&&((path[0]>=L'A'&&path[0]<=L'Z')||(path[0]>=L'a'&&path[0]<=L'z'))&&path[1]==L':'&&path[2]==L'\\')return 1;
 return profile&&n>3&&n<wcslen(profile)&&profile[n]==L'\\'&&!_wcsnicmp(path,profile,n);
}
static int r_structural(const wchar_t *path){PWSTR profile=NULL;int role=0;
 if(SUCCEEDED(SHGetKnownFolderPath(&FOLDERID_Profile,KF_FLAG_DONT_VERIFY,NULL,&profile)))role=r_structural_match(path,profile);
 else role=r_structural_match(path,NULL);if(profile)CoTaskMemFree(profile);return role;
}
#include "repair_policy.h"
#ifndef FILE_OPEN
#define FILE_OPEN 1
#define FILE_DIRECTORY_FILE 0x00000001
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020
#define FILE_NON_DIRECTORY_FILE 0x00000040
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif
#define R_MAX 8192
static HANDLE r_pins[512];static unsigned r_np;
static unsigned char r_user[1024],r_system[SECURITY_MAX_SID_SIZE],r_admin[SECURITY_MAX_SID_SIZE];
static PSID r_sid;static char r_line[8194];
typedef NTSTATUS (NTAPI *R_CREATE)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,PLARGE_INTEGER,ULONG,ULONG,ULONG,ULONG,PVOID,ULONG);
typedef NTSTATUS (NTAPI *R_QUERY)(ULONG,PVOID,ULONG,PULONG);
static R_CREATE r_create;static R_QUERY r_query;
static uint64_t r_ft(FILETIME t){return ((uint64_t)t.dwHighDateTime<<32)|t.dwLowDateTime;}
/* NtQuerySystemInformation class 3 returns the kernel BootTime directly (UTC
 * 100ns since 1601), NOT now-minus-uptime. This fixed native query has no COM,
 * remote provider, wildcard timezone conversion or unbounded enumeration.
 * SYSTEM_TIMEOFDAY_INFORMATION ABI is used by ntdll/WDK and Wine. A short,
 * unknown or inconsistent response refuses. Windows ABI testing still needed. */
static uint64_t r_boot(void){struct {LARGE_INTEGER boot,now,zone;ULONG zoneId,reserved;ULONGLONG bootBias,sleepBias;} t={0};ULONG len=0;
 if(!r_query||r_query(3,&t,sizeof(t),&len)<0||len!=sizeof(t)||t.boot.QuadPart<=0||t.now.QuadPart<t.boot.QuadPart)return 0;return (uint64_t)t.boot.QuadPart;}
/* TrustedInstaller is an OS servicing principal, not a private-home owner.
 * Exact well-known service SID; no general service-SID or user-group allowance. */
static int r_servicing(PSID sid){static const struct {BYTE revision,count;SID_IDENTIFIER_AUTHORITY authority;DWORD sub[6];} ti={1,6,{{0,0,0,0,0,5}},{80,956008885,3418522649,1831038044,1853292631,2271478464}};return EqualSid(sid,(PSID)&ti);}
static int r_acl_policy(PSECURITY_DESCRIPTOR sd,int privateObject){PSID owner=NULL;PACL acl=NULL;BOOL ownerDefault=FALSE,present=FALSE,defaulted=FALSE;int ok=0;
 if(!sd||!GetSecurityDescriptorOwner(sd,&owner,&ownerDefault)||!GetSecurityDescriptorDacl(sd,&present,&acl,&defaulted)||!present||!owner||!acl)goto end;
 if(privateObject==1?!EqualSid(owner,r_sid):!(EqualSid(owner,r_sid)||EqualSid(owner,r_system)||EqualSid(owner,r_admin)||(privateObject==2&&r_servicing(owner))))goto end;
 for(DWORD j=0;j<acl->AceCount;j++){void *p=NULL;if(!GetAce(acl,j,&p))goto end;ACE_HEADER *a=(ACE_HEADER*)p;
  if(a->AceType!=ACCESS_ALLOWED_ACE_TYPE&&a->AceType!=ACCESS_DENIED_ACE_TYPE)goto end;
  if(a->AceFlags&INHERIT_ONLY_ACE)continue;
  if(a->AceType==ACCESS_ALLOWED_ACE_TYPE){ACCESS_ALLOWED_ACE *allow=(ACCESS_ALLOWED_ACE*)p;PSID s=&allow->SidStart;
   if(!IsValidSid(s))goto end;
   if(!(EqualSid(s,r_sid)||EqualSid(s,r_system)||EqualSid(s,r_admin)||(privateObject==2&&r_servicing(s)))){
    DWORD forbidden=GENERIC_ALL|GENERIC_WRITE|WRITE_DAC|WRITE_OWNER|DELETE|FILE_DELETE_CHILD|FILE_WRITE_ATTRIBUTES|FILE_WRITE_EA;
    if(privateObject!=2)forbidden|=FILE_WRITE_DATA|FILE_APPEND_DATA;
    if(privateObject==1||(allow->Mask&forbidden))goto end;
   }
  }
 }
 ok=1;
end:return ok;}
static int r_acl(HANDLE h,int privateObject){PSECURITY_DESCRIPTOR sd=NULL;PSID owner=NULL;PACL acl=NULL;
 DWORD status=GetSecurityInfo(h,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,NULL,&acl,NULL,&sd);int ok=status==ERROR_SUCCESS&&r_acl_policy(sd,privateObject);if(sd)LocalFree(sd);return ok;}
static int r_info(HANDLE h,BY_HANDLE_FILE_INFORMATION *i,int dir,int privacy){
 wchar_t fsname[32];if(GetFileType(h)!=FILE_TYPE_DISK||!GetFileInformationByHandle(h,i)||
 (i->dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||!!(i->dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)!=dir||(!dir&&i->nNumberOfLinks!=1)||
 !GetVolumeInformationByHandleW(h,NULL,0,NULL,NULL,NULL,fsname,32)||wcscmp(fsname,L"NTFS")||!r_acl(h,privacy))return 0;
 return 1;}
static int r_same(const BY_HANDLE_FILE_INFORMATION *a,const BY_HANDLE_FILE_INFORMATION *b){return a->dwVolumeSerialNumber==b->dwVolumeSerialNumber&&a->nFileIndexHigh==b->nFileIndexHigh&&a->nFileIndexLow==b->nFileIndexLow&&a->nFileSizeHigh==b->nFileSizeHigh&&a->nFileSizeLow==b->nFileSizeLow&&r_ft(a->ftCreationTime)==r_ft(b->ftCreationTime)&&r_ft(a->ftLastWriteTime)==r_ft(b->ftLastWriteTime);}
static HANDLE r_relative(HANDLE dir,const wchar_t *leaf,ACCESS_MASK access,ULONG share,int directory,NTSTATUS *status){
 UNICODE_STRING name;name.Buffer=(PWSTR)leaf;name.Length=(USHORT)(wcslen(leaf)*sizeof(wchar_t));name.MaximumLength=name.Length;
 OBJECT_ATTRIBUTES oa;InitializeObjectAttributes(&oa,&name,OBJ_CASE_INSENSITIVE,dir,NULL);IO_STATUS_BLOCK io;HANDLE h=NULL;
 *status=r_create(&h,access|SYNCHRONIZE,&oa,&io,NULL,0,share,FILE_OPEN,FILE_OPEN_REPARSE_POINT|FILE_SYNCHRONOUS_IO_NONALERT|(directory?FILE_DIRECTORY_FILE:FILE_NON_DIRECTORY_FILE),NULL,0);return *status<0?INVALID_HANDLE_VALUE:h;
}
static int r_pin(HANDLE h){if(h==INVALID_HANDLE_VALUE||r_np>=512)return 0;r_pins[r_np++]=h;return 1;}
static int r_path(const wchar_t *s){size_t n=wcslen(s);if(n<4||n>2048||!((s[0]>=L'A'&&s[0]<=L'Z')||(s[0]>=L'a'&&s[0]<=L'z'))||s[1]!=L':'||s[2]!=L'\\')return 0;
 const wchar_t *part=s+3;for(const wchar_t *p=part;;p++){if(*p&&(*p<32||wcschr(L"/:\"<>|?*",*p)))return 0;if(*p==L'\\'||!*p){if(p==part||p[-1]==L'.'||p[-1]==L' ')return 0;if((p-part==1&&part[0]==L'.')||(p-part==2&&part[0]==L'.'&&part[1]==L'.'))return 0;part=p+1;}if(!*p)break;}return 1;}
/* Every ancestor remains held without FILE_SHARE_DELETE. Relative existing-only
 * opens mean replacement of an already audited namespace is never traversed. */
static HANDLE r_parent(const wchar_t *s,wchar_t *leaf){if(!r_path(s))return INVALID_HANDLE_VALUE;wchar_t drive[4]={s[0],L':',L'\\',0};if(GetDriveTypeW(drive)!=DRIVE_FIXED)return INVALID_HANDLE_VALUE;
 HANDLE h=CreateFileW(drive,FILE_LIST_DIRECTORY|FILE_TRAVERSE|FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,NULL);BY_HANDLE_FILE_INFORMATION info;
 if(!r_pin(h)||!r_info(h,&info,1,2))return INVALID_HANDLE_VALUE;
 const wchar_t *p=s+3;for(;;){const wchar_t *slash=wcschr(p,L'\\');if(!slash){wcscpy(leaf,p);return h;}wchar_t component[2049];size_t n=(size_t)(slash-p);wmemcpy(component,p,n);component[n]=0;NTSTATUS status;
 h=r_relative(h,component,FILE_LIST_DIRECTORY|FILE_TRAVERSE|FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,1,&status);
 wchar_t prefix[2049];size_t prefixLength=(size_t)(slash-s);wmemcpy(prefix,s,prefixLength);prefix[prefixLength]=0;
 if(!r_pin(h)||!r_info(h,&info,1,r_structural(prefix)?2:0))return INVALID_HANDLE_VALUE;p=slash+1;}
}
static int r_final(HANDLE h,const wchar_t *expected){wchar_t actual[4096],want[4096];swprintf(want,4096,L"\\\\?\\%ls",expected);DWORD n=GetFinalPathNameByHandleW(h,actual,4096,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);return n&&n<4096&&!_wcsicmp(actual,want);}
static int r_read(HANDLE h,unsigned char *out,DWORD cap,DWORD *size){LARGE_INTEGER zero;zero.QuadPart=0;DWORD got;if(!SetFilePointerEx(h,zero,NULL,FILE_BEGIN)||!ReadFile(h,out,cap,&got,NULL)||!got||got==cap)return 0;*size=got;return 1;}
static int r_getline(char *out,size_t cap,ULONGLONG deadline){size_t n=0;HANDLE input=GetStdHandle(STD_INPUT_HANDLE);while(GetTickCount64()<deadline){DWORD available=0,got=0;if(!PeekNamedPipe(input,NULL,0,NULL,&available,NULL))return 0;if(!available){Sleep(5);continue;}char c;if(!ReadFile(input,&c,1,&got,NULL)||!got)return 0;if(c=='\n'){out[n]=0;return 1;}if(c=='\r'||!c||n+1>=cap)return 0;out[n++]=c;}return 0;}
static int r_wline(wchar_t *out,ULONGLONG deadline){return r_getline(r_line,8193,deadline)&&MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,r_line,-1,out,2049)>0;}
static int r_missing(HANDLE parent,const wchar_t *leaf){NTSTATUS status;HANDLE h=r_relative(parent,leaf,FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,0,&status);if(h!=INVALID_HANDLE_VALUE)CloseHandle(h);return (ULONG)status==0xc0000034;}
static int r_foreign(HANDLE home){return r_missing(home,L".agentopsdeck-copilot-owner")&&r_missing(home,L".agentopsdeck-copilot-binding");}
static void r_hex(const unsigned char *b,DWORD n){static const char digits[]="0123456789abcdef";char *s=HeapAlloc(GetProcessHeap(),0,n*2+1);if(!s)return;for(DWORD j=0;j<n;j++){s[j*2]=digits[b[j]>>4];s[j*2+1]=digits[b[j]&15];}s[n*2]=0;output(s);SecureZeroMemory(s,n*2);HeapFree(GetProcessHeap(),0,s);}
/* Stable private refusal vocabulary; no path, body, SID or system error. */
enum R_STAGE {R_NATIVE=1,R_TOKEN=2,R_INPUT=3,R_HOME_PARENT=4,R_HOME=5,R_DB_NAMESPACE=6,R_DB=7,R_CONFIG=8,R_DIGEST=9,R_MARKERS=10,R_COMMIT=11,R_BRIDGE=12,R_CONSENT=13,R_RECHECK=14,R_RENAME=15,R_POST_RENAME=16};
static void r_refused(enum R_STAGE stage){char line[32];if(stage<R_NATIVE||stage>R_POST_RENAME)stage=R_NATIVE;snprintf(line,sizeof(line),"REFUSED\t%u\n",(unsigned)stage);output(line);}
/* Shared by the production transaction and real primitive harness. */
static int r_rename(HANDLE marker,HANDLE home,const wchar_t *backup){
 _Static_assert(offsetof(FILE_RENAME_INFO,RootDirectory)==8,"x64 rename root ABI");
 _Static_assert(offsetof(FILE_RENAME_INFO,FileNameLength)==16,"x64 rename length ABI");
 _Static_assert(offsetof(FILE_RENAME_INFO,FileName)==20&&sizeof(FILE_RENAME_INFO)==24,"x64 rename name ABI");
 size_t nameBytes=wcslen(backup)*sizeof(wchar_t),renameSize=sizeof(FILE_RENAME_INFO)+nameBytes;
 FILE_RENAME_INFO *rename=HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,renameSize);if(!rename)return 0;rename->ReplaceIfExists=FALSE;rename->RootDirectory=home;rename->FileNameLength=(DWORD)nameBytes;memcpy(rename->FileName,backup,nameBytes);
 /* WDK FILE_RENAME_INFORMATION ABI matches FILE_RENAME_INFO (x64 offsets
  * RootDirectory=8, FileNameLength=16, FileName=20). Class 10, not Ex:
  * exactly one synchronous, handle-relative, no-replace kernel request.
  * No Win32 path normalization, absolute fallback, copy, delete or retry. */
 typedef NTSTATUS (NTAPI *R_SET)(HANDLE,PIO_STATUS_BLOCK,PVOID,ULONG,FILE_INFORMATION_CLASS);
 R_SET set=(R_SET)(void*)GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtSetInformationFile");
 IO_STATUS_BLOCK io={0};NTSTATUS status=set?set(marker,&io,rename,(ULONG)renameSize,(FILE_INFORMATION_CLASS)10):(NTSTATUS)0xc0000002;
 HeapFree(GetProcessHeap(),0,rename);return status==0;
}
static int repairHeld(void){
 enum R_STAGE stage=R_NATIVE;int result=12;HANDLE token=NULL,marker=INVALID_HANDLE_VALUE,binding=INVALID_HANDLE_VALUE,dbPin=INVALID_HANDLE_VALUE,bridge=INVALID_HANDLE_VALUE,config=INVALID_HANDLE_VALUE;
 unsigned char markerBytes[R_MAX+1],bindingBytes[R_MAX+1],again[R_MAX+1];DWORD markerSize=0,bindingSize=0,againSize=0;
 wchar_t homePath[2049],dbPath[2049],cfgPath[2049],leaf[2049],dbLeaf[2049];BY_HANDLE_FILE_INFORMATION mi,bi,di,check;HANDLE home=INVALID_HANDLE_VALUE,dbParent=INVALID_HANDLE_VALUE;NTSTATUS status;uint64_t boot=0;
 ULONGLONG deadline=GetTickCount64()+22000;r_np=0;
 HMODULE nt=GetModuleHandleW(L"ntdll.dll");r_create=(R_CREATE)(void*)GetProcAddress(nt,"NtCreateFile");r_query=(R_QUERY)(void*)GetProcAddress(nt,"NtQuerySystemInformation");if(!r_create||!r_query)goto end;
 stage=R_TOKEN;DWORD size=sizeof(r_user),sidSize=sizeof(r_system);TOKEN_ELEVATION elevation;DWORD returned;
 if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token)||!GetTokenInformation(token,TokenUser,r_user,size,&returned)||!GetTokenInformation(token,TokenElevation,&elevation,sizeof(elevation),&returned)||elevation.TokenIsElevated)goto end;
 r_sid=((TOKEN_USER*)r_user)->User.Sid;if(!CreateWellKnownSid(WinLocalSystemSid,NULL,r_system,&sidSize))goto end;sidSize=sizeof(r_admin);if(!CreateWellKnownSid(WinBuiltinAdministratorsSid,NULL,r_admin,&sidSize))goto end;
 stage=R_INPUT;if(!r_wline(homePath,deadline)||!r_wline(dbPath,deadline)||!r_wline(cfgPath,deadline))goto end;
 stage=R_HOME_PARENT;HANDLE hp=r_parent(homePath,leaf);if(hp==INVALID_HANDLE_VALUE)goto end;
 stage=R_HOME;home=r_relative(hp,leaf,FILE_LIST_DIRECTORY|FILE_TRAVERSE|FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,1,&status);if(!r_pin(home)||!r_info(home,&check,1,1)||!r_final(home,homePath))goto end;
 /* DB must not lie under HOME (nor HOME under the DB namespace). */
 stage=R_DB_NAMESPACE;size_t hn=wcslen(homePath);if(!_wcsnicmp(dbPath,homePath,hn)&&(dbPath[hn]==L'\\'||!dbPath[hn]))goto end;
 stage=R_DB;dbParent=r_parent(dbPath,dbLeaf);if(dbParent==INVALID_HANDLE_VALUE||!r_acl(dbParent,0))goto end;
 dbPin=r_relative(dbParent,dbLeaf,FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,0,&status);if(dbPin==INVALID_HANDLE_VALUE||!r_info(dbPin,&di,0,1)||!r_final(dbPin,dbPath))goto end;
 stage=R_CONFIG;HANDLE cp=r_parent(cfgPath,leaf);if(cp==INVALID_HANDLE_VALUE||!r_acl(cp,0))goto end;
 config=r_relative(cp,leaf,GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,0,&status);if(config==INVALID_HANDLE_VALUE||!r_info(config,&check,0,1)||!r_final(config,cfgPath)||check.nFileSizeHigh||check.nFileSizeLow>1048576)goto end;
 stage=R_DIGEST;if(!r_getline(r_line,65,deadline)||strlen(r_line)!=64)goto end;
 HCRYPTPROV provider=0;HCRYPTHASH hash=0;unsigned char chunk[4096],digest[32];DWORD hashLength=32;BOOL hashOk=CryptAcquireContextW(&provider,NULL,NULL,PROV_RSA_AES,CRYPT_VERIFYCONTEXT)&&CryptCreateHash(provider,CALG_SHA_256,0,0,&hash);
 DWORD remaining=check.nFileSizeLow;while(hashOk&&remaining){DWORD got=0,take=remaining>sizeof(chunk)?sizeof(chunk):remaining;hashOk=ReadFile(config,chunk,take,&got,NULL)&&got==take&&CryptHashData(hash,chunk,got,0);remaining-=got;if(!got)break;}
 hashOk=hashOk&&!remaining&&CryptGetHashParam(hash,HP_HASHVAL,digest,&hashLength,0)&&hashLength==32;if(hash)CryptDestroyHash(hash);if(provider)CryptReleaseContext(provider,0);SecureZeroMemory(chunk,sizeof(chunk));if(!hashOk)goto end;
 for(DWORD j=0;j<32;j++){const char *digits="0123456789abcdef";if(r_line[j*2]!=digits[digest[j]>>4]||r_line[j*2+1]!=digits[digest[j]&15])goto end;}
 SecureZeroMemory(digest,sizeof(digest));
 stage=R_MARKERS;marker=r_relative(home,L".agentopsdeck-claude-owner",GENERIC_READ|DELETE|READ_CONTROL,0,0,&status);
 binding=r_relative(home,L".agentopsdeck-claude-binding",GENERIC_READ|READ_CONTROL,0,0,&status);
 if(marker==INVALID_HANDLE_VALUE||binding==INVALID_HANDLE_VALUE||!r_info(marker,&mi,0,1)||!r_info(binding,&bi,0,1)||!r_foreign(home)||!(boot=r_boot())||!repair_preboot(r_ft(mi.ftCreationTime),r_ft(mi.ftLastWriteTime),boot)||!r_read(marker,markerBytes,sizeof(markerBytes),&markerSize)||!r_read(binding,bindingBytes,sizeof(bindingBytes),&bindingSize))goto end;
 output("HELD\t");r_hex(markerBytes,markerSize);output("\t");r_hex(bindingBytes,bindingSize);output("\n");
 stage=R_COMMIT;if(!r_getline(r_line,32,deadline)||strcmp(r_line,"COMMIT"))goto end;
 /* Exact original SQL owner was closed by parent. No fictional coexistence
 * with share=0: close only our attribute pin, open bridge, compare same object. */
 stage=R_BRIDGE;CloseHandle(dbPin);dbPin=INVALID_HANDLE_VALUE;
 bridge=r_relative(dbParent,dbLeaf,GENERIC_READ|READ_CONTROL,0,0,&status);
 if(bridge==INVALID_HANDLE_VALUE||!r_info(bridge,&check,0,1)||!r_same(&di,&check)||!r_final(bridge,dbPath)||r_boot()!=boot||!r_info(home,&check,1,1)||!r_foreign(home)||!r_info(marker,&check,0,1)||!r_same(&mi,&check)||!repair_preboot(r_ft(check.ftCreationTime),r_ft(check.ftLastWriteTime),boot)||!r_read(marker,again,sizeof(again),&againSize)||againSize!=markerSize||memcmp(again,markerBytes,markerSize)||!r_info(binding,&check,0,1)||!r_same(&bi,&check)||!r_read(binding,again,sizeof(again),&againSize)||againSize!=bindingSize||memcmp(again,bindingBytes,bindingSize))goto end;
 stage=R_CONSENT;if(MessageBoxW(NULL,L"已独占持有本次检查的同一个旧标记、绑定与原 DB 桥接句柄。请再次确认刚才全部可信重启时序声明适用于这个始终未恢复/替换的原标记。只重命名为一个不覆盖的备份，不自动启动工作。任一事实不确定请选择否。",L"确认当前持有的遗留标记",MB_YESNO|MB_ICONWARNING|MB_DEFBUTTON2)!=IDYES){output("CANCELLED\n");goto end;}
 stage=R_RECHECK;if(r_boot()!=boot||!r_info(marker,&check,0,1)||!r_same(&mi,&check)||!r_foreign(home))goto end;
 /* Fixed single backup name intentionally refuses any prior backup/collision.
 * No retry, restore, unlink, replacement or second automatic action. */
 const wchar_t *backup=L".agentopsdeck-claude-owner.pre-restart-backup";
 stage=R_RENAME;if(!r_rename(marker,home,backup))goto end;
 stage=R_POST_RENAME;wchar_t backupPath[4096];swprintf(backupPath,4096,L"%ls\\%ls",homePath,backup);
 if(!r_info(marker,&check,0,1)||!r_same(&mi,&check)||!r_read(marker,again,sizeof(again),&againSize)||againSize!=markerSize||memcmp(again,markerBytes,markerSize)||!r_final(marker,backupPath)||!r_missing(home,L".agentopsdeck-claude-owner"))goto end;
 output("DONE\n");result=0;
end:
 if(result)r_refused(stage);
 if(marker!=INVALID_HANDLE_VALUE)CloseHandle(marker);if(binding!=INVALID_HANDLE_VALUE)CloseHandle(binding);if(dbPin!=INVALID_HANDLE_VALUE)CloseHandle(dbPin);if(bridge!=INVALID_HANDLE_VALUE)CloseHandle(bridge);if(config!=INVALID_HANDLE_VALUE)CloseHandle(config);while(r_np)CloseHandle(r_pins[--r_np]);if(token)CloseHandle(token);
 SecureZeroMemory(markerBytes,sizeof(markerBytes));SecureZeroMemory(bindingBytes,sizeof(bindingBytes));SecureZeroMemory(again,sizeof(again));SecureZeroMemory(r_line,sizeof(r_line));return result;
}
