/**
 * /2/8 live television AUDIO, using a separate external SIP/media server.
 * Explicitly does NOT use Yemot internet broadcast / music_on_hold.
 *
 * A SIP endpoint (for example Asterisk with FFmpeg) ingests authorised
 * channel feeds, turns them into G.711 telephone audio, and answers calls.
 * Yemot is only the inbound telephone router.
 *
 * An enabled flag and six approved SIP destinations are mandatory; no
 * incomplete routes are published to real callers.
 */
export const TV_CHANNELS=Object.freeze([
  {key:'1',title:'כאן 11',env:'BRANCH2_TV_KAN11_SIP'},
  {key:'2',title:'ערוץ 12',env:'BRANCH2_TV_12_SIP'},
  {key:'3',title:'ערוץ 13',env:'BRANCH2_TV_13_SIP'},
  {key:'4',title:'ערוץ 14',env:'BRANCH2_TV_14_SIP'},
  {key:'5',title:'איי 24 ניוז',env:'BRANCH2_TV_I24_SIP'},
  {key:'6',title:'ערוץ הכנסת',env:'BRANCH2_TV_KNESSET_SIP'}
]);
const enabled=env=>/^(1|yes|true|on)$/i.test(String(env.BRANCH2_LIVE_TV_ENABLED||''));
const say=t=>[{type:'text',data:t}];
export const configuredTvChannels=(env=process.env)=>TV_CHANNELS.map(c=>({...c,destination:String(env[c.env]||'').trim()}));
// Never allow injection into UpdateExtension or routing outside the approved SIP domain.
// Hostnames and trusted IPs are supplied by the operator, not by the caller.
export function validSipDestination(input) {
  if(!input || input.length>160 || /[\s\r\n=&?#]/.test(input)) return false;
  return /^(?:[a-z0-9_.-]+@)?[a-z0-9.-]+(?::[0-9]{2,5})?$/i.test(input);
}
export function branch2TvStatus(env=process.env) {
  const missing=configuredTvChannels(env).filter(c=>!validSipDestination(c.destination)).map(c=>c.key);
  return {enabled:enabled(env),ready:enabled(env)&&missing.length===0,missing};
}
export async function branch2TvHandler(call) {
  const status=branch2TvStatus();
  if(!status.ready) {
    await call.read(say('שידורי הטלוויזיה עדיין אינם מחוברים לשרת השמע'), 'tap', {max_digits:1,min_digits:1,sec_wait:3,allow_empty:true,empty_val:'x'});
    return call.go_to_folder('/2');
  }
  const menu=TV_CHANNELS.map(c=>'ל'+c.title+' הקישו '+c.key).join(' ')+' לחזרה הקישו כוכבית';
  const key=await call.read(say(menu),'tap',{max_digits:1,min_digits:1,sec_wait:9,digits_allowed:[1,2,3,4,5,6],amount_attempts:2});
  if(!/^[1-6]$/.test(String(key))) return call.go_to_folder('/2');
  return call.go_to_folder('/2/8/'+key);
}
export async function configureBranch2Tv({updateExtension,publicUrl,env=process.env}) {
  const status=branch2TvStatus(env);
  if(!status.ready){
    console.info('[TV2/8] SIP routes not provisioned; missing endpoints or flag',status);
    return status;
  }
  if(!/^https:\/\//i.test(publicUrl||'')) throw new Error('HTTPS PUBLIC_BASE_URL required');
  for(const channel of configuredTvChannels(env)){
    await updateExtension('ivr2:/2/8/'+channel.key,{
      type:'routing_ip',
      routing_ip:channel.destination,
      routing_ip_end_goto:'/2/8',
      title:channel.title
    });
  }
  await updateExtension('ivr2:/2/8',{
    type:'api',api_link:publicUrl.replace(/\/$/,'')+'/yemot-tv',title:'שידורים חיים'
  });
  console.info('[TV2/8] external SIP routing configured; live audio still requires phone verification');
  return {...status,provisioned:true};
}
