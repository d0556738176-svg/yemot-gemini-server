# שלוחה 2 — חיפוש YouTube והכנת שמע מורשה לימות המשיח

## מה המערכת עושה

1. שלוחה 2 מחפשת סרטונים באמצעות YouTube Data API ומציגה כותרת, ערוץ ומזהה.
2. בלוח המחוונים בוחרים את הסרטון ומקשרים אליו **כתובת HTTPS ישירה לקובץ שמע/וידאו מורשה**.
3. כאשר מתקשר בוחר את אותו סרטון ואומר ״כן״, השרת מוריד את קובץ המקור מהכתובת הרשומה, ממיר אותו באמצעות FFmpeg ל־WAV מונו 8 kHz עם PCM 16-bit, מפצל למקטעים של עד 120 שניות, מעלה כל מקטע לימות המשיח דרך `UploadFile` ומאמת אותו דרך `GetFile`.
4. קובצי השמע נשמרים בתיקיית שלוחה 2 תחת `/2/youtube-authorized/` ומוחזרים לשיחת הטלפון להשמעה.

## גבול חשוב: חיפוש YouTube אינו הרשאת הורדה

YouTube Data API מספק פרטי סרטונים ומזהים, אך אינו מספק MP3. מדיניות Google לשירותי YouTube API אוסרת הורדה/אחסון של עותקים מתוכן האודיו־וידאו של YouTube ללא אישור כתוב מראש. לכן המערכת הזו **לא** משתמשת ב־yt-dlp כדי לקרוע את זרם YouTube של כל סרטון שנמצא. השתמשו בקובץ המקור המקורי שלכם או במקור שמע נפרד שיש לכם הרשאה מתאימה להעתיק ולהשמיע. `yt-dlp` או FFmpeg כשלעצמם אינם מעניקים הרשאה.

## הגדרות Render הנדרשות

יש להגדיר את המשתנים הבאים בסביבת השירות המבודדת/הייעודית, בלי להכניס סודות לקוד או לשלוח אותם בצ'אט:

- `YOUTUBE_API_KEY` — מפתח YouTube Data API v3 לחיפוש.
- `YEMOT_API_KEY` — טוקן API של ימות המשיח עבור `UploadFile` ו־`GetFile`.
- `DASHBOARD_ACCESS_TOKEN` — אסימון חזק ופרטי להגנת לוח המחוונים וה־API.
- `SUPABASE_URL` ו־`SUPABASE_KEY` — גישה מצד השרת למסד הנתונים.
- `AUTHORIZED_AUDIO_HOSTS` — שמות מארחים בלבד, מופרדים בפסיקים, שמורשים לספק קבצי מקור. לדוגמה: `media.example.com,project.supabase.co`. אין להוסיף `https://`, נתיבים או כתובות YouTube.

הריצו ב־Supabase את `supabase.sql` שבמאגר כדי ליצור את הטבלה `authorized_audio_sources`. השתמשו במפתח שרת מתאים, והגבילו גישה ציבורית לטבלה; הקוד ניגש אליה מצד השרת.

## הפעלה דרך לוח המחוונים

1. פתחו `/dashboard` בדומיין של השירות שמריץ את הגרסה העדכנית.
2. הזינו את `DASHBOARD_ACCESS_TOKEN` ולחצו ״שמור״.
3. באזור ״חיפוש YouTube וחיבור מקור שמע״ חפשו את שם הסרטון. ליד התוצאה הרצויה לחצו ״בחר וחבר מקור שמע״.
4. העלו את קובץ האודיו/וידאו המקורי או העמידו אותו בשרת קבצים מאובטח עם קישור ישיר שמחזיר את תוכן הקובץ. קישור לעמוד HTML, קישור צפייה ב־YouTube או קישור לזרם YouTube **אינם** מקור קובץ ישיר.
5. הדביקו את הכתובת הישירה בשדה מקור השמע, סמנו את אישור הזכויות ולחצו ״שמור מיפוי מקור״.
6. לחצו ״בדוק מיפוי״ כדי לוודא שהרשומה קיימת.
7. התקשרו למספר הבדיקה, היכנסו לשלוחה 2, חפשו את הסרטון, בחרו את אותו מספר תוצאה ואמרו ״כן״. ההכנה וההעלאה מתבצעות בעת בחירת ההשמעה.

## בדיקה בעזרת API

חיפוש (החליפו `SERVICE_URL` בדומיין השירות ואת המונח במונח חיפוש):

```sh
curl -H "Authorization: Bearer $DASHBOARD_ACCESS_TOKEN" \
  "https://SERVICE_URL/api/youtube/search?q=YOUR_SEARCH"
```

רישום קובץ מקור מורשה — יש להחליף את מזהה הסרטון ואת כתובת הקובץ הישירה; המארח חייב להופיע ב־`AUTHORIZED_AUDIO_HOSTS`:

```sh
curl -X POST "https://SERVICE_URL/api/youtube/authorized-source" \
  -H "Authorization: Bearer $DASHBOARD_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"videoId":"REPLACE_WITH_VIDEO_ID","sourceUrl":"https://media.example.com/original-audio.mp3","rightsConfirmed":true}'
```

בדיקת מקור:

```sh
curl -H "Authorization: Bearer $DASHBOARD_ACCESS_TOKEN" \
  "https://SERVICE_URL/api/youtube/authorized-source?videoId=REPLACE_WITH_VIDEO_ID"
```

הסרת מיפוי:

```sh
curl -X DELETE -H "Authorization: Bearer $DASHBOARD_ACCESS_TOKEN" \
  "https://SERVICE_URL/api/youtube/authorized-source?videoId=REPLACE_WITH_VIDEO_ID"
```

אל תכניסו טוקנים אמיתיים לפקודות שנשמרות בקובץ, לצילומי מסך או ל־GitHub.

## תקלות נפוצות

- `Supabase is not configured` — חסרים `SUPABASE_URL` או `SUPABASE_KEY`.
- `Source URL must be HTTPS and use an allowlisted host` — הכתובת אינה HTTPS או שהמארח חסר ב־`AUTHORIZED_AUDIO_HOSTS`.
- `No authorized audio source mapped to this video` — אין מיפוי פעיל למזהה הסרטון, או שהמיפוי לא מצביע על קובץ מקור תקף.
- `YEMOT_API_KEY is missing` — אין טוקן ימות המשיח בסביבת השירות.
- שגיאת `UploadFile`/`GetFile` — בדקו את הרשאות הטוקן, הנתיב, גודל הקובץ וזמינות API ימות המשיח.
- אין להשמעה מקור אוטומטי רק מעצם בחירת תוצאה: יש לרשום בנפרד את מקור השמע המורשה. מזהה YouTube וכותרת אינם קובץ שמע.

## רשימת בדיקה לפני שימוש אמיתי

- [ ] חיפוש YouTube עובד עם מפתח הבדיקה.
- [ ] המיפוי נשמר ונמצא ב־Supabase.
- [ ] קובץ המקור זמין ב־HTTPS מהמארח המאושר.
- [ ] FFmpeg מפיק מקטעי WAV תקינים.
- [ ] `UploadFile` מחזיר הצלחה ו־`GetFile` מאשר שכל מקטע קיים.
- [ ] שיחת טלפון אמיתית בשלוחה 2 בוחרת את הסרטון ומנגנת את כל המקטעים.
- [ ] כל בדיקות שלוחות 1, 3, 4 ו־5 נשארות מחוץ לשינוי הזה.

שימו לב: הצלחת build או בדיקות יחידה אינה תחליף לשיחת טלפון אמיתית. שירות staging ללא מפתחות וניתוב נפרד של ימות המשיח יכול לאמת build בלבד.
