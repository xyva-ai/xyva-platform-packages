#include <node_api.h>
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>

#include <new>
#include <string>
#include <vector>

typedef LONG NTSTATUS;
typedef struct { USHORT Length, MaximumLength; PWSTR Buffer; } XYVA_UNICODE_STRING;
typedef struct { ULONG Length; HANDLE RootDirectory; XYVA_UNICODE_STRING* ObjectName; ULONG Attributes; PVOID SecurityDescriptor, SecurityQualityOfService; } XYVA_OBJECT_ATTRIBUTES;
typedef struct { union { NTSTATUS Status; PVOID Pointer; }; ULONG_PTR Information; } XYVA_IO_STATUS_BLOCK;
typedef struct { BOOLEAN ReplaceIfExists; HANDLE RootDirectory; ULONG FileNameLength; WCHAR FileName[1]; } XYVA_FILE_RENAME_INFORMATION;
typedef struct { BOOLEAN DeleteFile; } XYVA_FILE_DISPOSITION_INFORMATION;
extern "C" NTSTATUS NTAPI NtCreateFile(PHANDLE, ACCESS_MASK, XYVA_OBJECT_ATTRIBUTES*, XYVA_IO_STATUS_BLOCK*, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
extern "C" NTSTATUS NTAPI NtSetInformationFile(HANDLE, XYVA_IO_STATUS_BLOCK*, PVOID, ULONG, ULONG);
extern "C" ULONG NTAPI RtlNtStatusToDosError(NTSTATUS);

#define XYVA_NT_OK(status) ((NTSTATUS)(status) >= 0)
#define XYVA_OBJ_DONT_REPARSE 0x1000L
#define XYVA_FILE_OPEN 1L
#define XYVA_FILE_CREATE 2L
#define XYVA_FILE_OPEN_IF 3L
#define XYVA_FILE_RENAME_INFORMATION_CLASS 10L
#define XYVA_FILE_DISPOSITION_INFORMATION_CLASS 13L
#define XYVA_FILE_DIRECTORY_FILE 1L
#define XYVA_FILE_NON_DIRECTORY_FILE 0x40L
#define XYVA_FILE_OPEN_REPARSE_POINT 0x200000L
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x20L
#endif

struct Root {
  HANDLE handle = INVALID_HANDLE_VALUE;
  ~Root() { if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); }
};

static bool IsLeaf(const std::wstring& leaf);

static bool SplitAbsoluteDrivePath(const std::wstring& path, std::vector<std::wstring>* components) {
  if (path.size() < 4 || path[1] != L':' || (path[2] != L'\\' && path[2] != L'/')) return false;
  size_t cursor = 3;
  while (cursor < path.size()) {
    const size_t next = path.find_first_of(L"\\\\/", cursor);
    const std::wstring component = path.substr(cursor, next == std::wstring::npos ? std::wstring::npos : next - cursor);
    if (!IsLeaf(component)) return false;
    components->push_back(component);
    if (next == std::wstring::npos) break;
    cursor = next + 1;
  }
  return !components->empty();
}

#ifdef XYVA_TEST_BUILD
struct Barrier {
  HANDLE reached = 0;
  HANDLE proceed = 0;
  ~Barrier() { if (reached) CloseHandle(reached); if (proceed) CloseHandle(proceed); }
  bool active() const { return reached && proceed; }
};
static Barrier testBarrier;
#endif

static void Fail(napi_env env, const char* code) {
  napi_value message, error, value;
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, 0, message, &error);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, error, "code", value);
  napi_throw(env, error);
}

static bool String(napi_env env, napi_value value, std::wstring* output) {
  size_t size = 0;
  if (napi_get_value_string_utf16(env, value, 0, 0, &size) != napi_ok) return false;
  std::vector<char16_t> buffer(size + 1);
  if (napi_get_value_string_utf16(env, value, buffer.data(), size + 1, &size) != napi_ok) return false;
  output->assign(reinterpret_cast<wchar_t*>(buffer.data()), size);
  return output->find(L'\0') == std::wstring::npos;
}

static bool IsLeaf(const std::wstring& leaf) {
  return !leaf.empty() && leaf != L"." && leaf != L".." && leaf.find_first_of(L"\\/:") == std::wstring::npos;
}

#ifdef XYVA_TEST_BUILD
static bool IsBarrierName(const std::wstring& name) {
  return name.rfind(L"Local\\xyva-secure-store-", 0) == 0 && name.size() <= 240;
}

static bool AwaitTestBarrier() {
  return !testBarrier.active() || (SetEvent(testBarrier.reached) && WaitForSingleObject(testBarrier.proceed, 10'000) == WAIT_OBJECT_0);
}
#endif

static bool IsNotReparsePoint(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO info{};
  return GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))
    && !(info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT);
}

static std::wstring CurrentSid() {
  HANDLE token = 0;
  DWORD size = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return L"";
  GetTokenInformation(token, TokenUser, 0, 0, &size);
  std::vector<BYTE> buffer(size);
  bool queried = GetTokenInformation(token, TokenUser, buffer.data(), size, &size) != FALSE;
  CloseHandle(token);
  LPWSTR result = 0;
  if (!queried || !ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, &result)) return L"";
  std::wstring sid(result);
  LocalFree(result);
  return sid;
}

static PSECURITY_DESCRIPTOR PrivateDescriptor() {
  const std::wstring sid = CurrentSid();
  if (sid.empty()) return 0;
  const std::wstring sddl = L"O:" + sid + L"G:" + sid + L"D:P(A;;FA;;;" + sid + L")(A;;FA;;;SY)(A;;FA;;;BA)";
  PSECURITY_DESCRIPTOR descriptor = 0;
  return ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), 1, &descriptor, 0) ? descriptor : 0;
}

static bool HasPrivateAcl(HANDLE handle) {
  PSECURITY_DESCRIPTOR descriptor = 0;
  PSID owner = 0;
  PACL acl = 0;
  const DWORD result = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, 0, &acl, 0, &descriptor);
  SECURITY_DESCRIPTOR_CONTROL control{};
  DWORD revision = 0;
  const std::wstring current = CurrentSid();
  bool valid = result == ERROR_SUCCESS && descriptor && owner && !current.empty()
    && GetSecurityDescriptorControl(descriptor, &control, &revision)
    && (control & SE_DACL_PRESENT) && (control & SE_DACL_PROTECTED)
    && acl && acl->AceCount == 3;
  LPWSTR ownerString = 0;
  valid = valid && ConvertSidToStringSidW(owner, &ownerString) && current == ownerString;
  if (ownerString) LocalFree(ownerString);
  bool user = false, system = false, administrators = false;
  for (DWORD index = 0; valid && index < acl->AceCount; ++index) {
    void* rawAce = 0;
    if (!GetAce(acl, index, &rawAce)) { valid = false; break; }
    const ACE_HEADER* header = reinterpret_cast<ACE_HEADER*>(rawAce);
    const ACCESS_ALLOWED_ACE* ace = reinterpret_cast<ACCESS_ALLOWED_ACE*>(rawAce);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE || ace->Mask != FILE_ALL_ACCESS) { valid = false; break; }
    LPWSTR sidString = 0;
    if (!ConvertSidToStringSidW(reinterpret_cast<PSID>(const_cast<DWORD*>(&ace->SidStart)), &sidString)) { valid = false; break; }
    const std::wstring sid(sidString);
    LocalFree(sidString);
    if (sid == current) { if (user) valid = false; user = true; }
    else if (sid == L"S-1-5-18") { if (system) valid = false; system = true; }
    else if (sid == L"S-1-5-32-544") { if (administrators) valid = false; administrators = true; }
    else valid = false;
  }
  if (descriptor) LocalFree(descriptor);
  return valid && user && system && administrators;
}

static Root* GetRoot(napi_env env, napi_value value) {
  void* raw = 0;
  return napi_get_value_external(env, value, &raw) == napi_ok ? static_cast<Root*>(raw) : 0;
}

static HANDLE OpenRelative(Root* root, const std::wstring& leaf, ULONG disposition, ULONG options, PSECURITY_DESCRIPTOR descriptor, DWORD access) {
  XYVA_UNICODE_STRING name{ static_cast<USHORT>(leaf.size() * sizeof(wchar_t)), static_cast<USHORT>((leaf.size() + 1) * sizeof(wchar_t)), const_cast<PWSTR>(leaf.c_str()) };
  XYVA_OBJECT_ATTRIBUTES attributes{ sizeof(attributes), root->handle, &name, XYVA_OBJ_DONT_REPARSE, descriptor, 0 };
  XYVA_IO_STATUS_BLOCK io{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  const NTSTATUS status = NtCreateFile(&handle, access, &attributes, &io, 0, FILE_ATTRIBUTE_NORMAL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, disposition, options, 0, 0);
  if (!XYVA_NT_OK(status)) {
    SetLastError(RtlNtStatusToDosError(status));
    return INVALID_HANDLE_VALUE;
  }
  return handle;
}

static napi_value OpenTrustedRoot(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1], receiver;
  napi_get_cb_info(env, info, &count, args, &receiver, 0);
  std::wstring rootPath;
  if (count != 1 || !String(env, args[0], &rootPath) || rootPath.rfind(L"\\\\", 0) == 0 || rootPath.find(L':') != 1) {
    Fail(env, "XYVA_INVALID_ROOT"); return 0;
  }
  Root* root = new Root();
  root->handle = CreateFileW(rootPath.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, 0, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, 0);
  if (root->handle == INVALID_HANDLE_VALUE || !IsNotReparsePoint(root->handle) || !HasPrivateAcl(root->handle)) {
    delete root;
    Fail(env, "XYVA_UNTRUSTED_ROOT"); return 0;
  }
  napi_value external;
  napi_create_external(env, root, [](napi_env, void* value, void*) { delete static_cast<Root*>(value); }, 0, &external);
  return external;
}

static napi_value EnsureTrustedRoot(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1], receiver;
  napi_get_cb_info(env, info, &count, args, &receiver, 0);
  std::wstring rootPath;
  std::vector<std::wstring> components;
  if (count != 1 || !String(env, args[0], &rootPath) || rootPath.rfind(L"\\\\", 0) == 0 || !SplitAbsoluteDrivePath(rootPath, &components)) {
    Fail(env, "XYVA_INVALID_ROOT"); return 0;
  }
  // Open existing parents by handle. A component exchanged for a junction
  // after this point cannot redirect private-root creation.
  Root parent;
  const std::wstring volume = rootPath.substr(0, 3);
  parent.handle = CreateFileW(volume.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, 0, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, 0);
  if (parent.handle == INVALID_HANDLE_VALUE || !IsNotReparsePoint(parent.handle)) {
    Fail(env, "XYVA_ROOT_PARENT_UNSAFE"); return 0;
  }
  for (size_t index = 0; index + 1 < components.size(); ++index) {
    HANDLE child = OpenRelative(&parent, components[index], XYVA_FILE_OPEN,
      XYVA_FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | XYVA_FILE_DIRECTORY_FILE,
      0, SYNCHRONIZE | READ_CONTROL | FILE_READ_ATTRIBUTES);
    if (child == INVALID_HANDLE_VALUE || !IsNotReparsePoint(child)) {
      if (child != INVALID_HANDLE_VALUE) CloseHandle(child);
      Fail(env, "XYVA_ROOT_PARENT_UNSAFE"); return 0;
    }
    CloseHandle(parent.handle);
    parent.handle = child;
  }
  // The state root is the first private object in the chain.  It must be born
  // with the private owner and protected DACL: creating it with inherited ACLs
  // and hardening it afterwards leaves an observable TOCTOU window.
  PSECURITY_DESCRIPTOR descriptor = PrivateDescriptor();
  if (!descriptor) { Fail(env, "XYVA_SECURITY_DESCRIPTOR_FAILED"); return 0; }
  Root* root = new Root();
  root->handle = OpenRelative(&parent, components.back(), XYVA_FILE_OPEN_IF,
    XYVA_FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | XYVA_FILE_DIRECTORY_FILE,
    descriptor, SYNCHRONIZE | READ_CONTROL | FILE_READ_ATTRIBUTES);
  LocalFree(descriptor);
  if (root->handle == INVALID_HANDLE_VALUE || !IsNotReparsePoint(root->handle) || !HasPrivateAcl(root->handle)) {
    delete root;
    Fail(env, "XYVA_INSECURE_ROOT"); return 0;
  }
  napi_value external;
  napi_create_external(env, root, [](napi_env, void* value, void*) { delete static_cast<Root*>(value); }, 0, &external);
  return external;
}

static napi_value OpenPrivateDirectory(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], receiver;
  napi_get_cb_info(env, info, &count, args, &receiver, 0);
  Root* parent = count ? GetRoot(env, args[0]) : 0;
  std::wstring leaf;
  if (!parent || count != 2 || !String(env, args[1], &leaf) || !IsLeaf(leaf)) { Fail(env, "XYVA_INVALID_INPUT"); return 0; }
  Root* child = new Root();
  child->handle = OpenRelative(parent, leaf, XYVA_FILE_OPEN,
    XYVA_FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | XYVA_FILE_DIRECTORY_FILE,
    0, SYNCHRONIZE | READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY);
  if (child->handle == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    delete child;
    Fail(env, error == ERROR_FILE_NOT_FOUND ? "XYVA_NOT_FOUND" : "XYVA_DIRECTORY_OPEN_FAILED"); return 0;
  }
  if (!IsNotReparsePoint(child->handle) || !HasPrivateAcl(child->handle)) {
    delete child;
    Fail(env, "XYVA_INSECURE_DIRECTORY"); return 0;
  }
  napi_value external;
  napi_create_external(env, child, [](napi_env, void* value, void*) { delete static_cast<Root*>(value); }, 0, &external);
  return external;
}

static napi_value Create(napi_env env, napi_callback_info info, bool directory) {
  size_t count = 3;
  napi_value args[3], receiver;
  napi_get_cb_info(env, info, &count, args, &receiver, 0);
  Root* root = count ? GetRoot(env, args[0]) : 0;
  std::wstring leaf;
  if (!root || !String(env, args[1], &leaf) || !IsLeaf(leaf) || (directory ? count != 2 : count != 3)) {
    Fail(env, "XYVA_INVALID_INPUT"); return 0;
  }
  PSECURITY_DESCRIPTOR descriptor = PrivateDescriptor();
  if (!descriptor) { Fail(env, "XYVA_SECURITY_DESCRIPTOR_FAILED"); return 0; }
#ifdef XYVA_TEST_BUILD
  if (!AwaitTestBarrier()) {
    LocalFree(descriptor); Fail(env, "XYVA_TEST_BARRIER_TIMEOUT"); return 0;
  }
#endif
  HANDLE handle = OpenRelative(root, leaf, XYVA_FILE_CREATE,
    XYVA_FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | (directory ? XYVA_FILE_DIRECTORY_FILE : XYVA_FILE_NON_DIRECTORY_FILE),
    descriptor, directory ? (SYNCHRONIZE | READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES) : (SYNCHRONIZE | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES));
  LocalFree(descriptor);
  if (handle == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    Fail(env, error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS ? "XYVA_ALREADY_EXISTS" : "XYVA_CREATE_FAILED"); return 0;
  }
  if (!IsNotReparsePoint(handle) || !HasPrivateAcl(handle)) {
    CloseHandle(handle);
    Fail(env, "XYVA_INSECURE_ACL_BEFORE_WRITE"); return 0;
  }
  if (!directory) {
    void* bytes = 0; size_t size = 0; DWORD written = 0;
    if (napi_get_buffer_info(env, args[2], &bytes, &size) != napi_ok || size > MAXDWORD) {
      CloseHandle(handle); Fail(env, "XYVA_INVALID_INPUT"); return 0;
    }
    if (!WriteFile(handle, bytes, static_cast<DWORD>(size), &written, 0) || written != size) {
      CloseHandle(handle); Fail(env, "XYVA_WRITE_FAILED"); return 0;
    }
    if (!FlushFileBuffers(handle)) { CloseHandle(handle); Fail(env, "XYVA_FLUSH_FAILED"); return 0; }
    if (!HasPrivateAcl(handle)) { CloseHandle(handle); Fail(env, "XYVA_INSECURE_ACL_AFTER_WRITE"); return 0; }
  }
  CloseHandle(handle);
  napi_value undefined; napi_get_undefined(env, &undefined); return undefined;
}

static napi_value CreatePrivateFile(napi_env env, napi_callback_info info) { return Create(env, info, false); }
static napi_value CreatePrivateDirectory(napi_env env, napi_callback_info info) { return Create(env, info, true); }

static napi_value ReadPrivateFile(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], receiver;
  napi_get_cb_info(env, info, &count, args, &receiver, 0);
  Root* root = count ? GetRoot(env, args[0]) : 0;
  std::wstring leaf;
  if (!root || count != 2 || !String(env, args[1], &leaf) || !IsLeaf(leaf)) { Fail(env, "XYVA_INVALID_INPUT"); return 0; }
#ifdef XYVA_TEST_BUILD
  if (!AwaitTestBarrier()) { Fail(env, "XYVA_TEST_BARRIER_TIMEOUT"); return 0; }
#endif
  HANDLE handle = OpenRelative(root, leaf, XYVA_FILE_OPEN,
    XYVA_FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | XYVA_FILE_NON_DIRECTORY_FILE,
    0, SYNCHRONIZE | GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES);
  if (handle == INVALID_HANDLE_VALUE) { Fail(env, GetLastError() == ERROR_FILE_NOT_FOUND ? "XYVA_NOT_FOUND" : "XYVA_READ_FAILED"); return 0; }
  LARGE_INTEGER size{};
  if (!IsNotReparsePoint(handle) || !HasPrivateAcl(handle) || !GetFileSizeEx(handle, &size) || size.QuadPart < 0 || size.QuadPart > 4 * 1024 * 1024) {
    CloseHandle(handle); Fail(env, "XYVA_INSECURE_OR_INVALID_FILE"); return 0;
  }
  napi_value buffer;
  void* bytes = 0;
  napi_create_buffer(env, static_cast<size_t>(size.QuadPart), &bytes, &buffer);
  DWORD read = 0;
  const bool readOk = size.QuadPart == 0 || (ReadFile(handle, bytes, static_cast<DWORD>(size.QuadPart), &read, 0) && read == size.QuadPart);
  CloseHandle(handle);
  if (!readOk) { Fail(env, "XYVA_READ_FAILED"); return 0; }
  return buffer;
}

static napi_value ReplacePrivateFile(napi_env env, napi_callback_info info) {
  size_t count = 3;
  napi_value args[3], receiver;
  napi_get_cb_info(env, info, &count, args, &receiver, 0);
  Root* root = count ? GetRoot(env, args[0]) : 0;
  std::wstring temporary, target;
  if (!root || count != 3 || !String(env, args[1], &temporary) || !String(env, args[2], &target) || !IsLeaf(temporary) || !IsLeaf(target)) {
    Fail(env, "XYVA_INVALID_INPUT"); return 0;
  }
  HANDLE source = OpenRelative(root, temporary, XYVA_FILE_OPEN,
    XYVA_FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | XYVA_FILE_NON_DIRECTORY_FILE,
    0, DELETE | SYNCHRONIZE | READ_CONTROL | FILE_READ_ATTRIBUTES);
  if (source == INVALID_HANDLE_VALUE || !IsNotReparsePoint(source) || !HasPrivateAcl(source)) {
    if (source != INVALID_HANDLE_VALUE) CloseHandle(source);
    Fail(env, "XYVA_REPLACE_SOURCE_INVALID"); return 0;
  }
  HANDLE existing = OpenRelative(root, target, XYVA_FILE_OPEN,
    XYVA_FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | XYVA_FILE_NON_DIRECTORY_FILE,
    0, SYNCHRONIZE | READ_CONTROL | FILE_READ_ATTRIBUTES);
  if (existing != INVALID_HANDLE_VALUE) {
    const bool targetOk = IsNotReparsePoint(existing) && HasPrivateAcl(existing);
    CloseHandle(existing);
    if (!targetOk) { CloseHandle(source); Fail(env, "XYVA_REPLACE_TARGET_INSECURE"); return 0; }
  } else if (GetLastError() != ERROR_FILE_NOT_FOUND) {
    CloseHandle(source); Fail(env, "XYVA_REPLACE_TARGET_OPEN_FAILED"); return 0;
  }
  const size_t bytes = sizeof(XYVA_FILE_RENAME_INFORMATION) + target.size() * sizeof(wchar_t);
  std::vector<BYTE> storage(bytes);
  XYVA_FILE_RENAME_INFORMATION* rename = reinterpret_cast<XYVA_FILE_RENAME_INFORMATION*>(storage.data());
  rename->ReplaceIfExists = TRUE;
  rename->RootDirectory = root->handle;
  rename->FileNameLength = static_cast<ULONG>(target.size() * sizeof(wchar_t));
  memcpy(rename->FileName, target.data(), target.size() * sizeof(wchar_t));
  XYVA_IO_STATUS_BLOCK io{};
  const NTSTATUS status = NtSetInformationFile(source, &io, rename, static_cast<ULONG>(storage.size()), XYVA_FILE_RENAME_INFORMATION_CLASS);
  CloseHandle(source);
  if (!XYVA_NT_OK(status)) { Fail(env, "XYVA_REPLACE_FAILED"); return 0; }
  napi_value undefined; napi_get_undefined(env, &undefined); return undefined;
}

static napi_value DeletePrivateFile(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], receiver;
  napi_get_cb_info(env, info, &count, args, &receiver, 0);
  Root* root = count ? GetRoot(env, args[0]) : 0;
  std::wstring leaf;
  if (!root || count != 2 || !String(env, args[1], &leaf) || !IsLeaf(leaf)) { Fail(env, "XYVA_INVALID_INPUT"); return 0; }
#ifdef XYVA_TEST_BUILD
  if (!AwaitTestBarrier()) { Fail(env, "XYVA_TEST_BARRIER_TIMEOUT"); return 0; }
#endif
  HANDLE handle = OpenRelative(root, leaf, XYVA_FILE_OPEN,
    XYVA_FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | XYVA_FILE_NON_DIRECTORY_FILE,
    0, DELETE | SYNCHRONIZE | READ_CONTROL | FILE_READ_ATTRIBUTES);
  if (handle == INVALID_HANDLE_VALUE) { Fail(env, GetLastError() == ERROR_FILE_NOT_FOUND ? "XYVA_NOT_FOUND" : "XYVA_DELETE_FAILED"); return 0; }
  if (!IsNotReparsePoint(handle) || !HasPrivateAcl(handle)) { CloseHandle(handle); Fail(env, "XYVA_DELETE_TARGET_INVALID"); return 0; }
  XYVA_FILE_DISPOSITION_INFORMATION disposition{ TRUE };
  XYVA_IO_STATUS_BLOCK io{};
  const NTSTATUS status = NtSetInformationFile(handle, &io, &disposition, sizeof(disposition), XYVA_FILE_DISPOSITION_INFORMATION_CLASS);
  CloseHandle(handle);
  if (!XYVA_NT_OK(status)) { Fail(env, "XYVA_DELETE_FAILED"); return 0; }
  napi_value undefined; napi_get_undefined(env, &undefined); return undefined;
}

static napi_value HasPrivateDirectoryEntries(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1], receiver;
  napi_get_cb_info(env, info, &count, args, &receiver, 0);
  Root* root = count ? GetRoot(env, args[0]) : 0;
  if (!root || count != 1) { Fail(env, "XYVA_INVALID_INPUT"); return 0; }

  BYTE buffer[64 * 1024]{};
  if (!GetFileInformationByHandleEx(root->handle, FileIdBothDirectoryInfo, buffer, sizeof(buffer))) {
    const DWORD error = GetLastError();
    if (error != ERROR_NO_MORE_FILES) { Fail(env, "XYVA_DIRECTORY_ENUMERATION_FAILED"); return 0; }
    napi_value empty; napi_get_boolean(env, false, &empty); return empty;
  }

  BYTE* cursor = buffer;
  while (true) {
    const FILE_ID_BOTH_DIR_INFO* entry = reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(cursor);
    const std::wstring name(entry->FileName, entry->FileNameLength / sizeof(WCHAR));
    if (name != L"." && name != L"..") {
      napi_value present; napi_get_boolean(env, true, &present); return present;
    }
    if (entry->NextEntryOffset == 0) break;
    cursor += entry->NextEntryOffset;
    if (cursor >= buffer + sizeof(buffer)) { Fail(env, "XYVA_DIRECTORY_ENUMERATION_FAILED"); return 0; }
  }
  napi_value empty; napi_get_boolean(env, false, &empty); return empty;
}

#ifdef XYVA_TEST_BUILD
static napi_value ConfigureTestBarrier(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], receiver;
  napi_get_cb_info(env, info, &count, args, &receiver, 0);
  std::wstring reached, proceed;
  if (count != 2 || !String(env, args[0], &reached) || !String(env, args[1], &proceed)
    || !IsBarrierName(reached) || !IsBarrierName(proceed) || reached == proceed) {
    Fail(env, "XYVA_INVALID_INPUT"); return 0;
  }
  if (testBarrier.reached) { CloseHandle(testBarrier.reached); testBarrier.reached = 0; }
  if (testBarrier.proceed) { CloseHandle(testBarrier.proceed); testBarrier.proceed = 0; }
  SetLastError(ERROR_SUCCESS);
  testBarrier.reached = CreateEventW(0, TRUE, FALSE, reached.c_str());
  const DWORD reachedError = GetLastError();
  SetLastError(ERROR_SUCCESS);
  testBarrier.proceed = CreateEventW(0, TRUE, FALSE, proceed.c_str());
  const DWORD proceedError = GetLastError();
  if (!testBarrier.active() || reachedError == ERROR_ALREADY_EXISTS || proceedError == ERROR_ALREADY_EXISTS) {
    if (testBarrier.reached) { CloseHandle(testBarrier.reached); testBarrier.reached = 0; }
    if (testBarrier.proceed) { CloseHandle(testBarrier.proceed); testBarrier.proceed = 0; }
    Fail(env, "XYVA_TEST_EVENT_FAILED"); return 0;
  }
  napi_value undefined; napi_get_undefined(env, &undefined); return undefined;
}

static napi_value TestEvent(napi_env env, napi_callback_info info, bool wait) {
  size_t count = 2;
  napi_value args[2], receiver;
  napi_get_cb_info(env, info, &count, args, &receiver, 0);
  std::wstring name;
  int32_t timeout = 0;
  if (count < 1 || !String(env, args[0], &name) || !IsBarrierName(name)
    || (wait && (count != 2 || napi_get_value_int32(env, args[1], &timeout) != napi_ok || timeout < 1 || timeout > 30'000))) {
    Fail(env, "XYVA_INVALID_INPUT"); return 0;
  }
  HANDLE event = OpenEventW(wait ? SYNCHRONIZE : EVENT_MODIFY_STATE, FALSE, name.c_str());
  if (!event) { Fail(env, "XYVA_TEST_EVENT_FAILED"); return 0; }
  const DWORD result = wait ? WaitForSingleObject(event, static_cast<DWORD>(timeout)) : (SetEvent(event) ? WAIT_OBJECT_0 : WAIT_FAILED);
  CloseHandle(event);
  if (result != WAIT_OBJECT_0) { Fail(env, wait && result == WAIT_TIMEOUT ? "XYVA_TEST_BARRIER_TIMEOUT" : "XYVA_TEST_EVENT_FAILED"); return 0; }
  napi_value undefined; napi_get_undefined(env, &undefined); return undefined;
}
static napi_value WaitTestBarrier(napi_env env, napi_callback_info info) { return TestEvent(env, info, true); }
static napi_value SignalTestBarrier(napi_env env, napi_callback_info info) { return TestEvent(env, info, false); }

static napi_value TestProbe(napi_env env, napi_callback_info info, DWORD access, bool createDirectory) {
  size_t count = 1;
  napi_value args[1], receiver;
  napi_get_cb_info(env, info, &count, args, &receiver, 0);
  std::wstring target;
  if (count != 1 || !String(env, args[0], &target) || target.empty()) { Fail(env, "XYVA_INVALID_INPUT"); return 0; }
  DWORD error = ERROR_SUCCESS;
  if (createDirectory) {
    if (!CreateDirectoryW(target.c_str(), 0)) error = GetLastError();
  } else {
    HANDLE handle = CreateFileW(target.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, 0, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, 0);
    if (handle == INVALID_HANDLE_VALUE) error = GetLastError();
    else CloseHandle(handle);
  }
  napi_value value;
  napi_create_uint32(env, error, &value);
  return value;
}

static napi_value TestProbeRead(napi_env env, napi_callback_info info) { return TestProbe(env, info, GENERIC_READ, false); }
static napi_value TestProbeWrite(napi_env env, napi_callback_info info) { return TestProbe(env, info, GENERIC_WRITE, false); }
static napi_value TestProbeCreateDirectory(napi_env env, napi_callback_info info) { return TestProbe(env, info, 0, true); }

static napi_value TestCurrentToken(napi_env env, napi_callback_info info) {
  size_t count = 0;
  napi_value receiver;
  napi_get_cb_info(env, info, &count, 0, &receiver, 0);
  if (count) { Fail(env, "XYVA_INVALID_INPUT"); return 0; }
  const std::wstring sid = CurrentSid();
  SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
  PSID administrators = 0;
  BOOL member = FALSE;
  const bool valid = !sid.empty()
    && AllocateAndInitializeSid(&authority, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0, &administrators)
    && CheckTokenMembership(0, administrators, &member);
  if (administrators) FreeSid(administrators);
  if (!valid) { Fail(env, "XYVA_TOKEN_PROBE_FAILED"); return 0; }
  napi_value result, value;
  napi_create_object(env, &result);
  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(sid.data()), sid.size(), &value);
  napi_set_named_property(env, result, "sid", value);
  napi_get_boolean(env, member != FALSE, &value);
  napi_set_named_property(env, result, "administrator", value);
  return result;
}

static napi_value TestPrivateAcl(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1], receiver;
  napi_get_cb_info(env, info, &count, args, &receiver, 0);
  Root* root = count ? GetRoot(env, args[0]) : 0;
  if (!root || count != 1) { Fail(env, "XYVA_INVALID_INPUT"); return 0; }
  napi_value result;
  napi_get_boolean(env, HasPrivateAcl(root->handle), &result);
  return result;
}
#endif

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    { "openTrustedRoot", 0, OpenTrustedRoot, 0, 0, 0, napi_default, 0 },
    { "ensureTrustedRoot", 0, EnsureTrustedRoot, 0, 0, 0, napi_default, 0 },
    { "openPrivateDirectory", 0, OpenPrivateDirectory, 0, 0, 0, napi_default, 0 },
    { "createPrivateFile", 0, CreatePrivateFile, 0, 0, 0, napi_default, 0 },
    { "createPrivateDirectory", 0, CreatePrivateDirectory, 0, 0, 0, napi_default, 0 },
    { "readPrivateFile", 0, ReadPrivateFile, 0, 0, 0, napi_default, 0 },
    { "replacePrivateFile", 0, ReplacePrivateFile, 0, 0, 0, napi_default, 0 },
    { "deletePrivateFile", 0, DeletePrivateFile, 0, 0, 0, napi_default, 0 },
    { "hasPrivateDirectoryEntries", 0, HasPrivateDirectoryEntries, 0, 0, 0, napi_default, 0 },
#ifdef XYVA_TEST_BUILD
    { "configureTestBarrier", 0, ConfigureTestBarrier, 0, 0, 0, napi_default, 0 },
    { "waitTestBarrier", 0, WaitTestBarrier, 0, 0, 0, napi_default, 0 },
    { "signalTestBarrier", 0, SignalTestBarrier, 0, 0, 0, napi_default, 0 },
    { "testProbeRead", 0, TestProbeRead, 0, 0, 0, napi_default, 0 },
    { "testProbeWrite", 0, TestProbeWrite, 0, 0, 0, napi_default, 0 },
    { "testProbeCreateDirectory", 0, TestProbeCreateDirectory, 0, 0, 0, napi_default, 0 },
    { "testCurrentToken", 0, TestCurrentToken, 0, 0, 0, napi_default, 0 },
    { "testPrivateAcl", 0, TestPrivateAcl, 0, 0, 0, napi_default, 0 },
#endif
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
