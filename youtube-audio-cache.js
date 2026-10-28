// Persistent completion receipts live in Yemot beside the audio, not on Render's
// ephemeral disk. Only publish after ALL chunks have been uploaded and verified.
export function audioCachePaths(videoId, count) {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error('Invalid video ID');
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Invalid chunk count');
  const dir='/2/youtubeaudio/'+Buffer.from(videoId,'utf8').toString('hex');
  return Array.from({length:count},(_,i)=>dir+'/'+String(i+1).padStart(3,'0'));
}
export function audioManifestPath(videoId) {
  return 'ivr2:'+audioCachePaths(videoId,1)[0].replace(/\/001$/, '/complete.json');
}
export function verifiedAudioFile(data) {
  const n=Number(data?.file?.size);
  return data?.responseStatus==='OK' && data?.file?.exists===true && Number.isFinite(n) && n>44;
}
function validSavedPaths(paths) {
  return Array.isArray(paths) && paths.length>0 && paths.length<=10000 &&
    new Set(paths).size===paths.length &&
    paths.every(p=>typeof p==='string' && /^\/2\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+$/.test(p));
}
export function createAudioCache({getFile,readJson,writeJson,log=console}) {
  return {
    async lookup(videoId) {
      const manifest=await readJson(audioManifestPath(videoId));
      if (!manifest) return null;
      if (manifest.version!==1 || manifest.videoId!==videoId || manifest.complete!==true ||
          !Number.isInteger(manifest.chunkCount) || manifest.chunkCount<1 || manifest.chunkCount>10000) {
        throw Object.assign(new Error('Invalid audio completion receipt'),{code:'cache_invalid'});
      }
      const paths=manifest.playbackPaths;
      // Accept only safe extensionless files in branch 2, never a partial list.
      if (!validSavedPaths(paths) || paths.length!==manifest.chunkCount)
        throw Object.assign(new Error('Audio cache path mismatch'),{code:'cache_invalid'});
      for (const p of paths) {
        if (!verifiedAudioFile(await getFile('ivr2:'+p+'.wav'))) {
          throw Object.assign(new Error('Saved audio is missing or incomplete'),{code:'cache_incomplete'});
        }
      }
      log.info('[YouTube IVR] persistent audio cache hit',{videoId,chunks:paths.length,downloadSkipped:true});
      return {playbackPaths:paths,chunkCount:paths.length,cached:true};
    },
    async save(videoId,paths) {
      audioManifestPath(videoId); // validate identity before any IO
      if(!validSavedPaths(paths))
        throw Object.assign(new Error('Cannot save invalid audio paths'),{code:'cache_invalid'});
      for(const p of paths) {
        if(!verifiedAudioFile(await getFile('ivr2:'+p+'.wav')))
          throw Object.assign(new Error('Cannot cache unverified audio'),{code:'cache_incomplete'});
      }
      await writeJson(audioManifestPath(videoId),{
        version:1,videoId,complete:true,chunkCount:paths.length,playbackPaths:paths,createdAt:new Date().toISOString()
      });
      log.info('[YouTube IVR] persistent audio cache saved',{videoId,chunks:paths.length});
    }
  };
}
