# Branch 4 live test

This marker file exists only to trigger the opt-in `live-hf-music-test` GitHub Actions job on this feature branch. It does not enable branch 4, change production configuration, merge the pull request, or deploy the Node service.

The live test attempts one short audio generation through the public Hugging Face ACE-Step Space and validates that the response looks like an MP3. This does not validate Yemot upload or telephone playback.


The CI workflow is configured to run this smoke test only when this PR is explicitly marked `[live-hf-test]`. The test validates the external audio response only; Yemot upload and phone playback still require separate verification.
