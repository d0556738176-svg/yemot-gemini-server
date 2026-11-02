"""Isolated source/convert experiment. No IVR routes, credentials or provider API."""
import argparse, json, os, pathlib, subprocess, tempfile

def run(args, timeout):
    # communicate drains output while enforcing the deadline, even for silent children.
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        out, error = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        import signal
        os.killpg(p.pid, signal.SIGKILL)
        p.communicate()
        raise TimeoutError('stage deadline exceeded') from None
    if p.returncode:
        raise RuntimeError('stage failed (exit %s)' % p.returncode)
    return out

def inspect(path):
    data = json.loads(run(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_type','-of','json',str(path)],30))
    duration = float(data['format']['duration'])
    if duration <= 0 or not any(s.get('codec_type') == 'audio' for s in data.get('streams',[])):
        raise ValueError('missing audio or duration')
    return duration

def prepare(video_id, root, source=None, expected=None):
    import re
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
        raise ValueError('invalid video ID')
    folder = pathlib.Path(root) / video_id
    folder.mkdir(parents=True,exist_ok=True)
    # Local single-worker lease. A crash fails closed until reviewed.
    lock = folder / 'active.lock'
    fd = os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    os.close(fd)
    try:
        receipt = folder / 'ready.json'
        raw = folder / 'source.media'
        if not raw.exists():
            if source:
                import shutil
                shutil.copyfile(source,folder/'source.pending')
            else:
                # Native audio only: no MP3 encoding in the downloader.
                run(['yt-dlp','--no-playlist','--no-progress','--retries','2','--fragment-retries','2',
                     '--socket-timeout','30','-f','bestaudio','-o',str(folder/'source.pending'),
                     'https://www.youtube.com/watch?v='+video_id],1800)
            inspect(folder/'source.pending')
            os.replace(folder/'source.pending',raw)
        duration = inspect(raw)
        if expected and abs(duration-expected)>max(2,expected*.005):
            raise ValueError('source duration mismatch')
        target = folder/'phone.wav'
        if not target.exists():
            run(['ffmpeg','-nostdin','-v','error','-y','-i',str(raw),'-map','0:a:0','-vn',
                 '-ar','8000','-ac','1','-c:a','pcm_s16le','-f','wav',str(folder/'phone.pending')],900)
            converted = inspect(folder/'phone.pending')
            if abs(converted-duration)>max(2,duration*.005):
                raise ValueError('converted duration mismatch')
            os.replace(folder/'phone.pending',target)
        converted = inspect(target)
        if abs(converted-duration)>max(2,duration*.005):
            raise ValueError('cached duration mismatch')
        result={'videoId':video_id,'sourceBytes':raw.stat().st_size,'durationSec':converted,
                'converted':True,'yemotUploaded':False,'phonePlaybackVerified':False}
        tmp=folder/'ready.pending';tmp.write_text(json.dumps(result));os.replace(tmp,receipt)
        return result
    finally:
        lock.unlink(missing_ok=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('video_id');p.add_argument('--root',required=True)
    p.add_argument('--local-source');p.add_argument('--expected-seconds',type=float)
    a=p.parse_args();print(json.dumps(prepare(a.video_id,a.root,a.local_source,a.expected_seconds)))
