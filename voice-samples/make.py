import asyncio, edge_tts, os
text = open("voice-samples/menu.txt", encoding="utf-8").read()
os.makedirs("out", exist_ok=True)
V = [
  ("1-avri-natural", "he-IL-AvriNeural", "+0%", "+0Hz"),
  ("2-avri-warm-deep", "he-IL-AvriNeural", "-6%", "-6Hz"),
  ("3-avri-lively", "he-IL-AvriNeural", "+8%", "+4Hz"),
  ("4-hila-natural", "he-IL-HilaNeural", "+0%", "+0Hz"),
  ("5-hila-warm", "he-IL-HilaNeural", "-5%", "-4Hz"),
]
async def main():
    for name, voice, rate, pitch in V:
        await edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).save(f"out/{name}.mp3")
        print(name, os.path.getsize(f"out/{name}.mp3"))
asyncio.run(main())
