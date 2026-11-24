#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <stdio.h>
#include <wchar.h>

static int report(int reason) {
 if (reason) { printf("%d", reason); return 1; }
 fputs("private", stdout); return 0;
}

int wmain(int argc, wchar_t **argv) {
 if (argc == 2 && !wcscmp(argv[1], L"--version")) {
  fputs("agentopsdeck-private-path-v1", stdout); return 0;
 }
 if (argc != 1) return report(4);
 wchar_t path[32768];
 DWORD length = GetEnvironmentVariableW(L"AOD_PRIVATE_PATH", path, 32768);
 if (!length || length >= 32768) return report(4);
 HANDLE file = CreateFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES,
  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
  FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
 if (file == INVALID_HANDLE_VALUE) return report(4);
 BY_HANDLE_FILE_INFORMATION info;
 if (!GetFileInformationByHandle(file, &info)) { CloseHandle(file); return report(4); }
 if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { CloseHandle(file); return report(1); }
 HANDLE token = NULL; unsigned char user[1024], system[SECURITY_MAX_SID_SIZE], admin[SECURITY_MAX_SID_SIZE];
 DWORD returned = 0, size = sizeof(system);
 if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)
  || !GetTokenInformation(token, TokenUser, user, sizeof(user), &returned)
  || !CreateWellKnownSid(WinLocalSystemSid, NULL, system, &size)) {
  if (token) CloseHandle(token); CloseHandle(file); return report(4);
 }
 size = sizeof(admin);
 if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, admin, &size)) {
  CloseHandle(token); CloseHandle(file); return report(4);
 }
 PSID current = ((TOKEN_USER*)user)->User.Sid, owner = NULL;
 PACL acl = NULL; PSECURITY_DESCRIPTOR descriptor = NULL;
 DWORD status = GetSecurityInfo(file, SE_FILE_OBJECT,
  OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, NULL, &acl, NULL, &descriptor);
 int reason = 0;
 if (status != ERROR_SUCCESS || !descriptor || !IsValidSecurityDescriptor(descriptor) || !owner) reason = 4;
 else if (!EqualSid(owner, current)) reason = 2;
 else if (!acl) reason = 3;
 else if (!IsValidAcl(acl)) reason = 4;
 else for (DWORD i = 0; i < acl->AceCount; ++i) {
  void *entry = NULL;
  if (!GetAce(acl, i, &entry)) { reason = 4; break; }
  ACE_HEADER *header = (ACE_HEADER*)entry;
  if (header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE) {
   reason = 4; break;
  }
  PSID sid = &((ACCESS_ALLOWED_ACE*)entry)->SidStart;
  if (!IsValidSid(sid)) { reason = 4; break; }
  if (header->AceType == ACCESS_ALLOWED_ACE_TYPE
   && !EqualSid(sid, current) && !EqualSid(sid, system) && !EqualSid(sid, admin)) {
   reason = 3; break;
  }
 }
 if (descriptor) LocalFree(descriptor);
 CloseHandle(token); CloseHandle(file);
 SecureZeroMemory(user, sizeof(user));
 return report(reason);
}
