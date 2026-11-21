import datetime,unittest
from provider_stall import diagnose
class StallTests(unittest.TestCase):
    prefix='2026-11-02T12:11:30Z [download] 100% of 43.52MiB\n2026-11-02T12:11:34Z [ExtractAudio] Destination: /tmp/9scnWAgV6us.mp3\n'
    def test_suspected_not_proven_and_no_duplicate(self):
        r=diagnose(self.prefix,'9scnWAgV6us',datetime.datetime.fromisoformat('2026-11-02T12:15:00+00:00'))
        self.assertEqual(r['state'],'conversion_stall_suspected')
        self.assertFalse(r['startAnotherDownload']);self.assertFalse(r['canExtractPrivateTempFile'])
    def test_retry_invalidates_old_conversion(self):
        r=diagnose(self.prefix+'2026-11-02T12:14:00Z [youtube] Extracting URL: https://www.youtube.com/watch?v=9scnWAgV6us','9scnWAgV6us',datetime.datetime.fromisoformat('2026-11-02T12:18:00+00:00'))
        self.assertEqual(r['state'],'unknown')
    def test_terminal_summary_is_not_active_stall(self):
        r=diagnose(self.prefix+'2026-11-02T12:27:28Z [RUN_SUMMARY] failed','9scnWAgV6us',datetime.datetime.fromisoformat('2026-11-02T12:30:00+00:00'))
        self.assertEqual(r['state'],'unknown')
