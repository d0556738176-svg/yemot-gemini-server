"""Read-only stall diagnosis. Never starts, aborts or retries a provider run."""
import datetime,re

def diagnose(log, video_id, now, threshold_seconds=180):
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}',video_id):
        raise ValueError('invalid video ID')
    if now.tzinfo is None or threshold_seconds<=0:
        raise ValueError('timezone and positive threshold required')
    complete=None;conversion=None
    for line in log.splitlines():
        stamp=re.match(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)',line)
        if not stamp: continue
        at=datetime.datetime.fromisoformat(stamp[1].replace('Z','+00:00'))
        if '[youtube] Extracting URL:' in line:
            complete=conversion=None
        if '[download] 100%' in line:
            complete=at
        if '[ExtractAudio] Destination:' in line and video_id in line and complete:
            conversion=at
        if re.search(r'ERROR|\[RUN_SUMMARY\]|Deleting original file|\[download\] Destination:',line):
            if '[download] Destination:' not in line or conversion:
                complete=conversion=None
    if not conversion:
        return {'state':'unknown','canExtractPrivateTempFile':False}
    age=max(0,(now-conversion).total_seconds())
    return {'state':'conversion_stall_suspected' if age>=threshold_seconds else 'converting',
            'conversionStartedAt':conversion.isoformat(),'secondsSinceConversionStarted':age,
            'canExtractPrivateTempFile':False,
            'nextAction':'check_published_artifact','startAnotherDownload':False}
