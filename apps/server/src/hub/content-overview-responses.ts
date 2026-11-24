import { HubMemberRequestError } from './async-member-request.js';
import { CONTENT_OVERVIEW_RESPONSE_BYTES } from './content-overview-domain.js';

// Four small revocation responses remain admissible while one legal bulk
// response occupies its entire pool. This adds a fixed 640KiB control reserve,
// never another journal-sized slot or an unbounded queue of response bodies.
export const CONTENT_CONTROL_RESPONSE_BYTES=16*1024;
export const CONTENT_CONTROL_RESPONSE_CAPACITY=4*(6*CONTENT_CONTROL_RESPONSE_BYTES+65536);

/** Independent from SQL/control-lane admission. Account for UTF-16 parsed
 * content and JSON, encoded response and bounded stream copies. A single
 * original legal journal-sized overview remains admissible. No waiting queue
 * may retain large bodies, and unconsumed responses keep their reservation. */
export class ContentOverviewResponses {
  private used=0;
  private controlUsed=0;
  private closed=false;
  private readonly delivered=new Set<()=>void>();
  constructor(private readonly capacity=6*CONTENT_OVERVIEW_RESPONSE_BYTES+65536) {}
  get reservedBytes(){return this.used+this.controlUsed;}
  get capacityBytes(){return this.capacity+CONTENT_CONTROL_RESPONSE_CAPACITY;}
  reserve(bytes:number) {
    return this.allocate(bytes,false);
  }
  /** Only small, fixed-schema control replies may use this lane. */
  reserveControl() {
    return this.allocate(CONTENT_CONTROL_RESPONSE_BYTES,false,true);
  }
  /** Conflict JSON can repeat one immutable historical body 128 times. Charge
   * retained unique encoded fragments, not repeated wire references. The same
   * global ceiling is kept: 2*(3*C) == 6*C. Connector local JSON uses <=C;
   * Hub raw canonical JSON content can double when encoded, so reserve <=2*C
   * for unique historical snapshots. The remaining 3*C weighted space covers
   * the parsed view, one bounded RPC/serialization and copied stream chunks.
   * There is no joined giant string or retained duplicate snapshot string.
   * Reserve BEFORE reading the Connector view; validate the complete response
   * before publication so a failed proof still returns the original error. */
  reserveParts(bytes=3*CONTENT_OVERVIEW_RESPONSE_BYTES) {
    return this.allocate(bytes,true);
  }
  private allocate(bytes:number,fragmented:boolean,control=false) {
    const weight=(fragmented?2:6)*bytes+65536;
    const used=control?this.controlUsed:this.used,capacity=control?CONTENT_CONTROL_RESPONSE_CAPACITY:this.capacity;
    if(this.closed||!Number.isSafeInteger(bytes)||bytes<=0||bytes>(control?CONTENT_CONTROL_RESPONSE_BYTES:(fragmented?3:1)*CONTENT_OVERVIEW_RESPONSE_BYTES)||used+weight>capacity)
      throw new HubMemberRequestError(503);
    if(control)this.controlUsed+=weight;else this.used+=weight;
    let released=false,delivered=false;
    let encodedBytes=0;const encoded=new Set<Uint8Array>();
    const release=()=>{if(!released){released=true;encoded.clear();if(control)this.controlUsed-=weight;else this.used-=weight;}};
    const encode=(body:string)=>{
      const size=Buffer.byteLength(body);
      if(released||delivered||this.closed||encodedBytes+size>bytes)throw new HubMemberRequestError(503);
      const part=new TextEncoder().encode(body);encoded.add(part);encodedBytes+=size;return part;
    };
    const responseParts=(parts:readonly Uint8Array[],signal:AbortSignal,onFinish:()=>void=()=>{}):Response=>{
      if(released||delivered||this.closed||signal.aborted||parts.length>1024||parts.some(p=>!encoded.has(p)))throw new HubMemberRequestError(503);
      let payload:Uint8Array[]|undefined=[...parts],index=0,offset=0;
      delivered=true;let finished=false;
      let control:ReadableStreamDefaultController<Uint8Array>;
      const finish=()=>{if(finished)return;finished=true;payload=undefined;signal.removeEventListener('abort',abort);this.delivered.delete(abort);release();onFinish();};
      const abort=()=>{if(finished)return;control.error(new Error('shared_content_response_closed'));finish();};
      const stream=new ReadableStream<Uint8Array>({
        start(controller){control=controller;},
        pull(controller){
          if(!payload)return;
          while(index<payload.length&&offset===payload[index]!.length){index++;offset=0;}
          if(index===payload.length){controller.close();finish();return;}
          const part=payload[index]!,end=Math.min(offset+65536,part.length);
          // Copy the chunk: a retained last chunk must not retain a 64MiB
          // backing buffer after its reservation has been released.
          controller.enqueue(part.slice(offset,end));offset=end;
        },
        cancel(){finish();},
      },{highWaterMark:0});
      this.delivered.add(abort);signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted||this.closed)abort();
      try{return new Response(stream,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
      catch(error){abort();throw error;}
    };
    const response=(body:string,signal:AbortSignal,onFinish?:()=>void)=>responseParts([encode(body)],signal,onFinish);
    return {response,encode,responseParts,release:()=>{if(!delivered)release();}};
  }
  close(){this.closed=true;for(const cancel of [...this.delivered])cancel();}
}

/** Shared by every Hub composition in this process, not one budget per route. */
export const contentOverviewResponses=new ContentOverviewResponses();
