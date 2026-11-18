/**
 * Sub-extension /2/8: six live TV audio feeds on Yemot.
 *
 * Yemot's "internet live broadcast" first needs a permitted, working stream
 * registered under a NAME in the Yemot management dashboard. A web watch URL,
 * a YouTube page, or an HLS playlist name cannot be passed directly here.
 *
 * No stream URL or copyrighted feed is extracted/proxied by this module.
 * Configuration is opt-in, independent of the existing extension /2 player,
 * and never changes /2 itself.
 */
export const TV_CHANNELS = Object.freeze([
  { key:'1', title:'כאן 11', env:'BRANCH2_TV_KAN11_STREAM' },
  { key:'2', title:'ערוץ 12', env:'BRANCH2_TV_12_STREAM' },
  { key:'3', title:'ערוץ 13', env:'BRANCH2_TV_13_STREAM' },
  { key:'4', title:'ערוץ 14', env:'BRANCH2_TV_14_STREAM' },
  { key:'5', title:'איי 24 ניוז', env:'BRANCH2_TV_I24_STREAM' },
  { key:'6', title:'ערוץ הכנסת', env:'BRANCH2_TV_KNESSET_STREAM' }
]);

const isEnabled = env => /^(1|true|yes|on)$/i.test(String(env.BRANCH2_LIVE_TV_ENABLED||''));
const speech = message => [{type:'text', data:message}];
export function configuredTvChannels(env=process.env) {
  return TV_CHANNELS.map(c=>({...c, stream:String(env[c.env]||'').trim()}));
}
export function validStreamName(name) {
  // Use a registered *name*, never an arbitrary address or INI fragment.
  return Boolean(name) && name.length<=90 && !/[\r\n=,\/\\]/.test(name) && !/:\/\//.test(name);
}
export function tvChannelIni(channel, maxSeconds=10800) {
  if (!validStreamName(channel.stream)) throw new Error('Invalid live stream name: '+channel.key);
  const seconds=Math.max(60,Math.min(10800,Math.floor(Number(maxSeconds)||10800)));
  return {
    type:'music_on_hold',
    title:channel.title,
    music_on_hold:channel.stream+','+seconds,
    music_on_hold_end_goto:'/2/8'
  };
}
export function branch2TvStatus(env=process.env) {
  const channels=configuredTvChannels(env);
  const invalid=channels.filter(x=>!validStreamName(x.stream)).map(x=>x.key);
  return {enabled:isEnabled(env),ready:isEnabled(env)&&!invalid.length,missing:invalid};
}
export async function branch2TvHandler(call) {
  const status=branch2TvStatus();
  if(!status.ready) {
    await call.read(speech('השידורים החיים עדיין לא חוברו למקורות שידור מאושרים'), 'tap', {
      max_digits:1,min_digits:1,sec_wait:3,allow_empty:true,empty_val:'x'
    });
    return call.go_to_folder('/2');
  }
  const channels=configuredTvChannels();
  const menu=channels.map(c=>'ל'+c.title+' הקישו '+c.key).join('. ')+'. לחזרה הקישו כוכבית';
  const selected=await call.read(speech(menu),'tap',{
    max_digits:1,min_digits:1,sec_wait:9,
    digits_allowed:[1,2,3,4,5,6],
    amount_attempts:2
  });
  if(!/^[1-6]$/.test(String(selected))) return call.go_to_folder('/2');
  return call.go_to_folder('/2/8/'+selected);
}
export async function configureBranch2Tv({updateExtension,publicUrl,env=process.env}) {
  const status=branch2TvStatus(env);
  if (!status.ready) {
    console.info('[TV2/8] not provisioned: disabled or missing validated stream names',status);
    return status;
  }
  if(!publicUrl || !/^https:\/\//.test(publicUrl)) throw new Error('HTTPS PUBLIC_BASE_URL required');
  // Provision children first. No changes to /2 or other unrelated extensions.
  for(const channel of configuredTvChannels(env)) {
    await updateExtension('ivr2:/2/8/'+channel.key,tvChannelIni(channel));
  }
  await updateExtension('ivr2:/2/8',{
    type:'api',api_link:publicUrl.replace(/\/$/,'')+'/yemot-tv',title:'שידורים חיים'
  });
  console.info('[TV2/8] six child extensions provisioned. Stream playback still requires live telephone verification.');
  return {...status,provisioned:true};
}
