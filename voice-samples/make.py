import asyncio, edge_tts, os
text = open("voice-samples/menu.txt", encoding="utf-8").read()
os.makedirs("out", exist_ok=True)
V = [
  ("young-1-light", "he-IL-AvriNeural", "+6%", "+10Hz"),
  ("young-2-fresh", "he-IL-AvriNeural", "+8%", "+15Hz"),
  ("young-3-energetic", "he-IL-AvriNeural", "+12%", "+20Hz"),
  ("young-4-calm", "he-IL-AvriNeural", "+2%", "+12Hz"),
]
async def main():
    for name, voice, rate, pitch in V:
        await edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).save(f"out/{name}.mp3")
        print(name, os.path.getsize(f"out/{name}.mp3"))
asyncio.run(main())
