#ifndef AOD_REPAIR_POLICY_H
#define AOD_REPAIR_POLICY_H
#include <stdint.h>
/* Exact OS UTC boot time. Strictly more than two seconds BEFORE boot;
 * no after-boot tolerance and no uptime/wall-clock reconstruction. */
static int repair_preboot(uint64_t birth,uint64_t write,uint64_t boot){
 const uint64_t margin=20000000;
 return birth && write && boot>margin && birth<boot-margin && write<boot-margin;
}
#endif
