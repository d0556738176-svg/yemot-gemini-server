import { answerBranch1Website } from './branch1-websites.js';
import { findBranch1Events } from './branch1-events.js';

// Explicitly enabled only on isolated staging; no caller audio or model calls.
export async function verifyBranch1PublicSources({search,extract,logger=console}={}) {
  const websiteState={};
  const outcomes=await Promise.allSettled([
    answerBranch1Website('פתח אתר הידברות וקרא מה שכתוב',websiteState,{search,extract}),
    findBranch1Events('אירועים השבוע בבית שמש',search,{extract})
  ]);
  const website=websiteState.currentWebsitePages?.[0];
  const result={
    website:{read:!!website?.content,url:website?.url||null,chars:website?.content?.length||0,offset:websiteState.currentWebsiteReadOffset||0},
    calendar:{completed:outcomes[1].status==='fulfilled',datedListings:outcomes[1].status==='fulfilled'&&String(outcomes[1].value).includes('מופיעים:'),answerChars:outcomes[1].status==='fulfilled'?String(outcomes[1].value).length:0}
  };
  logger.info('[BRANCH1 SOURCE CHECK]',JSON.stringify(result));
  return result;
}
