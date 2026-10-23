#include <node_api.h>
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <string>
#include <vector>
#include <new>
typedef LONG NTSTATUS; typedef struct { USHORT Length,MaximumLength; PWSTR Buffer;} US; typedef struct { ULONG Length; HANDLE RootDirectory; US* ObjectName; ULONG Attributes; PVOID SecurityDescriptor,SecurityQualityOfService;} OA; typedef struct { union {NTSTATUS Status;PVOID Pointer;}; ULONG_PTR Information;} IOSB;
extern "C" NTSTATUS NTAPI NtCreateFile(PHANDLE,ACCESS_MASK,OA*,IOSB*,PLARGE_INTEGER,ULONG,ULONG,ULONG,ULONG,PVOID,ULONG); extern "C" ULONG NTAPI RtlNtStatusToDosError(NTSTATUS);
#define NT_OK(s) ((NTSTATUS)(s)>=0)
#define OBJ_DONT_REPARSE 0x1000L
#define FILE_OPEN 1L
#define FILE_CREATE 2L
#define FILE_DIRECTORY_FILE 1L
#define FILE_NON_DIRECTORY_FILE 0x40L
#define FILE_OPEN_REPARSE_POINT 0x200000L
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x20L
#endif
struct Root{HANDLE h=INVALID_HANDLE_VALUE;~Root(){if(h!=INVALID_HANDLE_VALUE)CloseHandle(h);}};
#ifdef XYVA_TEST_BUILD
struct Barrier { HANDLE reached=0, proceed=0; ~Barrier(){Reset();} void Reset(){if(reached){CloseHandle(reached);reached=0;}if(proceed){CloseHandle(proceed);proceed=0;}} bool Active()const{return reached&&proceed;} };
static Barrier barrier;
#endif
static void Fail(napi_env e,const char*c){napi_value m,x,v;napi_create_string_utf8(e,c,NAPI_AUTO_LENGTH,&m);napi_create_error(e,0,m,&x);napi_create_string_utf8(e,c,NAPI_AUTO_LENGTH,&v);napi_set_named_property(e,x,"code",v);napi_throw(e,x);}
static bool S(napi_env e,napi_value v,std::wstring*o){size_t n=0;if(napi_get_value_string_utf16(e,v,0,0,&n)!=napi_ok)return false;std::vector<char16_t>b(n+1);if(napi_get_value_string_utf16(e,v,b.data(),n+1,&n)!=napi_ok)return false;o->assign((wchar_t*)b.data(),n);return o->find(L'\0')==std::wstring::npos;}
static bool L(const std::wstring&s){return !s.empty()&&s!=L"."&&s!=L".."&&s.find_first_of(L"\\/:")==std::wstring::npos;}
static bool NR(HANDLE h){FILE_ATTRIBUTE_TAG_INFO i{};return GetFileInformationByHandleEx(h,FileAttributeTagInfo,&i,sizeof i)&&!(i.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT);}
static std::wstring CurrentSid(){HANDLE t;DWORD n=0;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&t))return L"";GetTokenInformation(t,TokenUser,0,0,&n);std::vector<BYTE>b(n);bool q=GetTokenInformation(t,TokenUser,b.data(),n,&n);CloseHandle(t);LPWSTR x=0;if(!q||!ConvertSidToStringSidW(((TOKEN_USER*)b.data())->User.Sid,&x))return L"";std::wstring r(x);LocalFree(x);return r;}
static PSECURITY_DESCRIPTOR SD(){std::wstring me=CurrentSid();std::wstring s=L"O:"+me+L"G:"+me+L"D:P(A;;FA;;;"+me+L")(A;;FA;;;SY)(A;;FA;;;BA)";PSECURITY_DESCRIPTOR d=0;return ConvertStringSecurityDescriptorToSecurityDescriptorW(s.c_str(),1,&d,0)?d:0;}
static bool Good(HANDLE h){PSECURITY_DESCRIPTOR d=0;PSID o=0;PACL a=0;DWORD r=GetSecurityInfo(h,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&o,0,&a,0,&d);SECURITY_DESCRIPTOR_CONTROL c;DWORD v;std::wstring me=CurrentSid();bool ok=!r&&d&&o&&!me.empty()&&GetSecurityDescriptorControl(d,&c,&v)&&(c&SE_DACL_PRESENT)&&(c&SE_DACL_PROTECTED)&&a&&a->AceCount==3;LPWSTR z=0;ok=ok&&ConvertSidToStringSidW(o,&z)&&me==z;if(z)LocalFree(z);bool user=false,system=false,admins=false;for(DWORD i=0;ok&&i<a->AceCount;i++){void*x=0;if(!GetAce(a,i,&x)){ok=false;break;}ACCESS_ALLOWED_ACE*q=(ACCESS_ALLOWED_ACE*)x;if(((ACE_HEADER*)x)->AceType!=ACCESS_ALLOWED_ACE_TYPE||q->Mask!=FILE_ALL_ACCESS){ok=false;break;}LPWSTR y=0;if(!ConvertSidToStringSidW((PSID)&q->SidStart,&y)){ok=false;break;}std::wstring k(y);LocalFree(y);if(k==me){if(user)ok=false;user=true;}else if(k==L"S-1-5-18"){if(system)ok=false;system=true;}else if(k==L"S-1-5-32-544"){if(admins)ok=false;admins=true;}else ok=false;}if(d)LocalFree(d);return ok&&user&&system&&admins;}
static Root* R(napi_env e,napi_value v){void*p=0;return napi_get_value_external(e,v,&p)==napi_ok?(Root*)p:0;}
static HANDLE Rel(Root*r,const std::wstring&l,ULONG disp,ULONG opt,PSECURITY_DESCRIPTOR d,DWORD access){US u{(USHORT)(l.size()*2),(USHORT)((l.size()+1)*2),(PWSTR)l.c_str()};OA a{sizeof a,r->h,&u,OBJ_DONT_REPARSE,d,0};IOSB io{};HANDLE h=INVALID_HANDLE_VALUE;NTSTATUS s=NtCreateFile(&h,access,&a,&io,0,FILE_ATTRIBUTE_NORMAL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,disp,opt,0,0);if(!NT_OK(s)){SetLastError(RtlNtStatusToDosError(s));return INVALID_HANDLE_VALUE;}return h;}
static napi_value Open(napi_env e,napi_callback_info i){size_t n=1;napi_value a[1],t;napi_get_cb_info(e,i,&n,a,&t,0);std::wstring p;if(n!=1||!S(e,a[0],&p)||p.rfind(L"\\\\",0)==0||p.find(L':')!=1){Fail(e,"XYVA_INVALID_ROOT");return 0;}Root*r=new Root;r->h=CreateFileW(p.c_str(),READ_CONTROL|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,0,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,0);if(r->h==INVALID_HANDLE_VALUE||!NR(r->h)){delete r;Fail(e,"XYVA_UNTRUSTED_ROOT");return 0;}napi_value x;napi_create_external(e,r,[](napi_env,void*p,void*){delete(Root*)p;},0,&x);return x;}
static napi_value Make(napi_env e,napi_callback_info i,bool dir){size_t n=3;napi_value a[3],t;napi_get_cb_info(e,i,&n,a,&t,0);Root*r=n?R(e,a[0]):0;std::wstring l;if(!r||!S(e,a[1],&l)||!L(l)||(dir?n!=2:n!=3)){Fail(e,"XYVA_INVALID_INPUT");return 0;}PSECURITY_DESCRIPTOR d=SD();if(!d){Fail(e,"XYVA_SECURITY_DESCRIPTOR_FAILED");return 0;}
#ifdef XYVA_TEST_BUILD
if(barrier.reached&&barrier.proceed){if(!SetEvent(barrier.reached)||WaitForSingleObject(barrier.proceed,10000)!=WAIT_OBJECT_0){LocalFree(d);Fail(e,"XYVA_TEST_BARRIER_TIMEOUT");return 0;}}
#endif
HANDLE h=Rel(r,l,FILE_CREATE,FILE_OPEN_REPARSE_POINT|FILE_SYNCHRONOUS_IO_NONALERT|(dir?FILE_DIRECTORY_FILE:FILE_NON_DIRECTORY_FILE),d,dir?(READ_CONTROL|WRITE_DAC|FILE_READ_ATTRIBUTES):(GENERIC_WRITE|READ_CONTROL|WRITE_DAC|FILE_READ_ATTRIBUTES));LocalFree(d);if(h==INVALID_HANDLE_VALUE){Fail(e,GetLastError()==ERROR_FILE_EXISTS?"XYVA_ALREADY_EXISTS":"XYVA_CREATE_FAILED");return 0;}if(!NR(h)){CloseHandle(h);Fail(e,"XYVA_REPARSE_HANDLE");return 0;}if(!Good(h)){CloseHandle(h);Fail(e,"XYVA_INSECURE_ACL_BEFORE_WRITE");return 0;}if(!dir){void*b;size_t z;DWORD w=0;if(napi_get_buffer_info(e,a[2],&b,&z)!=napi_ok||z>MAXDWORD){CloseHandle(h);Fail(e,"XYVA_INVALID_INPUT");return 0;}if(!WriteFile(h,b,(DWORD)z,&w,0)||w!=z){CloseHandle(h);Fail(e,"XYVA_WRITE_FAILED");return 0;}if(!FlushFileBuffers(h)){CloseHandle(h);Fail(e,"XYVA_FLUSH_FAILED");return 0;}if(!Good(h)){CloseHandle(h);Fail(e,"XYVA_INSECURE_ACL_AFTER_WRITE");return 0;}}CloseHandle(h);napi_value x;napi_get_undefined(e,&x);return x;}
static napi_value F(napi_env e,napi_callback_info i){return Make(e,i,false);}static napi_value D(napi_env e,napi_callback_info i){return Make(e,i,true);}
#ifdef XYVA_TEST_BUILD
static bool BarrierName(const std::wstring&x){return x.rfind(L"Local\\\\xyva-barrier-",0)==0&&x.size()<=240;}
static napi_value B(napi_env e,napi_callback_info i){size_t n=2;napi_value a[2],t;napi_get_cb_info(e,i,&n,a,&t,0);std::wstring x,y;if(n!=2||!S(e,a[0],&x)||!S(e,a[1],&y)||!BarrierName(x)||!BarrierName(y)||x==y){Fail(e,"XYVA_INVALID_INPUT");return 0;}PSECURITY_DESCRIPTOR d=SD();if(!d){Fail(e,"XYVA_SECURITY_DESCRIPTOR_FAILED");return 0;}SECURITY_ATTRIBUTES sa{sizeof sa,d,FALSE};barrier.Reset();SetLastError(ERROR_SUCCESS);barrier.reached=CreateEventW(&sa,TRUE,FALSE,x.c_str());DWORD reachedError=GetLastError();SetLastError(ERROR_SUCCESS);barrier.proceed=CreateEventW(&sa,TRUE,FALSE,y.c_str());DWORD proceedError=GetLastError();LocalFree(d);if(!barrier.Active()||reachedError==ERROR_ALREADY_EXISTS||proceedError==ERROR_ALREADY_EXISTS){barrier.Reset();Fail(e,"XYVA_TEST_EVENT_FAILED");return 0;}napi_value z;napi_get_undefined(e,&z);return z;}
static napi_value E(napi_env e,napi_callback_info i,bool wait){size_t n=2;napi_value a[2],t;napi_get_cb_info(e,i,&n,a,&t,0);std::wstring x;int32_t ms=0;if(n<1||!S(e,a[0],&x)||!BarrierName(x)||(wait&&(n!=2||napi_get_value_int32(e,a[1],&ms)!=napi_ok||ms<1||ms>30000))){Fail(e,"XYVA_INVALID_INPUT");return 0;}HANDLE h=OpenEventW(wait?SYNCHRONIZE:EVENT_MODIFY_STATE,FALSE,x.c_str());if(!h){Fail(e,"XYVA_TEST_EVENT_FAILED");return 0;}DWORD result=wait?WaitForSingleObject(h,(DWORD)ms):(SetEvent(h)?WAIT_OBJECT_0:WAIT_FAILED);CloseHandle(h);if(result!=WAIT_OBJECT_0){Fail(e,wait&&result==WAIT_TIMEOUT?"XYVA_TEST_BARRIER_TIMEOUT":"XYVA_TEST_EVENT_FAILED");return 0;}napi_value z;napi_get_undefined(e,&z);return z;}static napi_value W(napi_env e,napi_callback_info i){return E(e,i,true);}static napi_value G(napi_env e,napi_callback_info i){return E(e,i,false);}
#endif
NAPI_MODULE_INIT(){napi_property_descriptor p[]={{"openTrustedRoot",0,Open,0,0,0,napi_default,0},{"createPrivateFile",0,F,0,0,0,napi_default,0},{"createPrivateDirectory",0,D,0,0,0,napi_default,0}
#ifdef XYVA_TEST_BUILD
,{"configureTestBarrier",0,B,0,0,0,napi_default,0},{"waitTestBarrier",0,W,0,0,0,napi_default,0},{"signalTestBarrier",0,G,0,0,0,napi_default,0}
#endif
};napi_define_properties(env,exports,sizeof(p)/sizeof(p[0]),p);return exports;}
