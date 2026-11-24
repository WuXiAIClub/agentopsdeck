#ifndef UI_DIAGNOSTICS_H
#define UI_DIAGNOSTICS_H
#include <stdlib.h>
#include <ctype.h>
/* Bounded JSON syntax reader; only top-level exact keys enter fixed outputs.
   Unknown strings/objects are skipped, never searched for diagnostic text. */
typedef struct {const char *p,*end;int tokens;} UI_JSON;
typedef struct {char operation[64],phase[32],category[16],stage[32];double nums[16];unsigned present;int exit_present;double exit_code;} UI_DIAG;
static void uj_ws(UI_JSON *j){while(j->p<j->end&&strchr(" \r\n\t",*j->p))j->p++;}
static int uj_string(UI_JSON *j,char *out,size_t cap){
 if(j->p>=j->end||*j->p++!='"')return 0;
 size_t n=0;int escaped=0;
 while(j->p<j->end){unsigned char c=(unsigned char)*j->p++;if(c=='"'){if(cap)out[n<cap?n:cap-1]=0;if(escaped&&cap)out[0]=0;return 1;}if(c<32)return 0;
 if(c=='\\'){escaped=1;if(j->p==j->end)return 0;char e=*j->p++;if(e=='u'){for(int k=0;k<4;k++)if(j->p==j->end||!isxdigit((unsigned char)*j->p++))return 0;}else if(!strchr("\"\\/bfnrt",e))return 0;}
 if(cap&&n+1<cap)out[n++]=(char)c;else if(cap)escaped=1;
 }return 0;
}
static int uj_number(UI_JSON *j,double *v){const char *p=j->p;if(p<j->end&&*p=='-')p++;if(p==j->end)return 0;
 if(*p=='0')p++;else{if(*p<'1'||*p>'9')return 0;while(p<j->end&&isdigit((unsigned char)*p))p++;}
 if(p<j->end&&*p=='.'){p++;if(p==j->end||!isdigit((unsigned char)*p))return 0;while(p<j->end&&isdigit((unsigned char)*p))p++;}
 if(p<j->end&&(*p=='e'||*p=='E')){p++;if(p<j->end&&(*p=='+'||*p=='-'))p++;if(p==j->end||!isdigit((unsigned char)*p))return 0;while(p<j->end&&isdigit((unsigned char)*p))p++;}
 size_t n=(size_t)(p-j->p);if(n>=32)return 0;char b[32];memcpy(b,j->p,n);b[n]=0;*v=strtod(b,NULL);j->p=p;return 1;
}
static int uj_value(UI_JSON *j,int depth){uj_ws(j);if(depth>8||++j->tokens>256||j->p==j->end)return 0;
 if(*j->p=='"')return uj_string(j,NULL,0);
 if(*j->p=='{'||*j->p=='['){char open=*j->p++,close=open=='{'?'}':']';uj_ws(j);if(j->p<j->end&&*j->p==close){j->p++;return 1;}
 for(;;){if(open=='{'){if(!uj_string(j,NULL,0))return 0;uj_ws(j);if(j->p==j->end||*j->p++!=':')return 0;}if(!uj_value(j,depth+1))return 0;uj_ws(j);if(j->p==j->end)return 0;if(*j->p==close){j->p++;return 1;}if(*j->p++!=',')return 0;uj_ws(j);}}
 const char *l[]={"true","false","null"};for(int i=0;i<3;i++){size_t n=strlen(l[i]);if((size_t)(j->end-j->p)>=n&&!strncmp(j->p,l[i],n)){j->p+=n;return 1;}}
 double v;return uj_number(j,&v);
}
static int ud_in(const char *v,const char *list){char needle[96];snprintf(needle,sizeof(needle),"|%s|",v);return *v&&strstr(list,needle)!=NULL;}
static const char *ud_keys[]={"step","startupStage","ownerFailureCode","leaseStage","controlReason","controlTarget","aclReason","elapsedMs","pending","unknown","timedOut","admissionRefusalCode","sqlErrorCode","rollbackErrorCode","code"};
static int ud_num_valid(int i,double v){
 if(!(v>=0&&v<=9007199254740991.0))return 0;
 if(i!=7&&v!=(double)(long long)v)return 0;
 if(i==1)return v>=1&&v<=2;
 if(i==2)return v>=1&&v<=6;
 if(i==3)return v>=10&&v<=24;
 if(i==4)return v>=1&&v<=7;
 if(i==5||i==6)return v>=1&&v<=4;
 return 1;
}
static int ud_exit(UI_JSON *j,UI_DIAG *r){
 uj_ws(j);if(j->p==j->end||*j->p++!='{')return 0;
 int seen=0;
 for(;;){
  char key[64];uj_ws(j);if(!uj_string(j,key,sizeof(key)))return 0;
  uj_ws(j);if(j->p==j->end||*j->p++!=':')return 0;
  uj_ws(j);
  if(!strcmp(key,"code")){
   if(seen++)return 0;
   if((size_t)(j->end-j->p)>=4&&!strncmp(j->p,"null",4))j->p+=4;
   else{double v;if(!uj_number(j,&v)||v< -2147483648.0||v>4294967295.0||v!=(double)(long long)v)return 0;r->exit_present=1;r->exit_code=v;}
  }else if(!uj_value(j,1))return 0;
  uj_ws(j);if(j->p==j->end)return 0;
  if(*j->p=='}'){j->p++;return 1;}
  if(*j->p++!=',')return 0;
 }
}
static int ud_parse(const char *p,size_t n,UI_DIAG *r){
 if(n>8192)return 0;
 UI_JSON j={p,p+n,0};memset(r,0,sizeof(*r));uj_ws(&j);if(j.p==j.end||*j.p++!='{')return 0;
 char seen[40][64];int count=0;
 for(;;){
  uj_ws(&j);if(j.p<j.end&&*j.p=='}'){j.p++;break;}
  char k[64];if(count>=40||!uj_string(&j,k,sizeof(k)))return 0;
  for(int a=0;a<count;a++)if(!strcmp(k,seen[a]))return 0;
  strcpy(seen[count++],k);uj_ws(&j);if(j.p==j.end||*j.p++!=':')return 0;
  uj_ws(&j);
  char *dest=NULL;size_t cap=0;
  if(!strcmp(k,"operation")){dest=r->operation;cap=sizeof(r->operation);}
  if(!strcmp(k,"phase")){dest=r->phase;cap=sizeof(r->phase);}
  if(!strcmp(k,"category")){dest=r->category;cap=sizeof(r->category);}
  if(!strcmp(k,"stage")){dest=r->stage;cap=sizeof(r->stage);}
  if(dest){if(!uj_string(&j,dest,cap))return 0;}
  else if(!strcmp(k,"childExit")){if(!ud_exit(&j,r))return 0;}
  else{
   int i;for(i=0;i<15;i++)if(!strcmp(k,ud_keys[i]))break;
   if(i<15){double v;if(!uj_number(&j,&v)||!ud_num_valid(i,v))return 0;r->nums[i]=v;r->present|=1u<<i;}
   else if(!uj_value(&j,0))return 0;
  }
  uj_ws(&j);if(j.p==j.end)return 0;
  if(*j.p=='}'){j.p++;break;}
  if(*j.p++!=',')return 0;
  uj_ws(&j);if(j.p<j.end&&*j.p=='}')return 0;
 }
 uj_ws(&j);if(j.p!=j.end)return 0;
 if(*r->operation&&!ud_in(r->operation,"|process-startup|process-shutdown|process-shutdown-owner|connector-runtime-assembly|combined-application-layer|standalone-connector-layer|sdk-owned-lifecycle|storage-startup-owner|storage-startup-cleanup|storage-startup-admission|storage-coordinator-startup|connector-startup-task|shutdown-drain|shutdown-cleanup|application-drain|"))return 0;
 if(*r->category&&!ud_in(r->category,"|routine|slow|failed|"))return 0;
 if(*r->phase&&!ud_in(r->phase,"|pending|finished|starting|exited|spawn-failed|monitor-failed|"))return 0;
 if(*r->stage&&!ud_in(r->stage,"|monitor|monitor-ownership|spawn|guard|prepare|acquire|import|imported|duplicate|failed|observation|sdk-owned-lifecycle|env-schema|native-preflight|"))return 0;
 if(*r->operation&&(!ud_in(r->phase,"|pending|finished|")||!*r->category||!(r->present&(1u<<7))))return 0;
 return *r->operation||*r->stage;
}
static const char *ud_cause(const UI_DIAG *r){
 if(!(r->present&(1u<<4)))return NULL;
 int reason=(int)r->nums[4];
 int zh=ui_is_zh();
 const char *reasons_zh[]={"", "Windows 权限检查环境无效", "Windows权限检查超时", "Windows 权限检查无法启动", "Windows 权限检查未成功", "Windows 权限检查结果未确认", "Windows 权限检查拒绝", "Windows 权限检查调用异常"};
 const char *reasons_en[]={"", "Windows permission check environment invalid", "Windows permission check timed out", "Windows permission check failed to start", "Windows permission check did not succeed", "Windows permission check result unconfirmed", "Windows permission check refused", "Windows permission check invocation error"};
 const char *acl_zh[]={"Windows 权限检查拒绝", "专用目录存在重解析点", "专用目录所有者不匹配", "专用目录允许其他主体访问", "Windows 权限检查脚本异常"};
 const char *acl_en[]={"Windows permission check refused", "Dedicated directory contains a reparse point", "Dedicated directory owner mismatch", "Dedicated directory allows access to other principals", "Windows permission check script error"};
 if(reason==6&&(r->present&(1u<<6)))return zh?acl_zh[(int)r->nums[6]]:acl_en[(int)r->nums[6]];
 return zh?reasons_zh[reason]:reasons_en[reason];
}
static void ud_render(char *out,size_t cap,const UI_DIAG *r){
 const char *values[]={r->operation,r->phase,r->category,r->stage};const char *keys[]={"operation","phase","category","stage"};
 for(int i=0;i<4;i++)if(*values[i]){ui_add(out,cap,keys[i]);ui_add(out,cap,": ");ui_add(out,cap,values[i]);ui_add(out,cap,"\r\n");}
 for(int i=0;i<15;i++)if(r->present&(1u<<i)){char b[64];snprintf(b,sizeof(b),"%s: %.15g\r\n",ud_keys[i],r->nums[i]);ui_add(out,cap,b);}
 if(r->exit_present){char b[64];snprintf(b,sizeof(b),"exit: %.0f\r\n",r->exit_code);ui_add(out,cap,b);}
 const char *cause=ud_cause(r);if(cause){ui_add(out,cap,ui_is_zh()?"原因: ":"Cause: ");ui_add(out,cap,cause);ui_add(out,cap,"\r\n");}
}
static const char *ui_safe_diag(char *out,size_t cap,const char *text){
 UI_DIAG first={0};int found=0;char other[3072]="";const char *p=text;
 while(*p){
  const char *e=strchr(p,'\n');size_t n=e?(size_t)(e-p):strlen(p);
  if(n>17&&!strncmp(p,"DIAG\tstartup\tevent\t",19)){
   UI_DIAG r;
   if(ud_parse(p+19,n-19,&r)){
    if(!strcmp(r.category,"failed")){if(!found){first=r;found=1;}}
    else if(*r.stage)ud_render(other,sizeof(other),&r);
   }
  }
  if(!e)break;
  p=e+1;
 }
 if(found){
  ui_add(out,cap,ui_is_zh()?"首个失败事件（不以级联退出覆盖）\r\n":"First failure event (not overwritten by cascading exits)\r\n");
  ud_render(out,cap,&first);
  ui_add(out,cap,other);
  return ud_cause(&first);
 }
 ui_add(out,cap,other);
 return NULL;
}
#endif
