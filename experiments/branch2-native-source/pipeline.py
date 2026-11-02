"""Isolated source/convert experiment. No IVR routes, credentials or provider API."""
import argparse, json, os, pathlib, subprocess, tempfile, wave

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
        import re
        detail=error.decode('utf-8',errors='replace')[-4000:]
        detail=re.sub(r'https?://\S+','[url]',detail)
        detail=re.sub(r'(?i)(cookie|token|authorization|password)[=: ]+\S+',r'\1=[redacted]',detail)
        raise RuntimeError('stage failed (exit %s): %s' % (p.returncode,detail))
    return out

def inspect(path):
    import math
    with open(path,'rb') as f:
        header=f.read(512).lstrip().lower()
    if header.startswith((b'<html',b'<!doctype html',b'<?xml')):
        raise ValueError('media_unavailable: received a document instead of audio')
    data = json.loads(run(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_type','-of','json',str(path)],30))
    duration = float(data['format']['duration'])
    if not math.isfinite(duration) or duration <= 0 or not any(s.get('codec_type') == 'audio' for s in data.get('streams',[])):
        raise ValueError('missing audio or duration')
    return duration

def validate_phone(path, expected):
    import wave
    duration = inspect(path)
    if abs(duration-expected)>max(2,expected*.005):
        raise ValueError('converted duration mismatch')
    # RIFF headers alone can describe audio that was never written.
    with wave.open(str(path),'rb') as wav:
        if (wav.getnchannels(),wav.getsampwidth(),wav.getframerate()) != (1,2,8000):
            raise ValueError('unexpected phone audio format')
        frames = 0
        while True:
            block = wav.readframes(65536)
            if not block: break
            frames += len(block)//2
        if frames != wav.getnframes() or abs(frames/8000-expected)>max(2,expected*.005):
            raise ValueError('truncated phone audio')
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
                trust=['--compat-options','no-certifi'] if os.environ.get('SSL_CERT_FILE') else []
                run(['yt-dlp',*trust,'--js-runtimes','node','--no-playlist','--no-progress','--retries','2','--fragment-retries','2',
                     '--socket-timeout','30','-f','bestaudio','-o',str(folder/'source.pending'),
                     'https://www.youtube.com/watch?v='+video_id],1800)
            inspect(folder/'source.pending')
            os.replace(folder/'source.pending',raw)
        duration = inspect(raw)
        if expected and abs(duration-expected)>max(2,expected*.005):
            raise ValueError('source duration mismatch')
        target = folder/'phone.wav'
        if target.exists():
            try:
                validate_phone(target,duration)
            except (ValueError,RuntimeError,EOFError,wave.Error):
                target.unlink()
                receipt.unlink(missing_ok=True)
        if not target.exists():
            import shutil
            # PCM mono 8kHz requires 16,000 bytes/sec; retain a 64MiB reserve.
            required = int(duration*16000)+64*1024*1024
            if shutil.disk_usage(folder).free < required:
                raise OSError('insufficient space for conversion; source retained')
            run(['ffmpeg','-nostdin','-v','error','-xerror','-y','-i',str(raw),'-map','0:a:0','-vn',
                 '-ar','8000','-ac','1','-c:a','pcm_s16le','-f','wav',str(folder/'phone.pending')],900)
            validate_phone(folder/'phone.pending',duration)
            os.replace(folder/'phone.pending',target)
        converted = validate_phone(target,duration)
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
