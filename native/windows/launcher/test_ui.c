#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <stdio.h>
#include "ui_state.h"

static void test_english_locale_rendering(void){
#ifdef _WIN32
 _putenv("AOD_UI_LOCALE=en");
#else
 setenv("AOD_UI_LOCALE","en",1);
#endif
 UI_STATE s={0};
 ui_apply(&s,"check",0,"DIAG\tcodex\tversion\tunknown\tinvalid_val!\n");
 assert(strstr(s.observations,"version unconfirmed")!=NULL);
 ui_apply(&s,"start",11,"RESULT\t11\tStarting; HTTP readiness is not yet confirmed and the service was not terminated; reload status shortly (stage: spawn)\n");
 assert(s.pending==1);
 assert(strstr(s.message,"Starting; HTTP readiness not yet confirmed")!=NULL);
 ui_apply(&s,"repair-claude-marker",12,"RESULT\t12\trepair-native-refused-4\n");
 assert(s.failure==1);
 assert(strstr(s.report,"recoveryStage=4; HOME parent directory.")!=NULL);
 assert(strstr(s.message,"Recovery incomplete: HOME parent directory (stage 4)")!=NULL);
#ifdef _WIN32
 _putenv("AOD_UI_LOCALE=zh-CN");
#else
 setenv("AOD_UI_LOCALE","zh-CN",1);
#endif
}

int main(void){
#ifdef _WIN32
 _putenv("AOD_UI_LOCALE=zh-CN");
#else
 setenv("AOD_UI_LOCALE","zh-CN",1);
#endif
 UI_STATE s={0};s.running=s.agent=s.http_hub=s.http_connector=s.failure=1;
 ui_apply(&s,"repair-claude-marker",0,"RESULT\t0\trepair-backed-up-no-workers-started\n");
 assert(!s.running&&!s.agent&&!s.http_hub&&!s.http_connector&&!s.failure);assert(strstr(s.message,"备份"));
 for(int i=1;i<=16;i++){char line[128],want[64];snprintf(line,sizeof(line),"RESULT\t12\trepair-native-refused-%d\n",i);snprintf(want,sizeof(want),"恢复阶段=%d;",i);ui_apply(&s,"repair-claude-marker",12,line);assert(s.failure);assert(strstr(s.report,want));if(i==16)assert(strstr(s.message,"可能已发生"));}
 const char *invalid[]={"0","17","01","-1","4-secret","4\tprivate-path"};
 for(size_t i=0;i<sizeof(invalid)/sizeof(invalid[0]);i++){char line[128];snprintf(line,sizeof(line),"RESULT\t12\trepair-native-refused-%s\n",invalid[i]);ui_apply(&s,"repair-claude-marker",12,line);assert(!strstr(s.report,"恢复阶段="));assert(!strstr(s.report,"private-path"));}
 ui_apply(&s,"repair-claude-marker",12,"RESULT\t12\trepair-native-refused-4\nRESULT\t12\trepair-native-refused-5\n");assert(!strstr(s.report,"恢复阶段="));
 ui_apply(&s,"repair-claude-marker",12,"RESULT\t12\trepair-native-refused-4\nSECRET_TOKEN private-path\n");assert(!strstr(s.report,"SECRET_TOKEN"));assert(!strstr(s.report,"private-path"));
 test_english_locale_rendering();
 puts("PASS UI repair success, bounded stage1..16, postrename ambiguity, malformed/duplicate, secret suppression, and EN/zh-CN locale parity");
}
