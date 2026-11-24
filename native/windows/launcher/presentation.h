/* Logical-pixel presentation contract; shared by production and fixture. */
enum {V_TITLE,V_BODY,V_SMALL}; enum {V_IDLE,V_POLL,V_ACTION};
static int v_column(int i){const int x[]={56,254,526,724};return x[i];}
static int v_row(int i){return 422+i*52;}
static int v_font(int role){const int size[]={23,13,11};return size[role];}
static int v_primary_dark(int primary,int disabled){(void)disabled;return primary;}
static int v_busy_reason(int checking,int poll){return !checking?V_IDLE:poll?V_POLL:V_ACTION;}
static inline int v_scale(int v,int dpi){return (v*dpi+48)/96;}
