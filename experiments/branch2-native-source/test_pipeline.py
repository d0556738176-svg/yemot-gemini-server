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

if __name__=='__main__':unittest.main()
