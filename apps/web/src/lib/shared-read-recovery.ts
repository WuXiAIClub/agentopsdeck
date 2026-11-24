/** Serial, read-only recovery. A wakeup never bypasses server backoff, and
 * stopping prevents both future reads and publication through the caller's scope guard. */
export function sharedReadRecovery({read,online=()=>navigator.onLine,now=()=>Date.now(),schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id),random=()=>Math.random()}:{
  read:()=>Promise<void>;online?:()=>boolean;now?:()=>number;
  schedule?:(fn:()=>void,ms:number)=>ReturnType<typeof setTimeout>;cancel?:(id:ReturnType<typeof setTimeout>)=>void;random?:()=>number;
}) {
  let stopped=false,running=false,failures=0,notBefore=0,timer:ReturnType<typeof setTimeout>|undefined;
  const enqueue=(ms:number)=>{if(stopped)return;if(timer!==undefined)cancel(timer);timer=schedule(()=>{timer=undefined;void tick();},Math.max(ms,notBefore-now(),0));};
  const tick=async()=>{
    if(stopped||running)return;
    if(!online()){enqueue(15000);return;}
    if(now()<notBefore){enqueue(notBefore-now());return;}
    running=true;
    try{await read();failures=0;notBefore=0;}
    catch(error){failures++;const retry=(error as {retryAfterMs?:number})?.retryAfterMs;
      notBefore=now()+Math.max(Math.min(15000,1500*2**Math.min(failures-1,4)),Number.isFinite(retry)?Math.max(0,retry!):0)+Math.floor(random()*500);
    }finally{running=false;if(!stopped)enqueue(failures?notBefore-now():15000);}
  };
  enqueue(0);
  return {wake:()=>{if(!running)enqueue(0);},stop:()=>{stopped=true;if(timer!==undefined)cancel(timer);}};
}
