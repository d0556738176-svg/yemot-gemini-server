import pathlib,tempfile,unittest
from unittest.mock import patch
from pipeline import inspect,prepare

class ValidationTests(unittest.TestCase):
    def test_real_failed_download_is_rejected_before_conversion(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'input.webm';p.write_text('<html><h1>Site Unavailable</h1></html>')
            with patch('pipeline.run') as process:
                with self.assertRaisesRegex(ValueError,'media_unavailable'):
                    prepare('abcdefghijk',d,p)
                process.assert_not_called()
            folder=pathlib.Path(d)/'abcdefghijk'
            self.assertFalse((folder/'ready.json').exists())
            self.assertFalse((folder/'source.media').exists())
            self.assertFalse((folder/'active.lock').exists())

    def test_non_finite_duration_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'input';p.write_bytes(b'RIFF')
            with patch('pipeline.run',return_value=b'{"format":{"duration":"NaN"},"streams":[{"codec_type":"audio"}]}'):
                with self.assertRaises(ValueError):inspect(p)

class RecoveryTests(unittest.TestCase):
    def test_conversion_failure_retains_source_and_retry_never_downloads(self):
        import subprocess, pipeline
        with tempfile.TemporaryDirectory() as d:
            src=pathlib.Path(d)/'input.wav'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=duration=2','-y',str(src)],check=True)
            real_run=pipeline.run
            def fail_conversion(args,timeout):
                if args[0]=='ffmpeg': raise TimeoutError('simulated conversion timeout')
                return real_run(args,timeout)
            with patch('pipeline.run',side_effect=fail_conversion):
                with self.assertRaises(TimeoutError): prepare('abcdefghijk',d,src,2)
            folder=pathlib.Path(d)/'abcdefghijk'
            self.assertTrue((folder/'source.media').exists())
            self.assertFalse((folder/'ready.json').exists())
            src.unlink()
            def no_download(args,timeout):
                self.assertNotEqual(args[0],'yt-dlp')
                return real_run(args,timeout)
            with patch('pipeline.run',side_effect=no_download):
                self.assertTrue(prepare('abcdefghijk',d,expected=2)['converted'])
                (folder/'phone.wav').write_bytes(b'broken cache')
                self.assertTrue(prepare('abcdefghijk',d,expected=2)['converted'])

if __name__=='__main__':unittest.main()
