import base64
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import URLError

os.environ.update(JOB_ID="test-job", CALLBACK_URL="https://example.test", TICKET="test",
                  PAYLOAD=base64.b64encode(b"{}").decode(), ACESTEP_API_KEY="test")
spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def row(status, result=None):
    return {"data": [{"task_id": "task", "status": status, "result": result}]}


class PollingTests(unittest.TestCase):
    def poll(self, responses):
        with patch.object(worker, "api", side_effect=responses), patch.object(worker.time, "sleep"):
            return worker.wait_for_result("task")

    def test_transient_failure_then_pending_then_success(self):
        self.assertEqual(self.poll([URLError("temporary"), row(0), row(1, json.dumps([{"file": "/audio?id=1"}]))]), "/audio?id=1")

    def test_failure_does_not_leak_result(self):
        with self.assertRaisesRegex(RuntimeError, r"^ACE-Step generation failed \(status 2\)$"):
            self.poll([row(2, "private caller data")])

    def test_success_without_audio_fails(self):
        with self.assertRaisesRegex(RuntimeError, "without an audio"):
            self.poll([row(1, "[]")])

    def test_repeated_transport_errors_are_bounded(self):
        with self.assertRaisesRegex(RuntimeError, "polling failed repeatedly"):
            self.poll([URLError("down")] * 6)

    def test_deadline_expires_even_with_unknown_task(self):
        with patch.object(worker.time, "monotonic", side_effect=[0, 0, 2, 3]), patch.object(worker.time, "sleep"), patch.object(worker, "api", return_value={"data": []}):
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                worker.wait_for_result("task", timeout=1)


if __name__ == "__main__":
    unittest.main()
