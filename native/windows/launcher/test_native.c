#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdint.h>
#include <wchar.h>
#include <assert.h>
static int captureOutput;static char captured[4096];
static void output(const char *s){if(captureOutput){strncat(captured,s,sizeof(captured)-strlen(captured)-1);return;}fputs(s,stdout);fflush(stdout);}
#include "repair_native.h"
static int checks;
#define CHECK(x) do{if(!(x)){printf("FAIL line=%d expression=%s winerr=%lu\n",__LINE__,#x,GetLastError());return __LINE__;}checks++;}while(0)


static int ancestorWriteRed(void){
 unsigned char world[SECURITY_MAX_SID_SIZE];DWORD n=sizeof(world);CHECK(CreateWellKnownSid(WinWorldSid,NULL,world,&n));
 DWORD masks[]={FILE_WRITE_DATA,FILE_APPEND_DATA,GENERIC_WRITE,FILE_DELETE_CHILD,WRITE_DAC,WRITE_OWNER,DELETE,GENERIC_ALL,FILE_GENERIC_READ};
 for(unsigned j=0;j<sizeof(masks)/sizeof(masks[0]);j++){SECURITY_DESCRIPTOR sd;PACL acl=NULL;EXPLICIT_ACCESSW ea={0};ea.grfAccessPermissions=masks[j];ea.grfAccessMode=SET_ACCESS;ea.Trustee.TrusteeForm=TRUSTEE_IS_SID;ea.Trustee.ptstrName=(LPWSTR)world;CHECK(SetEntriesInAclW(1,&ea,NULL,&acl)==ERROR_SUCCESS);CHECK(InitializeSecurityDescriptor(&sd,SECURITY_DESCRIPTOR_REVISION));CHECK(SetSecurityDescriptorOwner(&sd,r_sid,FALSE));CHECK(SetSecurityDescriptorDacl(&sd,TRUE,acl,FALSE));CHECK(r_acl_policy(&sd,0)==(masks[j]==FILE_GENERIC_READ));CHECK(r_acl_policy(&sd,2)==(masks[j]==FILE_GENERIC_READ||masks[j]==FILE_WRITE_DATA||masks[j]==FILE_APPEND_DATA));CHECK(!r_acl_policy(&sd,1));LocalFree(acl);}return 0;
}


static int servicingBoundary(void){
 struct {BYTE revision,count;SID_IDENTIFIER_AUTHORITY authority;DWORD sub[6];} ti={1,6,{{0,0,0,0,0,5}},{80,956008885,3418522649,1831038044,1853292631,2271478464}};
 CHECK(IsValidSid(&ti));SECURITY_DESCRIPTOR sd;CHECK(InitializeSecurityDescriptor(&sd,SECURITY_DESCRIPTOR_REVISION));CHECK(SetSecurityDescriptorOwner(&sd,&ti,FALSE));
 PACL acl=NULL;EXPLICIT_ACCESSW ea={0};ea.grfAccessPermissions=FILE_ALL_ACCESS;ea.grfAccessMode=SET_ACCESS;ea.Trustee.TrusteeForm=TRUSTEE_IS_SID;ea.Trustee.ptstrName=(LPWSTR)&ti;CHECK(SetEntriesInAclW(1,&ea,NULL,&acl)==ERROR_SUCCESS);CHECK(SetSecurityDescriptorDacl(&sd,TRUE,acl,FALSE));
 CHECK(!r_acl_policy(&sd,0));CHECK(r_acl_policy(&sd,2));CHECK(!r_acl_policy(&sd,1));CHECK(SetSecurityDescriptorOwner(&sd,r_sid,FALSE));CHECK(!r_acl_policy(&sd,0));CHECK(r_acl_policy(&sd,2));CHECK(!r_acl_policy(&sd,1));CHECK(SetSecurityDescriptorOwner(&sd,&ti,FALSE));ti.sub[5]^=1;CHECK(!r_acl_policy(&sd,0));LocalFree(acl);return 0;
}

static int crashCase(const char *mode){
 HANDLE dir=CreateFileW(L".",FILE_LIST_DIRECTORY|FILE_TRAVERSE|FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,NULL);CHECK(dir!=INVALID_HANDLE_VALUE);
 HANDLE h=CreateFileW(L"marker",GENERIC_WRITE,0,NULL,CREATE_NEW,0,NULL);CHECK(h!=INVALID_HANDLE_VALUE);DWORD n;CHECK(WriteFile(h,"crash-stable-bytes",18,&n,NULL)&&n==18);CloseHandle(h);
 r_create=(R_CREATE)(void*)GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtCreateFile");NTSTATUS status;h=r_relative(dir,L"marker",GENERIC_READ|DELETE|READ_CONTROL,0,0,&status);CHECK(h!=INVALID_HANDLE_VALUE);
 if(!strcmp(mode,"--crash-after"))CHECK(r_rename(h,dir,L"backup"));TerminateProcess(GetCurrentProcess(),77);return 1;
}
int main(int argc,char **argv){
 if(argc==2)return crashCase(argv[1]);
 captureOutput=1;int refusal=repairHeld();captureOutput=0;printf("private-refusal-observed=%s",captured);CHECK(refusal==12);CHECK(!strncmp(captured,"REFUSED\t",8));
 r_create=(R_CREATE)(void*)GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtCreateFile");r_query=(R_QUERY)(void*)GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtQuerySystemInformation");CHECK(r_create&&r_query);
 CHECK(r_path(L"C:\\private\\file"));CHECK(!r_path(L"C:\\private\\..\\file"));CHECK(!r_path(L"C:\\private\\file:stream"));CHECK(!r_path(L"\\\\host\\share\\file"));CHECK(!r_path(L"C:\\private\\file."));
 CHECK(r_structural_match(L"C:\\",NULL));CHECK(r_structural_match(L"D:\\",L"C:\\Users\\mine"));CHECK(r_structural_match(L"C:\\Users",L"C:\\Users\\mine"));CHECK(!r_structural_match(L"C:\\Users\\mine",L"C:\\Users\\mine"));CHECK(!r_structural_match(L"C:\\Users\\mine\\AppData",L"C:\\Users\\mine"));CHECK(!r_structural_match(L"C:\\Users\\other",L"C:\\Users\\mine"));CHECK(!r_structural_match(L"C:\\User",L"C:\\Users\\mine"));CHECK(!r_structural_match(L"C:\\Users",NULL));CHECK(r_structural(L"C:\\"));
 for(int stage=1;stage<=16;stage++){captured[0]=0;captureOutput=1;r_refused((enum R_STAGE)stage);captureOutput=0;char want[32];snprintf(want,sizeof(want),"REFUSED\t%d\n",stage);CHECK(!strcmp(captured,want));}
 CHECK(repair_preboot(1,1,40000000));CHECK(!repair_preboot(20000000,1,40000000));CHECK(!repair_preboot(1,40000000,40000000));CHECK(!repair_preboot(0,1,40000000));
 uint64_t boot=r_boot();printf("boot-query-known=%d (Wine observation only)\n",boot!=0);
 HANDLE tok;DWORD len=sizeof(r_user),ss=sizeof(r_system);CHECK(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&tok));CHECK(GetTokenInformation(tok,TokenUser,r_user,len,&len));CloseHandle(tok);r_sid=((TOKEN_USER*)r_user)->User.Sid;CHECK(CreateWellKnownSid(WinLocalSystemSid,NULL,r_system,&ss));ss=sizeof(r_admin);CHECK(CreateWellKnownSid(WinBuiltinAdministratorsSid,NULL,r_admin,&ss));
 CHECK(CreateDirectoryW(L"fixture",NULL));HANDLE dir=CreateFileW(L"fixture",FILE_LIST_DIRECTORY|FILE_TRAVERSE|FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,NULL);CHECK(dir!=INVALID_HANDLE_VALUE);
 HANDLE h=CreateFileW(L"fixture\\marker",GENERIC_WRITE,0,NULL,CREATE_NEW,0,NULL);CHECK(h!=INVALID_HANDLE_VALUE);DWORD got;CHECK(WriteFile(h,"unchanged-marker-bytes",22,&got,NULL)&&got==22);CloseHandle(h);
 NTSTATUS status;h=r_relative(dir,L"marker",GENERIC_READ|DELETE|READ_CONTROL,0,0,&status);CHECK(h!=INVALID_HANDLE_VALUE);
 HANDLE conflict=r_relative(dir,L"marker",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,0,&status);CHECK(conflict==INVALID_HANDLE_VALUE&&(ULONG)status==0xc0000043);
 BY_HANDLE_FILE_INFORMATION before,after;CHECK(GetFileInformationByHandle(h,&before));
 HANDLE other=CreateFileW(L"fixture\\collision",GENERIC_WRITE,0,NULL,CREATE_NEW,0,NULL);CHECK(other!=INVALID_HANDLE_VALUE);CHECK(WriteFile(other,"collision-sentinel",18,&got,NULL)&&got==18);BY_HANDLE_FILE_INFORMATION distinct;CHECK(GetFileInformationByHandle(other,&distinct)&&!r_same(&before,&distinct));CloseHandle(other);
 CHECK(!MoveFileExW(L"fixture",L"swapped",0));CHECK(r_foreign(dir));HANDLE foreign=CreateFileW(L"fixture\\.agentopsdeck-copilot-owner",GENERIC_WRITE,0,NULL,CREATE_NEW,0,NULL);CHECK(foreign!=INVALID_HANDLE_VALUE);CloseHandle(foreign);CHECK(!r_foreign(dir));CHECK(DeleteFileW(L"fixture\\.agentopsdeck-copilot-owner"));
 CHECK(!r_rename(h,dir,L"collision"));CHECK(GetFileInformationByHandle(h,&after)&&r_same(&before,&after));
 int renamed=r_rename(h,dir,L"backup");CHECK(renamed);CHECK(GetFileInformationByHandle(h,&after)&&r_same(&before,&after));CHECK(r_missing(dir,L"marker"));
 const wchar_t *retained=renamed?L"backup":L"marker";
 unsigned char bytes[128];DWORD size;CHECK(r_read(h,bytes,sizeof(bytes),&size)&&size==22&&!memcmp(bytes,"unchanged-marker-bytes",22));CloseHandle(h);
 h=r_relative(dir,retained,GENERIC_READ|DELETE,0,0,&status);CHECK(h!=INVALID_HANDLE_VALUE);CHECK(!r_rename(h,dir,L"collision"));CloseHandle(h);
 // Attribute-only pin permits the original SQLite-style read/write opener,
 // then exact share=0 bridge refuses any held read/write opener.
 HANDLE pin=r_relative(dir,retained,FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,0,&status);CHECK(pin!=INVALID_HANDLE_VALUE);
 HANDLE live=r_relative(dir,retained,GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,0,&status);CHECK(live!=INVALID_HANDLE_VALUE);CloseHandle(pin);
 HANDLE bridge=r_relative(dir,retained,GENERIC_READ|READ_CONTROL,0,0,&status);CHECK(bridge==INVALID_HANDLE_VALUE&&(ULONG)status==0xc0000043);CloseHandle(live);
 bridge=r_relative(dir,retained,GENERIC_READ|READ_CONTROL,0,0,&status);CHECK(bridge!=INVALID_HANDLE_VALUE);CHECK(GetFileInformationByHandle(bridge,&after)&&r_same(&before,&after));CloseHandle(bridge);
 other=r_relative(dir,L"collision",GENERIC_READ,FILE_SHARE_READ,0,&status);CHECK(other!=INVALID_HANDLE_VALUE);CHECK(r_read(other,bytes,sizeof(bytes),&size)&&size==18&&!memcmp(bytes,"collision-sentinel",18));CloseHandle(other);
 CloseHandle(dir);
 // Real handle ACL policy, not a boolean fixture adapter.
 HANDLE secure=CreateFileW(L"fixture\\acl",GENERIC_READ|READ_CONTROL|WRITE_DAC|WRITE_OWNER,0,NULL,CREATE_NEW,0,NULL);CHECK(secure!=INVALID_HANDLE_VALUE);
 EXPLICIT_ACCESSW ea={0};ea.grfAccessPermissions=FILE_ALL_ACCESS;ea.grfAccessMode=SET_ACCESS;ea.Trustee.TrusteeForm=TRUSTEE_IS_SID;ea.Trustee.TrusteeType=TRUSTEE_IS_USER;ea.Trustee.ptstrName=(LPWSTR)r_sid;PACL acl=NULL;CHECK(SetEntriesInAclW(1,&ea,NULL,&acl)==ERROR_SUCCESS);CHECK(SetSecurityInfo(secure,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,r_sid,NULL,acl,NULL)==ERROR_SUCCESS);LocalFree(acl);{PSECURITY_DESCRIPTOR sd=NULL;PSID owner=NULL;PACL ac=NULL;DWORD err=GetSecurityInfo(secure,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,NULL,&ac,NULL,&sd);printf("acl-observation error=%lu owner-current=%d count=%u\n",err,owner?EqualSid(owner,r_sid):0,ac?ac->AceCount:0);if(ac)for(DWORD j=0;j<ac->AceCount;j++){void *v;GetAce(ac,j,&v);ACCESS_ALLOWED_ACE *a=v;printf("ace type=%u flags=%u mask=%lx current=%d system=%d admin=%d\n",a->Header.AceType,a->Header.AceFlags,a->Mask,EqualSid(&a->SidStart,r_sid),EqualSid(&a->SidStart,r_system),EqualSid(&a->SidStart,r_admin));}if(sd)LocalFree(sd);}CHECK(r_acl(secure,1));CHECK(r_info(secure,&after,0,1));puts("PASS safe current-owner private ACL and NTFS info");CHECK(ancestorWriteRed()==0);CHECK(servicingBoundary()==0);
 unsigned char everyone[SECURITY_MAX_SID_SIZE];ss=sizeof(everyone);CHECK(CreateWellKnownSid(WinWorldSid,NULL,everyone,&ss));ea.Trustee.ptstrName=(LPWSTR)everyone;ea.grfAccessPermissions=FILE_GENERIC_READ;CHECK(SetEntriesInAclW(1,&ea,NULL,&acl)==ERROR_SUCCESS);CHECK(SetSecurityInfo(secure,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,NULL,NULL,acl,NULL)==ERROR_SUCCESS);LocalFree(acl);CHECK(!r_acl(secure,1));CloseHandle(secure);
if(CreateSymbolicLinkW(L"fixture\\reparse",L"backup",2)){h=CreateFileW(L"fixture\\reparse",FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,NULL);CHECK(h!=INVALID_HANDLE_VALUE);CHECK(GetFileInformationByHandle(h,&after)&&(after.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));CHECK(!r_info(h,&after,0,1));CloseHandle(h);puts("PASS reparse refusal");}else puts("UNSUPPORTED reparse fixture creation");
 CHECK(CreateHardLinkW(L"fixture\\second-link",L"fixture\\backup",NULL));h=CreateFileW(renamed?L"fixture\\backup":L"fixture\\marker",FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,0,NULL);CHECK(h!=INVALID_HANDLE_VALUE);CHECK(GetFileInformationByHandle(h,&after)&&after.nNumberOfLinks==2);CHECK(!r_info(h,&after,0,1));CloseHandle(h);
 printf("PASS native primitive checks=%d (Wine, not Windows NTFS certification)\n",checks);return 0;
}
