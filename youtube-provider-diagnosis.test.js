import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyProviderTerminal,redactProviderDiagnostic} from './youtube-apify-source.js';
import {playbackFailureMessage} from './youtube-playback-prepare.js';
test('actual provider bot blockage wins over its later connection error',()=>{
 assert.equal(classifyProviderTerminal({status:'FAILED',statusMessage:'No videos were downloaded: 1 blocked on our side'},[
 'ERROR: aria2c exited with code 29','Sign in to confirm you are not a bot','TLS/SSL connection has been closed'
 ]),'apify_provider_blocked');
});
test('network, provider timeout and generic failures remain distinct',()=>{
 assert.equal(classifyProviderTerminal({status:'FAILED'},['SSL connection closed']),'apify_provider_network');
 assert.equal(classifyProviderTerminal({status:'TIMED-OUT'}),'apify_provider_timeout');
 assert.equal(classifyProviderTerminal({status:'FAILED'}),'apify_run_failed');
});
test('phone explains provider error without blaming local time or size',()=>{
 assert.ok(playbackFailureMessage('apify_provider_blocked').includes('נחסם'));
 assert.ok(playbackFailureMessage('apify_provider_network').includes('חיבור'));
 assert.ok(playbackFailureMessage('apify_provider_timeout').includes('הזמן שלו'));
});
test('diagnostics remove credentials and signed URLs',()=>{
 const value=redactProviderDiagnostic('ERROR secretValue https://host/path?token=abc password=pass123','secretValue');
 assert.ok(!value.includes('secretValue'));assert.ok(!value.includes('pass123'));assert.ok(!value.includes('https://'));
});

test('a "blocked on our side" summary with TLS/read-timeout detail is network trouble, not a bot-block',()=>{
 assert.equal(classifyProviderTerminal(
   {status:'FAILED',statusMessage:'This run produced no videos: 1 blocked on our side'},
   ['SSL/TLS handshake failure: Error in the pull function',
    "[youtube] 86eLl-ZYt4A: Unable to download API page: ...Read timed out (read timeout=20.0)"]
 ),'apify_provider_network');
});
test('an explicit bot-wall is still classified as a real block',()=>{
 assert.equal(classifyProviderTerminal(
   {status:'FAILED',statusMessage:'blocked on our side'},
   ['Sign in to confirm you are not a bot']
 ),'apify_provider_blocked');
});
test('a generic "blocked on our side" with no network or bot detail stays a block',()=>{
 assert.equal(classifyProviderTerminal({status:'FAILED',statusMessage:'1 blocked on our side'},[]),'apify_provider_blocked');
});
