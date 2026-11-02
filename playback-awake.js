// Keep only the local preparation process awake. Apify's external terminal
// webhooks wake a stopped instance; an in-process timer alone cannot do that.
export function createPlaybackAwake({env=process.env,fetchImpl=fetch,setIntervalImpl=setInterval,clearIntervalImpl=clearInterval,log=console}={}) {
  const leases=new Set();let timer=null,inflight=false;
  log.info?.('[YouTube IVR] preparation keep-awake configured',{enabled:String(env.BRANCH2_KEEPALIVE||'on').toLowerCase()!=='off',publicUrlConfigured:!!(env.RENDER_EXTERNAL_URL||env.PUBLIC_BASE_URL)});
  async function ping(){
    if(!leases.size||inflight)return;
    inflight=true;
    try {
      const base=String(env.RENDER_EXTERNAL_URL||env.PUBLIC_BASE_URL||'').trim().replace(/\/+$/,'');
      const r=await fetchImpl(base+'/health',{signal:AbortSignal.timeout(10000)});
      if(!r.ok)throw Error('HTTP '+r.status);
      // Consume/close the response, so periodic requests do not retain sockets.
      await r.body?.cancel();
      log.info?.('[YouTube IVR] preparation keep-awake confirmed',{active:leases.size});
    }catch(e){log.warn?.('[YouTube IVR] preparation keep-awake failed',{active:leases.size,message:String(e?.message||'request failed').slice(0,80)});}
    finally{inflight=false;}
  }
  function acquire(){
    const base=String(env.RENDER_EXTERNAL_URL||env.PUBLIC_BASE_URL||'').trim();
    if(String(env.BRANCH2_KEEPALIVE||'on').toLowerCase()==='off'||!/^https:\/\//.test(base))return ()=>{};
    const lease={};leases.add(lease);
    if(!timer){
      const configured=Number(env.BRANCH2_KEEPALIVE_MS);
      // Always below Render's 15-minute idle threshold, even with a bad setting.
      const interval=Number.isFinite(configured)&&configured>0?Math.max(60000,Math.min(300000,configured)):120000;
      timer=setIntervalImpl(()=>void ping(),interval);timer.unref?.();
      void ping();
      log.info?.('[YouTube IVR] preparation keep-awake started');
    }
    let released=false;
    return ()=>{
      if(released)return;released=true;leases.delete(lease);
      if(!leases.size&&timer){clearIntervalImpl(timer);timer=null;log.info?.('[YouTube IVR] preparation keep-awake stopped');}
    };
  }
  return {acquire,activeCount:()=>leases.size};
}
export const playbackAwake=createPlaybackAwake();
