#include <assert.h>
#include <stdio.h>
#include "repair_policy.h"
int main(void){
 assert(repair_preboot(100,101,30000000));
 assert(!repair_preboot(0,101,30000000));
 assert(!repair_preboot(100,0,30000000));
 assert(!repair_preboot(100,101,0));
 assert(!repair_preboot(30000000,101,30000000));
 assert(!repair_preboot(100,30000001,30000000));
 assert(!repair_preboot(10000000,100,30000000));
 assert(!repair_preboot(10000001,100,30000000));
 puts("PASS preboot/currentboot/equality/unknown/positive-margin");
}
