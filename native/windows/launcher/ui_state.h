#ifndef UI_STATE_H
#define UI_STATE_H
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
typedef struct {int http_hub,http_connector,agent,running,failure,pending;char message[512],report[4096],observations[2048];} UI_STATE;
#define UI_FIELD_GATE 1
static int ui_fields_allowed(const char *a,int c){return (!strcmp(a,"load")&&c==0)||!strcmp(a,"save")||!strcmp(a,"save-restart")||!strcmp(a,"provision");}
#define UI_REVISION_GATE 1
static inline int ui_update_revision(const char *a,int c,const char *text,char *revision){
 if(!ui_fields_allowed(a,c)){if(!strcmp(a,"load"))revision[0]=0;return 0;}
 if(!strcmp(a,"provision"))return c==0;
 const char *found=NULL,*p=text;int count=0;
 while(*p){
  const char *e=strchr(p,'\n');size_t n=e?(size_t)(e-p):strlen(p);
  if(n>=9&&!strncmp(p,"REVISION\t",9)){count++;if(n==73&&strspn(p+9,"abcdef0123456789")==64)found=p+9;}
  if(!e)break;
  p=e+1;
 }
 revision[0]=0;if(count!=1||!found)return 0;
 memcpy(revision,found,64);revision[64]=0;return 1;
}
static int ui_is_zh(void){
 const char* env=getenv("AOD_UI_LOCALE");
 if(!env||!env[0])env=getenv("AOD_LOCALE");
 if(!env||!env[0])env=getenv("LANG");
 if(env&&env[0]){
  if((env[0]=='z'||env[0]=='Z')&&(env[1]=='h'||env[1]=='H'))return 1;
  if((env[0]=='e'||env[0]=='E')&&(env[1]=='n'||env[1]=='N'))return 0;
 }
#ifdef _WIN32
 return PRIMARYLANGID(GetUserDefaultUILanguage())==LANG_CHINESE?1:0;
#else
 return 1;
#endif
}
static void ui_add(char *out,size_t cap,const char *v){size_t n=strlen(out);if(n<cap-1)snprintf(out+n,cap-n,"%s",v);}
static const char *ui_reason(const char *t){
 int zh=ui_is_zh();
 struct {const char *key,*zh,*en;} m[]={
 {"start-failed","启动失败；子进程已退出或启动入口失败。","Start failed; child process exited or entrypoint failed."},
 {"start-timeout","启动等待超时；服务可能仍在运行。","Startup timed out; service may still be running."},
 {"stop-unconfirmed","停止未确认；未启动替代进程。","Stop unconfirmed; replacement process was not started."},
 {"ownership-unresolved","无法确认服务所有权；未启动替代进程。","Service ownership unresolved; replacement process was not started."},
 {"operation-busy","另一个本机操作正在执行，请稍后重试。","Another local operation is in progress; please retry later."},
 {"config-conflict","配置已被其他操作修改；请重新载入后再保存。","Configuration was modified by another operation; reload before saving."},
 {"saved-restart-failed-pending","配置已保存，但重启未确认；等待安全重试。","Configuration saved, but restart is unconfirmed; awaiting safe retry."},
 {"helper-timeout-service-may-run","辅助程序等待超时；服务可能仍在运行，未强杀。","Helper timed out; service may still be running and was not force-killed."},
 {"install-cancelled-partial-files-recheck","安装已取消；可能留有部分文件，请重新检测。","Installation cancelled; partial files may remain, please recheck."},
 {"install-timeout-partial-files-recheck","安装超时；可能留有部分文件，请重新检测。","Installation timed out; partial files may remain, please recheck."},
 {"helper-launch-failed","无法启动本机辅助程序。","Failed to launch local UI helper."},
 {"claude-personal-home","不能使用个人 HOME；请选择专用目录。","Personal HOME cannot be used; select a dedicated directory."},
 {"claude-path-overlap","Claude 专用 HOME、SDK 与工作目录不能重叠。","Claude dedicated HOME, SDK, and workspace directories must not overlap."},
 {"claude-config-incomplete","Claude 配置不完整；请检查必填字段。","Claude configuration is incomplete; check required fields."},
 {"preflight-requires-safely-stopped-service","原生预检前必须确认服务已安全停止。","Service must be confirmed safely stopped before native preflight."},
 {"native-preflight-failed-stage-unavailable","原生预检失败；当前协议未提供具体失败阶段。","Native preflight failed; specific failure stage is unavailable."},
 {"启动失败","启动失败；子进程结束或启动器失败，请检查固定阶段诊断。","Start failed; child exited or launcher failed, inspect stage diagnostics."},
 {"尚未确认服务安全停止","停止未确认；未启动替代进程。","Stop unconfirmed; replacement process was not started."},
 {"无法安全确认","无法安全确认所有权或观察器；未启动替代进程。","Ownership or monitor unconfirmed; replacement process was not started."}};
 for(size_t i=0;i<sizeof(m)/sizeof(m[0]);i++)if(strstr(t,m[i].key))return zh?m[i].zh:m[i].en;
 return zh?"本机操作失败；具体条件未确认，请查看诊断并重新检查。":"Local operation failed; exact condition unconfirmed, inspect diagnostics and recheck.";
}
#include "ui_diagnostics.h"
static int ui_result_pending(const char *text){
 const char *p=text;
 while(*p){
  const char *e=strchr(p,'\n');size_t n=e?(size_t)(e-p):strlen(p);
  if(!strncmp(p,"RESULT\t11\t",10)){
   const char *v=p+10;
   const char *known[]={
    "starting","saved-restart-starting",
    "启动中，尚未确认 HTTP 就绪；服务未被终止，请稍后重新载入状态",
    "配置已保存，服务启动中；请稍后重新载入状态",
    "Starting; HTTP readiness is not yet confirmed and the service was not terminated; reload status shortly",
    "Configuration saved and service starting; reload status shortly"
   };
   for(size_t i=0;i<sizeof(known)/sizeof(known[0]);i++){
    size_t k=strlen(known[i]);
    if(n>=10+k&&!strncmp(v,known[i],k)&&(n==10+k||!strncmp(v+k,"（阶段：",strlen("（阶段："))||!strncmp(v+k," (stage: ",9)))return 1;
   }
  }
  if(!e)break;
  p=e+1;
 }
 return 0;
}
static inline int ui_lifecycle_allowed(const UI_STATE *s,const char *a){return !s->pending||(strcmp(a,"start")&&strcmp(a,"restart")&&strcmp(a,"save-restart"));}
static int ui_repair_stage(const char *text){
 const char *prefix="RESULT\t12\trepair-native-refused-",*p=text;size_t k=strlen(prefix);int found=0,count=0;
 while(*p){
  const char *e=strchr(p,'\n');size_t n=e?(size_t)(e-p):strlen(p);if(n&&p[n-1]=='\r')n--;
  if(n>=7&&!strncmp(p,"RESULT\t",7)){count++;if(n>k&&n<=k+2&&!strncmp(p,prefix,k)){if(n==k+1&&p[k]>='1'&&p[k]<='9')found=p[k]-'0';else if(n==k+2&&p[k]=='1'&&p[k+1]>='0'&&p[k+1]<='6')found=10+p[k+1]-'0';}}
  if(!e)break;
  p=e+1;
 }
 return count==1?found:0;
}
static void ui_apply(UI_STATE *s,const char *action,int code,const char *text){
 int zh=ui_is_zh();
 if(!strcmp(action,"check")){
  s->observations[0]=0;const char *components[]={"node","npm","sdk","claude","codex","bash","gitBash"};
  for(size_t i=0;i<sizeof(components)/sizeof(components[0]);i++){
   char needle[64];snprintf(needle,sizeof(needle),"DIAG\t%s\tversion\t",components[i]);
   const char *r=strstr(text,needle);if(!r)continue;
   r+=strlen(needle);const char *end=strchr(r,'\n'),*v=strchr(r,'\t');
   ui_add(s->observations,sizeof(s->observations),components[i]);ui_add(s->observations,sizeof(s->observations),": ");
   if(v&&(!end||v<end)){
    v++;size_t n=end?(size_t)(end-v):strlen(v);
    if(n>0&&n<96&&strspn(v,"0123456789. /CLI-v")==n){char val[96];memcpy(val,v,n);val[n]=0;ui_add(s->observations,sizeof(s->observations),val);}
    else ui_add(s->observations,sizeof(s->observations),zh?"版本未确认":"version unconfirmed");
   }else ui_add(s->observations,sizeof(s->observations),zh?"版本未确认":"version unconfirmed");
   ui_add(s->observations,sizeof(s->observations),"\r\n");
  }
 }
 if(!strcmp(action,"start")||!strcmp(action,"restart")||!strcmp(action,"stop")||!strcmp(action,"save-restart")||!strcmp(action,"preflight"))s->agent=0;
 int poll=!strcmp(action,"status"),lifecycle=!strcmp(action,"start")||!strcmp(action,"restart")||!strcmp(action,"save-restart");
 int was_pending=s->pending;int pending=code==11&&ui_result_pending(text);
 if(pending&&(lifecycle||poll)){
  s->pending=1;
  if(!poll||!s->failure){
   s->failure=0;
   snprintf(s->message,sizeof(s->message),"%s",zh?"启动中；尚未确认 HTTP 就绪，请等待状态观察。重复启动已禁用。":"Starting; HTTP readiness not yet confirmed, awaiting status observation. Duplicate start disabled.");
  }
 }
 if(poll&&s->pending&&code!=0&&!pending){
  s->pending=0;
  if(!s->failure){
   s->failure=1;snprintf(s->message,sizeof(s->message),"%s",ui_reason(text));
   s->report[0]=0;const char *cause=ui_safe_diag(s->report,sizeof(s->report),text);
   if(cause){ui_add(s->message,sizeof(s->message)," ");ui_add(s->message,sizeof(s->message),cause);}
  }
 }
 if(!poll&&code!=0&&!pending){
  s->pending=0;s->failure=1;snprintf(s->message,sizeof(s->message),"%s",ui_reason(text));
  s->report[0]=0;const char *cause=ui_safe_diag(s->report,sizeof(s->report),text);
  if(cause){ui_add(s->message,sizeof(s->message)," ");ui_add(s->message,sizeof(s->message),cause);}
 }
 if(strstr(text,"DIAG\tservice\townership\trunning\n"))s->running=1;
 if(strstr(text,"DIAG\tservice\townership\tstopped\n")||(!strcmp(action,"stop")&&code==0))s->running=0;
 if((poll&&!pending&&((strstr(text,"DIAG\thub\thttp\tavailable-shared-process\n")||strstr(text,"DIAG\tconnector\thttp\tshared-process-not-agent-readiness\n"))||strstr(text,"DIAG\tservice\townership\tstopped\n")))||(!strcmp(action,"stop")&&code==0)||(!poll&&code==0&&lifecycle))s->pending=0;
 if(poll&&was_pending&&!s->pending&&!s->failure)snprintf(s->message,sizeof(s->message),"%s",zh?"状态观察已返回；HTTP 与 Agent 就绪须独立确认。":"Status observation returned; HTTP and Agent readiness must be confirmed independently.");
 if(!poll&&code==0&&(!s->failure||lifecycle)){s->failure=0;snprintf(s->message,sizeof(s->message),"%s",zh?"操作已返回；HTTP 与 Agent 就绪须独立确认。":"Operation returned; HTTP and Agent readiness must be confirmed independently.");}
 if(!strcmp(action,"status")||!strcmp(action,"start")||!strcmp(action,"restart")||!strcmp(action,"stop")||!strcmp(action,"save-restart")){s->http_hub=s->http_connector=0;}
 if(strstr(text,"DIAG\thub\thttp\tavailable-shared-process\n"))s->http_hub=1;
 if(strstr(text,"DIAG\tconnector\thttp\tshared-process-not-agent-readiness\n"))s->http_connector=1;
 if(strstr(text,"DIAG\tclaude\tjob-readiness\tnative-preflight-passed-no-inference\n"))s->agent=1;
 if(!strcmp(action,"repair-claude-marker")){
  int stage=ui_repair_stage(text);s->agent=s->pending=0;
  if(code==0){
   s->running=s->http_hub=s->http_connector=0;s->failure=0;
   snprintf(s->message,sizeof(s->message),"%s",zh?"已备份一个遗留 Claude 标记；服务保持停止，未自动启动工作。请另行选择启动。":"Backed up one legacy Claude marker; service remains stopped and no workers were started.");
  }else if(strstr(text,"repair-cancelled-no-change")){
   s->running=s->http_hub=s->http_connector=0;s->failure=0;
   snprintf(s->message,sizeof(s->message),"%s",zh?"恢复已取消；没有移动标记，未自动启动。":"Recovery cancelled; no marker moved and service was not started.");
  }else if(stage){
   static const char *names_zh[]={"","原生接口","当前用户权限","受控请求","HOME 上层目录","HOME 私有目录","DB 命名空间","原 DB 文件","配置文件","配置一致性","标记、绑定与重启时序","提交握手","独占 DB 桥接","用户确认","提交前复核","不覆盖备份","备份后复核"};
   static const char *names_en[]={"","Native interface","Current user privilege","Controlled request","HOME parent directory","HOME private directory","DB namespace","Original DB file","Configuration file","Configuration consistency","Marker, binding & reboot chronology","Commit handshake","Exclusive DB bridge","User confirmation","Pre-commit recheck","No-overwrite backup","Post-backup recheck"};
   s->running=s->http_hub=s->http_connector=0;
   if(zh){
    snprintf(s->report,sizeof(s->report),"恢复阶段=%d; %s。仅固定枚举，无路径、凭据或标记正文。",stage,names_zh[stage]);
    if(stage==16)snprintf(s->message,sizeof(s->message),"备份可能已发生，但结果未确认（阶段 %d）；不要重试或还原。",stage);
    else snprintf(s->message,sizeof(s->message),"恢复未完成：%s（阶段 %d）；未自动恢复或启动工作。",names_zh[stage],stage);
   }else{
    snprintf(s->report,sizeof(s->report),"recoveryStage=%d; %s. Fixed enum only; no paths, credentials, or marker content.",stage,names_en[stage]);
    if(stage==16)snprintf(s->message,sizeof(s->message),"Backup may have occurred, but result is unconfirmed (stage %d); do not retry or restore.",stage);
    else snprintf(s->message,sizeof(s->message),"Recovery incomplete: %s (stage %d); no automatic recovery or worker startup.",names_en[stage],stage);
   }
  }else{
   snprintf(s->message,sizeof(s->message),"%s",zh?"恢复拒绝或结果未确认；不要自动重试。服务状态待确认，未自动恢复或启动工作。":"Recovery refused or result unconfirmed; do not retry automatically. Service status pending confirmation.");
  }
 }
}
#endif
